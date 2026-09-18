# JRiver Media Center automation support for the DeskThing audio app.
# This attaches to an already running JRiver process and never enables a
# network service or starts a second JRiver instance.

if (-not ('DeskThingJRiverDispatch' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DeskThingJRiverDispatch
{
    [ComImport]
    [Guid("00020400-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDispatch
    {
        [PreserveSig] int GetTypeInfoCount(out uint count);
        [PreserveSig] int GetTypeInfo(
            uint index,
            int localeId,
            out System.Runtime.InteropServices.ComTypes.ITypeInfo typeInfo);
        [PreserveSig] int GetIDsOfNames(
            ref Guid interfaceId,
            [MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.LPWStr)] string[] names,
            uint nameCount,
            int localeId,
            [Out] int[] dispatchIds);
        [PreserveSig] int Invoke(
            int dispatchId,
            ref Guid interfaceId,
            int localeId,
            short flags,
            ref System.Runtime.InteropServices.ComTypes.DISPPARAMS parameters,
            IntPtr result,
            IntPtr exceptionInfo,
            IntPtr argumentError);
    }

    [DllImport("oleaut32.dll")]
    private static extern int VariantClear(IntPtr variant);

    public static object Get(object target, int dispatchId)
    {
        var dispatch = (IDispatch)target;
        var parameters = new System.Runtime.InteropServices.ComTypes.DISPPARAMS();
        var interfaceId = Guid.Empty;
        var result = Marshal.AllocCoTaskMem(16);
        try
        {
            for (var index = 0; index < 16; index++) Marshal.WriteByte(result, index, 0);
            var status = dispatch.Invoke(
                dispatchId,
                ref interfaceId,
                0,
                2,
                ref parameters,
                result,
                IntPtr.Zero,
                IntPtr.Zero);
            if (status != 0) Marshal.ThrowExceptionForHR(status);
            return Marshal.GetObjectForNativeVariant(result);
        }
        finally
        {
            VariantClear(result);
            Marshal.FreeCoTaskMem(result);
        }
    }
}
'@
}
$script:DeskThingJRiverApplication = $null
$script:DeskThingJRiverLastConnectionAttempt = 0L

function Release-DeskThingJRiverComReference {
  param($Value)
  if ($Value -and [Runtime.InteropServices.Marshal]::IsComObject($Value)) {
    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($Value) } catch { }
  }
}

function Reset-DeskThingJRiverAutomation {
  Release-DeskThingJRiverComReference $script:DeskThingJRiverApplication
  $script:DeskThingJRiverApplication = $null
}

function Connect-DeskThingJRiverAutomation {
  if ($script:DeskThingJRiverApplication) { return $true }

  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($now - $script:DeskThingJRiverLastConnectionAttempt -lt 1000) {
    return $false
  }
  $script:DeskThingJRiverLastConnectionAttempt = $now

  try {
    $script:DeskThingJRiverApplication =
      [Runtime.InteropServices.Marshal]::GetActiveObject('MediaJukebox Application')
    return $true
  } catch {
    return $false
  }
}

function Get-DeskThingJRiverStatus {
  if (-not (Connect-DeskThingJRiverAutomation)) { return $null }

  $zones = $null
  $zone = $null
  $file = $null
  $playback = $null
  try {
    $zones = $script:DeskThingJRiverApplication.GetZones()
    $zoneIndex = [int]$zones.GetActiveZone()
    $zone = $zones.GetZone($zoneIndex)
    $file = $zone.GetPlayingFile()
    $playback = $zone.GetPlayback()
    if (-not $file -or -not $playback) { return $null }

    # These legacy VAR_DISPATCH members are null through PowerShell's normal
    # COM adapter, so read their dispatch IDs directly.
    $state = [int][DeskThingJRiverDispatch]::Get($playback, 1)
    $position = [double][DeskThingJRiverDispatch]::Get($playback, 3)
    $duration = [double][DeskThingJRiverDispatch]::Get($playback, 4)

    $title = [string]$file.Get('Name', $false)
    if (-not $title) {
      $filename = [string]$file.Get('Filename', $false)
      if ($filename) { $title = [IO.Path]::GetFileNameWithoutExtension($filename) }
    }
    $artist = [string]$file.Get('Artist', $false)
    if (-not $artist) { $artist = [string]$file.Get('Album Artist', $false) }

    return [pscustomobject]@{
      fileId = [long]$file.GetKey()
      title = $title
      artist = $artist
      album = [string]$file.Get('Album', $false)
      positionMs = [long][math]::Max(0, [math]::Round($position * 1000))
      durationMs = [long][math]::Max(0, [math]::Round($duration * 1000))
      state = $state
      isPlaying = ($state -eq 2)
      isPaused = ($state -eq 1)
      activeZone = $zoneIndex
    }
  } catch {
    Reset-DeskThingJRiverAutomation
    return $null
  } finally {
    Release-DeskThingJRiverComReference $playback
    Release-DeskThingJRiverComReference $file
    Release-DeskThingJRiverComReference $zone
    Release-DeskThingJRiverComReference $zones
  }
}

function Invoke-DeskThingJRiverCommand {
  param(
    [Parameter(Mandatory)]
    [ValidateSet('play', 'pause', 'stop', 'next', 'previous')]
    [string] $Command
  )

  if (-not (Connect-DeskThingJRiverAutomation)) { return $false }

  $zones = $null
  $zone = $null
  $playback = $null
  try {
    $zones = $script:DeskThingJRiverApplication.GetZones()
    $zone = $zones.GetZone([int]$zones.GetActiveZone())
    $playback = $zone.GetPlayback()
    if (-not $playback) { return $false }

    switch ($Command) {
      'play' {
        $state = [int][DeskThingJRiverDispatch]::Get($playback, 1)
        # JRiver Play() restarts the file. Pause() toggles pause/resume.
        if ($state -eq 1) { $playback.Pause() } else { $playback.Play() }
      }
      'pause' { $playback.Pause() }
      'stop' { $playback.Stop() }
      'next' { $playback.Next() }
      'previous' { $playback.Previous() }
    }
    return $true
  } catch {
    Reset-DeskThingJRiverAutomation
    return $false
  } finally {
    Release-DeskThingJRiverComReference $playback
    Release-DeskThingJRiverComReference $zone
    Release-DeskThingJRiverComReference $zones
  }
}
