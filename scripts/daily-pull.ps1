<#
  Daily job: pull new Morpheus recordings into S3, then put them in the
  dashboard index so they are searchable the same morning.

  Why --days=7 and not --days=1: the puller writes each recording's Morpheus id
  into its S3 key and lists the destination before it starts, so anything
  already uploaded is skipped. Re-scanning a week costs listing time and
  uploads nothing twice, but a day missed because this machine was off, the
  line was down, or the dialer returned errors is picked up on the next run
  instead of being lost. With --days=1 a missed day stays missed.

  Why the index runs here and not only in GitHub Actions: that workflow syncs
  at 23:00 UTC, which is 04:00 Pakistan time - two hours BEFORE this pull. On
  its own it would leave each morning's recordings invisible until the next
  day. It stays as the nightly reconcile; this is the fast path.

  Why --recent=8: the pull covers 7 days, so the index has to look at least
  that far back. Give it fewer folders than the pull window and a backfilled
  day would land in S3 and never be indexed.

  Leaves behind:
    logs\daily-<stamp>.log             full output of that run
    morpheus-pull-status.json          health, including lastSuccess
    Desktop\MORPHEUS-PULL-FAILED.txt   only when something needs a human

  -Check reports health without pulling anything.
#>
param(
  [int]$Days = 7,
  [int]$Concurrency = 8,
  [int]$Recent = 8,
  [int]$LagDays = 2,
  [switch]$DryRun,
  [switch]$SkipIndex,
  [switch]$Check
)

$ErrorActionPreference = 'Stop'

# Why these two helpers exist.
#
# Tee-Object in PowerShell 5.1 writes UTF-16, so appending it after an
# Out-File -Encoding utf8 header produced a log file with two encodings in it.
# Select-String then read the UTF-8 BOM, decoded the rest as UTF-8, and found
# nothing - which is why the status summaries came back empty.
function Write-Log {
  param([Parameter(ValueFromPipeline = $true)][AllowEmptyString()]$Text)
  process {
    # An ErrorRecord's own ToString() is "System.Management.Automation.Remote-
    # Exception" for native stderr, which says nothing. The message is what the
    # program actually printed.
    $line = if ($null -eq $Text) { '' }
            elseif ($Text -is [System.Management.Automation.ErrorRecord]) { $Text.Exception.Message }
            else { [string]$Text }
    $line | Out-File -FilePath $script:log -Append -Encoding utf8
    # Write-Host, not Write-Output: this must not become the return value of
    # whatever function is logging. That is what turned $pullCode into an array
    # of log lines on the first attempt.
    Write-Host $line
  }
}

# And the reason the scheduled job died silently on 25 Nov: with
# $ErrorActionPreference = 'Stop', PowerShell 5.1 wraps every stderr line from a
# native command in an ErrorRecord, and that becomes a TERMINATING error. npx
# prints a Node-version warning to stderr on startup, so the job was killed
# before it had pulled anything - no index step, no status file, no alert. The
# orphaned node child kept uploading, which is why it looked like it worked.
#
# Inside here stderr is ordinary output again, and the native exit code is
# returned rather than $? being consulted.
function Invoke-Native {
  param([string]$Exe, [string[]]$Arguments)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Exe @Arguments 2>&1 | Write-Log
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
}
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$statusFile = Join-Path $root 'morpheus-pull-status.json'
$alertFile  = Join-Path ([Environment]::GetFolderPath('Desktop')) 'MORPHEUS-PULL-FAILED.txt'
# A job that has not fully succeeded in this long is worth a human looking at.
$staleHours = 36

function Read-Status {
  if (Test-Path $statusFile) {
    try { return Get-Content $statusFile -Raw | ConvertFrom-Json } catch { return $null }
  }
  return $null
}

function Get-AgeHours($stamp) {
  if (-not $stamp) { return $null }
  try { return [math]::Round(((Get-Date) - [datetime]$stamp).TotalHours, 1) } catch { return $null }
}

if ($Check) {
  $s = Read-Status
  if ($null -eq $s) { Write-Output 'No run has been recorded yet.'; exit 2 }
  $age = Get-AgeHours $s.lastSuccess
  Write-Output "last run     : $($s.finishedAt)"
  Write-Output "last success : $($s.lastSuccess)  ($age hours ago)"
  Write-Output "window       : $($s.window)   (lag $($s.lagDays) days)"
  Write-Output "pull         : $($s.pullSummary)"
  if ($s.pending) { Write-Output "pending      : $($s.pending)" }
  Write-Output "index        : $($s.indexSummary)"
  Write-Output "log          : $($s.log)"
  if ($null -eq $age -or $age -gt $staleHours) {
    Write-Output "STALE - nothing has fully succeeded in over $staleHours hours"
    exit 1
  }
  Write-Output 'healthy'
  exit 0
}

$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $logDir "daily-$stamp.log"
$start = Get-Date

# ---- 1. pull -------------------------------------------------------------
'' | Out-File -FilePath $log -Encoding utf8   # start the file, UTF-8, empty
('=== pull ' + $start.ToString('yyyy-MM-dd HH:mm:ss') + ' ===') | Write-Log

# Why the window ends two days back instead of today. The dialer records to
# uncompressed WAV and re-encodes to M4A about a day and a half later - the
# vendor's words: "This is by design. If you want M4A recording format, pull
# recordings after 24 hours in Basic plan." A WAV is roughly 4x the bytes of
# the same call, so pulling today's calls would quadruple storage for no gain.
# Two days back clears the lag with room to spare.
#
# This only avoids wasted downloads; it is not the real guard. The puller
# checks each downloaded file and leaves a WAV on the dialer for a later run,
# so even if conversion falls behind, nothing is archived in the wrong format
# and nothing is lost - each day stays in the window for seven runs.
$pullFrom = (Get-Date).AddDays(-($Days - 1 + $LagDays)).ToString('yyyy-MM-dd')
$pullTo   = (Get-Date).AddDays(-$LagDays).ToString('yyyy-MM-dd')

"pulling $pullFrom .. $pullTo  (lag $LagDays days)" | Write-Log
$pullArgs = @('tsx', '--env-file=.env.local', 'scripts/morpheus-pull.ts', "--from=$pullFrom", "--to=$pullTo", "--concurrency=$Concurrency")
if ($DryRun) { $pullArgs += '--dry-run' }
$pullCode = Invoke-Native -Exe 'npx' -Arguments $pullArgs


# ---- 2. index ------------------------------------------------------------
# Runs even when the pull failed part-way: whatever did reach S3 should become
# searchable now rather than waiting a day for the nightly reconcile.
$indexCode = 0
if ($SkipIndex -or $DryRun) {
  '=== index skipped ===' | Write-Log
} else {
  ('=== index ' + (Get-Date).ToString('HH:mm:ss') + ' ===') | Write-Log
  $previousProfile = $env:AWS_PROFILE
  # The reader credential can list and get, and cannot overwrite anything.
  $env:AWS_PROFILE = 'reader'
  try {
    $indexCode = Invoke-Native -Exe 'npx' -Arguments @('tsx', '--env-file=.env.local', 'scripts/index-recordings.ts', "--recent=$Recent")
  } finally {
    $env:AWS_PROFILE = $previousProfile
  }
}

$end = Get-Date

function Get-LastMatch($pattern) {
  $m = Select-String -Path $log -Pattern $pattern | Select-Object -Last 1
  if ($m) { return $m.Line.Trim() }
  return ''
}
$pullSummary  = Get-LastMatch '^(UPLOADED|WOULD UPLOAD):'
# Recordings the dialer had not re-encoded yet. Not a failure - they are taken
# on a later run - but worth seeing, because a number that never falls means
# the re-encode has stopped.
$pendingSummary = Get-LastMatch 'still WAV on the dialer'
$indexSummary = Get-LastMatch 'indexed|rows|up to date|unchanged'

$ok = ($pullCode -eq 0 -and $indexCode -eq 0)
$prev = Read-Status
$status = [ordered]@{
  lastRun       = $start.ToString('o')
  finishedAt    = $end.ToString('o')
  minutes       = [math]::Round(($end - $start).TotalMinutes, 1)
  pullExitCode  = $pullCode
  indexExitCode = $indexCode
  ok            = $ok
  pullSummary   = $pullSummary
  indexSummary  = $indexSummary
  window        = "$pullFrom .. $pullTo"
  lagDays       = $LagDays
  pending       = $pendingSummary
  log           = $log
  lastSuccess   = $null
}
if ($ok) { $status.lastSuccess = $end.ToString('o') }
elseif ($prev -and $prev.lastSuccess) { $status.lastSuccess = $prev.lastSuccess }
$status | ConvertTo-Json | Out-File -FilePath $statusFile -Encoding utf8

$age = Get-AgeHours $status.lastSuccess
$stale = ($null -eq $age -or $age -gt $staleHours)

if (-not $ok -or $stale) {
  $msg = @()
  $msg += 'The daily Morpheus job needs attention.'
  $msg += ''
  $msg += 'when             : ' + $end.ToString('yyyy-MM-dd HH:mm')
  $msg += 'pull exit code   : ' + $pullCode
  $msg += 'index exit code  : ' + $indexCode
  $msg += 'last full success: ' + $status.lastSuccess
  $msg += 'pull             : ' + $pullSummary
  $msg += 'index            : ' + $indexSummary
  $msg += 'full log         : ' + $log
  $msg += ''
  $msg += 'Recordings are still on the dialer, so nothing is lost yet.'
  $msg += 'Re-running picks up whatever is missing, because it skips what'
  $msg += 'S3 already has:'
  $msg += ''
  $msg += '    cd ' + $root
  $msg += '    powershell -File scripts\daily-pull.ps1'
  $msg | Out-File -FilePath $alertFile -Encoding utf8
} elseif (Test-Path $alertFile) {
  Remove-Item $alertFile -Force
}

# Keep a month of logs, not a year.
Get-ChildItem $logDir -Filter 'daily-*.log' |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
  Remove-Item -Force -ErrorAction SilentlyContinue

if ($pullCode -ne 0) { exit $pullCode }
exit $indexCode
