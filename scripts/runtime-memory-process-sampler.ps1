param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [Parameter(Mandatory = $true)][string]$OutputFile,
  [Parameter(Mandatory = $true)][string]$StopFile,
  [Parameter(Mandatory = $true)][string]$ReadyFile,
  [int]$IntervalMs = 250,
  [int64]$MaxOutputBytes = 268435456,
  [int]$MaxSamples = 200000
)

$ErrorActionPreference = 'Stop'
$IntervalMs = [Math]::Max(100, [Math]::Min(500, $IntervalMs))
$MaxOutputBytes = [Math]::Max(1048576, [Math]::Min(1073741824, $MaxOutputBytes))
$MaxSamples = [Math]::Max(1, [Math]::Min(1000000, $MaxSamples))
$MaxLineBytes = 4MB
$ErrorFile = "$OutputFile.error"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Failure([string]$Code, [System.Exception]$Exception) {
  try {
    $failure = [ordered]@{
      schema = 'siftory-runtime-memory-sampler-error/v1'
      code = $Code
      exceptionType = $Exception.GetType().FullName
      sampledAt = [DateTime]::UtcNow.ToString('o')
    }
    [System.IO.File]::WriteAllText(
      $ErrorFile,
      ($failure | ConvertTo-Json -Compress),
      $Utf8NoBom
    )
  } catch {}
}

trap {
  Write-Failure 'sampler-failed' $_.Exception
  exit 1
}

function As-UInt64($Value) {
  if ($null -eq $Value) { return [uint64]0 }
  return [Convert]::ToUInt64($Value, [Globalization.CultureInfo]::InvariantCulture)
}

function Creation-Utc($Value) {
  if ($Value -is [DateTime]) { return $Value.ToUniversalTime() }
  return [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$Value).ToUniversalTime()
}

function Process-Identity($Row) {
  $created = Creation-Utc $Row.CreationDate
  return '{0}@{1}' -f ([int]$Row.ProcessId), $created.Ticks
}

function Process-Role($Row, [int]$RootProcessId) {
  if ([int]$Row.ProcessId -eq $RootProcessId) { return 'main' }
  $command = ([string]$Row.CommandLine).ToLowerInvariant()
  $name = ([string]$Row.Name).ToLowerInvariant()
  if ($command -match '--type=gpu-process') { return 'gpu' }
  if ($command -match '--type=renderer') { return 'renderer' }
  if ($command -match '--type=utility') { return 'utility' }
  if ($command -match '(dinoembeddingchild|clipembeddingchild|embeddingpreparationchild|usermodelruntimechild|audiosemanticbuildchild|modelruntime|onnxruntime)') {
    return 'model-child'
  }
  if ($command -match '(vectorannworker|semanticvectorsearchworker|catalogworker|suggestionscanworker|clusteringworker|feedbackworker|worker\.(js|cjs|mjs))') {
    return 'worker'
  }
  if ($name -match '^(electron|node)\.exe$') { return 'worker' }
  return 'other-child'
}

function Read-ProcessRows {
  return @(
    Get-CimInstance Win32_Process -Property @(
      'ProcessId',
      'ParentProcessId',
      'CreationDate',
      'Name',
      'CommandLine',
      'WorkingSetSize',
      'PrivatePageCount',
      'PageFileUsage',
      'PageFaults',
      'ThreadCount',
      'HandleCount',
      'KernelModeTime',
      'UserModeTime'
    )
  )
}

function Find-RootRow($Rows, [int]$ProcessId) {
  return @($Rows | Where-Object { [int]$_.ProcessId -eq $ProcessId }) | Select-Object -First 1
}

$initialRows = Read-ProcessRows
$rootRow = Find-RootRow $initialRows $RootPid
if ($null -eq $rootRow) { throw "Root process does not exist" }
$RootIdentity = Process-Identity $rootRow
$RootCreatedUtc = Creation-Utc $rootRow.CreationDate

$outputDirectory = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($OutputFile))
if (-not [System.IO.Directory]::Exists($outputDirectory)) {
  throw 'Sampler output directory must already exist'
}
$stream = New-Object System.IO.FileStream(
  $OutputFile,
  [System.IO.FileMode]::CreateNew,
  [System.IO.FileAccess]::Write,
  [System.IO.FileShare]::Read
)
$writer = New-Object System.IO.StreamWriter($stream, $Utf8NoBom)
$writer.AutoFlush = $true
$sampleNumber = 0
$writtenBytes = [int64]0
$raceSkips = 0

try {
  [System.IO.File]::WriteAllText($ReadyFile, $RootIdentity, $Utf8NoBom)
  while (-not [System.IO.File]::Exists($StopFile)) {
    $started = [Diagnostics.Stopwatch]::StartNew()
    $rows = Read-ProcessRows
    $currentRoot = Find-RootRow $rows $RootPid
    if ($null -eq $currentRoot -or (Process-Identity $currentRoot) -ne $RootIdentity) {
      if ([System.IO.File]::Exists($StopFile)) { break }
      throw 'Root process identity changed or exited'
    }

    $byParent = @{}
    foreach ($row in $rows) {
      $parentKey = [string]([int]$row.ParentProcessId)
      if (-not $byParent.ContainsKey($parentKey)) { $byParent[$parentKey] = New-Object Collections.ArrayList }
      [void]$byParent[$parentKey].Add($row)
    }

    $selected = New-Object Collections.ArrayList
    $queue = New-Object Collections.Queue
    $seen = @{}
    $queue.Enqueue($currentRoot)
    while ($queue.Count -gt 0) {
      $parent = $queue.Dequeue()
      $parentIdentity = Process-Identity $parent
      if ($seen.ContainsKey($parentIdentity)) { continue }
      $seen[$parentIdentity] = $true
      [void]$selected.Add($parent)
      $children = $byParent[[string]([int]$parent.ProcessId)]
      if ($null -eq $children) { continue }
      $parentCreated = Creation-Utc $parent.CreationDate
      foreach ($child in $children) {
        try {
          $childCreated = Creation-Utc $child.CreationDate
          if ($childCreated -lt $parentCreated) {
            $raceSkips += 1
            continue
          }
          $queue.Enqueue($child)
        } catch {
          $raceSkips += 1
        }
      }
    }

    $processes = @()
    $aggregateWorkingSet = [uint64]0
    $aggregatePrivate = [uint64]0
    $aggregateCommit = [uint64]0
    foreach ($row in $selected) {
      $created = Creation-Utc $row.CreationDate
      $workingSet = As-UInt64 $row.WorkingSetSize
      $privateBytes = As-UInt64 $row.PrivatePageCount
      $commitBytes = (As-UInt64 $row.PageFileUsage) * 1024
      $aggregateWorkingSet += $workingSet
      $aggregatePrivate += $privateBytes
      $aggregateCommit += $commitBytes
      $processes += [ordered]@{
        identity = Process-Identity $row
        pid = [int]$row.ProcessId
        ppid = [int]$row.ParentProcessId
        createdAt = $created.ToString('o')
        name = [System.IO.Path]::GetFileName([string]$row.Name)
        role = Process-Role $row $RootPid
        workingSetBytes = $workingSet
        privateBytes = $privateBytes
        commitBytes = $commitBytes
        pageFaults = As-UInt64 $row.PageFaults
        threadCount = [int](As-UInt64 $row.ThreadCount)
        handleCount = [int](As-UInt64 $row.HandleCount)
        cpuKernelMs = [Math]::Round((As-UInt64 $row.KernelModeTime) / 10000.0, 3)
        cpuUserMs = [Math]::Round((As-UInt64 $row.UserModeTime) / 10000.0, 3)
      }
    }
    $processes = @($processes | Sort-Object -Property createdAt, pid)

    $operatingSystem = Get-CimInstance Win32_OperatingSystem -Property @(
      'FreePhysicalMemory',
      'TotalVisibleMemorySize'
    )
    $sample = [ordered]@{
      schema = 'siftory-runtime-memory-sample/v1'
      sequence = $sampleNumber
      sampledAt = [DateTime]::UtcNow.ToString('o')
      intervalMs = $IntervalMs
      rootIdentity = $RootIdentity
      rootCreatedAt = $RootCreatedUtc.ToString('o')
      processRaceSkips = $raceSkips
      system = [ordered]@{
        freePhysicalMemoryBytes = (As-UInt64 $operatingSystem.FreePhysicalMemory) * 1024
        totalPhysicalMemoryBytes = (As-UInt64 $operatingSystem.TotalVisibleMemorySize) * 1024
      }
      aggregate = [ordered]@{
        processCount = $processes.Count
        workingSetBytes = $aggregateWorkingSet
        privateBytes = $aggregatePrivate
        commitBytes = $aggregateCommit
      }
      processes = $processes
    }
    $json = $sample | ConvertTo-Json -Depth 7 -Compress
    $lineBytes = $Utf8NoBom.GetByteCount($json) + 1
    if ($lineBytes -gt $MaxLineBytes) { throw 'Sampler JSON line exceeded the bounded size' }
    if ($writtenBytes + $lineBytes -gt $MaxOutputBytes) { throw 'Sampler output exceeded the bounded size' }
    $writer.WriteLine($json)
    $writtenBytes += $lineBytes
    $sampleNumber += 1
    if ($sampleNumber -ge $MaxSamples) { throw 'Sampler sample count exceeded the bounded limit' }
    $remaining = $IntervalMs - [int]$started.ElapsedMilliseconds
    if ($remaining -gt 0) { Start-Sleep -Milliseconds $remaining }
  }
} finally {
  $writer.Dispose()
  $stream.Dispose()
}
