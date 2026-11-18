using System.Text.RegularExpressions;

namespace PopuConnect.Core;

public record BluetoothKeyboard(string Id, string Name)
{
    public override string ToString() => $"{Name} · {Id}";
}
public record MidiDestination(string Id, string Name, string InstanceId, string TransportCode, int GroupIndex)
{
    public ConnectionType Type { get; init; }
    public string WindowsOutputId { get; init; } = "";
}
public record DeviceSnapshot(bool BluetoothConnected, IReadOnlyList<MidiDestination> Destinations);

public interface IDeviceDiscovery
{
    Task<IReadOnlyList<BluetoothKeyboard>> DiscoverAsync(CancellationToken token);
    Task<DeviceSnapshot> InspectAsync(string bluetoothId, CancellationToken token);
    Task<IReadOnlyList<MidiDestination>> GetDestinationsAsync(CancellationToken token);
}

public static partial class EndpointSelection
{
    public static string NormalizeBluetoothId(string value)
    {
        var compact = value.Trim().Replace(":", "").Replace("-", "");
        if (!MacPattern().IsMatch(compact)) throw new ArgumentException("Use the 12-digit hexadecimal Bluetooth ID from midi bluetooth list.");
        return compact.ToUpperInvariant();
    }
    [GeneratedRegex("^[0-9a-fA-F]{12}$")]
    private static partial Regex MacPattern();

    public static MidiDestination? Resolve(string bluetoothId, string preferred, IReadOnlyList<MidiDestination> endpoints)
    {
        var address = NormalizeBluetoothId(bluetoothId);
        // Match the transport's device identity, never the friendly name or a cached endpoint alone.
        var matches = endpoints.Where(e => e.TransportCode.Equals("BLEMIDI", StringComparison.OrdinalIgnoreCase)
            && e.InstanceId.Replace(":", "").Replace("-", "").EndsWith("_" + address, StringComparison.OrdinalIgnoreCase)
            && e.GroupIndex == 0).ToArray();
        var exact = matches.FirstOrDefault(e => e.Id.Equals(preferred, StringComparison.OrdinalIgnoreCase));
        if (exact != null) return exact;
        return matches.Length switch
        {
            0 => null,
            1 => matches[0],
            _ => throw new InvalidOperationException("This device has multiple MIDI output endpoints. Specify the exact ID in Diagnostics.")
        };
    }
}

public interface INativeMidi
{
    Task<IReadOnlyList<MidiDestination>> GetUsbOutputsAsync(CancellationToken token);
    Task<IReadOnlyList<MidiDestination>> GetBluetoothOutputsAsync(CancellationToken token);
    Task OpenBluetoothOutputAsync(string outputId, CancellationToken token);
    void ReleaseBluetoothOutput(string? keepOutputId = null);
    Task SendAsync(string outputId, IEnumerable<byte[]> messages, CancellationToken token, bool keepBluetoothOpen = false);
}

public sealed class ConnectionController(IMidiCli? cli, IDeviceDiscovery discovery, Settings settings, Action save, INativeMidi? nativeMidi = null)
{
    public const string BluetoothToolsRequired = "This connection requires Windows MIDI Services Tools with midi.exe and the Bluetooth LE MIDI transport.";
    private IMidiCli BluetoothCli => cli ?? throw new InvalidOperationException(BluetoothToolsRequired);
    private readonly SemaphoreSlim operations = new(1, 1);
    private bool wasConnected;
    private bool automaticAttempted;
    private string observedDevice = "";
    public bool Ready { get; private set; }
    public MidiDestination? Endpoint { get; private set; }
    public event Action<string>? LightingActivity;
    public event Action<MidiDestination, IReadOnlyList<byte[]>>? SendingTo;
    public MidiDevice? Device { get; set; } = settings.BluetoothDeviceId.Length > 0
        ? new(settings.DeviceName, ConnectionType.Bluetooth, BluetoothDeviceId: settings.BluetoothDeviceId) : null;

    public async Task CheckEnvironmentAsync(CancellationToken token, bool includeBluetooth = true)
    {
        if (cli == null)
        {
            if (includeBluetooth) throw new InvalidOperationException(BluetoothToolsRequired);
            return;
        }
        if (!includeBluetooth)
        {
            await cli.RunAsync(token, "sysex", "send-file", "--help");
            await cli.RunAsync(token, "service", "status");
            return;
        }
        foreach (var command in new[] { new[] { "bluetooth", "connect", "--help" }, new[] { "sysex", "send-file", "--help" } })
            await cli.RunAsync(token, command);
        var help = await cli.RunAsync(token, "bluetooth", "customize", "--help");
        if (!help.Contains("--keep-when-offline", StringComparison.Ordinal))
            throw new InvalidOperationException("The MIDI CLI does not support keeping endpoints offline. Update Windows MIDI Services Tools.");
        await cli.RunAsync(token, "bluetooth", "status");
        await cli.RunAsync(token, "service", "status");
        await cli.RunAsync(token, "bluetooth", "list");
    }

    public async Task ConnectAsync(CancellationToken token)
    {
        await operations.WaitAsync(token);
        try
        {
            Ready = false;
            if (Device is { IsWindowsBluetooth: true } device)
            {
                var native = nativeMidi ?? throw new InvalidOperationException("Windows Bluetooth MIDI outputs are unavailable.");
                var outputs = await native.GetBluetoothOutputsAsync(token);
                var selected = DeviceSelection.ResolveWindowsBluetooth(device, outputs);
                native.ReleaseBluetoothOutput(selected?.WindowsOutputId);
                var output = selected
                    ?? throw new InvalidOperationException("The selected Bluetooth MIDI output is unavailable. Check pairing in Windows and refresh the device list.");
                await native.OpenBluetoothOutputAsync(output.WindowsOutputId, token);
                return;
            }
            nativeMidi?.ReleaseBluetoothOutput();
            if (Device?.Type == ConnectionType.Usb)
            {
                var endpoints = await GetUsbDestinationsAsync(token);
                if (DeviceSelection.ResolveUsb(Device, endpoints) == null)
                    throw new InvalidOperationException("The USB MIDI endpoint is unavailable. Connect the USB cable and refresh the device list.");
                return;
            }
            var bluetoothCli = BluetoothCli;
            var id = EndpointSelection.NormalizeBluetoothId(settings.BluetoothDeviceId);
            var snapshot = await discovery.InspectAsync(id, token);
            var endpoint = EndpointSelection.Resolve(id, settings.MidiEndpointId, snapshot.Destinations);
            if (!snapshot.BluetoothConnected || endpoint == null)
                await bluetoothCli.RunAsync(token, "bluetooth", "connect", id);
            if (!settings.RetentionConfiguredFor.Equals(id, StringComparison.OrdinalIgnoreCase))
            {
                await bluetoothCli.RunAsync(token, "bluetooth", "customize", id, "--keep-when-offline", "always");
                settings.RetentionConfiguredFor = id; save();
            }
            // A successful CLI request is not evidence that the radio link is already up.
            for (var i = 0; i < 20; i++)
            {
                snapshot = await discovery.InspectAsync(id, token);
                endpoint = EndpointSelection.Resolve(id, settings.MidiEndpointId, snapshot.Destinations);
                if (snapshot.BluetoothConnected && endpoint != null) return;
                await Task.Delay(500, token);
            }
            if (!snapshot.BluetoothConnected) throw new InvalidOperationException("PopuPiano is disconnected from Bluetooth. Turn on the keyboard and try again.");
            throw new InvalidOperationException("Bluetooth is connected. The group 1 MIDI output endpoint is missing. Check Windows MIDI Services and refresh the device list.");
        }
        finally { operations.Release(); }
    }

    public async Task<bool> PollAsync(CancellationToken token)
    {
        await operations.WaitAsync(token);
        try
        {
            Ready = false;
            if (observedDevice != Device?.Key)
            {
                observedDevice = Device?.Key ?? ""; wasConnected = false; automaticAttempted = false;
            }
            if (Device == null)
            {
                Endpoint = null;
                nativeMidi?.ReleaseBluetoothOutput();
                return false;
            }
            var snapshot = await InspectCurrentAsync(token);
            Endpoint = ResolveCurrent(snapshot.Destinations);
            Ready = snapshot.BluetoothConnected && Endpoint != null;
            if (!snapshot.BluetoothConnected) { wasConnected = false; automaticAttempted = false; }
            if (Ready)
            {
                wasConnected = true;
                SaveEndpoint();
                if (settings.AutoLightsOff && !automaticAttempted)
                {
                    automaticAttempted = true; // Retry only on a new connection or explicit user action.
                    await SendCoreAsync([PopuPianoLighting.AllOff()], token);
                    return true;
                }
            }
            else if (!wasConnected) automaticAttempted = false;
            return false;
        }
        finally { operations.Release(); }
    }

    public async Task SendAsync(IEnumerable<byte[]> messages, CancellationToken token)
    {
        await operations.WaitAsync(token);
        try { await SendCoreAsync(messages, token); }
        finally { operations.Release(); }
    }

    private async Task SendCoreAsync(IEnumerable<byte[]> messages, CancellationToken token)
    {
        var frames = messages.ToArray();
        foreach (var frame in frames) LightingActivity?.Invoke("SysEx TX requested: " + PopuPianoLighting.Hex(frame));
        try
        {
            await SendFramesAsync(frames, token);
            LightingActivity?.Invoke("SysEx send complete. Check the lights on the keyboard.");
        }
        catch (Exception e)
        {
            LightingActivity?.Invoke("SysEx send could not be confirmed. " + DeviceDiagnosticsReport.ErrorCode(e));
            throw;
        }
    }

    private async Task SendFramesAsync(byte[][] messages, CancellationToken token)
    {
        Ready = false;
        var snapshot = await InspectCurrentAsync(token);
        if (!snapshot.BluetoothConnected) throw new InvalidOperationException("The keyboard is disconnected. The lighting command was not sent.");
        Endpoint = ResolveCurrent(snapshot.Destinations)
            ?? throw new InvalidOperationException("No PopuPiano MIDI output endpoint found. Refresh the device list.");
        SaveEndpoint();
        SendingTo?.Invoke(Endpoint, messages);
        if (cli == null || Device?.IsWindowsBluetooth == true)
        {
            if (nativeMidi == null || Endpoint.WindowsOutputId.Length == 0)
                throw new InvalidOperationException("The Windows MIDI output port is unavailable.");
            await nativeMidi.SendAsync(Endpoint.WindowsOutputId, messages, token, keepBluetoothOpen: Device?.IsWindowsBluetooth == true);
        }
        else await SendFileAsync(cli, Endpoint.Id, messages, token);
        var after = await InspectCurrentAsync(token);
        if (!after.BluetoothConnected || ResolveCurrent(after.Destinations)?.Id != Endpoint.Id)
        { Ready = false; throw new InvalidOperationException("Connection lost during transmission. Device receipt could not be confirmed."); }
        Ready = true;
    }

    private static async Task SendFileAsync(IMidiCli cli, string endpointId, IEnumerable<byte[]> messages, CancellationToken token)
    {
        var file = Path.Combine(Path.GetTempPath(), $"PopuConnect-{Guid.NewGuid():N}.syx");
        try
        {
            await File.WriteAllBytesAsync(file, messages.SelectMany(m => m).ToArray(), token);
            await cli.RunAsync(token, "sysex", "send-file", file, endpointId);
        }
        finally { if (File.Exists(file)) File.Delete(file); }
    }

    private async Task<DeviceSnapshot> InspectCurrentAsync(CancellationToken token)
    {
        if (Device is { IsWindowsBluetooth: true } bluetooth)
        {
            if (nativeMidi == null) return new(false, []);
            var outputs = await nativeMidi.GetBluetoothOutputsAsync(token);
            var selected = DeviceSelection.ResolveWindowsBluetooth(bluetooth, outputs);
            nativeMidi.ReleaseBluetoothOutput(selected?.WindowsOutputId);
            return new(selected != null, outputs);
        }
        nativeMidi?.ReleaseBluetoothOutput();
        if (Device?.Type != ConnectionType.Usb)
            return await discovery.InspectAsync(settings.BluetoothDeviceId, token);
        var endpoints = await GetUsbDestinationsAsync(token);
        return new(DeviceSelection.ResolveUsb(Device, endpoints) != null, endpoints);
    }
    public Task<IReadOnlyList<MidiDestination>> GetUsbDestinationsAsync(CancellationToken token) =>
        cli == null && nativeMidi != null ? nativeMidi.GetUsbOutputsAsync(token) : discovery.GetDestinationsAsync(token);
    private MidiDestination? ResolveCurrent(IReadOnlyList<MidiDestination> endpoints) => Device switch
    {
        { Type: ConnectionType.Usb } usb => DeviceSelection.ResolveUsb(usb, endpoints),
        { IsWindowsBluetooth: true } bluetooth => DeviceSelection.ResolveWindowsBluetooth(bluetooth, endpoints),
        null => null,
        _ => EndpointSelection.Resolve(settings.BluetoothDeviceId, settings.MidiEndpointId, endpoints)
    };

    private void SaveEndpoint()
    {
        if (Endpoint == null || Device?.IsWindowsBluetooth == true) return;
        if (Device?.Type == ConnectionType.Usb)
        {
            if (settings.UsbEndpointId == Endpoint.Id && settings.UsbDeviceInstanceId == Endpoint.InstanceId) return;
            settings.UsbEndpointId = Endpoint.Id; settings.UsbDeviceInstanceId = Endpoint.InstanceId; settings.UsbDeviceName = Endpoint.Name;
        }
        else
        {
            if (settings.MidiEndpointId == Endpoint.Id) return;
            settings.MidiEndpointId = Endpoint.Id;
        }
        save();
    }
}
