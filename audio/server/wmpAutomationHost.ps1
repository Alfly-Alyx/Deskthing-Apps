$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("00000112-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDeskThingOleObject
{
    [PreserveSig] int SetClientSite([MarshalAs(UnmanagedType.Interface)] IDeskThingOleClientSite clientSite);
}

[ComImport, Guid("00000118-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDeskThingOleClientSite
{
    [PreserveSig] int SaveObject();
    [PreserveSig] int GetMoniker(uint assign, uint which, out IntPtr moniker);
    [PreserveSig] int GetContainer(out IntPtr container);
    [PreserveSig] int ShowObject();
    [PreserveSig] int OnShowWindow([MarshalAs(UnmanagedType.Bool)] bool show);
    [PreserveSig] int RequestNewObjectLayout();
}

[ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDeskThingServiceProvider
{
    [PreserveSig] int QueryService(ref Guid service, ref Guid iid, out IntPtr result);
}

[ComImport, Guid("CBB92747-741F-44FE-AB5B-F1A48F3B2A59"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDeskThingWmpRemoteMediaServices
{
    [PreserveSig] int GetServiceType([MarshalAs(UnmanagedType.BStr)] out string serviceType);
    [PreserveSig] int GetApplicationName([MarshalAs(UnmanagedType.BStr)] out string applicationName);
    [PreserveSig] int GetScriptableObject(
        [MarshalAs(UnmanagedType.BStr)] out string name,
        [MarshalAs(UnmanagedType.IDispatch)] out object dispatch);
    [PreserveSig] int GetCustomUIMode([MarshalAs(UnmanagedType.BStr)] out string file);
}

[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public sealed class DeskThingWmpRemoteSite : IDeskThingOleClientSite, IDeskThingServiceProvider, IDeskThingWmpRemoteMediaServices
{
    private const int S_OK = 0;
    private const int E_NOTIMPL = unchecked((int)0x80004001);
    private const int E_NOINTERFACE = unchecked((int)0x80004002);
    private static readonly Guid RemoteGuid = new Guid("CBB92747-741F-44FE-AB5B-F1A48F3B2A59");

    public int QueryService(ref Guid service, ref Guid iid, out IntPtr result)
    {
        if (iid == RemoteGuid)
        {
            result = Marshal.GetComInterfaceForObject(this, typeof(IDeskThingWmpRemoteMediaServices));
            return S_OK;
        }
        result = IntPtr.Zero;
        return E_NOINTERFACE;
    }

    public int GetServiceType(out string serviceType) { serviceType = "Remote"; return S_OK; }
    public int GetApplicationName(out string name) { name = "DeskThing"; return S_OK; }
    public int GetScriptableObject(out string name, out object dispatch)
    {
        name = null;
        dispatch = null;
        return E_NOTIMPL;
    }
    public int GetCustomUIMode(out string file) { file = null; return E_NOTIMPL; }
    public int SaveObject() { return E_NOTIMPL; }
    public int GetMoniker(uint assign, uint which, out IntPtr moniker)
    {
        moniker = IntPtr.Zero;
        return E_NOTIMPL;
    }
    public int GetContainer(out IntPtr container)
    {
        container = IntPtr.Zero;
        return E_NOINTERFACE;
    }
    public int ShowObject() { return S_OK; }
    public int OnShowWindow(bool show) { return S_OK; }
    public int RequestNewObjectLayout() { return E_NOTIMPL; }
}

public sealed class DeskThingWmpRemote : IDisposable
{
    private object player;
    private DeskThingWmpRemoteSite site;

    public object Player { get { return player; } }

    public DeskThingWmpRemote()
    {
        site = new DeskThingWmpRemoteSite();
        var type = Type.GetTypeFromCLSID(
            new Guid("6BF52A52-394A-11D3-B153-00C04F79FAA6"),
            true);
        player = Activator.CreateInstance(type);
        var result = ((IDeskThingOleObject)player).SetClientSite(site);
        if (result < 0) Marshal.ThrowExceptionForHR(result);
    }

    public void Dispose()
    {
        var value = player;
        player = null;
        if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
        GC.KeepAlive(site);
        site = null;
    }
}
'@

$wmpRemote = $null
$wmpRemoteLastAttemptAt = 0L

function Close-WmpRemote {
  if ($script:wmpRemote) {
    try { $script:wmpRemote.Dispose() } catch { }
  }
  $script:wmpRemote = $null
}

function Get-WmpRemote {
  $process = Get-Process -Name 'wmplayer' -ErrorAction SilentlyContinue |
    Sort-Object StartTime |
    Select-Object -First 1
  if (-not $process) {
    Close-WmpRemote
    return $null
  }

  if ($script:wmpRemote) {
    try {
      if ([bool]$script:wmpRemote.Player.isRemote) { return $script:wmpRemote }
    } catch { }
    Close-WmpRemote
  }

  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if (($now - $script:wmpRemoteLastAttemptAt) -lt 1000) { return $null }
  $script:wmpRemoteLastAttemptAt = $now

  try {
    $candidate = [DeskThingWmpRemote]::new()
    Start-Sleep -Milliseconds 40
    if (-not [bool]$candidate.Player.isRemote) {
      $candidate.Dispose()
      return $null
    }
    $script:wmpRemote = $candidate
    return $script:wmpRemote
  } catch {
    Close-WmpRemote
    return $null
  }
}

function Get-WmpStatus {
  $remote = Get-WmpRemote
  if (-not $remote) { return $null }

  try {
    $player = $remote.Player
    $media = $player.currentMedia
    if (-not $media) { return $null }

    $title = [string]$media.name
    if (-not $title) { $title = [string]$media.getItemInfo('Title') }
    if (-not $title) { return $null }

    $artist = [string]$media.getItemInfo('Artist')
    if (-not $artist) { $artist = [string]$media.getItemInfo('Author') }
    $album = [string]$media.getItemInfo('Album')
    $durationMs = [math]::Max(0, [double]$media.duration * 1000)
    $positionMs = [math]::Max(0, [double]$player.controls.currentPosition * 1000)
    $playState = [int]$player.playState

    [pscustomobject]@{
      id = if ([string]$media.sourceURL) { [string]$media.sourceURL } else { $title }
      title = $title
      artist = $artist
      album = $album
      durationMs = [long]$durationMs
      positionMs = [long][math]::Min($positionMs, $durationMs)
      isPlaying = $playState -eq 3
      isPaused = $playState -eq 2
    }
  } catch {
    Close-WmpRemote
    return $null
  }
}

function Send-WmpCommand {
  param(
    [Parameter(Mandatory)] [string] $Command,
    [long] $PositionMs = 0
  )

  $remote = Get-WmpRemote
  if (-not $remote) { return $false }

  try {
    $controls = $remote.Player.controls
    switch ($Command) {
      'play' { $controls.play() }
      'pause' { $controls.pause() }
      'next' { $controls.next() }
      'previous' { $controls.previous() }
      'stop' { $controls.stop() }
      'seek' { $controls.currentPosition = [math]::Max(0, $PositionMs) / 1000 }
      default { return $false }
    }
    return $true
  } catch {
    Close-WmpRemote
    return $false
  }
}

function Write-BridgeResponse {
  param([System.Collections.IDictionary] $Response)
  [Console]::Out.WriteLine(($Response | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
}

while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }

  try {
    $request = $line | ConvertFrom-Json
    $requestId = [int]$request.requestId

    if ([string]$request.command -eq 'status') {
      $status = Get-WmpStatus
      if (-not $status) {
        Write-BridgeResponse ([ordered]@{
          requestId = $requestId
          ok = $false
          error = 'wmp_media_not_found'
        })
        continue
      }

      Write-BridgeResponse ([ordered]@{
        requestId = $requestId
        ok = $true
        id = $status.id
        title = $status.title
        artist = $status.artist
        album = $status.album
        durationMs = $status.durationMs
        positionMs = $status.positionMs
        isPlaying = $status.isPlaying
        isPaused = $status.isPaused
      })
      continue
    }

    $positionMs = if ($null -ne $request.positionMs) { [long]$request.positionMs } else { 0L }
    Write-BridgeResponse ([ordered]@{
      requestId = $requestId
      ok = [bool](Send-WmpCommand -Command ([string]$request.command) -PositionMs $positionMs)
    })
  } catch {
    $failedRequestId = if ($request -and $null -ne $request.requestId) { [int]$request.requestId } else { 0 }
    Write-BridgeResponse ([ordered]@{
      requestId = $failedRequestId
      ok = $false
      error = $_.Exception.Message
    })
  }
}

Close-WmpRemote
