param(
  [string]$TargetRoot = "$env:USERPROFILE\Downloads",
  [string]$Mode = "metadata",
  [int]$Concurrency = 4,
  [int]$TimeoutMs = 180000,
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
$repo = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
if (-not $OutDir) {
  $OutDir = Join-Path $repo "artifacts\benchmark\media-search-ipc"
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$jsonOut = Join-Path $OutDir "media-search-ipc-scan-$stamp.json"
$samplesOut = Join-Path $OutDir "media-search-ipc-scan-perf-$stamp.jsonl"
$summaryOut = Join-Path $OutDir "media-search-ipc-scan-$stamp.summary.json"

$pathValue = [Environment]::GetEnvironmentVariable("Path", "Process")
if (-not $pathValue) {
  $pathValue = [Environment]::GetEnvironmentVariable("PATH", "Process")
}
if ($pathValue) {
  [Environment]::SetEnvironmentVariable("PATH", $null, "Process")
  [Environment]::SetEnvironmentVariable("Path", $pathValue, "Process")
}

$argsList = @(
  (Join-Path $repo "tests\media-search-ipc-scan-benchmark.cjs"),
  $TargetRoot,
  "--mode=$Mode",
  "--concurrency=$Concurrency",
  "--timeout-ms=$TimeoutMs"
)

$node = Start-Process -FilePath "node.exe" -ArgumentList $argsList -WorkingDirectory $repo -RedirectStandardOutput $jsonOut -RedirectStandardError "$jsonOut.stderr.txt" -PassThru -WindowStyle Hidden
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
$node.Refresh()
$exitCode = $node.ExitCode
if ($null -eq $exitCode) {
  $exitCode = 0
}
if ($exitCode -ne 0) {
  $stderr = ""
  if (Test-Path -LiteralPath "$jsonOut.stderr.txt") {
    $stderr = Get-Content -LiteralPath "$jsonOut.stderr.txt" -Raw
  }
  throw "IPC scan benchmark failed with exit code $exitCode. $stderr"
}

$raw = Get-Content -LiteralPath $jsonOut -Raw
$jsonStart = $raw.IndexOf("{")
if ($jsonStart -gt 0) {
  $raw = $raw.Substring($jsonStart)
}
$benchmark = $raw | ConvertFrom-Json
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
  mode = $Mode
  concurrency = $Concurrency
  files = @{
    benchmarkJson = $jsonOut
    stderr = "$jsonOut.stderr.txt"
    samplesJsonl = $samplesOut
    summaryJson = $summaryOut
  }
  elapsedMs = $benchmark.elapsedMs
  elapsedSeconds = $benchmark.elapsedSeconds
  task = $benchmark.task
  status = $benchmark.status
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
}

$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryOut -Encoding UTF8
$summary | ConvertTo-Json -Depth 8
