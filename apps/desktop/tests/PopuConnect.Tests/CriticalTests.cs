using PopuConnect.Core;
using Xunit;

namespace PopuConnect.Tests;

public sealed class CriticalTests
{
    [Fact]
    public void AllOffHasExactWireFormat()
    {
        var bytes = PopuPianoLighting.AllOff();
        Assert.Equal(63, bytes.Length);
        Assert.Equal(new byte[] { 0xF0, 3, 0x20, 29 }, bytes[..4]);
        for (var i = 0; i < 29; i++) { Assert.Equal(i, bytes[4 + i * 2]); Assert.Equal(0, bytes[5 + i * 2]); }
        Assert.Equal(0xF7, bytes[^1]);
    }

    [Theory]
    [InlineData(0, 0)] [InlineData(1, 1)] [InlineData(2, 1)] [InlineData(127, 64)] [InlineData(254, 127)] [InlineData(255, 127)]
    public void ColorConversionUsesSevenBits(byte value, byte expected) => Assert.Equal(expected, PopuPianoLighting.To7Bit(value));

    [Fact]
    public void PaletteAndKeyMessagesAreFramedAndSevenBit()
    {
        Assert.Equal(new byte[] { 0xF0, 3, 0x1E, 1, 1, 127, 64, 0, 0xF7 }, PopuPianoLighting.Palette(255, 127, 0));
        foreach (var message in new[] { PopuPianoLighting.Palette(255, 1, 200), PopuPianoLighting.AllOn(), PopuPianoLighting.Keys([0, 28], 127) })
        {
            Assert.Equal(0xF0, message[0]); Assert.Equal(0xF7, message[^1]);
            Assert.All(message[1..^1], b => Assert.InRange(b, (byte)0, (byte)127));
        }
    }

    [Fact]
    public void InvalidKeysAndSlotsAreRejected()
    {
        foreach (var keys in new[] { new[] { -1 }, new[] { 29 }, Array.Empty<int>(), new[] { 0, 0 } })
            Assert.Throws<ArgumentException>(() => PopuPianoLighting.Keys(keys, 1));
        Assert.Throws<ArgumentOutOfRangeException>(() => PopuPianoLighting.Keys([0], 128));
        Assert.Throws<ArgumentOutOfRangeException>(() => PopuPianoLighting.Keys([0], -1));
    }

    private const string Address = "AABBCCDDEEFF";
    private static MidiDestination Destination(string id = "ump-selected") => new(id, "PopuPiano", @"SWD\MIDISRV\MIDIU_BLEMIDI_PopuPiano_" + Address, "BLEMIDI", 0);

    [Fact]
    public void EndpointSelectionRejectsOtherDevicesAndRefreshesStaleId()
    {
        var correct = Destination("new-id");
        var other = Destination("wrong") with { InstanceId = @"SWD\MIDISRV\MIDIU_BLEMIDI_PopuPiano_112233445566" };
        Assert.Equal(correct, EndpointSelection.Resolve(Address, "old-id", [other, correct]));
        Assert.Null(EndpointSelection.Resolve(Address, "wrong", [other]));
        Assert.Null(EndpointSelection.Resolve(Address, "", [correct with { TransportCode = "USB" }]));
        Assert.Null(EndpointSelection.Resolve(Address, "", [correct with { GroupIndex = 1 }]));
        Assert.Throws<InvalidOperationException>(() => EndpointSelection.Resolve(Address, "", [correct, Destination("another")]));
        Assert.Equal(correct, EndpointSelection.Resolve(Address, "new-id", [correct, Destination("another")]));
        Assert.Equal(Address, EndpointSelection.NormalizeBluetoothId("aa:bb:cc:dd:ee:ff"));
        Assert.Throws<ArgumentException>(() => EndpointSelection.NormalizeBluetoothId("ump-selected"));
    }

    [Fact]
    public async Task ExistingConnectionIsNotReconnected()
    {
        var cli = new FakeCli(); var discovery = new FakeDiscovery();
        var settings = new Settings { BluetoothDeviceId = Address, RetentionConfiguredFor = Address };
        await new ConnectionController(cli, discovery, settings, () => { }).ConnectAsync(CancellationToken.None);
        Assert.Empty(cli.Calls);
    }

    [Fact]
    public async Task OfflineEndpointDoesNotMeanBluetoothIsConnected()
    {
        var cli = new FakeCli(); var discovery = new FakeDiscovery { Connected = false };
        cli.OnCall = args => { if (args.Take(2).SequenceEqual(new[] { "bluetooth", "connect" })) discovery.Connected = true; };
        var settings = new Settings { BluetoothDeviceId = Address };
        await new ConnectionController(cli, discovery, settings, () => { }).ConnectAsync(CancellationToken.None);
        Assert.Contains(cli.Calls, c => c.SequenceEqual(new[] { "bluetooth", "connect", Address }));
        Assert.Contains(cli.Calls, c => c.SequenceEqual(new[] { "bluetooth", "customize", Address, "--keep-when-offline", "always" }));
        Assert.DoesNotContain(cli.Calls, c => c.Contains("--temporary"));
    }

    [Fact]
    public async Task AutoOffRunsOncePerConnectionAndNeverWhileOffline()
    {
        var cli = new FakeCli(); var discovery = new FakeDiscovery { Connected = false };
        var settings = new Settings { BluetoothDeviceId = Address, AutoLightsOff = true };
        var controller = new ConnectionController(cli, discovery, settings, () => { });
        Assert.False(await controller.PollAsync(CancellationToken.None)); Assert.False(controller.Ready);
        discovery.Connected = true;
        Assert.True(await controller.PollAsync(CancellationToken.None));
        Assert.False(await controller.PollAsync(CancellationToken.None));
        discovery.Connected = false;
        Assert.False(await controller.PollAsync(CancellationToken.None));
        discovery.Connected = true;
        Assert.True(await controller.PollAsync(CancellationToken.None));
        Assert.Equal(2, cli.Calls.Count(c => c[0] == "sysex"));
        Assert.All(cli.SentFiles, f => Assert.False(File.Exists(f)));
        Assert.All(cli.Payloads, b => Assert.Equal(PopuPianoLighting.AllOff(), b));
    }

    [Fact]
    public async Task AutoOffFailureIsNotRepeatedOnEveryPoll()
    {
        var cli = new FakeCli { FailSend = true }; var discovery = new FakeDiscovery();
        var controller = new ConnectionController(cli, discovery, new() { BluetoothDeviceId = Address, AutoLightsOff = true }, () => { });
        await Assert.ThrowsAsync<InvalidOperationException>(() => controller.PollAsync(CancellationToken.None));
        Assert.False(await controller.PollAsync(CancellationToken.None));
        Assert.Single(cli.SentFiles); Assert.False(File.Exists(cli.SentFiles[0]));
    }

    [Fact]
    public async Task DisconnectedKeyboardCannotReceiveSysEx()
    {
        var cli = new FakeCli();
        var controller = new ConnectionController(cli, new FakeDiscovery { Connected = false }, new() { BluetoothDeviceId = Address }, () => { });
        await Assert.ThrowsAsync<InvalidOperationException>(() => controller.SendAsync([PopuPianoLighting.AllOff()], CancellationToken.None));
        Assert.Empty(cli.Calls);
    }

    [Fact]
    public async Task MissingOutputPortPreventsSend()
    {
        var cli = new FakeCli();
        var controller = new ConnectionController(cli, new FakeDiscovery { Outputs = [] }, new() { BluetoothDeviceId = Address }, () => { });
        await Assert.ThrowsAsync<InvalidOperationException>(() => controller.SendAsync([PopuPianoLighting.AllOff()], CancellationToken.None));
        Assert.Empty(cli.Calls);
    }

    [Fact]
    public async Task DisconnectDuringSendIsReportedAsUnconfirmed()
    {
        var cli = new FakeCli(); var discovery = new FakeDiscovery();
        cli.OnCall = args => { if (args[0] == "sysex") discovery.Connected = false; };
        var controller = new ConnectionController(cli, discovery, new() { BluetoothDeviceId = Address }, () => { });
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => controller.SendAsync([PopuPianoLighting.AllOff()], CancellationToken.None));
        Assert.Contains("Connection lost", error.Message);
        Assert.False(controller.Ready);
        Assert.All(cli.SentFiles, f => Assert.False(File.Exists(f)));
    }

    [Fact]
    public async Task AutoOffWaitsForOutputPortAfterBluetoothConnects()
    {
        var cli = new FakeCli(); var discovery = new FakeDiscovery { Outputs = [] };
        var controller = new ConnectionController(cli, discovery, new() { BluetoothDeviceId = Address, AutoLightsOff = true }, () => { });
        Assert.False(await controller.PollAsync(CancellationToken.None));
        Assert.Empty(cli.Calls);
        discovery.Outputs = [Destination()];
        Assert.True(await controller.PollAsync(CancellationToken.None));
        Assert.False(await controller.PollAsync(CancellationToken.None));
        Assert.Single(cli.SentFiles);
    }

    [Fact]
    public async Task LightingOperationsAreSerializedAndTempFilesDeletedOnFailure()
    {
        var cli = new FakeCli { FailSend = true }; var discovery = new FakeDiscovery();
        var controller = new ConnectionController(cli, discovery, new() { BluetoothDeviceId = Address }, () => { });
        async Task Attempt() { await Assert.ThrowsAsync<InvalidOperationException>(() => controller.SendAsync([PopuPianoLighting.AllOff()], CancellationToken.None)); }
        await Task.WhenAll(Attempt(), Attempt());
        Assert.Equal(1, cli.MaximumConcurrent);
        Assert.All(cli.SentFiles, f => Assert.False(File.Exists(f)));
    }

    [Fact]
    public async Task RealCliRunnerReportsMissingExecutableAndExitCode()
    {
        var logs = new List<string>();
        await Assert.ThrowsAsync<InvalidOperationException>(() => new MidiCli(logs.Add, "PopuConnect-nonexistent-command.exe").RunAsync(CancellationToken.None, "--help"));
        var shell = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => new MidiCli(logs.Add, shell).RunAsync(CancellationToken.None, "/d", "/c", "exit 7"));
        Assert.Contains("7", error.Message);
        var windowsShell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
        await Assert.ThrowsAsync<TimeoutException>(() => new MidiCli(logs.Add, windowsShell, TimeSpan.FromMilliseconds(150)).RunAsync(CancellationToken.None, "-NoProfile", "-Command", "Start-Sleep -Seconds 10"));
    }

    [Fact]
    public async Task MissingServicesAndUnsupportedCliAreReported()
    {
        var cli = new FakeCli { FailAll = true };
        await Assert.ThrowsAsync<InvalidOperationException>(() => new ConnectionController(cli, new FakeDiscovery(), new(), () => { }).CheckEnvironmentAsync(CancellationToken.None));
        cli.FailAll = false; cli.Help = "old CLI";
        await Assert.ThrowsAsync<InvalidOperationException>(() => new ConnectionController(cli, new FakeDiscovery(), new(), () => { }).CheckEnvironmentAsync(CancellationToken.None));
    }

    [Fact]
    public async Task CliCancellationStopsChildProcess()
    {
        var shell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => new MidiCli(_ => { }, shell).RunAsync(cancellation.Token, "-NoProfile", "-Command", "Start-Sleep -Seconds 20"));
    }

    [Fact]
    public async Task CancellationDuringLightingSendDeletesTemporaryFile()
    {
        var cli = new FakeCli { SendDelay = 20_000 };
        var controller = new ConnectionController(cli, new FakeDiscovery(), new() { BluetoothDeviceId = Address }, () => { });
        using var cancellation = new CancellationTokenSource();
        cli.OnCall = args => { if (args[0] == "sysex") cancellation.CancelAfter(50); };
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => controller.SendAsync([PopuPianoLighting.AllOff()], cancellation.Token));
        Assert.Single(cli.SentFiles);
        Assert.False(File.Exists(cli.SentFiles[0]));
    }

    [Fact]
    public void SettingsRoundTripAndCorruptionIsExplicit()
    {
        var dir = Path.Combine(Path.GetTempPath(), "PopuConnect-test-" + Guid.NewGuid()); var path = Path.Combine(dir, "settings.json");
        try
        {
            var store = new SettingsStore(path);
            Assert.True(store.Load().AutoConnect);
            store.Save(new() { BluetoothDeviceId = Address, MidiEndpointId = "ump-1", AutoConnect = false, AutoLightsOff = true, ColorRgb = 123, RetentionConfiguredFor = Address });
            var saved = store.Load();
            Assert.Equal(Address, saved.BluetoothDeviceId); Assert.Equal("ump-1", saved.MidiEndpointId);
            Assert.True(saved.AutoLightsOff); Assert.False(saved.AutoConnect); Assert.Equal(123, saved.ColorRgb);
            Assert.Equal(Address, saved.RetentionConfiguredFor);
            File.WriteAllText(path, "{broken");
            Assert.Throws<System.Text.Json.JsonException>(() => store.Load());
        }
        finally { if (Directory.Exists(dir)) Directory.Delete(dir, true); }
    }

    private sealed class FakeDiscovery : IDeviceDiscovery
    {
        public bool Connected = true;
        public IReadOnlyList<MidiDestination> Outputs = [Destination()];
        public Task<IReadOnlyList<BluetoothKeyboard>> DiscoverAsync(CancellationToken token) => Task.FromResult<IReadOnlyList<BluetoothKeyboard>>([]);
        public Task<DeviceSnapshot> InspectAsync(string bluetoothId, CancellationToken token) => Task.FromResult(new DeviceSnapshot(Connected, Outputs));
        public Task<IReadOnlyList<MidiDestination>> GetDestinationsAsync(CancellationToken token) => Task.FromResult(Outputs);
    }
    private sealed class FakeCli : IMidiCli
    {
        public readonly List<string[]> Calls = [];
        public readonly List<string> SentFiles = [];
        public readonly List<byte[]> Payloads = [];
        public Action<string[]>? OnCall;
        public bool FailSend, FailAll;
        public string Help = "--keep-when-offline";
        public int MaximumConcurrent;
        public int SendDelay = 20;
        private int concurrent;
        public async Task<string> RunAsync(CancellationToken cancellationToken, params string[] arguments)
        {
            Calls.Add(arguments); OnCall?.Invoke(arguments);
            if (FailAll) throw new InvalidOperationException("MIDI service unavailable");
            if (arguments[0] == "sysex" && !arguments.Contains("--help"))
            {
                MaximumConcurrent = Math.Max(MaximumConcurrent, ++concurrent);
                try
                {
                    SentFiles.Add(arguments[2]); Payloads.Add(await File.ReadAllBytesAsync(arguments[2], cancellationToken));
                    Assert.Equal("ump-selected", arguments[3]);
                    await Task.Delay(SendDelay, cancellationToken);
                    if (FailSend) throw new InvalidOperationException("CLI error");
                }
                finally { concurrent--; }
            }
            return Help;
        }
    }
}
