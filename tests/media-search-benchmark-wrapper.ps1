param(
  [string]$TargetRoot = "$env:USERPROFILE\Downloads",
  [int]$Limit = 0,
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
$repo = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
if (-not $OutDir) {
  $OutDir = Join-Path $repo "artifacts\benchmark\media-search"
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$jsonOut = Join-Path $OutDir "media-search-benchmark-$stamp.json"
$samplesOut = Join-Path $OutDir "media-search-perf-samples-$stamp.jsonl"
$summaryOut = Join-Path $OutDir "media-search-benchmark-$stamp.summary.json"

$argsList = @(
  (Join-Path $repo "tests\media-search-benchmark.cjs"),
  $TargetRoot,
  "--json-out=$jsonOut"
)
if ($Limit -gt 0) {
  $argsList += "--limit=$Limit"
}

$node = Start-Process -FilePath "node.exe" -ArgumentList $argsList -WorkingDirectory $repo -PassThru -WindowStyle Hidden
$samples = New-Object System.Collections.Generic.List[object]

while (-not $node.HasExited) {
  $sampleTime = Get-Date
  $cpu = $null
  $mem = $null
  $gpuTotal = 0.0
  try {
    $counter = Get-Counter '\Processor(_Total)\% Processor Time','\Memory\% Committed Bytes In Use' -SampleInterval 1 -MaxSamples 1
    foreach ($s in $counter.CounterSamples) {
      if ($s.Path -like '*processor(_total)*') { $cpu = [double]$s.CookedValue }
      if ($s.Path -like '*memory*') { $mem = [double]$s.CookedValue }
    }
  } catch {}
  try {
    $gpu = Get-Counter '\GPU Engine(*)\Utilization Percentage' -SampleInterval 1 -MaxSamples 1
    $gpuTotal = [double](($gpu.CounterSamples | Measure-Object -Property CookedValue -Sum).Sum)
  } catch {}
  $node.Refresh()
  $row = [pscustomobject]@{
    time = $sampleTime.ToString("o")
    cpuPercent = $cpu
    memoryCommittedPercent = $mem
    gpuPercent = [math]::Round($gpuTotal, 2)
    nodeWorkingSetMb = [math]::Round($node.WorkingSet64 / 1MB, 2)
  }
  $samples.Add($row) | Out-Null
  $row | ConvertTo-Json -Compress | Add-Content -LiteralPath $samplesOut -Encoding UTF8
}

$node.WaitForExit()
if ($node.ExitCode -ne 0) {
  throw "Benchmark failed with exit code $($node.ExitCode)"
}

$benchmark = Get-Content -LiteralPath $jsonOut -Raw | ConvertFrom-Json
$cpuValues = @($samples | Where-Object { $null -ne $_.cpuPercent } | ForEach-Object { [double]$_.cpuPercent })
$memValues = @($samples | Where-Object { $null -ne $_.memoryCommittedPercent } | ForEach-Object { [double]$_.memoryCommittedPercent })
$gpuValues = @($samples | ForEach-Object { [double]$_.gpuPercent })
$nodeMemValues = @($samples | ForEach-Object { [double]$_.nodeWorkingSetMb })

function Avg($values) {
  if (-not $values -or $values.Count -eq 0) { return 0 }
  return [math]::Round((($values | Measure-Object -Average).Average), 2)
}

function MaxVal($values) {
  if (-not $values -or $values.Count -eq 0) { return 0 }
  return [math]::Round((($values | Measure-Object -Maximum).Maximum), 2)
}

$summary = [pscustomobject]@{
  targetRoot = $TargetRoot
  limit = $(if ($Limit -gt 0) { $Limit } else { $null })
  files = @{
    benchmarkJson = $jsonOut
    samplesJsonl = $samplesOut
    summaryJson = $summaryOut
  }
  totalMs = $benchmark.totalMs
  videos = $benchmark.enumerate.videos
  phasePercent = @{
    enumerate = $benchmark.enumerate.percentOfTotal
    metadata = $benchmark.metadata.percentOfTotal
    thumbnails = $benchmark.thumbnails.percentOfTotal
  }
  phaseMs = @{
    enumerate = $benchmark.enumerate.elapsedMs
    metadata = $benchmark.metadata.elapsedMs
    thumbnails = $benchmark.thumbnails.elapsedMs
  }
  perVideoMs = @{
    metadataAvg = $benchmark.metadata.avgMs
    thumbnailsAvg = $benchmark.thumbnails.avgMs
  }
  performance = @{
    sampleCount = $samples.Count
    avgCpuPercent = Avg $cpuValues
    peakCpuPercent = MaxVal $cpuValues
    avgGpuPercent = Avg $gpuValues
    peakGpuPercent = MaxVal $gpuValues
    avgMemoryCommittedPercent = Avg $memValues
    peakMemoryCommittedPercent = MaxVal $memValues
    peakNodeWorkingSetMb = MaxVal $nodeMemValues
  }
  failures = @{
    enumerate = $benchmark.enumerate.failed
    metadata = $benchmark.metadata.failed
    thumbnails = $benchmark.thumbnails.failed
  }
}

$summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summaryOut -Encoding UTF8
$summary | ConvertTo-Json -Depth 6
