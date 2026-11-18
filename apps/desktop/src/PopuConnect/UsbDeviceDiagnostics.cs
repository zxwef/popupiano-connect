using PopuConnect.Core;
using Windows.Devices.Enumeration;
using Windows.Devices.Power;

namespace PopuConnect;

internal static class UsbDeviceDiagnostics
{
    private const string Instance = "System.Devices.DeviceInstanceId";
    private const string Parent = "System.Devices.Parent";
    private const string Container = "System.Devices.ContainerId";
    private const string Life = "System.Devices.BatteryLife";
    private const string Hardware = "System.Devices.HardwareIds";
    private const string Compatible = "System.Devices.CompatibleIds";
    private const string Class = "System.Devices.ClassGuid";
    private const string HidSelector = "System.Devices.InterfaceClassGuid:=\"{4D1E55B2-F16F-11CF-88CB-001111000030}\" AND System.Devices.InterfaceEnabled:=System.StructuredQueryType.Boolean#True";
    private const string DriverInterface = "{3F114A6A-11FA-4BD0-9D2C-6B7780CD80AD} 19";

    public static async Task<BatteryReading> InspectAsync(MidiDevice? selected, DeviceDiagnosticsReport report, Action<string> log, CancellationToken token)
    {
        const ConnectionType usb = ConnectionType.Usb;
        if (selected is not { Type: ConnectionType.Usb, Available: true })
            return BatteryReading.Unavailable(usb, "Select a connected USB keyboard from the MIDI device list.");
        var readings = new List<BatteryReading>();
        void Record(BatteryReading r) { readings.Add(r); log($"{r.State}: {r.Display}"); }
        try
        {
            var nodes = await ReadNodesAsync(token, Hardware, Class, Life);
            var tree = CreateTree(nodes);
            var root = await FindPhysicalDeviceAsync(selected, tree, token);
            if (root == null) return BatteryReading.Unknown(usb, "Windows could not match the selected MIDI port to a single physical USB device.");
            log($"USB root={report.Id(root.Id)} {DeviceDiagnosticsReport.UsbCodes([root.Id])}");
            var members = nodes.Where(n => tree.IsPartOf(n.Id, root)).ToArray();
            foreach (var node in members)
            {
                var codes = DeviceDiagnosticsReport.UsbCodes(Ids(node, Hardware).Concat(Ids(node, Compatible)).Append(node.Id));
                log($"PnP {report.Id(node.Id)} parent={report.Id(Property(node, Parent))} classGuid={FormatGuid(node, Class)} {codes}");
                ReadProperty(node);
            }
            var batteryCount = 0;
            var hidCount = 0;
            async Task ProbeAsync(string label, string selector, Func<DeviceInformation, Task> read)
            {
                try
                {
                    var interfaces = await DeviceInformation.FindAllAsync(selector, [Instance, Life, "System.Devices.InterfaceClassGuid", "System.DeviceInterface.Hid.UsagePage", "System.DeviceInterface.Hid.UsageId"]).AsTask(token);
                    foreach (var info in interfaces.Where(i => tree.IsPartOf(Property(i, Instance), root)))
                    {
                        log($"{label} interface={report.Id(info.Id)} node={report.Id(Property(info, Instance))} interfaceClass={FormatGuid(info, "System.Devices.InterfaceClassGuid")}");
                        ReadProperty(info);
                        try { await read(info); }
                        catch (Exception e) when (e is not OperationCanceledException) { Record(BatteryReading.Error(usb, label + ": " + DeviceDiagnosticsReport.ErrorCode(e))); }
                    }
                }
                catch (Exception e) when (e is not OperationCanceledException) { Record(BatteryReading.Error(usb, label + " enumeration: " + DeviceDiagnosticsReport.ErrorCode(e))); }
            }
            await ProbeAsync("PnP", "System.Devices.InterfaceEnabled:=System.StructuredQueryType.Boolean#True", _ => Task.CompletedTask);
            await ProbeAsync("Battery API", Battery.GetDeviceSelector(), async info =>
            {
                batteryCount++;
                var battery = await Battery.FromIdAsync(info.Id).AsTask(token);
                if (battery == null) { Record(BatteryReading.Error(usb, "Windows could not open the battery interface.")); return; }
                var data = battery.GetReport();
                log($"BatteryReport status={data.Status} remaining_mWh={data.RemainingCapacityInMilliwattHours} full_mWh={data.FullChargeCapacityInMilliwattHours}");
                if (data.Status != Windows.System.Power.BatteryStatus.NotPresent)
                    Record(BatteryReading.FromCapacity(data.RemainingCapacityInMilliwattHours, data.FullChargeCapacityInMilliwattHours));
            });
            await ProbeAsync("HID", HidSelector, async info =>
            {
                hidCount++;
                log($"HID usagePage={Property(info, "System.DeviceInterface.Hid.UsagePage")} usageId={Property(info, "System.DeviceInterface.Hid.UsageId")}");
                await HidBatteryProbe.InspectAsync(info.Id, log, Record, token);
            });
            log($"Checked: PnP nodes={members.Length}, Battery interfaces={batteryCount}, HID collections={hidCount}.");
            log("Battery checks use standard Windows interfaces.");
            return BatteryReading.UsbSummary(readings);
        }
        catch (Exception e) when (e is not OperationCanceledException) { return BatteryReading.Error(usb, "USB PnP: " + DeviceDiagnosticsReport.ErrorCode(e)); }

        void ReadProperty(DeviceInformation info)
        {
            if (!info.Properties.TryGetValue(Life, out var raw) || raw == null) { log("  PnP BatteryLife: no value"); return; }
            log($"  PnP BatteryLife={ (raw is byte b ? b.ToString() : "unexpected type") }");
            Record(BatteryReading.FromUsbValue(raw is byte bval ? bval : null, Life));
        }
    }

    internal static Task<DeviceInformationCollection> ReadNodesAsync(CancellationToken token, params string[] additionalProperties) =>
        DeviceInformation.FindAllAsync("System.Devices.Present:=System.StructuredQueryType.Boolean#True",
            [Parent, Container, Compatible, .. additionalProperties], DeviceInformationKind.Device).AsTask(token);

    internal static UsbDeviceTree CreateTree(IEnumerable<DeviceInformation> nodes) =>
        new(nodes.Select(node => new UsbNode(node.Id, Property(node, Parent),
            Guid.TryParse(Property(node, Container), out var container) ? container : Guid.Empty,
            Ids(node, Compatible).Any(id => id.StartsWith(@"USB\Class_09", StringComparison.OrdinalIgnoreCase)))));

    internal static async Task<UsbNode?> FindPhysicalDeviceAsync(MidiDevice selected, UsbDeviceTree tree, CancellationToken token)
    {
        var root = tree.PhysicalDevice(selected.InstanceId);
        if (root != null) return root;
        var endpoint = await DeviceInformation.CreateFromIdAsync(selected.MidiEndpointId, [DriverInterface],
            DeviceInformationKind.DeviceInterface).AsTask(token);
        var path = endpoint == null ? "" : Property(endpoint, DriverInterface);
        if (path.Length == 0) return null;
        var driver = await DeviceInformation.CreateFromIdAsync(path, [Instance], DeviceInformationKind.DeviceInterface).AsTask(token);
        return driver == null ? null : tree.PhysicalDevice(Property(driver, Instance));
    }

    private static string FormatGuid(DeviceInformation info, string key) => Guid.TryParse(Property(info, key), out var g) ? g.ToString() : "—";
    private static string Property(DeviceInformation info, string key) => info.Properties.TryGetValue(key, out var value) ? value?.ToString() ?? "" : "";
    private static IEnumerable<string> Ids(DeviceInformation info, string key) =>
        info.Properties.TryGetValue(key, out var value) && value is IEnumerable<string> ids ? ids : [];
}

