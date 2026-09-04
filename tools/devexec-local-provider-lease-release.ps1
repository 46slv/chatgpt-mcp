[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('identity', 'release')]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [string]$LeasePath,

    [string]$ExpectedVolumeSerial,
    [string]$ExpectedFileIndex,

    # Auditor-only race seam.  It is inert unless both private paths are
    # supplied, and is deliberately reached only after CreateFile succeeds.
    [string]$TestReadyPath,
    [string]$TestContinuePath
)

# Private, one-shot helper for local-provider-lease.mjs.  It prints only a
# bounded protocol token; callers must not publish arguments, stderr, or the
# token.  In particular, it never resolves a second pathname after a handle
# has been opened.  Failure is intentionally indistinguishable to callers.
$ErrorActionPreference = 'Stop'

try {
    if ($Mode -eq 'release' -and (([string]::IsNullOrWhiteSpace($ExpectedVolumeSerial)) -or ([string]::IsNullOrWhiteSpace($ExpectedFileIndex)))) {
        throw 'missing expected file identity'
    }
    if (($TestReadyPath -and -not $TestContinuePath) -or ($TestContinuePath -and -not $TestReadyPath)) { throw 'invalid test gate' }

    if (-not ('DevExecLeaseNative' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class DevExecLeaseNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct BY_HANDLE_FILE_INFORMATION {
    public uint FileAttributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct FILE_DISPOSITION_INFO {
    [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile;
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern SafeFileHandle CreateFile(
    string name, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
    uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetFileInformationByHandle(
    SafeFileHandle file, out BY_HANDLE_FILE_INFORMATION information);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SetFileInformationByHandle(
    SafeFileHandle file, int fileInformationClass, ref FILE_DISPOSITION_INFO information,
    uint bufferSize);
}
'@
    }

    # DELETE plus FILE_READ_ATTRIBUTES lets the exact opened handle be both
    # identified and marked for deletion.  OPEN_REPARSE_POINT prevents an
    # attacker-controlled reparse target from becoming the opened object.
    $DELETE = [uint32]0x00010000
    $FILE_READ_ATTRIBUTES = [uint32]0x00000080
    $FILE_SHARE_READ = [uint32]0x00000001
    $FILE_SHARE_WRITE = [uint32]0x00000002
    $FILE_SHARE_DELETE = [uint32]0x00000004
    $OPEN_EXISTING = [uint32]3
    $FILE_FLAG_OPEN_REPARSE_POINT = [uint32]0x00200000
    $desiredAccess = if ($Mode -eq 'release') { $DELETE -bor $FILE_READ_ATTRIBUTES } else { $FILE_READ_ATTRIBUTES }
    $handle = [DevExecLeaseNative]::CreateFile(
        $LeasePath,
        $desiredAccess,
        ($FILE_SHARE_READ -bor $FILE_SHARE_WRITE -bor $FILE_SHARE_DELETE),
        [IntPtr]::Zero,
        $OPEN_EXISTING,
        $FILE_FLAG_OPEN_REPARSE_POINT,
        [IntPtr]::Zero)
    try {
        if ($null -eq $handle -or $handle.IsInvalid) { throw 'open failed' }
        $info = New-Object DevExecLeaseNative+BY_HANDLE_FILE_INFORMATION
        if (-not [DevExecLeaseNative]::GetFileInformationByHandle($handle, [ref]$info)) { throw 'identity failed' }
        $volume = ('{0:X8}' -f $info.VolumeSerialNumber)
        $index = ('{0:X8}{1:X8}' -f $info.FileIndexHigh, $info.FileIndexLow)
        if ($Mode -eq 'identity') {
            [Console]::Write("IDENTITY $volume $index")
            exit 0
        }
        if ($volume -cne $ExpectedVolumeSerial.ToUpperInvariant() -or $index -cne $ExpectedFileIndex.ToUpperInvariant()) { throw 'identity mismatch' }
        if ($TestReadyPath) {
            $ready = [System.IO.File]::Open($TestReadyPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
            $ready.Dispose()
            $clock = [Diagnostics.Stopwatch]::StartNew()
            while (-not [System.IO.File]::Exists($TestContinuePath)) {
                if ($clock.ElapsedMilliseconds -ge 5000) { throw 'test gate timeout' }
                Start-Sleep -Milliseconds 10
            }
        }
        $disposition = New-Object DevExecLeaseNative+FILE_DISPOSITION_INFO
        $disposition.DeleteFile = $true
        # FileDispositionInfo is handle-bound.  CloseHandle below is the only
        # deletion transition; this helper never calls DeleteFile(path).
        if (-not [DevExecLeaseNative]::SetFileInformationByHandle($handle, 4, [ref]$disposition, [uint32][Runtime.InteropServices.Marshal]::SizeOf([type][DevExecLeaseNative+FILE_DISPOSITION_INFO]))) { throw 'disposition failed' }
    } finally {
        if ($null -ne $handle) { $handle.Dispose() }
    }
    [Console]::Write('RELEASED')
    exit 0
} catch {
    [Console]::Write('NEEDS_ATTENTION')
    exit 1
}
