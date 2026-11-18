using PopuConnect.Core;
using Windows.Devices.Enumeration;
using Windows.Devices.Midi;
using Windows.Storage.Streams;

namespace PopuConnect;

public sealed partial class WindowsDeviceDiscovery
{
    public static async Task<string[]> GetUsbInputIdsAsync(MidiDevice device, CancellationToken token)
    {
        var ports = await DeviceInformation.FindAllAsync(MidiInPort.GetDeviceSelector(),
            ["System.Devices.DeviceInstanceId", MidiProperty + "52"]).AsTask(token);
        var associated = ports.Where(p => Property(p, MidiProperty + "52").Equals(device.MidiEndpointId, StringComparison.OrdinalIgnoreCase))
            .Select(p => p.Id).ToArray();
        if (associated.Length > 0 || ports.Count == 0) return associated;

        var nodes = await UsbDeviceDiagnostics.ReadNodesAsync(token);
        var tree = UsbDeviceDiagnostics.CreateTree(nodes);
        var root = await UsbDeviceDiagnostics.FindPhysicalDeviceAsync(device, tree, token);
        if (root == null) return [];
        return ports.Where(p => tree.IsPartOf(Property(p, "System.Devices.DeviceInstanceId"), root)).Select(p => p.Id).ToArray();
    }

    public async Task<IReadOnlyList<MidiDestination>> GetUsbOutputsAsync(CancellationToken token)
    {
        // Keep the existing UMP identity when the service is installed without the console.
        var endpoints = await GetDestinationsAsync(token);
        var usb = endpoints.Where(e => e.Type == ConnectionType.Usb && e.GroupIndex == 0 && e.WindowsOutputId.Length > 0).ToList();
        var legacy = await DeviceInformation.FindAllAsync(MidiOutPort.GetDeviceSelector(),
            ["System.Devices.DeviceInstanceId", MidiProperty + "52", MidiProperty + "19"]).AsTask(token);
        foreach (var port in legacy)
        {
            if (Property(port, MidiProperty + "52").Length > 0 || MidiSynthesizer.IsSynthesizer(port)) continue;
            var instance = Property(port, "System.Devices.DeviceInstanceId");
            if (instance.Length == 0) continue;
            var driver = Property(port, MidiProperty + "19");
            if (!driver.StartsWith(@"\\?\USB#", StringComparison.OrdinalIgnoreCase) && !await HasUsbParentAsync(instance, token)) continue;
            usb.Add(new(port.Id, port.Name, instance, "USB", 0) { Type = ConnectionType.Usb, WindowsOutputId = port.Id });
        }
        return usb;
    }

    private async Task<bool> HasUsbParentAsync(string node, CancellationToken token)
    {
        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        while (node.Length > 0 && visited.Add(node))
        {
            if (node.StartsWith(@"USB\", StringComparison.OrdinalIgnoreCase)) return true;
            // A Bluetooth adapter may itself be attached via USB.
            if (node.StartsWith("BTH", StringComparison.OrdinalIgnoreCase)) return false;
            try
            {
                var device = await DeviceInformation.CreateFromIdAsync(node, ["System.Devices.Parent"], DeviceInformationKind.Device).AsTask(token);
                node = device == null ? "" : Property(device, "System.Devices.Parent");
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                log($"Could not identify the bus for MIDI port {node}: {e.Message}");
                return false;
            }
        }
        return false;
    }

    public async Task SendAsync(string outputId, IEnumerable<byte[]> messages, CancellationToken token, bool keepBluetoothOpen = false)
    {
        if (keepBluetoothOpen)
        {
            await OpenBluetoothOutputAsync(outputId, token);
            try { SendFrames(bluetoothOutput!, messages, token); }
            catch { ReleaseBluetoothOutput(); throw; }
            return;
        }
        using var port = await OpenOutputAsync(outputId, token);
        SendFrames(port, messages, token);
    }

    private static void SendFrames(IMidiOutPort port, IEnumerable<byte[]> messages, CancellationToken token)
    {
        foreach (var message in messages)
        {
            token.ThrowIfCancellationRequested();
            using var writer = new DataWriter();
            writer.WriteBytes(message);
            port.SendMessage(new MidiSystemExclusiveMessage(writer.DetachBuffer()));
        }
    }

    private static async Task<IMidiOutPort> OpenOutputAsync(string outputId, CancellationToken token)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        try
        {
            return await MidiOutPort.FromIdAsync(outputId).AsTask(timeout.Token)
                ?? throw new InvalidOperationException("Windows could not open the MIDI output. Check the connection and port access.");
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            throw new TimeoutException("Opening the Windows MIDI output timed out after 10 seconds.");
        }
    }
}
