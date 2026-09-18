$ErrorActionPreference = 'Stop'

$mediaMonkey = $null
$lastConnectAttemptAt = 0L

function Release-ComReference {
  param($Value)
  if ($Value -and [Runtime.InteropServices.Marshal]::IsComObject($Value)) {
    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($Value) } catch { }
  }
}

function Reset-MediaMonkey {
  Release-ComReference $script:mediaMonkey
  $script:mediaMonkey = $null
}

function Get-MediaMonkey {
  $process = Get-Process -Name 'MediaMonkey' -ErrorAction SilentlyContinue |
    Sort-Object StartTime |
    Select-Object -First 1
  if (-not $process) {
    Reset-MediaMonkey
    return $null
  }

  if ($script:mediaMonkey) { return $script:mediaMonkey }

  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if (($now - $script:lastConnectAttemptAt) -lt 1000) { return $null }
  $script:lastConnectAttemptAt = $now

  try {
    $candidate = New-Object -ComObject 'SongsDB5.SDBApplication'
    $candidate.ShutdownAfterDisconnect = $false
    $script:mediaMonkey = $candidate
    return $script:mediaMonkey
  } catch {
    Reset-MediaMonkey
    return $null
  }
}

function Get-MediaMonkeyStatus {
  $application = Get-MediaMonkey
  if (-not $application) { return $null }

  $player = $null
  $song = $null
  try {
    $player = $application.Player
    $song = $player.CurrentSong
    if (-not $song) { return $null }

    $title = [string]$song.Title
    if (-not $title) { return $null }

    $durationMs = [long][math]::Max(0, [double]$player.CurrentSongLength)
    if ($durationMs -le 0) {
      $durationMs = [long][math]::Max(0, [double]$song.SongLength)
    }
    $positionMs = [long][math]::Max(0, [double]$player.PlaybackTime)
    if ($durationMs -gt 0) {
      $positionMs = [long][math]::Min($positionMs, $durationMs)
    }
    $isPaused = [bool]$player.IsPaused
    $isPlaying = [bool]$player.IsPlaying -and -not $isPaused
    $path = [string]$song.Path

    [pscustomobject]@{
      id = if ($path) { $path } elseif ([long]$song.ID -gt 0) { "library:$([long]$song.ID)" } else { $title }
      title = $title
      artist = [string]$song.ArtistName
      album = [string]$song.AlbumName
      positionMs = $positionMs
      durationMs = $durationMs
      isPlaying = $isPlaying
      isPaused = $isPaused
    }
  } catch {
    Reset-MediaMonkey
    return $null
  } finally {
    Release-ComReference $song
    Release-ComReference $player
  }
}

function Send-MediaMonkeyCommand {
  param(
    [Parameter(Mandatory)] [string] $Command,
    [long] $PositionMs = 0
  )

  $application = Get-MediaMonkey
  if (-not $application) { return $false }

  $player = $null
  try {
    $player = $application.Player
    switch ($Command) {
      'play' { [void]$player.Play() }
      'pause' { [void]$player.Pause() }
      'next' { [void]$player.Next() }
      'previous' { [void]$player.Previous() }
      'stop' { [void]$player.Stop() }
      'seek' { $player.PlaybackTime = [long][math]::Max(0, $PositionMs) }
      default { return $false }
    }
    return $true
  } catch {
    Reset-MediaMonkey
    return $false
  } finally {
    Release-ComReference $player
  }
}

function Write-Response {
  param([Parameter(Mandatory)] $Value)
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }

  $request = $null
  try {
    $request = $line | ConvertFrom-Json

    if ($request.command -eq 'status') {
      $status = Get-MediaMonkeyStatus
      if (-not $status) {
        Write-Response ([pscustomobject]@{
          requestId = $request.requestId
          ok = $false
          error = 'media_not_found'
        })
        continue
      }

      $status | Add-Member -NotePropertyName requestId -NotePropertyValue $request.requestId
      $status | Add-Member -NotePropertyName ok -NotePropertyValue $true
      Write-Response $status
      continue
    }

    Write-Response ([pscustomobject]@{
      requestId = $request.requestId
      ok = [bool](Send-MediaMonkeyCommand -Command ([string]$request.command) -PositionMs ([long]$request.positionMs))
    })
  } catch {
    Write-Response ([pscustomobject]@{
      requestId = if ($request) { $request.requestId } else { $null }
      ok = $false
      error = $_.Exception.Message
    })
  }
}

Reset-MediaMonkey
