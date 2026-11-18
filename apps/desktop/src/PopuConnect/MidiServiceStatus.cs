using System.Runtime.InteropServices;

namespace PopuConnect;

internal static class MidiServiceStatus
{
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenSCManagerW(string? machine, string? database, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenServiceW(IntPtr manager, string name, uint access);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool QueryServiceStatus(IntPtr service, out ServiceStatus status);
    [DllImport("advapi32.dll")] private static extern bool CloseServiceHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatus { public uint Type, State, Accepted, ExitCode, SpecificExit, Checkpoint, WaitHint; }

    internal static string Query()
    {
        var manager = OpenSCManagerW(null, null, 1);
        if (manager == IntPtr.Zero) return $"SCM Win32={Marshal.GetLastWin32Error()}";
        try
        {
            var service = OpenServiceW(manager, "MidiSrv", 4);
            if (service == IntPtr.Zero)
            {
                var error = Marshal.GetLastWin32Error();
                return error == 1060 ? "MidiSrv is not registered (Win32=1060)" : $"OpenService Win32={error}";
            }
            try
            {
                if (!QueryServiceStatus(service, out var s)) return $"QueryServiceStatus Win32={Marshal.GetLastWin32Error()}";
                var name = s.State switch { 1 => "Stopped", 2 => "StartPending", 3 => "StopPending", 4 => "Running", 5 => "ContinuePending", 6 => "PausePending", 7 => "Paused", _ => "Unknown" };
                return $"MidiSrv {name} ({s.State}), exit={s.ExitCode}, serviceExit={s.SpecificExit}";
            }
            finally { CloseServiceHandle(service); }
        }
        finally { CloseServiceHandle(manager); }
    }
}

