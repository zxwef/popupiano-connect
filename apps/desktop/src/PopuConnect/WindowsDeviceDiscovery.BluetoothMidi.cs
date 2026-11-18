using PopuConnect.Core;
using Windows.Devices.Bluetooth;
using Windows.Devices.Enumeration;
using Windows.Devices.Midi;

namespace PopuConnect;

public sealed partial class WindowsDeviceDiscovery
{
    private const string InstanceProperty = "System.Devices.DeviceInstanceId";
    private const string ContainerProperty = "System.Devices.ContainerId";
    private const string BleContainerProperty = "System.Devices.Aep.ContainerId";
    private static readonly Guid PcContainer = new("00000000-0000-0000-ffff-ffffffffffff");
    private IMidiOutPort? bluetoothOutput;
    private string? bluetoothOutputId;

    public async Task OpenBluetoothOutputAsync(string outputId, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        ReleaseBluetoothOutput(outputId);
        if (bluetoothOutput != null) return;
        bluetoothOutput = await OpenOutputAsync(outputId, token);
        bluetoothOutputId = outputId;
        report("Bluetooth MIDI · Windows output opened for this session.");
    }

    public void ReleaseBluetoothOutput(string? keepOutputId = null)
    {
        if (bluetoothOutput == null || string.Equals(bluetoothOutputId, keepOutputId, StringComparison.OrdinalIgnoreCase)) return;
        var port = bluetoothOutput;
        bluetoothOutput = null;
        bluetoothOutputId = null;
        try
        {
            port.Dispose();
            report("Bluetooth MIDI · Windows output released.");
        }
        catch (Exception e) { report("Failed to close Bluetooth MIDI output: " + DeviceDiagnosticsReport.ErrorCode(e)); }
    }

    public async Task<IReadOnlyList<MidiDestination>> GetBluetoothOutputsAsync(CancellationToken token)
    {
        var endpoints = await GetDestinationsAsync(token);
        var outputs = endpoints.Where(e => e.Type == ConnectionType.Bluetooth && e.GroupIndex == 0 && e.WindowsOutputId.Length > 0).ToList();
        var mappedPorts = endpoints.Where(e => e.Type != ConnectionType.Unknown && e.WindowsOutputId.Length > 0)
            .Select(e => e.WindowsOutputId).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var paired = await DeviceInformation.FindAllAsync(BluetoothLEDevice.GetDeviceSelectorFromPairingState(true),
            [BleContainerProperty, ContainerProperty], DeviceInformationKind.AssociationEndpoint).AsTask(token);
        var containers = new HashSet<Guid>();
        foreach (var device in paired)
            foreach (var key in new[] { BleContainerProperty, ContainerProperty })
                if (TryContainer(device, key, out var id)) containers.Add(id);

        var ports = await DeviceInformation.FindAllAsync(MidiOutPort.GetDeviceSelector(),
            [InstanceProperty, ContainerProperty]).AsTask(token);
        foreach (var port in ports)
        {
            if (mappedPorts.Contains(port.Id) || MidiSynthesizer.IsSynthesizer(port)) continue;
            var instance = Property(port, InstanceProperty);
            if (instance.Length == 0) continue;
            if ((TryContainer(port, ContainerProperty, out var container) && containers.Contains(container))
                || await HasBluetoothParentAsync(instance, containers, token))
            {
                outputs.Add(new(port.Id, port.Name, instance, "WinRT", 0)
                    { Type = ConnectionType.Bluetooth, WindowsOutputId = port.Id });
            }
        }
        return outputs.DistinctBy(e => e.WindowsOutputId, StringComparer.OrdinalIgnoreCase).ToArray();
    }

    private async Task<bool> HasBluetoothParentAsync(string instance, HashSet<Guid> containers, CancellationToken token)
    {
        for (int depth = 0; depth < 12 && instance.Length > 0; depth++)
        {
            if (instance.StartsWith(@"BTHLE\", StringComparison.OrdinalIgnoreCase) ||
                instance.StartsWith(@"BTHLEDEVICE\", StringComparison.OrdinalIgnoreCase)) return true;
            if (instance.StartsWith(@"USB\", StringComparison.OrdinalIgnoreCase) ||
                instance.StartsWith(@"PCI\", StringComparison.OrdinalIgnoreCase)) return false;
            DeviceInformation node;
            try
            {
                node = await DeviceInformation.CreateFromIdAsync(instance, ["System.Devices.Parent", ContainerProperty],
                    DeviceInformationKind.Device).AsTask(token);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                log($"Could not verify the Bluetooth bus for MIDI output {instance}: {e.Message}");
                return false;
            }
            if (node == null) return false;
            if (TryContainer(node, ContainerProperty, out var container) && containers.Contains(container)) return true;
            var parent = Property(node, "System.Devices.Parent");
            if (parent.Equals(instance, StringComparison.OrdinalIgnoreCase)) return false;
            instance = parent;
        }
        return false;
    }

    private static bool TryContainer(DeviceInformation device, string key, out Guid id) =>
        Guid.TryParse(Property(device, key), out id) && id != Guid.Empty && id != PcContainer;
}
