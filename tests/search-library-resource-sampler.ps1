param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [Parameter(Mandatory = $true)][string]$PidFile,
  [Parameter(Mandatory = $true)][string]$StopFile,
  [Parameter(Mandatory = $true)][string]$ReadyFile,
  [Parameter(Mandatory = $true)][string]$OutputFile,
  [Parameter(Mandatory = $true)][string]$NvidiaSmiPath,
  [int]$IntervalMs = 100
)

$ErrorActionPreference = "Stop"
$IntervalMs = [Math]::Max(50, [Math]::Min(1000, $IntervalMs))
$CheckpointDirectory = "$OutputFile.checkpoints"
$ErrorFile = "$OutputFile.error"
[System.IO.Directory]::CreateDirectory($CheckpointDirectory) | Out-Null

trap {
  try {
    $failure = [pscustomobject]@{
      exceptionType = $_.Exception.GetType().FullName
      errorId = [string]$_.FullyQualifiedErrorId
      category = [string]$_.CategoryInfo.Category
      line = [int]$_.InvocationInfo.ScriptLineNumber
    }
    [System.IO.File]::WriteAllText(
      $ErrorFile,
      ($failure | ConvertTo-Json -Compress),
      (New-Object System.Text.UTF8Encoding($false))
    )
  } catch {}
  exit 1
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class SiftoryProcessIo {
  [StructLayout(LayoutKind.Sequential)]
  public struct IoCounters {
    public UInt64 ReadOperationCount;
    public UInt64 WriteOperationCount;
    public UInt64 OtherOperationCount;
    public UInt64 ReadTransferCount;
    public UInt64 WriteTransferCount;
    public UInt64 OtherTransferCount;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetProcessIoCounters(
    IntPtr processHandle,
    out IoCounters counters
  );
}
"@

function Read-IoCounters([System.Diagnostics.Process]$Process) {
  try {
    $counters = New-Object SiftoryProcessIo+IoCounters
    if ([SiftoryProcessIo]::GetProcessIoCounters($Process.Handle, [ref]$counters)) {
      return [pscustomobject]@{
        readBytes = [uint64]$counters.ReadTransferCount
        writeBytes = [uint64]$counters.WriteTransferCount
      }
    }
  } catch {}
  return $null
}

function Read-GpuSample {
  $gpuProcess = $null
  try {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $NvidiaSmiPath
    $startInfo.Arguments = "--query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $gpuProcess = New-Object System.Diagnostics.Process
    $gpuProcess.StartInfo = $startInfo
    if (-not $gpuProcess.Start()) { return $null }
    if (-not $gpuProcess.WaitForExit(2000)) {
      try { $gpuProcess.Kill() } catch {}
      return $null
    }
    $stdout = $gpuProcess.StandardOutput.ReadToEnd()
    $lines = @($stdout -split "`r?`n" | Where-Object { $_.Trim().Length -gt 0 })
    $rows = @()
    foreach ($line in $lines) {
      $parts = @($line -split ',' | ForEach-Object { [double]$_.Trim() })
      if ($parts.Count -ge 3) { $rows += ,$parts }
    }
    if ($rows.Count -eq 0) { return $null }
    return [pscustomobject]@{
      usedMiB = [double](($rows | ForEach-Object { $_[0] } | Measure-Object -Sum).Sum)
      totalMiB = [double](($rows | ForEach-Object { $_[1] } | Measure-Object -Sum).Sum)
      utilizationPercent = [double](($rows | ForEach-Object { $_[2] } | Measure-Object -Maximum).Maximum)
      deviceCount = $rows.Count
    }
  } catch {
    return $null
  } finally {
    if ($null -ne $gpuProcess) { $gpuProcess.Dispose() }
  }
}

$root = Get-Process -Id $RootPid -ErrorAction Stop
$rootIo = Read-IoCounters $root
$rootStartCpuMs = [double]$root.CPU * 1000
$rootStartReadBytes = if ($null -ne $rootIo) { [double]$rootIo.readBytes } else { 0 }
$rootStartWriteBytes = if ($null -ne $rootIo) { [double]$rootIo.writeBytes } else { 0 }
$rootLastCpuMs = $rootStartCpuMs
$rootLastReadBytes = $rootStartReadBytes
$rootLastWriteBytes = $rootStartWriteBytes
$rootPeakRssBytes = [double]$root.WorkingSet64
$children = @{}
$childPeakAggregateRssBytes = 0.0
$childLargestPeakRssBytes = 0.0
$sampleCount = 0
$sampleErrors = 0
$processRaceSkips = 0
$observedChildProcessSamples = 0
$activeAtStop = $null
$stopSnapshotTaken = $false
$gpuBaseline = Read-GpuSample
$gpuPeakUsedMiB = if ($null -ne $gpuBaseline) { [double]$gpuBaseline.usedMiB } else { 0 }
$gpuPeakUtilizationPercent = if ($null -ne $gpuBaseline) { [double]$gpuBaseline.utilizationPercent } else { 0 }

function New-ResourceResult {
  $childCpuMs = 0.0
  $childReadBytes = 0.0
  $childWriteBytes = 0.0
  foreach ($row in $children.Values) {
    $childCpuMs += [double]$row.cpuMs
    $childReadBytes += [double]$row.readBytes
    $childWriteBytes += [double]$row.writeBytes
  }

  return [pscustomobject]@{
    sampling = [pscustomobject]@{
      intervalMs = $IntervalMs
      samples = $sampleCount
      errors = $sampleErrors
      processRaceSkips = $processRaceSkips
      observedChildProcesses = $children.Count
      observedChildProcessSamples = $observedChildProcessSamples
      activeAtStop = $activeAtStop
      stopSnapshotTaken = $stopSnapshotTaken
    }
    cpu = [pscustomobject]@{
      mainMsApprox = [Math]::Max(0.0, [double]($rootLastCpuMs - $rootStartCpuMs))
      childMsApprox = $childCpuMs
    }
    memory = [pscustomobject]@{
      mainPeakRssBytes = $rootPeakRssBytes
      childPeakAggregateRssBytesApprox = $childPeakAggregateRssBytes
      childLargestPeakRssBytesApprox = $childLargestPeakRssBytes
    }
    io = [pscustomobject]@{
      mainReadBytesApprox = [Math]::Max(
        0.0,
        [double]($rootLastReadBytes - $rootStartReadBytes)
      )
      mainWriteBytesApprox = [Math]::Max(
        0.0,
        [double]($rootLastWriteBytes - $rootStartWriteBytes)
      )
      childReadBytesApprox = $childReadBytes
      childWriteBytesApprox = $childWriteBytes
    }
    gpu = if ($null -ne $gpuBaseline) {
      [pscustomobject]@{
        deviceCount = $gpuBaseline.deviceCount
        baselineUsedMiB = $gpuBaseline.usedMiB
        peakUsedMiB = $gpuPeakUsedMiB
        peakDeltaUsedMiB = [Math]::Max(
          0.0,
          [double]($gpuPeakUsedMiB - [double]$gpuBaseline.usedMiB)
        )
        totalMiB = $gpuBaseline.totalMiB
        peakUtilizationPercent = $gpuPeakUtilizationPercent
      }
    } else {
      $null
    }
  }
}

function Write-ResourceResult([string]$TargetPath) {
  $temporaryPath = "$TargetPath.tmp"
  $json = New-ResourceResult | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText(
    $temporaryPath,
    $json,
    (New-Object System.Text.UTF8Encoding($false))
  )
  if (Test-Path -LiteralPath $TargetPath) { [System.IO.File]::Delete($TargetPath) }
  [System.IO.File]::Move($temporaryPath, $TargetPath)
}

[System.IO.File]::WriteAllText($ReadyFile, "ready")

while (-not (Test-Path -LiteralPath $StopFile)) {
  try {
    $ids = @(
      Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue |
        ForEach-Object { if ($_ -match '^\d+$') { [int]$_ } } |
        Sort-Object -Unique
    )
    $processes = if ($ids.Count -gt 0) {
      @(Get-Process -Id $ids -ErrorAction SilentlyContinue)
    } else {
      @()
    }
    $activeChildRssBytes = 0.0
    foreach ($process in $processes) {
      try {
        $process.Refresh()
        $cpuMs = [double]$process.CPU * 1000
        $rssBytes = [double]$process.WorkingSet64
        $io = Read-IoCounters $process
        $readBytes = if ($null -ne $io) { [double]$io.readBytes } else { 0 }
        $writeBytes = if ($null -ne $io) { [double]$io.writeBytes } else { 0 }
        if ($process.Id -eq $RootPid) {
          $rootLastCpuMs = [Math]::Max($rootLastCpuMs, $cpuMs)
          $rootLastReadBytes = [Math]::Max($rootLastReadBytes, $readBytes)
          $rootLastWriteBytes = [Math]::Max($rootLastWriteBytes, $writeBytes)
          $rootPeakRssBytes = [Math]::Max($rootPeakRssBytes, $rssBytes)
          continue
        }
        $key = [string]$process.Id
        if (-not $children.ContainsKey($key)) {
          $children[$key] = [pscustomobject]@{
            cpuMs = 0.0
            peakRssBytes = 0.0
            readBytes = 0.0
            writeBytes = 0.0
          }
        }
        $row = $children[$key]
        $row.cpuMs = [Math]::Max([double]$row.cpuMs, $cpuMs)
        $row.peakRssBytes = [Math]::Max([double]$row.peakRssBytes, $rssBytes)
        $row.readBytes = [Math]::Max([double]$row.readBytes, $readBytes)
        $row.writeBytes = [Math]::Max([double]$row.writeBytes, $writeBytes)
        $observedChildProcessSamples += 1
        $activeChildRssBytes += $rssBytes
        $childLargestPeakRssBytes = [Math]::Max($childLargestPeakRssBytes, $rssBytes)
      } catch {
        # A tracked child can exit between Get-Process and Refresh. That is a
        # normal lifecycle race, not a sampler failure.
        $processRaceSkips += 1
      }
    }
    $childPeakAggregateRssBytes = [Math]::Max($childPeakAggregateRssBytes, $activeChildRssBytes)
    if (($sampleCount % [Math]::Max(1, [Math]::Floor(1000 / $IntervalMs))) -eq 0) {
      $gpu = Read-GpuSample
      if ($null -ne $gpu) {
        if ($null -eq $gpuBaseline) { $gpuBaseline = $gpu }
        $gpuPeakUsedMiB = [Math]::Max($gpuPeakUsedMiB, [double]$gpu.usedMiB)
        $gpuPeakUtilizationPercent = [Math]::Max(
          $gpuPeakUtilizationPercent,
          [double]$gpu.utilizationPercent
        )
      }
    }
    $sampleCount += 1
    $checkpointInterval = [Math]::Max(1, [Math]::Floor(5000 / $IntervalMs))
    if (($sampleCount % $checkpointInterval) -eq 0) {
      $checkpointName = "{0:D12}.json" -f $sampleCount
      Write-ResourceResult (Join-Path $CheckpointDirectory $checkpointName)
    }
  } catch {
    $sampleErrors += 1
  }
  Start-Sleep -Milliseconds $IntervalMs
}

$stopIds = @(
  Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue |
    ForEach-Object { if ($_ -match '^\d+$') { [int]$_ } } |
    Sort-Object -Unique
)
$stopProcesses = if ($stopIds.Count -gt 0) {
  @(Get-Process -Id $stopIds -ErrorAction SilentlyContinue)
} else {
  @()
}
$activeAtStop = @($stopProcesses | Where-Object { $_.Id -ne $RootPid }).Count
$stopSnapshotTaken = $true
Write-ResourceResult $OutputFile
