$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

. (Join-Path $PSScriptRoot 'jriverAutomationBridge.ps1')

function Write-DeskThingJRiverResponse {
  param($Value)
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
}

while (($line = [Console]::In.ReadLine()) -ne $null) {
  $request = $null
  try {
    $request = $line | ConvertFrom-Json
    if ($request.command -eq 'status') {
      $status = Get-DeskThingJRiverStatus
      if (-not $status) {
        Write-DeskThingJRiverResponse ([pscustomobject]@{
          requestId = $request.requestId
          ok = $false
          error = 'jriver_not_available'
        })
        continue
      }

      $status | Add-Member -NotePropertyName requestId -NotePropertyValue $request.requestId
      $status | Add-Member -NotePropertyName ok -NotePropertyValue $true
      Write-DeskThingJRiverResponse $status
      continue
    }

    if ($request.command -in @('play', 'pause', 'stop', 'next', 'previous')) {
      Write-DeskThingJRiverResponse ([pscustomobject]@{
        requestId = $request.requestId
        ok = [bool](Invoke-DeskThingJRiverCommand -Command ([string]$request.command))
      })
      continue
    }

    Write-DeskThingJRiverResponse ([pscustomobject]@{
      requestId = $request.requestId
      ok = $false
      error = 'unknown_command'
    })
  } catch {
    Write-DeskThingJRiverResponse ([pscustomobject]@{
      requestId = if ($request) { $request.requestId } else { $null }
      ok = $false
      error = $_.Exception.Message
    })
  }
}

Reset-DeskThingJRiverAutomation
