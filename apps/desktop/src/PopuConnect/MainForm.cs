using PopuConnect.Core;

namespace PopuConnect;

public sealed partial class MainForm : Form
{
    private readonly SettingsStore store = new(SettingsStore.DefaultPath);
    private readonly Settings settings;
    private readonly CancellationTokenSource lifetime = new();
    private readonly ConnectionController controller;
    private readonly WindowsDeviceDiscovery discovery;
    private readonly MidiCli? cli;
    private readonly MidiDeviceCatalog catalog;
    private readonly ComboBox devices = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 500, DropDownWidth = 950 };
    private readonly CheckBox preferUsb = new() { Text = "Prefer USB automatically", AutoSize = true };
    private readonly CheckBox autoConnect = new() { Text = "Connect on startup", AutoSize = true };
    private readonly CheckBox autoOff = new() { Text = "Turn off main module lights on connect", AutoSize = true };
    private readonly Label connection = new() { Text = "Checking Windows MIDI Services…", AutoSize = true };
    private readonly Label status = new() { Text = "Starting…", AutoSize = true, MaximumSize = new(550, 0) };
    private readonly TextBox diagnostics = new() { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, WordWrap = false, Dock = DockStyle.Fill, Visible = false };
    private readonly List<Control> actions = [];
    private readonly Button off;
    private readonly Button apply;
    private readonly Button color;
    private readonly System.Windows.Forms.Timer monitor = new() { Interval = 2000 };
    private readonly TextBox bluetoothId = new() { Width = 500, PlaceholderText = "Bluetooth ID from midi bluetooth list" };
    private readonly TextBox endpointId = new() { Width = 500, PlaceholderText = "Exact MIDI endpoint ID (if ambiguous)" };
    private bool busy;
    private bool initialized;
    private bool selecting;
    private bool canMonitor;
    private bool closing;
    private bool shutdownComplete;
    private TaskCompletionSource? activeOperationDone;
    private Color selectedColor;
    private string? loadError;

    public MainForm()
    {
        try { settings = store.Load(); }
        catch (Exception e) when (e is IOException or System.Text.Json.JsonException or UnauthorizedAccessException)
        { settings = new(); loadError = $"Could not read settings: {e.Message}. The original file will stay intact until new settings are saved."; }
        var cliPath = MidiCliLocation.Find();
        cli = cliPath == null ? null : new MidiCli(Log, cliPath);
        discovery = new(Log, entry => { if (!closing) Record(entry); });
        catalog = new(cli, discovery, Log, discovery);
        controller = new(cli, discovery, settings, () => store.Save(settings), discovery);
        Text = "PopuConnect";
        Font = new("Segoe UI", 10);
        BackColor = Color.FromArgb(246, 247, 249);
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new(665, 610);
        MinimumSize = new(620, 410);
        AutoScroll = true;
        StartPosition = FormStartPosition.CenterScreen;
        selectedColor = Color.FromArgb(settings.ColorRgb | unchecked((int)0xFF000000));

        var root = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 1, RowCount = 6, Padding = new(16) };
        Controls.Add(root);
        var connectBox = Box("Connection");
        var connectLayout = Column(); connectBox.Controls.Add(connectLayout);
        connectLayout.Controls.Add(devices); connectLayout.Controls.Add(connection);
        var connect = ActionButton("Connect / Retry", ConnectAsync);
        var refresh = ActionButton("Refresh devices", RefreshAsync);
        connectLayout.Controls.Add(Row(connect, refresh));
        autoConnect.Checked = settings.AutoConnect;
        connectLayout.Controls.Add(autoConnect);
        preferUsb.Checked = settings.ConnectionPreference == ConnectionPreference.Automatic;
        connectLayout.Controls.Add(preferUsb);
        if (cli == null)
        {
            var toolsLink = new LinkLabel { Text = "Optional: Windows MIDI Services Tools", AutoSize = true };
            toolsLink.LinkClicked += (_, _) =>
            {
                try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("https://github.com/microsoft/MIDI/releases") { UseShellExecute = true }); }
                catch (System.ComponentModel.Win32Exception e) { status.Text = e.Message; }
            };
            connectLayout.Controls.Add(toolsLink);
        }
        root.Controls.Add(connectBox, 0, 0);

        var lightsBox = Box("Lighting"); var lightsLayout = Column(); lightsBox.Controls.Add(lightsLayout);
        off = ActionButton("Turn off lights", () => SendLightingAsync(
            PopuPianoLighting.OffFrames(), "Lights-off commands sent."));
        off.BackColor = Color.FromArgb(225, 234, 245);
        var hints = new ToolTip();
        hints.SetToolTip(off, "Turns off the main module and ExtraPiano lights.");
        Disposed += (_, _) => hints.Dispose();
        lightsLayout.Controls.Add(off);
        autoOff.Checked = settings.AutoLightsOff; lightsLayout.Controls.Add(autoOff);
        color = new Button { Text = "Choose color…", AutoSize = true, BackColor = selectedColor };
        color.Click += (_, _) => ChooseColor(); actions.Add(color);
        apply = ActionButton("Apply to all keys", () => SendLightingAsync(
            [PopuPianoLighting.Palette(selectedColor.R, selectedColor.G, selectedColor.B), PopuPianoLighting.AllOn()], "Command sent."));
        lightsLayout.Controls.Add(Row(color, apply)); root.Controls.Add(lightsBox, 0, 1);
        var batteryBox = Box("Battery"); var batteryLayout = Column(); batteryBox.Controls.Add(batteryLayout);
        batterySource.Items.AddRange(["Follow MIDI connection", "USB", "Bluetooth (BLE)"]);
        batterySource.SelectedIndex = 0;
        batterySource.SelectedIndexChanged += (_, _) => batteryStatus.Text = "Select Check battery to read the chosen source.";
        batteryLayout.Controls.Add(Row(batterySource, ActionButton("Check battery", CheckBatteryAsync)));
        batteryLayout.Controls.Add(batteryStatus);
        root.Controls.Add(batteryBox, 0, 2);
        root.Controls.Add(status, 0, 3);

        var collect = ActionButton("Collect device diagnostics", CollectDiagnosticsAsync);
        export = ActionButton("Export diagnostics", ExportDiagnosticsAsync);
        root.Controls.Add(Row(collect, export, showDiagnostics), 0, 4);
        var details = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, Visible = false, MinimumSize = new(0, 0) };
        details.RowStyles.Add(new(SizeType.AutoSize)); details.RowStyles.Add(new(SizeType.AutoSize));
        details.RowStyles.Add(new(SizeType.AutoSize)); details.RowStyles.Add(new(SizeType.Percent, 100));
        details.Controls.Add(bluetoothId); details.Controls.Add(endpointId);
        bluetoothId.Visible = cli != null;
        var saveIds = ActionButton("Validate and save IDs", SaveManualAsync);
        var report = ActionButton(cli == null ? "Windows MIDI ports" : "CLI output", async () =>
        {
            if (cli == null)
            {
                var ports = await catalog.RefreshAsync(false, lifetime.Token);
                Log($"Windows USB/Bluetooth MIDI outputs: {ports.Count}.");
                foreach (var port in ports) Log($"{port.Name} | {port.Type} | {port.MidiEndpointId}");
                return;
            }
            await cli.RunAsync(lifetime.Token, "enumerate", "endpoints", "--show-endpoint-id");
            try
            {
                await cli.RunAsync(lifetime.Token, "bluetooth", "status");
                await cli.RunAsync(lifetime.Token, "bluetooth", "list");
            }
            catch (Exception e) when (e is InvalidOperationException or TimeoutException) { Log(e.Message); }
        });
        var copy = new Button { Text = "Copy log", AutoSize = true };
        copy.Click += (_, _) => { if (diagnostics.TextLength > 0) Clipboard.SetText(diagnostics.Text); };
        details.Controls.Add(Row(saveIds, report, copy));
        details.Controls.Add(diagnostics);
        var tabs = new TabControl { Dock = DockStyle.Top, Height = 245, Visible = false };
        var snapshotTab = new TabPage("Report preview");
        captureButton = ActionButton("Record USB SysEx", ToggleUsbCaptureAsync);
        var snapshotLayout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3 };
        snapshotLayout.RowStyles.Add(new(SizeType.AutoSize));
        snapshotLayout.RowStyles.Add(new(SizeType.AutoSize));
        snapshotLayout.RowStyles.Add(new(SizeType.Percent, 100));
        snapshotLayout.Controls.Add(captureButton, 0, 0);
        snapshotLayout.Controls.Add(captureStatus, 0, 1);
        snapshotLayout.Controls.Add(reportView, 0, 2);
        snapshotTab.Controls.Add(snapshotLayout);
        var liveTab = new TabPage("Local log and manual IDs"); liveTab.Controls.Add(details);
        tabs.TabPages.Add(snapshotTab); tabs.TabPages.Add(liveTab);
        root.Controls.Add(tabs, 0, 5);
        details.Visible = diagnostics.Visible = true;
        showDiagnostics.CheckedChanged += (_, _) =>
        {
            tabs.Visible = showDiagnostics.Checked;
            if (showDiagnostics.Checked) reportView.Text = deviceReport.Render();
            if (WindowState == FormWindowState.Normal)
                Height = Math.Min(root.PreferredSize.Height + Height - ClientSize.Height + 8, Screen.FromControl(this).WorkingArea.Height);
        };
        controller.SendingTo += (ep, frames) =>
        {
            Record($"{ep.Type} SysEx OUT: MIDI={deviceReport.Id(ep.Id)} instance={deviceReport.Id(ep.InstanceId)}");
            if (usbCapture is { IsRecording: true } capture) capture.RecordSend(ep, frames);
        };
        controller.LightingActivity += message =>
        {
            var entry = $"{controller.Device?.Type} {message}";
            Record(entry);
            Log(entry);
        };
        devices.SelectedIndexChanged += async (_, _) =>
        {
            if (selecting || !initialized || busy || devices.SelectedItem is not MidiDevice chosen) return;
            await RunAsync(async () =>
            {
                SelectDevice(chosen); store.Save(settings);
                status.Text = "Device saved. Select Connect / Retry.";
                await PollAsync();
            });
        };
        autoConnect.CheckedChanged += (_, _) => SaveOptions();
        autoOff.CheckedChanged += (_, _) => SaveOptions();
        preferUsb.CheckedChanged += async (_, _) =>
        {
            if (selecting || !initialized || busy) return;
            await RunAsync(async () =>
            {
                settings.ConnectionPreference = preferUsb.Checked ? ConnectionPreference.Automatic
                    : controller.Device?.Type == ConnectionType.Usb ? ConnectionPreference.Usb : ConnectionPreference.Bluetooth;
                store.Save(settings);
                await UpdateDeviceListAsync(false);
                await PollAsync();
            });
        };
        monitor.Tick += async (_, _) =>
        {
            if (!busy && initialized && canMonitor && !devices.DroppedDown && !batterySource.DroppedDown) await RunAsync(async () =>
            {
                await UpdateDeviceListAsync(false);
                await PollAsync();
            }, quiet: true);
        };
        Shown += async (_, _) =>
        {
            initialized = true;
            Log(cliPath == null ? "midi.exe was not found. Using Windows USB and Bluetooth MIDI outputs." : $"MIDI CLI: {cliPath}");
            if (loadError != null) { Log(loadError); status.Text = loadError; }
            await RunAsync(async () =>
            {
                await controller.CheckEnvironmentAsync(lifetime.Token, includeBluetooth: false);
                canMonitor = true;
                await RefreshAsync();
                if (settings.AutoConnect && controller.Device != null) await ConnectAsync();
            });
            if (!closing) monitor.Start();
        };
        FormClosing += async (_, e) =>
        {
            if (shutdownComplete) return;
            e.Cancel = true;
            if (closing) return;
            closing = true; monitor.Stop(); lifetime.Cancel();
            // Keep the message loop alive until CLI cancellation and .syx cleanup finish.
            await Task.Yield();
            if (activeOperationDone != null) await activeOperationDone.Task;
            shutdownComplete = true;
            Close();
        };
        FormClosed += (_, _) => { discovery.ReleaseBluetoothOutput(); usbCapture?.Dispose(); monitor.Dispose(); lifetime.Dispose(); };
        UpdateLighting();
    }

    private static GroupBox Box(string title) => new() { Text = title, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Dock = DockStyle.Top, Padding = new(12), Margin = new(0, 0, 0, 12) };
    private static FlowLayoutPanel Column() => new() { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, Dock = DockStyle.Fill };
    private static FlowLayoutPanel Row(params Control[] controls)
    {
        var row = new FlowLayoutPanel { AutoSize = true, WrapContents = true, Margin = Padding.Empty };
        row.Controls.AddRange(controls); return row;
    }
    private Button ActionButton(string text, Func<Task> operation)
    {
        var button = new Button { Text = text, AutoSize = true, Padding = new(6, 2, 6, 2) };
        button.Click += async (_, _) => await RunAsync(operation);
        actions.Add(button); return button;
    }
    private async Task RunAsync(Func<Task> operation, bool quiet = false)
    {
        if (busy || closing) return;
        busy = true;
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        activeOperationDone = done;
        foreach (var control in actions) control.Enabled = false;
        batterySource.Enabled = false;
        devices.Enabled = autoConnect.Enabled = autoOff.Enabled = preferUsb.Enabled = false;
        try { await operation(); }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception e)
        {
            if (closing) return;
            status.Text = e.Message;
            Record("Operation failed: " + DeviceDiagnosticsReport.ErrorCode(e));
            for (Exception? cause = e; cause != null; cause = cause.InnerException)
                Log($"{cause.GetType().Name} (0x{cause.HResult:X8}): {cause.Message}");
            connection.Text = "Connection not confirmed";
            if (!quiet) diagnostics.SelectionStart = diagnostics.TextLength;
        }
        finally
        {
            if (!closing)
            {
                busy = false;
                foreach (var control in actions) control.Enabled = true;
                devices.Enabled = autoConnect.Enabled = autoOff.Enabled = preferUsb.Enabled = true;
                UpdateLighting();
            }
            done.TrySetResult();
        }
    }
    private async Task RefreshAsync()
    {
        status.Text = "Looking for USB and Bluetooth MIDI devices…";
        await UpdateDeviceListAsync(true);
        canMonitor = true;
        status.Text = controller.Device == null ? "Select your PopuPiano or enter its IDs in Diagnostics." : "Device list refreshed.";
        if (cli == null && controller.Device == null)
            status.Text = "Select your PopuPiano. For Bluetooth, pair it in Windows first.";
        await PollAsync();
    }
    private async Task UpdateDeviceListAsync(bool scanBluetooth)
    {
        var found = (await catalog.RefreshAsync(scanBluetooth, lifetime.Token)).ToList();
        if (cli != null && settings.BluetoothDeviceId.Length > 0 && !found.Any(d => d.Type == ConnectionType.Bluetooth && d.BluetoothDeviceId.Equals(settings.BluetoothDeviceId, StringComparison.OrdinalIgnoreCase)))
            found.Add(new(settings.DeviceName, ConnectionType.Bluetooth, BluetoothDeviceId: settings.BluetoothDeviceId, Available: false));
        if (cli == null && settings.WindowsBluetoothEndpointId.Length > 0 && !found.Any(d => d.IsWindowsBluetooth &&
            d.MidiEndpointId.Equals(settings.WindowsBluetoothEndpointId, StringComparison.OrdinalIgnoreCase)))
            found.Add(new(settings.WindowsBluetoothDeviceName, ConnectionType.Bluetooth, MidiEndpointId: settings.WindowsBluetoothEndpointId,
                InstanceId: settings.WindowsBluetoothInstanceId, Available: false, IsWindowsBluetooth: true));
        if (settings.UsbEndpointId.Length > 0 && !found.Any(d => d.Type == ConnectionType.Usb &&
            (d.MidiEndpointId.Equals(settings.UsbEndpointId, StringComparison.OrdinalIgnoreCase) || d.InstanceId.Equals(settings.UsbDeviceInstanceId, StringComparison.OrdinalIgnoreCase))))
            found.Add(new(settings.UsbDeviceName, ConnectionType.Usb, MidiEndpointId: settings.UsbEndpointId, InstanceId: settings.UsbDeviceInstanceId, Available: false));
        var chosen = DeviceSelection.Choose(settings, found);
        if (controller.Device?.Key != chosen?.Key || controller.Device?.Available != chosen?.Available)
            batteryStatus.Text = "Battery level has not been checked for this connection.";
        controller.Device = chosen;
        selecting = true;
        try
        {
            if (!devices.Items.Cast<MidiDevice>().SequenceEqual(found))
            { devices.Items.Clear(); devices.Items.AddRange(found.Cast<object>().ToArray()); }
            devices.SelectedItem = chosen;
            preferUsb.Checked = settings.ConnectionPreference == ConnectionPreference.Automatic;
        }
        finally { selecting = false; }
        if (!bluetoothId.Focused) bluetoothId.Text = settings.BluetoothDeviceId;
        if (!endpointId.Focused) endpointId.Text = chosen is { Type: ConnectionType.Usb } or { IsWindowsBluetooth: true }
            ? chosen.MidiEndpointId : settings.MidiEndpointId;
        await RefreshUsbCaptureAsync(found);
    }
    private void SelectDevice(MidiDevice device)
    {
        if (controller.Device?.Key != device.Key) batteryStatus.Text = "Battery level has not been checked for this connection.";
        controller.Device = device;
        if (device.Type == ConnectionType.Usb)
        {
            settings.UsbEndpointId = device.MidiEndpointId; settings.UsbDeviceInstanceId = device.InstanceId; settings.UsbDeviceName = device.Name;
            settings.ConnectionPreference = ConnectionPreference.Usb;
        }
        else if (device.IsWindowsBluetooth)
        {
            settings.WindowsBluetoothEndpointId = device.MidiEndpointId;
            settings.WindowsBluetoothInstanceId = device.InstanceId;
            settings.WindowsBluetoothDeviceName = device.Name;
            settings.ConnectionPreference = ConnectionPreference.Bluetooth;
        }
        else
        {
            if (settings.BluetoothDeviceId != device.BluetoothDeviceId) { settings.MidiEndpointId = ""; settings.RetentionConfiguredFor = ""; }
            settings.BluetoothDeviceId = device.BluetoothDeviceId; settings.DeviceName = device.Name;
            settings.ConnectionPreference = ConnectionPreference.Bluetooth;
        }
        selecting = true;
        try { preferUsb.Checked = false; } finally { selecting = false; }
        bluetoothId.Text = settings.BluetoothDeviceId;
        endpointId.Text = device.Type == ConnectionType.Usb || device.IsWindowsBluetooth ? device.MidiEndpointId : settings.MidiEndpointId;
    }
    private async Task ConnectAsync()
    {
        var selected = controller.Device;
        if (selected == null)
            throw new InvalidOperationException("Select a keyboard from the list first.");
        await controller.CheckEnvironmentAsync(lifetime.Token, includeBluetooth: selected.Type == ConnectionType.Bluetooth && !selected.IsWindowsBluetooth);
        canMonitor = true;
        status.Text = "Connecting to PopuPiano…";
        await controller.ConnectAsync(lifetime.Token);
        status.Text = selected.IsWindowsBluetooth ? "Windows opened the Bluetooth MIDI output."
            : selected.Type == ConnectionType.Usb ? "USB MIDI is available in Windows." : "Bluetooth MIDI connected.";
        await PollAsync();
    }
    private async Task PollAsync()
    {
        var sent = await controller.PollAsync(lifetime.Token);
        var type = controller.Device?.Type == ConnectionType.Usb ? "USB" : "Bluetooth";
        connection.Text = controller.Ready ? $"{type} MIDI connected · output ready" : controller.Device == null ? "Select a device" : $"Waiting for {type} MIDI";
        if (controller.Device?.IsWindowsBluetooth == true && controller.Ready)
            connection.Text = "Bluetooth MIDI · Windows output found";
        if (cli == null && controller.Device == null)
            connection.Text = devices.Items.Cast<MidiDevice>().Any(d => d.Available)
                ? "Windows MIDI · select a keyboard" : "Windows MIDI · no USB or Bluetooth outputs found";
        if (controller.Device is { Type: ConnectionType.Usb, Available: true, SupportsOutput: false })
            connection.Text = "USB MIDI found · group 1 output unavailable";
        if (sent) status.Text = "Command sent.";
        UpdateLighting();
    }
    private async Task SendLightingAsync(byte[][] messages, string successMessage)
    {
        await controller.SendAsync(messages, lifetime.Token);
        status.Text = successMessage;
    }
    private async Task SaveManualAsync()
    {
        var preferred = endpointId.Text.Trim();
        var outputs = await controller.GetUsbDestinationsAsync(lifetime.Token);
        var usb = outputs.FirstOrDefault(e => e.Id.Equals(preferred, StringComparison.OrdinalIgnoreCase) && e.Type == ConnectionType.Usb && e.GroupIndex == 0);
        if (usb != null)
        {
            SelectDevice(new(usb.Name, ConnectionType.Usb, MidiEndpointId: usb.Id, InstanceId: usb.InstanceId));
            store.Save(settings); canMonitor = true;
            await PollAsync();
            status.Text = "USB endpoint validated and saved.";
            return;
        }
        if (cli == null)
        {
            var ports = await discovery.GetBluetoothOutputsAsync(lifetime.Token);
            var output = ports.FirstOrDefault(p => p.Id.Equals(preferred, StringComparison.OrdinalIgnoreCase));
            if (output == null) throw new InvalidOperationException("Enter the ID of an available USB or Bluetooth MIDI output from the Windows MIDI ports list.");
            SelectDevice(new(output.Name, ConnectionType.Bluetooth, MidiEndpointId: output.Id, InstanceId: output.InstanceId, IsWindowsBluetooth: true));
            store.Save(settings);
            canMonitor = true;
            await PollAsync();
            status.Text = "Bluetooth MIDI output validated and saved.";
            return;
        }
        var id = EndpointSelection.NormalizeBluetoothId(bluetoothId.Text);
        var snapshot = await discovery.InspectAsync(id, lifetime.Token);
        if (preferred.Length > 0 && !snapshot.Destinations.Any(e => e.Id.Equals(preferred, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("The MIDI ID does not match an output endpoint. Check the CLI output.");
        var endpoint = EndpointSelection.Resolve(id, preferred, snapshot.Destinations);
        if (preferred.Length > 0 && endpoint?.Id.Equals(preferred, StringComparison.OrdinalIgnoreCase) != true)
            throw new InvalidOperationException("The endpoint does not match this keyboard's Bluetooth ID and group 1.");
        SelectDevice(new("PopuPiano", ConnectionType.Bluetooth, BluetoothDeviceId: id)); settings.MidiEndpointId = endpoint?.Id ?? "";
        store.Save(settings);
        canMonitor = true;
        status.Text = "IDs validated and saved. Select Connect / Retry.";
        await PollAsync();
    }
    private void ChooseColor()
    {
        using var dialog = new ColorDialog { Color = selectedColor, FullOpen = true };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        selectedColor = dialog.Color; color.BackColor = selectedColor;
        SaveOptions();
    }
    private void SaveOptions()
    {
        if (!initialized || closing) return;
        settings.AutoConnect = autoConnect.Checked; settings.AutoLightsOff = autoOff.Checked;
        settings.ColorRgb = selectedColor.ToArgb() & 0xFFFFFF;
        try { store.Save(settings); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { status.Text = "Could not save settings."; Log(e.ToString()); }
    }
    private void UpdateLighting()
    {
        off.Enabled = apply.Enabled = !busy && controller.Ready;
        batterySource.Enabled = !busy;
        export.Enabled = !busy && (hasSnapshot || usbCapture != null);
    }
    private void Log(string text)
    {
        if (closing || IsDisposed || string.IsNullOrWhiteSpace(text)) return;
        if (InvokeRequired) { BeginInvoke(() => Log(text)); return; }
        if (diagnostics.TextLength > 100_000) diagnostics.Text = diagnostics.Text[^50_000..];
        diagnostics.AppendText($"[{DateTime.Now:HH:mm:ss}] {text.TrimEnd()}\r\n");
    }
}
