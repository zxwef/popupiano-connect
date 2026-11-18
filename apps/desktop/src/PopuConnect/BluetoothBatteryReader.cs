using System.Globalization;
using PopuConnect.Core;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Devices.Radios;
using Windows.Storage.Streams;

namespace PopuConnect;

internal static class BluetoothBatteryReader
{
    internal static async Task<BatteryReading> ReadAsync(string address, Action<string> trace, CancellationToken lifetime)
    {
        const ConnectionType source = ConnectionType.Bluetooth;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime);
        timeout.CancelAfter(TimeSpan.FromSeconds(25));
        var token = timeout.Token;
        try
        {
            var adapter = await BluetoothAdapter.GetDefaultAsync().AsTask(token);
            if (adapter == null || !adapter.IsLowEnergySupported)
                return BatteryReading.Unavailable(source, "No Bluetooth LE adapter is available.");
            var radio = await adapter.GetRadioAsync().AsTask(token);
            if (radio == null || radio.State != RadioState.On)
                return BatteryReading.Unavailable(source, $"Bluetooth radio: {radio?.State.ToString() ?? "unavailable"}.");

            var id = ulong.Parse(EndpointSelection.NormalizeBluetoothId(address), NumberStyles.HexNumber);
            using var device = await BluetoothLEDevice.FromBluetoothAddressAsync(id).AsTask(token);
            if (device == null) return BatteryReading.Unavailable(source, "Windows could not open the selected BLE device.");
            var services = await device.GetGattServicesForUuidAsync(GattServiceUuids.Battery, BluetoothCacheMode.Uncached).AsTask(token);
            var found = services.Services;
            try
            {
                var outcome = services.Status switch
                {
                    GattCommunicationStatus.Success => GattDiscoveryStatus.Success,
                    GattCommunicationStatus.Unreachable => GattDiscoveryStatus.Unreachable,
                    _ => GattDiscoveryStatus.Failed
                };
                var discovery = BatteryReading.FromGattDiscovery(outcome,
                    found?.Count ?? 0, Status(services.Status, services.ProtocolError));
                trace(discovery.Detail);
                if (discovery.State != BatteryState.Unknown) return discovery;
                var result = BatteryReading.Unknown(source, "Service 180F has no readable 2A19 characteristic.");
                foreach (var service in found!)
                {
                    var characteristics = await service.GetCharacteristicsForUuidAsync(GattCharacteristicUuids.BatteryLevel, BluetoothCacheMode.Uncached).AsTask(token);
                    trace($"GATT 2A19: {Status(characteristics.Status, characteristics.ProtocolError)}");
                    if (characteristics.Status != GattCommunicationStatus.Success)
                    {
                        result = BatteryReading.Error(source, "2A19 discovery failed: " + Status(characteristics.Status, characteristics.ProtocolError));
                        continue;
                    }
                    foreach (var characteristic in characteristics.Characteristics)
                    {
                        trace($"2A19 properties={characteristic.CharacteristicProperties}");
                        if (!characteristic.CharacteristicProperties.HasFlag(GattCharacteristicProperties.Read)) continue;
                        var read = await characteristic.ReadValueAsync(BluetoothCacheMode.Uncached).AsTask(token);
                        trace("ReadValueAsync: " + Status(read.Status, read.ProtocolError));
                        if (read.Status != GattCommunicationStatus.Success)
                        {
                            result = BatteryReading.Error(source, "2A19 read failed: " + Status(read.Status, read.ProtocolError));
                            continue;
                        }
                        using var reader = DataReader.FromBuffer(read.Value);
                        var data = new byte[reader.UnconsumedBufferLength];
                        reader.ReadBytes(data);
                        result = BatteryReading.FromGattValue(data);
                        if (result.Percent.HasValue) return result;
                    }
                }
                return result;
            }
            finally { if (found != null) foreach (var service in found) service.Dispose(); }
        }
        catch (OperationCanceledException) when (!lifetime.IsCancellationRequested)
        { return BatteryReading.Unavailable(source, "The BLE operation timed out after 25 seconds."); }
        catch (Exception e) when (e is not OperationCanceledException)
        { return BatteryReading.Error(source, "Windows BLE: " + DeviceDiagnosticsReport.ErrorCode(e)); }
    }

    private static string Status(GattCommunicationStatus status, byte? error) =>
        error is byte code ? $"{status} ATT=0x{code:X2}" : status.ToString();
}

