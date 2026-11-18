using System.ComponentModel;
using PopuConnect.Core;
using Xunit;

namespace PopuConnect.Tests;

public sealed class HardwareDiagnosticsTests
{
    [Fact]
    public void ExtensionOffIsExactlyOne24KeyAssignment()
    {
        var frame = PopuPianoLighting.ExtraPianoOff();
        Assert.Equal(53, frame.Length);
        Assert.Equal(new byte[] { 0xF0, 4, 0x20, 0x18 }, frame[..4]);
        for (int i = 0; i < 24; i++)
            Assert.Equal(new byte[] { (byte)i, 0 }, frame[(4 + i * 2)..(6 + i * 2)]);
        Assert.Equal(0xF7, frame[^1]);
        Assert.All(frame[1..^1], b => Assert.InRange((int)b, 0, 127));
        Assert.EndsWith("16 00 17 00 F7", PopuPianoLighting.Hex(frame));
    }

    [Theory]
    [InlineData(GattDiscoveryStatus.Unreachable, 0, "Unreachable", BatteryState.Unavailable)]
    [InlineData(GattDiscoveryStatus.Failed, 0, "ProtocolError ATT=0x05", BatteryState.ReadError)]
    [InlineData(GattDiscoveryStatus.Success, 0, "Success", BatteryState.ServiceAbsent)]
    [InlineData(GattDiscoveryStatus.Success, 1, "Success", BatteryState.Unknown)]
    public void GattDiscoveryNeedsSuccessfulEnumerationForAbsence(GattDiscoveryStatus outcome, int count, string status, BatteryState expected)
    {
        var result = BatteryReading.FromGattDiscovery(outcome, count, status);
        Assert.Equal(expected, result.State);
        Assert.Null(result.Percent);
        if (outcome != GattDiscoveryStatus.Success) Assert.Contains(status, result.Detail);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(49)]
    [InlineData(100)]
    public void GattReadInterpretsASinglePercentageByte(byte level)
    {
        var reading = BatteryReading.FromGattValue([level]);
        Assert.Equal(ConnectionType.Bluetooth, reading.Source);
        Assert.Equal((int)level, reading.Percent);
        Assert.Equal(BatteryState.Received, reading.State);
    }

    [Fact]
    public void MalformedGattPayloadNeverReportsCharge()
    {
        foreach (var raw in new byte[][] { [], [0, 100], [101], [255] })
        {
            var reading = BatteryReading.FromGattValue(raw);
            Assert.Null(reading.Percent);
            Assert.Equal(BatteryState.ReadError, reading.State);
        }
    }

    [Theory]
    [InlineData(500, 2000, 25)]
    [InlineData(0, 2000, 0)]
    [InlineData(0, 0, null)]
    [InlineData(null, 2000, null)]
    [InlineData(-1, 2000, null)]
    [InlineData(4500, 2000, null)]
    public void UsbDeviceCapacityChecksMissingAndInvalidReports(int? remaining, int? full, int? percent) =>
        Assert.Equal(percent, BatteryReading.FromCapacity(remaining, full).Percent);

    [Theory]
    [InlineData(6, 0x20, 128, 0, 255, 50)]
    [InlineData(6, 0x20, 0, 0, 0, null)]
    [InlineData(6, 0x20, 255, 0, 100, null)]
    [InlineData(0x85, 0x64, 67, 0, 255, 67)]
    [InlineData(0x85, 0x65, 128, 0, 255, null)]
    [InlineData(0x85, 0x66, 80, 0, 100, null)]
    public void OnlyKnownBatteryUsagesAndValidValuesGivePercent(ushort page, ushort usage, long value, long min, long max, int? percent) =>
        Assert.Equal(percent, BatteryReading.FromHid(page, usage, value, min, max, "HID").Percent);

    [Fact]
    public void MissingWindowsValueOrHidAccessFailureDoesNotBecomeZero()
    {
        var noValue = BatteryReading.FromUsbValue(101, "PnP");
        var denied = BatteryReading.Error(ConnectionType.Usb, "HID AccessDenied");
        Assert.Equal(BatteryState.Unknown, BatteryReading.UsbSummary([noValue]).State);
        Assert.Equal(denied, BatteryReading.UsbSummary([noValue, denied]));
        Assert.Equal(0, BatteryReading.UsbSummary([denied, BatteryReading.FromUsbValue(0, "PnP")]).Percent);
    }

    [Fact]
    public void UsbProbeCorrelatesCompositeSiblingsButExcludesHostAndIdenticalKeyboard()
    {
        var group = Guid.NewGuid();
        var keyboard = new UsbNode(@"USB\VID_1234&PID_0010\one", "hub", group);
        var other = keyboard with { Id = @"USB\VID_1234&PID_0010\two" };
        var tree = new UsbDeviceTree([keyboard, other, new("midi", "audio", group), new("audio", keyboard.Id, group),
            new("hid", keyboard.Id, group), new("other-hid", other.Id, group), new("host-battery", "pc", Guid.Empty),
            new("floating", "", group), new("loop", "loop", Guid.Empty)]);
        Assert.Equal(keyboard, tree.PhysicalDevice("midi"));
        Assert.True(tree.IsPartOf("hid", keyboard));
        Assert.False(tree.IsPartOf("other-hid", keyboard));
        Assert.False(tree.IsPartOf("host-battery", keyboard));
        Assert.Null(tree.PhysicalDevice("floating"));
        Assert.Null(tree.PhysicalDevice("loop"));
    }

    [Fact]
    public void BluetoothDevicesAndUsbHubsAreNotBatteryTargets()
    {
        var group = Guid.NewGuid();
        var adapter = new UsbNode(@"USB\VID_BBBB&PID_0123\port", "hub", group);
        var tree = new UsbDeviceTree([adapter, new(@"BTHLE\device", adapter.Id, group),
            new(@"USB\VID_1234&PID_0001\hub", "", group, IsHub: true)]);
        Assert.Null(tree.PhysicalDevice(@"BTHLE\device"));
        Assert.Null(tree.PhysicalDevice(@"USB\VID_1234&PID_0001\hub"));
    }

    [Fact]
    public async Task ExportMasksHardwareIdentityAndOmitsRawExceptionText()
    {
        var report = new DeviceDiagnosticsReport();
        const string usb = @"USB\VID_1234&PID_ABCD&MI_01\MY-PRIVATE-SERIAL";
        const string mac = "AABBCCDDEEFF";
        var code = DeviceDiagnosticsReport.UsbCodes([usb, @"USB\CLASS_FF&SUBCLASS_02&PROT_01"]);
        Assert.Equal("VID_1234&PID_ABCD&MI_01, CLASS_FF&SUBCLASS_02&PROT_01", code);
        report.Snapshot = $"Windows USB {code} id={report.Id(usb)} BLE={report.Id(mac)} {report.Name("PopuPiano Alice")} {report.Name("Alice gear")}";
        var error = new InvalidOperationException(@"C:\Users\Alice\secret", new Win32Exception(5));
        error.Data["ExitCode"] = 19;
        report.Record(DeviceDiagnosticsReport.ErrorCode(error));
        report.Record("SysEx: " + PopuPianoLighting.Hex(PopuPianoLighting.ExtraPianoOff()));
        var path = Path.GetTempFileName();
        try
        {
            await report.ExportAsync(path, CancellationToken.None);
            var text = await File.ReadAllTextAsync(path);
            Assert.Equal(report.Render(), text);
            Assert.Contains("VID_1234", text); Assert.Contains("F0 04 20 18", text);
            Assert.Contains("Win32=5", text); Assert.Contains("exit=19", text);
            Assert.DoesNotContain("PRIVATE", text); Assert.DoesNotContain(mac, text); Assert.DoesNotContain("Alice", text);
            Assert.Equal(report.Id(usb), report.Id(usb.ToLowerInvariant()));
            Assert.NotEqual(report.Id(usb), new DeviceDiagnosticsReport().Id(usb));
        }
        finally { File.Delete(path); }
    }
}

