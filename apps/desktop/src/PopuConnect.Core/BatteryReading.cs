namespace PopuConnect.Core;

public enum BatteryState { Unknown, ServiceAbsent, Unavailable, ReadError, Received }
public enum GattDiscoveryStatus { Success, Unreachable, Failed }

public sealed record BatteryReading(ConnectionType Source, BatteryState State, string Detail, int? Percent = null)
{
    public static BatteryReading Unknown(ConnectionType source, string reason) => new(source, BatteryState.Unknown, reason);
    public static BatteryReading Error(ConnectionType source, string reason) => new(source, BatteryState.ReadError, reason);
    public static BatteryReading Unavailable(ConnectionType source, string reason) => new(source, BatteryState.Unavailable, reason);

    public static BatteryReading FromGattDiscovery(GattDiscoveryStatus outcome, int count, string status) => outcome switch
    {
        GattDiscoveryStatus.Unreachable => Unavailable(ConnectionType.Bluetooth, "Device unreachable during GATT 180F discovery: " + status),
        GattDiscoveryStatus.Failed => Error(ConnectionType.Bluetooth, "GATT 180F discovery failed: " + status),
        _ when count == 0 => new(ConnectionType.Bluetooth, BatteryState.ServiceAbsent, "Standard Battery Service 180F was not found."),
        _ => Unknown(ConnectionType.Bluetooth, $"Battery services found: {count}.")
    };

    public static BatteryReading FromGattValue(byte[] value) => value is [<= 100]
        ? new(ConnectionType.Bluetooth, BatteryState.Received, "GATT 180F / 2A19", value[0])
        : Error(ConnectionType.Bluetooth, "Invalid 2A19 value. Expected one byte from 0 to 100.");

    public static BatteryReading FromUsbValue(long? value, string method) => value is >= 0 and <= 100
        ? new(ConnectionType.Usb, BatteryState.Received, method, (int)value)
        : Unknown(ConnectionType.Usb, $"{method}: no valid percentage available.");

    public static BatteryReading FromCapacity(int? remaining, int? full) =>
        FromUsbValue(remaining >= 0 && full > 0 && remaining <= full
            ? (long)Math.Round(100.0 * remaining.Value / full.Value, MidpointRounding.AwayFromZero) : null,
            "Windows BatteryReport (remaining/full)");

    public static BatteryReading FromHid(ushort page, ushort usage, long value, long min, long max, string method)
    {
        if (max <= min || value < min || value > max) return Unknown(ConnectionType.Usb, method + ": value out of range.");
        if (page == 6 && usage == 0x20)
            return FromUsbValue((long)Math.Round(100m * (value - (decimal)min) / (max - (decimal)min), MidpointRounding.AwayFromZero), method);
        return FromUsbValue(page == 0x85 && usage is 0x64 or 0x65 ? value : null, method);
    }

    public static BatteryReading UsbSummary(IReadOnlyList<BatteryReading> readings) =>
        readings.FirstOrDefault(r => r.State == BatteryState.Received) ??
        readings.FirstOrDefault(r => r.State == BatteryState.ReadError) ??
        Unknown(ConnectionType.Usb, "The checked USB interfaces returned no battery percentage.");

    public string Display => Percent.HasValue ? $"{Percent}% · {Detail}" : Detail;
}

