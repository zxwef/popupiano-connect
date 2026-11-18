using System.Text;
using PopuConnect.Core;
using Windows.Devices.Enumeration;
using Windows.Devices.Midi;

namespace PopuConnect;

public sealed partial class MainForm
{
    private readonly DeviceDiagnosticsReport deviceReport = new();
    private readonly ComboBox batterySource = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 193, AccessibleName = "Battery source" };
    private readonly Label batteryStatus = new() { Text = "Battery level has not been checked.", AutoSize = true, MaximumSize = new(580, 0) };
    private readonly CheckBox showDiagnostics = new() { Appearance = Appearance.Button, Text = "Diagnostics and manual IDs", AutoSize = true };
    private readonly TextBox reportView = new() { Multiline = true, ReadOnly = true, Dock = DockStyle.Fill, ScrollBars = ScrollBars.Vertical };
    private readonly Dictionary<string, DateTimeOffset> lastSuccess = new(StringComparer.OrdinalIgnoreCase);
    private readonly Button export;
    private readonly Button captureButton;
    private readonly Label captureStatus = new() { Text = "USB SysEx · recording off.", AutoSize = true, MaximumSize = new(540, 0) };
    private UsbSysExCapture? usbCapture;
    private bool hasSnapshot;
    private string lastBle = "BLE GATT: unchecked. Select Bluetooth in Battery and select Check battery.";

    private async Task ToggleUsbCaptureAsync()
    {
        if (usbCapture is { IsRecording: true })
        {
            usbCapture.Dispose();
            captureButton.Text = "Record USB SysEx";
        }
        else
        {
            var usb = SelectedUsb();
            if (usb == null)
            {
                captureStatus.Text = "Select PopuPiano [USB] from the device list first.";
                return;
            }
            usbCapture = new(usb, deviceReport, typeof(MainForm).Assembly.GetName().Version?.ToString() ?? "—");
            captureButton.Text = "Stop recording";
            captureStatus.Text = "USB SysEx · looking for a MIDI input…";
            canMonitor = true;
            await usbCapture.UpdateAsync(usb.Available, lifetime.Token);
        }
        UpdateUsbCaptureReport();
    }

    private async Task RefreshUsbCaptureAsync(IReadOnlyList<MidiDevice> devices)
    {
        if (usbCapture is not { IsRecording: true } capture) return;
        bool present = devices.Any(device => device is { Type: ConnectionType.Usb, Available: true } &&
            device.MidiEndpointId.Equals(capture.Device.MidiEndpointId, StringComparison.OrdinalIgnoreCase) &&
            device.InstanceId.Equals(capture.Device.InstanceId, StringComparison.OrdinalIgnoreCase));
        await capture.UpdateAsync(present, lifetime.Token);
        UpdateUsbCaptureReport();
    }

    private void UpdateUsbCaptureReport()
    {
        if (usbCapture == null) return;
        captureStatus.Text = (usbCapture.IsRecording ? "Recording · " : "Stopped · ") + usbCapture.Summary();
        var current = usbCapture.Render();
        if (deviceReport.UsbSysExCapture == current) return;
        deviceReport.UsbSysExCapture = current;
        if (showDiagnostics.Checked) reportView.Text = deviceReport.Render();
    }

    private async Task CheckBatteryAsync()
    {
        var type = batterySource.SelectedIndex switch { 1 => ConnectionType.Usb, 2 => ConnectionType.Bluetooth, _ => controller.Device?.Type };
        if (type == null) { batteryStatus.Text = "Select a battery source or a MIDI device."; return; }
        batteryStatus.Text = "Checking battery level…";
        if (type == ConnectionType.Usb)
        {
            var usb = SelectedUsb();
            var trace = new StringBuilder();
            var reading = await UsbDeviceDiagnostics.InspectAsync(usb, deviceReport, line => trace.AppendLine(line), lifetime.Token);
            if (trace.Length > 0) Record($"USB battery check {deviceReport.Id(usb?.MidiEndpointId)}\r\n{trace}");
            ShowReading(reading, usb?.MidiEndpointId ?? "");
            return;
        }

        var address = controller.Device?.Type == ConnectionType.Bluetooth ? controller.Device.BluetoothDeviceId : "";
        if (address.Length == 0)
        {
            var candidates = devices.Items.OfType<MidiDevice>().Where(d => d.Type == ConnectionType.Bluetooth && d.BluetoothDeviceId.Length > 0)
                .Select(d => new BluetoothKeyboard(d.BluetoothDeviceId, d.Name)).ToList();
            if (settings.BluetoothDeviceId.Length > 0) candidates.Add(new(settings.BluetoothDeviceId, settings.DeviceName));
            try { candidates.AddRange(await discovery.DiscoverAsync(lifetime.Token)); }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                Record("BLE scan: " + DeviceDiagnosticsReport.ErrorCode(e));
                if (candidates.Count == 0)
                {
                    ShowReading(BatteryReading.Unavailable(ConnectionType.Bluetooth,
                        e is BluetoothDiscoveryException ? e.Message : "BLE scan failed: " + DeviceDiagnosticsReport.ErrorCode(e)), "");
                    return;
                }
            }
            if (candidates.Count == 0)
            {
                ShowReading(BatteryReading.Unavailable(ConnectionType.Bluetooth, "The BLE scan found no keyboard. Enable discovery mode."), "");
                return;
            }
            address = PickBluetooth(candidates);
            if (address.Length == 0) { batteryStatus.Text = "Bluetooth battery check canceled."; return; }
        }
        var key = address;
        Record("BLE read requested for " + deviceReport.Id(key));
        ShowReading(await BluetoothBatteryReader.ReadAsync(address, Record, lifetime.Token), key);
    }

    private MidiDevice? SelectedUsb() => controller.Device?.Type == ConnectionType.Usb ? controller.Device :
        DeviceSelection.Choose(new Settings { UsbEndpointId = settings.UsbEndpointId, UsbDeviceInstanceId = settings.UsbDeviceInstanceId,
            ConnectionPreference = ConnectionPreference.Usb }, devices.Items.OfType<MidiDevice>().ToArray());

    private string PickBluetooth(List<BluetoothKeyboard> candidates)
    {
        using var dialog = new Form { Text = "Bluetooth battery", ClientSize = new(500, 125), FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false, MinimizeBox = false, StartPosition = FormStartPosition.CenterParent, Padding = new(8) };
        var list = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 455 };
        list.Items.AddRange(candidates.DistinctBy(c => c.Id, StringComparer.OrdinalIgnoreCase).Cast<object>().ToArray());
        list.SelectedIndex = 0;
        var read = new Button { Text = "Read GATT", DialogResult = DialogResult.OK, AutoSize = true };
        var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, AutoSize = true };
        var panel = Column(); panel.Controls.Add(new Label { Text = "Select a keyboard for a separate BLE connection.", AutoSize = true });
        panel.Controls.Add(list); panel.Controls.Add(Row(read, cancel)); dialog.Controls.Add(panel);
        dialog.AcceptButton = read; dialog.CancelButton = cancel;
        return dialog.ShowDialog(this) == DialogResult.OK && list.SelectedItem is BluetoothKeyboard device ? device.Id : "";
    }

    private void Record(string entry)
    {
        deviceReport.Record(entry);
        if (showDiagnostics.Checked) reportView.Text = deviceReport.Render();
    }
    private void ShowReading(BatteryReading reading, string key)
    {
        var now = DateTimeOffset.Now;
        var source = reading.Source == ConnectionType.Usb ? "USB" : "Bluetooth";
        if (reading.Percent.HasValue) lastSuccess[key] = now;
        var stamp = lastSuccess.TryGetValue(key, out var time) ? $" · last read {time:dd.MM HH:mm:ss}" : "";
        batteryStatus.Text = $"{source} · {reading.Display}{stamp}";
        var line = $"{source} {deviceReport.Id(key)} {reading.State}: {reading.Display} ({now:O})";
        if (reading.Source == ConnectionType.Bluetooth) lastBle = line;
        Record(line);
    }

    private async Task CollectDiagnosticsAsync()
    {
        var sb = new StringBuilder();
        void Line(string s) => sb.AppendLine(s);
        Line($"PopuConnect {typeof(MainForm).Assembly.GetName().Version} | Windows {Environment.OSVersion.Version} | {DateTimeOffset.Now:O}");
        Line("Device IDs are replaced with session labels. The report enumerates system interfaces in read-only mode.");
        Line("Windows MIDI Services: " + MidiServiceStatus.Query());
        Line($"midi.exe: {(cli == null ? "not found" : "found")}");
        var selected = controller.Device;
        Line(selected == null ? "No device selected." :
            $"Selected: {deviceReport.Name(selected.Name)} {selected.Type}, MIDI={deviceReport.Id(selected.MidiEndpointId)}, Bluetooth={deviceReport.Id(selected.BluetoothDeviceId)}, instance={deviceReport.Id(selected.InstanceId)}, available={selected.Available}");
        async Task Section(string title, Func<Task> read)
        {
            Line(""); Line(title);
            try { await read(); }
            catch (Exception e) when (e is not OperationCanceledException) { Line("Error: " + DeviceDiagnosticsReport.ErrorCode(e)); }
        }
        if (cli != null)
        {
            await Section("CLI: enumerate endpoints --show-endpoint-id", async () =>
            {
                var ids = CliDeviceIds.Endpoints(await cli.RunAsync(lifetime.Token, "enumerate", "endpoints", "--show-endpoint-id"));
                Line($"exit=0; endpoints={ids.Count}"); foreach (var id in ids) Line("MIDI=" + deviceReport.Id(id));
            });
            await Section("CLI: bluetooth list", async () =>
            {
                var ids = CliDeviceIds.Bluetooth(await cli.RunAsync(lifetime.Token, "bluetooth", "list"));
                Line($"exit=0; devices={ids.Count}"); foreach (var id in ids) Line("Bluetooth=" + deviceReport.Id(id));
            });
        }
        await Section("Windows UMP endpoints", async () =>
        {
            var endpoints = await discovery.GetDestinationsAsync(lifetime.Token);
            Line($"Entries: {endpoints.Count}");
            foreach (var ep in endpoints)
                Line($"{deviceReport.Name(ep.Name)} MIDI={deviceReport.Id(ep.Id)} {ep.Type} group={ep.GroupIndex + 1} instance={deviceReport.Id(ep.InstanceId)}");
        });
        await Section("Windows USB MIDI outputs", async () =>
        {
            var outputs = await discovery.GetUsbOutputsAsync(lifetime.Token);
            Line($"Entries: {outputs.Count}");
            foreach (var ep in outputs) Line($"{deviceReport.Name(ep.Name)} USB MIDI={deviceReport.Id(ep.Id)} OUT={deviceReport.Id(ep.WindowsOutputId)} instance={deviceReport.Id(ep.InstanceId)}");
        });
        await Section("Windows Bluetooth MIDI outputs", async () =>
        {
            var outputs = await discovery.GetBluetoothOutputsAsync(lifetime.Token);
            Line($"Entries: {outputs.Count}");
            foreach (var ep in outputs) Line($"{deviceReport.Name(ep.Name)} MIDI={deviceReport.Id(ep.Id)} OUT={deviceReport.Id(ep.WindowsOutputId)} instance={deviceReport.Id(ep.InstanceId)}");
        });
        foreach (var port in new[] { ("IN", MidiInPort.GetDeviceSelector()), ("OUT", MidiOutPort.GetDeviceSelector()) })
            await Section("Windows MIDI " + port.Item1, async () =>
            {
                var found = await DeviceInformation.FindAllAsync(port.Item2).AsTask(lifetime.Token);
                Line($"Entries: {found.Count}"); foreach (var p in found) Line($"{deviceReport.Name(p.Name)} port={deviceReport.Id(p.Id)}");
            });
        await Section("USB: PnP / Power / HID", async () =>
        {
            var usb = SelectedUsb();
            var result = await UsbDeviceDiagnostics.InspectAsync(usb, deviceReport, Line, lifetime.Token);
            Line($"{result.State}: {result.Display}");
            if (selected?.Type == ConnectionType.Usb && batterySource.SelectedIndex != 2) ShowReading(result, usb?.MidiEndpointId ?? "");
        });
        Line(""); Line(lastBle);
        UpdateUsbCaptureReport();
        deviceReport.Snapshot = sb.ToString(); hasSnapshot = true;
        reportView.Text = deviceReport.Render(); showDiagnostics.Checked = true;
        status.Text = "Report ready. You can save it as a text file.";
    }

    private async Task ExportDiagnosticsAsync()
    {
        using var dialog = new SaveFileDialog { Title = "Export diagnostics", Filter = "Text report (*.txt)|*.txt",
            FileName = $"PopuConnect-{DateTime.Now:yyyyMMdd-HHmmss}.txt", DefaultExt = "txt" };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        UpdateUsbCaptureReport();
        await deviceReport.ExportAsync(dialog.FileName, lifetime.Token);
        status.Text = "Diagnostic report saved.";
    }
}

