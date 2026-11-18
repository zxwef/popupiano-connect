using System.ComponentModel;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace PopuConnect.Core;

// Diagnostic fields are constructed by the probes. Never append raw CLI output,
// exception messages, friendly names or device paths to the export.
public sealed partial class DeviceDiagnosticsReport
{
    private readonly byte[] key = RandomNumberGenerator.GetBytes(32);
    private readonly Queue<string> events = new();
    public string Snapshot { get; set; } = "No device snapshot has been collected.";
    public string? UsbSysExCapture { get; set; }

    public string Id(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return "—";
        var hash = HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(value.ToUpperInvariant()));
        return "#" + Convert.ToHexString(hash, 0, 6);
    }

    public string Name(string value) => value.Contains("PopuPiano", StringComparison.OrdinalIgnoreCase)
        ? "PopuPiano" : "device " + Id(value);

    [GeneratedRegex(@"(?:VID_[0-9A-F]{4}&PID_[0-9A-F]{4}(?:&REV_[0-9A-F]{4})?(?:&MI_[0-9A-F]{2})?|CLASS_[0-9A-F]{2}(?:&SUBCLASS_[0-9A-F]{2})?(?:&PROT_[0-9A-F]{2})?)", RegexOptions.IgnoreCase)]
    private static partial Regex UsbFields();
    public static string UsbCodes(IEnumerable<string> ids) => string.Join(", ", ids.SelectMany(id => UsbFields().Matches(id).Select(m => m.Value.ToUpperInvariant())).Distinct());

    public void Record(string entry)
    {
        if (events.Count >= 100) events.Dequeue();
        events.Enqueue($"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz}  {entry}");
    }
    public static string ErrorCode(Exception ex)
    {
        var code = $"{ex.GetType().Name} HRESULT=0x{ex.HResult:X8}";
        if (ex is Win32Exception win) code += $" Win32={win.NativeErrorCode}";
        if (ex.Data["ExitCode"] is int exit) code += $" exit={exit}";
        return ex.InnerException == null ? code : code + " / " + ErrorCode(ex.InnerException);
    }
    public string Render() => Snapshot + Environment.NewLine + Environment.NewLine +
        (UsbSysExCapture == null ? "" : UsbSysExCapture + Environment.NewLine + Environment.NewLine) +
        "Session events (last 100)" + Environment.NewLine + string.Join(Environment.NewLine, events);
    public Task ExportAsync(string path, CancellationToken token) => File.WriteAllTextAsync(path, Render(), new UTF8Encoding(true), token);
}

