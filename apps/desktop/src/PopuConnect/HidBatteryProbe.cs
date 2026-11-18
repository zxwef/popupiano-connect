using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using PopuConnect.Core;
using Windows.Devices.HumanInterfaceDevice;
using Windows.Storage;

namespace PopuConnect;

internal static class HidBatteryProbe
{
    // hidpi.h: HIDP_CAPS and HIDP_{VALUE,BUTTON}_CAPS use fixed-width fields.
    [StructLayout(LayoutKind.Explicit, Size = 64)]
    private struct Caps
    {
        [FieldOffset(0)] public ushort Usage;
        [FieldOffset(2)] public ushort Page;
        [FieldOffset(4)] public ushort InputBytes;
        [FieldOffset(6)] public ushort OutputBytes;
        [FieldOffset(8)] public ushort FeatureBytes;
        [FieldOffset(44)] public ushort CollectionCount;
        [FieldOffset(46)] public ushort InputButtons;
        [FieldOffset(48)] public ushort InputValues;
        [FieldOffset(52)] public ushort OutputButtons;
        [FieldOffset(54)] public ushort OutputValues;
        [FieldOffset(58)] public ushort FeatureButtons;
        [FieldOffset(60)] public ushort FeatureValues;
    }

    [StructLayout(LayoutKind.Explicit, Size = 72)]
    private struct UsageCaps
    {
        [FieldOffset(0)] public ushort Page;
        [FieldOffset(2)] public byte ReportId;
        [FieldOffset(6)] public ushort Collection;
        [FieldOffset(12)] public byte IsRange;
        [FieldOffset(56)] public ushort Usage;
        [FieldOffset(58)] public ushort LastUsage;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
    [DllImport("hid.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.U1)]
    private static extern bool HidD_GetPreparsedData(SafeFileHandle handle, out IntPtr data);
    [DllImport("hid.dll")]
    [return: MarshalAs(UnmanagedType.U1)]
    private static extern bool HidD_FreePreparsedData(IntPtr data);
    [DllImport("hid.dll")] private static extern int HidP_GetCaps(IntPtr data, out Caps caps);
    [DllImport("hid.dll")] private static extern int HidP_GetValueCaps(int type, [Out] UsageCaps[] caps, ref ushort count, IntPtr data);
    [DllImport("hid.dll")] private static extern int HidP_GetButtonCaps(int type, [Out] UsageCaps[] caps, ref ushort count, IntPtr data);

    private static bool Describe(string path, Action<string> log)
    {
        using var file = CreateFileW(path, 0, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (file.IsInvalid || !HidD_GetPreparsedData(file, out var data)) throw new Win32Exception();
        try
        {
            CheckStatus(HidP_GetCaps(data, out var caps));
            log($"HID collection {caps.Page:X4}/{caps.Usage:X4}; link collections={caps.CollectionCount}; bytes IN/OUT/FEATURE={caps.InputBytes}/{caps.OutputBytes}/{caps.FeatureBytes}");
            var counts = new[] { (caps.InputValues, caps.InputButtons), (caps.OutputValues, caps.OutputButtons), (caps.FeatureValues, caps.FeatureButtons) };
            bool battery = false;
            for (var type = 0; type < counts.Length; type++)
            {
                foreach (var buttons in new[] { false, true })
                {
                    ushort count = buttons ? counts[type].Item2 : counts[type].Item1;
                    if (count == 0) continue;
                    var fields = new UsageCaps[count];
                    CheckStatus(buttons ? HidP_GetButtonCaps(type, fields, ref count, data) : HidP_GetValueCaps(type, fields, ref count, data));
                    foreach (var field in fields.Take(count))
                    {
                        var end = field.IsRange == 0 ? field.Usage : field.LastUsage;
                        log($"  {(HidReportType)type} ID={field.ReportId} link={field.Collection} {(buttons ? "button" : "value")} page={field.Page:X4} usages={field.Usage:X4}..{end:X4}");
                        if (type != 1 && !buttons && BatteryUsages.Any(u => u.Page == field.Page && u.Id >= field.Usage && u.Id <= end)) battery = true;
                    }
                }
            }
            return battery;
        }
        finally { HidD_FreePreparsedData(data); }
    }

    private static void CheckStatus(int status)
    {
        if (status != 0x00110000) throw new ExternalException("HID parser", status);
    }

    private static readonly (ushort Page, ushort Id)[] BatteryUsages = [(0x85, 0x64), (0x85, 0x65), (0x06, 0x20)];

    public static async Task InspectAsync(string path, Action<string> log, Action<BatteryReading> record, CancellationToken token)
    {
        try
        {
            if (!Describe(path, log)) { log("HID: no readable numeric battery usages found."); return; }
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            record(BatteryReading.Error(ConnectionType.Usb, "HID descriptor: " + DeviceDiagnosticsReport.ErrorCode(e)));
            // The WinRT parser may still expose the standard battery controls.
        }
        using var device = await HidDevice.FromIdAsync(path, FileAccessMode.Read).AsTask(token);
        if (device == null) { record(BatteryReading.Error(ConnectionType.Usb, "Windows could not open the HID collection for reading.")); return; }
        foreach (var type in new[] { HidReportType.Feature, HidReportType.Input })
        foreach (var usage in BatteryUsages)
        foreach (var field in device.GetNumericControlDescriptions(type, usage.Page, usage.Id))
        {
            var method = $"HID {type} ID={field.ReportId} usage={usage.Page:X2}/{usage.Id:X2}";
            log($"{method} logical={field.LogicalMinimum}..{field.LogicalMaximum}, bits={field.ReportSize}, count={field.ReportCount}, null={field.HasNull}");
            if (!field.IsAbsolute || field.ReportCount != 1) continue;
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
            deadline.CancelAfter(TimeSpan.FromSeconds(4));
            try
            {
                var value = type == HidReportType.Feature
                    ? (await device.GetFeatureReportAsync(field.ReportId).AsTask(deadline.Token)).GetNumericControlByDescription(field).Value
                    : (await device.GetInputReportAsync(field.ReportId).AsTask(deadline.Token)).GetNumericControlByDescription(field).Value;
                log($"{method} raw={value}");
                record(BatteryReading.FromHid(usage.Page, usage.Id, value, field.LogicalMinimum, field.LogicalMaximum, method));
            }
            catch (OperationCanceledException) when (!token.IsCancellationRequested)
            { record(BatteryReading.Error(ConnectionType.Usb, $"{method}: read timed out.")); }
            catch (Exception e) when (e is not OperationCanceledException)
            { record(BatteryReading.Error(ConnectionType.Usb, method + ": " + DeviceDiagnosticsReport.ErrorCode(e))); }
        }
    }
}

