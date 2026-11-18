using PopuConnect.Core;
using Xunit;

namespace PopuConnect.Tests;

public sealed class UsbMidiTests
{
    private const string Address = "AABBCCDDEEFF";
    private const string UsbId = @"\\?\swd#midisrv#midiu_usb_123#{e7cce071-3c03-423f-88d3-f1045d02552b}";
    private const string BtId = @"\\?\swd#midisrv#midiu_blemidi_popupiano_aabbccddeeff#{e7cce071-3c03-423f-88d3-f1045d02552b}";
    private static readonly MidiDestination UsbEndpoint = new(UsbId, "PopuPiano", @"SWD\MIDISRV\USB_123", "KSA", 0) { Type = ConnectionType.Usb };
    private static readonly MidiDestination BtEndpoint = new(BtId, "PopuPiano", @"SWD\MIDISRV\MIDIU_BLEMIDI_PopuPiano_" + Address, "BLEMIDI", 0) { Type = ConnectionType.Bluetooth };
    private static readonly MidiDevice Usb = new("PopuPiano", ConnectionType.Usb, MidiEndpointId: UsbId, InstanceId: UsbEndpoint.InstanceId);
    private static readonly MidiDevice Bluetooth = new("PopuPiano", ConnectionType.Bluetooth, BluetoothDeviceId: Address, MidiEndpointId: BtId);

    [Fact]
    public void CliIdsIgnoreFormattingAndNeverTreatEndpointIdAsBluetoothAddress()
    {
        Assert.Equal(new[] { UsbId }, CliDeviceIds.Endpoints($"Count: 1\r\nID: \u001b[32m{UsbId}\u001b[0m\r\n").ToArray());
        Assert.Empty(CliDeviceIds.Bluetooth(BtId));
        Assert.Equal(new[] { Address }, CliDeviceIds.Bluetooth($"│ {Address} │ PopuPiano │\nAA:BB:CC:DD:EE:FF\naa-bb-cc-dd-ee-ff").ToArray());
        Assert.Empty(CliDeviceIds.Bluetooth("prefixAABBCCDDEEFFsuffix 0000000000000"));
        Assert.Empty(CliDeviceIds.Endpoints(Address));
    }

    [Fact]
    public void UsbNeedsTransportAndBusMetadata()
    {
        Assert.Equal(ConnectionType.Usb, TransportIdentity.Classify("KSA", @"\\?\usb#vid_1234", 0));
        Assert.Equal(ConnectionType.Usb, TransportIdentity.Classify("KS", "", 1234));
        Assert.Equal(ConnectionType.Unknown, TransportIdentity.Classify("KSA", @"\\?\pci#1234", 0));
        Assert.Equal(ConnectionType.Unknown, TransportIdentity.Classify("VIRTUAL", @"\\?\usb#1234", 1234));
        Assert.Equal(ConnectionType.Bluetooth, TransportIdentity.Classify("BLEMIDI", @"\\?\usb#1234", 1234));
    }

    [Fact]
    public async Task CatalogRunsBothCliCommandsAndCombinesVerifiedTransports()
    {
        var cli = new FakeCli(); var discovery = new FakeDiscovery();
        var result = await new MidiDeviceCatalog(cli, discovery, _ => { }).RefreshAsync(false, CancellationToken.None);
        Assert.Equal(2, result.Count);
        Assert.Equal(ConnectionType.Usb, result[0].Type);
        Assert.Equal(UsbId, result[0].MidiEndpointId); Assert.Empty(result[0].BluetoothDeviceId);
        Assert.Equal(ConnectionType.Bluetooth, result[1].Type);
        Assert.Equal(Address, result[1].BluetoothDeviceId);
        Assert.Contains(cli.Calls, c => c.SequenceEqual(new[] { "enumerate", "endpoints", "--show-endpoint-id" }));
        Assert.Contains(cli.Calls, c => c.SequenceEqual(new[] { "bluetooth", "list" }));
        discovery.Outputs = [UsbEndpoint with { Type = ConnectionType.Unknown }];
        Assert.DoesNotContain(await new MidiDeviceCatalog(cli, discovery, _ => { }).RefreshAsync(false, CancellationToken.None), d => d.Type == ConnectionType.Usb);
    }

    [Fact]
    public async Task UsbWorksEvenIfBluetoothCliFails()
    {
        var cli = new FakeCli { FailBluetooth = true }; var discovery = new FakeDiscovery();
        var result = await new MidiDeviceCatalog(cli, discovery, _ => { }).RefreshAsync(true, CancellationToken.None);
        Assert.Single(result); Assert.Equal(Usb, result[0]);
        var controller = new ConnectionController(cli, discovery, new(), () => { }) { Device = Usb };
        await controller.CheckEnvironmentAsync(CancellationToken.None, includeBluetooth: false);
        await controller.ConnectAsync(CancellationToken.None);
        await controller.SendAsync([PopuPianoLighting.AllOff()], CancellationToken.None);
        Assert.Equal(UsbId, cli.SentEndpoint);
        Assert.Equal(0, discovery.BluetoothInspections);
    }

    [Fact]
    public async Task UsbInputOnlyEndpointIsListedButCannotReceiveLighting()
    {
        var cli = new FakeCli(); var discovery = new FakeDiscovery { Outputs = [UsbEndpoint with { GroupIndex = -1 }] };
        var result = await new MidiDeviceCatalog(cli, discovery, _ => { }).RefreshAsync(false, CancellationToken.None);
        var device = Assert.Single(result, d => d.Type == ConnectionType.Usb);
        Assert.True(device.Available); Assert.False(device.SupportsOutput);
        var controller = new ConnectionController(cli, discovery, new(), () => { }) { Device = device };
        Assert.False(await controller.PollAsync(CancellationToken.None));
        await Assert.ThrowsAsync<InvalidOperationException>(() => controller.SendAsync([PopuPianoLighting.AllOff()], CancellationToken.None));
        Assert.Equal(0, cli.SendCount);
    }

    [Fact]
    public async Task UsbConnectNeverInvokesBluetoothAndSettingsStaySeparate()
    {
        var cli = new FakeCli(); var discovery = new FakeDiscovery();
        var settings = new Settings { BluetoothDeviceId = Address, MidiEndpointId = BtId, RetentionConfiguredFor = Address };
        var controller = new ConnectionController(cli, discovery, settings, () => { }) { Device = Usb };
        await controller.ConnectAsync(CancellationToken.None);
        Assert.Empty(cli.Calls);
        await controller.SendAsync([PopuPianoLighting.AllOff()], CancellationToken.None);
        Assert.Equal(UsbId, cli.SentEndpoint);
        Assert.Equal(UsbId, settings.UsbEndpointId); Assert.Equal(UsbEndpoint.InstanceId, settings.UsbDeviceInstanceId);
        Assert.Equal(Address, settings.BluetoothDeviceId); Assert.Equal(BtId, settings.MidiEndpointId); Assert.Equal(Address, settings.RetentionConfiguredFor);
        Assert.DoesNotContain(cli.Calls, c => c[0] == "bluetooth");
    }

    [Fact]
    public void AutomaticPreferenceAndManualChoiceHandleUsbUnplugAndReplug()
    {
        var settings = new Settings { BluetoothDeviceId = Address, MidiEndpointId = BtId, UsbEndpointId = UsbId };
        Assert.Equal(Usb, DeviceSelection.Choose(settings, [Bluetooth, Usb]));
        settings.ConnectionPreference = ConnectionPreference.Bluetooth;
        Assert.Equal(Bluetooth, DeviceSelection.Choose(settings, [Bluetooth, Usb]));
        settings.ConnectionPreference = ConnectionPreference.Automatic;
        settings.UsbEndpointId = UsbId; settings.UsbDeviceInstanceId = Usb.InstanceId;
        Assert.Equal(Bluetooth, DeviceSelection.Choose(settings, [Bluetooth, Usb with { Available = false }]));
        Assert.Equal(Usb, DeviceSelection.Choose(settings, [Bluetooth, Usb]));
        var changed = Usb with { MidiEndpointId = UsbId + "-new" };
        Assert.Equal(changed, DeviceSelection.Choose(settings, [Bluetooth, changed]));
        settings.ConnectionPreference = ConnectionPreference.Usb;
        Assert.Equal(Usb with { Available = false }, DeviceSelection.Choose(settings, [Bluetooth, Usb with { Available = false }]));
    }

    [Fact]
    public void NoArbitraryUsbDeviceIsSelectedAutomatically()
    {
        Assert.Null(DeviceSelection.Choose(new(), [Usb]));
        var settings = new Settings { BluetoothDeviceId = Address };
        Assert.Equal(Bluetooth, DeviceSelection.Choose(settings, [Bluetooth, Usb]));
        Assert.Equal(Bluetooth, DeviceSelection.Choose(settings, [Bluetooth, Usb with { Name = "Other keyboard" }]));
        Assert.Equal(Bluetooth, DeviceSelection.Choose(settings, [Bluetooth, Usb with { Name = "Populated Synth" }]));
        Assert.Equal(Bluetooth, DeviceSelection.Choose(settings, [Bluetooth, Usb, Usb with { MidiEndpointId = "another" }]));
        Assert.Equal(Bluetooth, DeviceSelection.Choose(settings, [Bluetooth, Usb with { Type = ConnectionType.Unknown }]));
    }

    [Fact]
    public async Task UnplugResetsUsbAutomaticLightingAndBlocksManualSend()
    {
        var cli = new FakeCli(); var discovery = new FakeDiscovery();
        var controller = new ConnectionController(cli, discovery, new() { AutoLightsOff = true }, () => { }) { Device = Usb };
        Assert.True(await controller.PollAsync(CancellationToken.None));
        Assert.False(await controller.PollAsync(CancellationToken.None));
        discovery.Outputs = [BtEndpoint];
        Assert.False(await controller.PollAsync(CancellationToken.None)); Assert.False(controller.Ready);
        await Assert.ThrowsAsync<InvalidOperationException>(() => controller.SendAsync([PopuPianoLighting.AllOff()], CancellationToken.None));
        discovery.Outputs = [UsbEndpoint, BtEndpoint];
        Assert.True(await controller.PollAsync(CancellationToken.None));
        Assert.Equal(2, cli.SendCount);
    }

    [Fact]
    public async Task UsbIdentityAndDirectionAreRevalidatedBeforeSending()
    {
        var cli = new FakeCli(); var discovery = new FakeDiscovery { Outputs = [UsbEndpoint with { Type = ConnectionType.Bluetooth }] };
        var controller = new ConnectionController(cli, discovery, new(), () => { }) { Device = Usb };
        await Assert.ThrowsAsync<InvalidOperationException>(() => controller.SendAsync([PopuPianoLighting.AllOff()], CancellationToken.None));
        discovery.Outputs = [UsbEndpoint with { GroupIndex = 1 }];
        await Assert.ThrowsAsync<InvalidOperationException>(() => controller.ConnectAsync(CancellationToken.None));
        discovery.Outputs = [UsbEndpoint with { InstanceId = "wrong-device" }];
        await Assert.ThrowsAsync<InvalidOperationException>(() => controller.SendAsync([PopuPianoLighting.AllOff()], CancellationToken.None));
        Assert.Empty(cli.Calls);
    }

    [Fact]
    public async Task UsbUnplugDuringSendIsReportedAndFileDeleted()
    {
        var cli = new FakeCli(); var discovery = new FakeDiscovery();
        cli.AfterSend = () => discovery.Outputs = [BtEndpoint];
        var controller = new ConnectionController(cli, discovery, new(), () => { }) { Device = Usb };
        await Assert.ThrowsAsync<InvalidOperationException>(() => controller.SendAsync([PopuPianoLighting.AllOff()], CancellationToken.None));
        Assert.False(controller.Ready);
        Assert.False(File.Exists(cli.Calls.Single(c => c[0] == "sysex")[2]));
    }

    [Fact]
    public async Task AutomaticRouteSwitchSendsToEachSelectedEndpointOnce()
    {
        var cli = new FakeCli(); var discovery = new FakeDiscovery();
        var settings = new Settings { BluetoothDeviceId = Address, MidiEndpointId = BtId, UsbEndpointId = UsbId, AutoLightsOff = true };
        var controller = new ConnectionController(cli, discovery, settings, () => { });
        Assert.True(await controller.PollAsync(CancellationToken.None)); Assert.Equal(BtId, cli.SentEndpoint);
        controller.Device = DeviceSelection.Choose(settings, [Bluetooth, Usb]);
        Assert.True(await controller.PollAsync(CancellationToken.None)); Assert.Equal(UsbId, cli.SentEndpoint);
        Assert.False(await controller.PollAsync(CancellationToken.None));
        Assert.Equal(2, cli.SendCount);
    }

    [Fact]
    public void OldSettingsLoadWithoutMigrationAndNewPreferencesRoundTrip()
    {
        var dir = Path.Combine(Path.GetTempPath(), "PopuConnect-usb-test-" + Guid.NewGuid());
        Directory.CreateDirectory(dir); var path = Path.Combine(dir, "settings.json");
        try
        {
            File.WriteAllText(path, """{"BluetoothDeviceId":"AABBCCDDEEFF","MidiEndpointId":"old-bt","AutoLightsOff":true,"ColorRgb":123,"Extension":1} """);
            var store = new SettingsStore(path); var settings = store.Load();
            Assert.Equal(Address, settings.BluetoothDeviceId); Assert.Equal("old-bt", settings.MidiEndpointId);
            Assert.True(settings.AutoLightsOff); Assert.Equal(123, settings.ColorRgb);
            Assert.Equal(ConnectionPreference.Automatic, settings.ConnectionPreference); Assert.Empty(settings.UsbEndpointId);
            settings.UsbEndpointId = UsbId; settings.UsbDeviceInstanceId = Usb.InstanceId; settings.ConnectionPreference = ConnectionPreference.Usb;
            store.Save(settings); settings = store.Load();
            Assert.Equal(UsbId, settings.UsbEndpointId); Assert.Equal(Usb.InstanceId, settings.UsbDeviceInstanceId);
            Assert.Equal(ConnectionPreference.Usb, settings.ConnectionPreference); Assert.Equal("old-bt", settings.MidiEndpointId);
        }
        finally { Directory.Delete(dir, true); }
    }

    private sealed class FakeDiscovery : IDeviceDiscovery
    {
        public IReadOnlyList<MidiDestination> Outputs = [UsbEndpoint, BtEndpoint];
        public int BluetoothInspections;
        public Task<IReadOnlyList<MidiDestination>> GetDestinationsAsync(CancellationToken token) => Task.FromResult(Outputs);
        public Task<IReadOnlyList<BluetoothKeyboard>> DiscoverAsync(CancellationToken token) => Task.FromResult<IReadOnlyList<BluetoothKeyboard>>([new(Address, "PopuPiano")]);
        public Task<DeviceSnapshot> InspectAsync(string bluetoothId, CancellationToken token)
        { Assert.Equal(Address, bluetoothId); BluetoothInspections++; return Task.FromResult(new DeviceSnapshot(true, Outputs)); }
    }

    [Fact]
    public async Task MissingCliUsesOnlyTheSelectedWindowsOutputForUsb()
    {
        var discovery = new FakeDiscovery { Outputs = [] };
        var native = new NativeUsb();
        var settings = new Settings { BluetoothDeviceId = Address, MidiEndpointId = BtId };
        var catalog = new MidiDeviceCatalog(null, discovery, _ => { }, native);
        var controller = new ConnectionController(null, discovery, settings, () => { }, native);
        var token = CancellationToken.None;
        await controller.CheckEnvironmentAsync(token, includeBluetooth: false);
        controller.Device = Assert.Single(await catalog.RefreshAsync(true, token));
        await controller.ConnectAsync(token);
        var palette = PopuPianoLighting.Palette(255, 65, 25);
        await controller.SendAsync([palette, PopuPianoLighting.AllOn()], token);
        Assert.Equal("windows-output-id", native.Opened);
        Assert.Equal(palette, native.Sent[0]);
        Assert.Equal(PopuPianoLighting.AllOn(), native.Sent[1]);
        Assert.Equal(BtId, settings.MidiEndpointId);
        Assert.Equal(0, discovery.BluetoothInspections);
        native.Outputs = [];
        Assert.Empty(await catalog.RefreshAsync(false, token));
        await Assert.ThrowsAsync<InvalidOperationException>(() => controller.SendAsync([palette], token));
        Assert.False(controller.Ready);
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => controller.CheckEnvironmentAsync(token, includeBluetooth: true));
        Assert.Contains("Bluetooth", error.Message);
    }

    [Fact]
    public async Task AutoOffSendsMainFrameAndManualOffCanSendBothToSameUsbOutput()
    {
        var native = new NativeUsb();
        var settings = new Settings { AutoLightsOff = true };
        var controller = new ConnectionController(null, new FakeDiscovery(), settings, () => { }, native) { Device = Usb };
        var events = new List<string>();
        controller.LightingActivity += events.Add;
        Assert.True(await controller.PollAsync(CancellationToken.None));
        Assert.Equal(PopuPianoLighting.AllOff(), Assert.Single(native.Sent));
        Assert.False(await controller.PollAsync(CancellationToken.None));
        var extension = PopuPianoLighting.ExtraPianoOff();
        await controller.SendAsync([extension], CancellationToken.None);
        Assert.Equal("windows-output-id", native.Opened);
        Assert.Equal(extension, Assert.Single(native.Sent));
        Assert.Contains(events, e => e.Contains(PopuPianoLighting.Hex(extension)));
        await controller.SendAsync(PopuPianoLighting.OffFrames(), CancellationToken.None);
        Assert.Equal("windows-output-id", native.Opened);
        Assert.Collection(native.Sent,
            main => Assert.Equal(PopuPianoLighting.AllOff(), main),
            extra => Assert.Equal(extension, extra));
    }

    [Fact]
    public async Task WindowsBluetoothSendsToSelectedOutputWithoutCliOrUsb()
    {
        var endpoint = new MidiDestination("ble-out", "PopuPiano", "ble-instance", "WinRT", 0)
            { Type = ConnectionType.Bluetooth, WindowsOutputId = "win-ble-out" };
        var native = new NativeUsb { Outputs = [], BluetoothOutputs = [endpoint] };
        var discovery = new FakeDiscovery { Outputs = [] };
        var catalog = new MidiDeviceCatalog(null, discovery, _ => { }, native);
        var settings = new Settings
        {
            BluetoothDeviceId = Address, MidiEndpointId = BtId, ConnectionPreference = ConnectionPreference.Bluetooth,
            WindowsBluetoothEndpointId = endpoint.Id, WindowsBluetoothInstanceId = endpoint.InstanceId
        };
        var token = CancellationToken.None;
        var found = await catalog.RefreshAsync(true, token);
        var selected = Assert.Single(found);
        Assert.True(selected.IsWindowsBluetooth);
        Assert.Equal(ConnectionType.Bluetooth, selected.Type);
        Assert.Equal(selected, DeviceSelection.Choose(settings, found));
        var controller = new ConnectionController(null, discovery, settings, () => { }, native) { Device = selected };
        await controller.ConnectAsync(token);
        Assert.Equal(endpoint.WindowsOutputId, native.BluetoothPort);
        await controller.SendAsync(PopuPianoLighting.OffFrames(), token);
        Assert.Equal(endpoint.WindowsOutputId, native.Opened);
        Assert.Equal(2, native.Sent.Length);
        Assert.Equal(0, discovery.BluetoothInspections);
        Assert.Equal(BtId, settings.MidiEndpointId);
        Assert.False(await controller.PollAsync(token));
        Assert.Equal(endpoint.WindowsOutputId, native.BluetoothPort);
        await controller.SendAsync(PopuPianoLighting.OffFrames(), token);
        Assert.Equal(1, native.BluetoothOpens);
        native.BluetoothOutputs = [endpoint with { InstanceId = "different-keyboard" }];
        await Assert.ThrowsAsync<InvalidOperationException>(() => controller.SendAsync(PopuPianoLighting.OffFrames(), token));
        Assert.False(controller.Ready);
        Assert.Null(native.BluetoothPort);
    }

    private sealed class NativeUsb : INativeMidi
    {
        public IReadOnlyList<MidiDestination> Outputs = [UsbEndpoint with { WindowsOutputId = "windows-output-id" }];
        public IReadOnlyList<MidiDestination> BluetoothOutputs = [];
        public string? BluetoothPort;
        public int BluetoothOpens;
        public string? Opened;
        public byte[][] Sent = [];
        public Task<IReadOnlyList<MidiDestination>> GetUsbOutputsAsync(CancellationToken token) => Task.FromResult(Outputs);
        public Task<IReadOnlyList<MidiDestination>> GetBluetoothOutputsAsync(CancellationToken token) => Task.FromResult(BluetoothOutputs);
        public Task OpenBluetoothOutputAsync(string outputId, CancellationToken token)
        {
            if (BluetoothPort != outputId) BluetoothOpens++;
            BluetoothPort = outputId;
            return Task.CompletedTask;
        }
        public void ReleaseBluetoothOutput(string? keepOutputId = null)
        {
            if (BluetoothPort != keepOutputId) BluetoothPort = null;
        }
        public async Task SendAsync(string outputId, IEnumerable<byte[]> messages, CancellationToken token, bool keepBluetoothOpen = false)
        {
            if (keepBluetoothOpen) await OpenBluetoothOutputAsync(outputId, token);
            Opened = outputId;
            Sent = messages.ToArray();
        }
    }
    private sealed class FakeCli : IMidiCli
    {
        public List<string[]> Calls { get; } = [];
        public string SentEndpoint = "";
        public bool FailBluetooth;
        public int SendCount;
        public Action? AfterSend;
        public Task<string> RunAsync(CancellationToken cancellationToken, params string[] arguments)
        {
            Calls.Add(arguments);
            if (arguments[0] == "bluetooth" && FailBluetooth) throw new InvalidOperationException("Bluetooth transport absent");
            if (arguments[0] == "enumerate") return Task.FromResult($"ID: {UsbId}\nID: {BtId}\n");
            if (arguments.SequenceEqual(new[] { "bluetooth", "list" })) return Task.FromResult($"│ {Address} │ PopuPiano │");
            if (arguments[0] == "sysex" && !arguments.Contains("--help"))
            {
                SentEndpoint = arguments[3]; SendCount++;
                Assert.Equal(PopuPianoLighting.AllOff(), File.ReadAllBytes(arguments[2]));
                AfterSend?.Invoke();
            }
            return Task.FromResult("--keep-when-offline");
        }
    }
}
