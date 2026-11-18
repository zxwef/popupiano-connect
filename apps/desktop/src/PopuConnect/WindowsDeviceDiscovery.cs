using System.Globalization;
using PopuConnect.Core;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.Advertisement;
using Windows.Devices.Enumeration;

namespace PopuConnect;

internal sealed class BluetoothDiscoveryException(string message) : InvalidOperationException(message);

// Uses Windows metadata and radio status only. The MIDI service owns GATT and the connection.
public sealed partial class WindowsDeviceDiscovery(Action<string> log, Action<string> report) : IDeviceDiscovery, INativeMidi
{
    private const string MidiProperty = "{3F114A6A-11FA-4BD0-9D2C-6B7780CD80AD} ";
    private const string UmpSelector = "System.Devices.InterfaceClassGuid:=\"{E7CCE071-3C03-423F-88D3-F1045D02552B}\" AND System.Devices.InterfaceEnabled:=System.StructuredQueryType.Boolean#True";
    private static readonly Guid MidiService = new("03B80E5A-EDE8-4B33-A751-6CE34EC4C700");

    public async Task<IReadOnlyList<BluetoothKeyboard>> DiscoverAsync(CancellationToken token)
    {
        var radio = await BluetoothAdapter.GetDefaultAsync().AsTask(token);
        if (radio == null || !radio.IsLowEnergySupported) throw new BluetoothDiscoveryException("No Bluetooth LE adapter found.");
        var state = await radio.GetRadioAsync().AsTask(token);
        if (state?.State != Windows.Devices.Radios.RadioState.On) throw new BluetoothDiscoveryException("The Bluetooth radio is unavailable. Check Windows settings.");
        var found = new Dictionary<ulong, BluetoothKeyboard>();
        var sync = new object();
        var watcher = new BluetoothLEAdvertisementWatcher { ScanningMode = BluetoothLEScanningMode.Active };
        Exception? scanError = null;
        watcher.Received += (_, e) =>
        {
            var name = e.Advertisement.LocalName;
            var midi = e.Advertisement.ServiceUuids.Contains(MidiService);
            lock (sync)
            {
                if (midi || name.Contains("popu", StringComparison.OrdinalIgnoreCase) || found.ContainsKey(e.BluetoothAddress))
                {
                    if (string.IsNullOrWhiteSpace(name) && found.TryGetValue(e.BluetoothAddress, out var old)) name = old.Name;
                    found[e.BluetoothAddress] = new(e.BluetoothAddress.ToString("X12"), string.IsNullOrWhiteSpace(name) ? "Bluetooth MIDI" : name);
                }
            }
        };
        watcher.Stopped += (_, e) =>
        {
            if (e.Error != BluetoothError.Success) scanError = new BluetoothDiscoveryException($"Bluetooth scan stopped: {e.Error}. Check Bluetooth permissions.");
        };
        try
        {
            watcher.Start();
            // Include bonded devices, which may stop advertising once connected.
            var paired = await DeviceInformation.FindAllAsync(BluetoothLEDevice.GetDeviceSelectorFromPairingState(true)).AsTask(token);
            foreach (var info in paired.Where(p => p.Name.Contains("popu", StringComparison.OrdinalIgnoreCase)))
            {
                using var device = await BluetoothLEDevice.FromIdAsync(info.Id).AsTask(token).WaitAsync(TimeSpan.FromSeconds(5), token);
                if (device != null) lock (sync) found[device.BluetoothAddress] = new(device.BluetoothAddress.ToString("X12"), info.Name);
            }
            await Task.Delay(TimeSpan.FromSeconds(5), token);
        }
        finally { watcher.Stop(); }
        if (scanError != null) throw scanError;
        lock (sync) return found.Values.OrderBy(d => !d.Name.Contains("popu", StringComparison.OrdinalIgnoreCase)).ThenBy(d => d.Name).ToArray();
    }

    public async Task<DeviceSnapshot> InspectAsync(string bluetoothId, CancellationToken token)
    {
        var id = EndpointSelection.NormalizeBluetoothId(bluetoothId);
        using var device = await BluetoothLEDevice.FromBluetoothAddressAsync(ulong.Parse(id, NumberStyles.HexNumber)).AsTask(token).WaitAsync(TimeSpan.FromSeconds(5), token);
        var connected = device?.ConnectionStatus == BluetoothConnectionStatus.Connected;
        var destinations = await GetDestinationsAsync(token);
        log($"Bluetooth {id}: {(connected ? "connected" : "offline")}; outputs={destinations.Count}");
        return new(connected, destinations);
    }

    public async Task<IReadOnlyList<MidiDestination>> GetDestinationsAsync(CancellationToken token)
    {
        var endpoints = await DeviceInformation.FindAllAsync(UmpSelector,
            [MidiProperty + "2", MidiProperty + "19", MidiProperty + "54", "System.Devices.DeviceInstanceId"]).AsTask(token);
        // A legacy output port associated with a UMP endpoint confirms that group 1 can receive.
        var ports = await DeviceInformation.FindAllAsync(Windows.Devices.Midi.MidiOutPort.GetDeviceSelector(),
            [MidiProperty + "52", MidiProperty + "18"]).AsTask(token);
        var destinations = new List<MidiDestination>();
        foreach (var ep in endpoints)
        {
            var code = Property(ep, MidiProperty + "2");
            var instance = Property(ep, "System.Devices.DeviceInstanceId");
            var driver = Property(ep, MidiProperty + "19");
            var vendor = ep.Properties.TryGetValue(MidiProperty + "54", out var vid) && vid != null ? Convert.ToInt32(vid, CultureInfo.InvariantCulture) : 0;
            var type = TransportIdentity.Classify(code, driver, vendor);
            if (type == ConnectionType.Unknown && (code.Equals("KS", StringComparison.OrdinalIgnoreCase) || code.Equals("KSA", StringComparison.OrdinalIgnoreCase)))
            {
                // Some KS endpoints expose a SWD/aggregate interface. Check the actual PnP ancestry.
                if (await HasUsbParentAsync(instance, token)) type = ConnectionType.Usb;
            }
            foreach (var port in ports)
            {
                if (!Property(port, MidiProperty + "52").Equals(ep.Id, StringComparison.OrdinalIgnoreCase)) continue;
                if (!port.Properties.TryGetValue(MidiProperty + "18", out var groupValue) || groupValue == null) continue;
                var group = Convert.ToInt32(groupValue, CultureInfo.InvariantCulture);
                destinations.Add(new(ep.Id, ep.Name, instance, code, group) { Type = type, WindowsOutputId = port.Id });
            }
            if (!destinations.Any(d => d.Id.Equals(ep.Id, StringComparison.OrdinalIgnoreCase)))
                destinations.Add(new(ep.Id, ep.Name, instance, code, -1) { Type = type });
        }
        foreach (var ep in destinations) log($"OUT group={ep.GroupIndex + 1} {ep.Name} | {ep.Id} | {ep.InstanceId} | {ep.TransportCode}");
        return destinations.Distinct().ToArray();
    }

    private static string Property(DeviceInformation info, string key) =>
        info.Properties.TryGetValue(key, out var value) ? value?.ToString() ?? "" : "";
}
