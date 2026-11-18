using System.Text.RegularExpressions;

namespace PopuConnect.Core;

public enum ConnectionType { Unknown, Bluetooth, Usb }
public enum ConnectionPreference { Automatic, Bluetooth, Usb }

public static class TransportIdentity
{
    public static ConnectionType Classify(string transportCode, string driverInterfaceId, int usbVendorId)
    {
        if (transportCode.Equals("BLEMIDI", StringComparison.OrdinalIgnoreCase)) return ConnectionType.Bluetooth;
        if ((transportCode.Equals("KS", StringComparison.OrdinalIgnoreCase) || transportCode.Equals("KSA", StringComparison.OrdinalIgnoreCase) || transportCode.Equals("USB", StringComparison.OrdinalIgnoreCase))
            && (usbVendorId > 0 || driverInterfaceId.StartsWith(@"\\?\usb#", StringComparison.OrdinalIgnoreCase))) return ConnectionType.Usb;
        return ConnectionType.Unknown;
    }
}

public record MidiDevice(string Name, ConnectionType Type, string BluetoothDeviceId = "", string MidiEndpointId = "", string InstanceId = "", bool Available = true, bool SupportsOutput = true, bool IsWindowsBluetooth = false)
{
    public string Key => Type == ConnectionType.Usb ? "USB:" + MidiEndpointId : IsWindowsBluetooth ? "WINBT:" + MidiEndpointId : "BT:" + BluetoothDeviceId;
    public override string ToString() => $"{Name} [{(Type == ConnectionType.Usb ? "USB" : IsWindowsBluetooth ? "Bluetooth · Windows" : "Bluetooth")}] · {(Type == ConnectionType.Usb || IsWindowsBluetooth ? MidiEndpointId : BluetoothDeviceId)}{(Available ? SupportsOutput ? "" : " (no group 1 output)" : " (unavailable)")}";
}

public static partial class CliDeviceIds
{
    // Extract invariant identity tokens, without interpreting columns, translated headers or names.
    public static IReadOnlySet<string> Endpoints(string text) => EndpointPattern().Matches(AnsiPattern().Replace(text, ""))
        .Select(m => m.Value).ToHashSet(StringComparer.OrdinalIgnoreCase);
    public static IReadOnlySet<string> Bluetooth(string text) => BluetoothPattern().Matches(AnsiPattern().Replace(text, ""))
        .Select(m => EndpointSelection.NormalizeBluetoothId(m.Value)).ToHashSet(StringComparer.OrdinalIgnoreCase);

    [GeneratedRegex("\u001b\\[[0-?]*[ -/]*[@-~]")]
    private static partial Regex AnsiPattern();
    [GeneratedRegex("""\\\\\?\\[^\r\n"│┃]+?#\{e7cce071-3c03-423f-88d3-f1045d02552b\}""", RegexOptions.IgnoreCase)]
    private static partial Regex EndpointPattern();
    [GeneratedRegex(@"(?<![\w:#\\-])(?:[0-9a-f]{12}|(?:[0-9a-f]{2}:){5}[0-9a-f]{2}|(?:[0-9a-f]{2}-){5}[0-9a-f]{2})(?![\w:#\\-])", RegexOptions.IgnoreCase)]
    private static partial Regex BluetoothPattern();
}

public static class DeviceSelection
{
    public static MidiDestination? ResolveUsb(MidiDevice device, IReadOnlyList<MidiDestination> endpoints) => endpoints.FirstOrDefault(e =>
        e.Type == ConnectionType.Usb && e.GroupIndex == 0 && e.Id.Equals(device.MidiEndpointId, StringComparison.OrdinalIgnoreCase)
        && e.InstanceId.Equals(device.InstanceId, StringComparison.OrdinalIgnoreCase));

    public static MidiDestination? ResolveWindowsBluetooth(MidiDevice device, IReadOnlyList<MidiDestination> endpoints) =>
        endpoints.FirstOrDefault(e => e.Type == ConnectionType.Bluetooth && e.GroupIndex == 0 && e.WindowsOutputId.Length > 0
            && e.Id.Equals(device.MidiEndpointId, StringComparison.OrdinalIgnoreCase)
            && e.InstanceId.Equals(device.InstanceId, StringComparison.OrdinalIgnoreCase));

    public static MidiDevice? Choose(Settings settings, IReadOnlyList<MidiDevice> devices)
    {
        var bluetooth = devices.FirstOrDefault(d => d.IsWindowsBluetooth
            && d.MidiEndpointId.Equals(settings.WindowsBluetoothEndpointId, StringComparison.OrdinalIgnoreCase)
            && d.InstanceId.Equals(settings.WindowsBluetoothInstanceId, StringComparison.OrdinalIgnoreCase))
            ?? devices.FirstOrDefault(d => d.Type == ConnectionType.Bluetooth && !d.IsWindowsBluetooth
                && d.BluetoothDeviceId.Equals(settings.BluetoothDeviceId, StringComparison.OrdinalIgnoreCase));
        var available = devices.Where(d => d.Type == ConnectionType.Usb && d.Available).ToArray();
        var usb = available.FirstOrDefault(d => d.MidiEndpointId.Equals(settings.UsbEndpointId, StringComparison.OrdinalIgnoreCase)
            && (settings.UsbDeviceInstanceId.Length == 0 || d.InstanceId.Equals(settings.UsbDeviceInstanceId, StringComparison.OrdinalIgnoreCase)));
        if (usb == null && settings.UsbDeviceInstanceId.Length > 0)
        {
            var sameInstance = available.Where(d => d.InstanceId.Equals(settings.UsbDeviceInstanceId, StringComparison.OrdinalIgnoreCase)).ToArray();
            if (sameInstance.Length == 1) usb = sameInstance[0];
        }
        if (settings.ConnectionPreference == ConnectionPreference.Bluetooth) return bluetooth;
        if (settings.ConnectionPreference == ConnectionPreference.Usb)
            return usb ?? devices.FirstOrDefault(d => d.Type == ConnectionType.Usb && !d.Available && d.MidiEndpointId.Equals(settings.UsbEndpointId, StringComparison.OrdinalIgnoreCase));
        if (usb?.SupportsOutput == false) usb = null;
        return usb ?? bluetooth;
    }
}

public sealed class MidiDeviceCatalog(IMidiCli? cli, IDeviceDiscovery discovery, Action<string> log, INativeMidi? nativeMidi = null)
{
    private readonly Dictionary<string, string> bluetoothNames = new(StringComparer.OrdinalIgnoreCase);

    public async Task<IReadOnlyList<MidiDevice>> RefreshAsync(bool scanBluetooth, CancellationToken token)
    {
        if (cli == null)
        {
            if (nativeMidi == null) throw new InvalidOperationException("Windows MIDI is unavailable.");
            var usb = await nativeMidi.GetUsbOutputsAsync(token);
            IReadOnlyList<MidiDestination> bluetooth = [];
            try { bluetooth = await nativeMidi.GetBluetoothOutputsAsync(token); }
            catch (Exception e) when (e is not OperationCanceledException) { log("Windows Bluetooth MIDI output discovery: " + e.Message); }
            return usb.Select(e => new MidiDevice(e.Name, ConnectionType.Usb, MidiEndpointId: e.Id, InstanceId: e.InstanceId))
                .Concat(bluetooth.Select(e => new MidiDevice(e.Name, ConnectionType.Bluetooth, MidiEndpointId: e.Id, InstanceId: e.InstanceId, IsWindowsBluetooth: true)))
                .OrderBy(d => d.Type == ConnectionType.Usb ? 0 : 1).ThenBy(d => d.Name).ThenBy(d => d.MidiEndpointId).ToArray();
        }
        var output = await cli.RunAsync(token, "enumerate", "endpoints", "--show-endpoint-id");
        var ids = CliDeviceIds.Endpoints(output);
        var metadata = await discovery.GetDestinationsAsync(token);
        var devices = metadata.Where(e => e.Type == ConnectionType.Usb && ids.Contains(e.Id))
            .OrderBy(e => e.GroupIndex != 0)
            .Select(e => new MidiDevice(e.Name, ConnectionType.Usb, MidiEndpointId: e.Id, InstanceId: e.InstanceId, SupportsOutput: e.GroupIndex == 0))
            .DistinctBy(d => d.Key, StringComparer.OrdinalIgnoreCase).ToList();
        if (metadata.Any(e => e.Type == ConnectionType.Usb && !ids.Contains(e.Id)))
            log("No USB endpoint found in the CLI output. Check the CLI version and the full ID in Diagnostics.");
        IReadOnlySet<string> bluetoothIds;
        try { bluetoothIds = CliDeviceIds.Bluetooth(await cli.RunAsync(token, "bluetooth", "list")); }
        catch (Exception e) when (e is InvalidOperationException or TimeoutException)
        { log("Bluetooth is unavailable. USB remains available. " + e.Message); return devices; }
        if (scanBluetooth)
        {
            try { foreach (var d in await discovery.DiscoverAsync(token)) bluetoothNames[d.Id] = d.Name; }
            catch (Exception e) when (e is not OperationCanceledException) { log("Additional Bluetooth discovery: " + e.Message); }
        }
        foreach (var id in bluetoothIds)
        {
            MidiDestination? endpoint = null;
            try { endpoint = EndpointSelection.Resolve(id, "", metadata); }
            catch (InvalidOperationException e) { log(e.Message); }
            var name = bluetoothNames.GetValueOrDefault(id, endpoint?.Name ?? "Bluetooth MIDI");
            devices.Add(new(name, ConnectionType.Bluetooth, BluetoothDeviceId: id, MidiEndpointId: endpoint?.Id ?? ""));
        }
        return devices.OrderBy(d => d.Type == ConnectionType.Usb ? 0 : 1).ThenBy(d => d.Name).ToArray();
    }
}
