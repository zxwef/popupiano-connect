using Microsoft.Win32;

namespace PopuConnect;

internal static class MidiCliLocation
{
    public static string? Find()
    {
        // 64-bit registration written by WindowsMidiServicesConsole.wxs.
        const string key = @"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows MIDI Services\Desktop App SDK Runtime";
        var registered = Registry.GetValue(key, "MidiConsole", null) as string;
        if (registered != null && Path.IsPathFullyQualified(registered) && File.Exists(registered)) return registered;

        var installed = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "Windows MIDI Services", "Tools", "midi.exe");
        if (File.Exists(installed)) return installed;

        foreach (var entry in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            var directory = Environment.ExpandEnvironmentVariables(entry.Trim().Trim('"'));
            if (!Path.IsPathFullyQualified(directory)) continue;
            var candidate = Path.Combine(directory, "midi.exe");
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }
}
