using System.Text;
using PopuConnect.Core;
using Windows.Devices.Midi;
using Windows.Foundation;
using Windows.Storage.Streams;

namespace PopuConnect;

internal sealed class UsbSysExCapture(MidiDevice device, DeviceDiagnosticsReport report, string version) : IDisposable
{
    private sealed class Input(MidiInPort port)
    {
        public MidiInPort Port { get; } = port;
        public MidiSysExAssembler Assembler { get; } = new();
        public TypedEventHandler<MidiInPort, MidiMessageReceivedEventArgs>? Handler { get; set; }
        public bool Active { get; set; } = true;
    }

    private readonly Dictionary<string, Input> inputs = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> failedInputs = new(StringComparer.OrdinalIgnoreCase);
    private readonly Lock gate = new();
    private readonly StringBuilder journal = new();
    private readonly DateTimeOffset started = DateTimeOffset.Now;
    private int received;
    private int ordinary;
    private int candidates;
    private int errors;
    private int discarded;
    private int overflow;
    private int opened;
    private string? enumerationError;
    private DateTimeOffset? ended;

    public MidiDevice Device { get; } = device;
    public bool IsRecording => ended == null;

    public async Task UpdateAsync(bool available, CancellationToken token)
    {
        string[] ids;
        try
        {
            ids = available ? await WindowsDeviceDiscovery.GetUsbInputIdsAsync(Device, token) : [];
            enumerationError = null;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            var code = DeviceDiagnosticsReport.ErrorCode(e);
            if (enumerationError != code)
            {
                enumerationError = code;
                Error(Device.MidiEndpointId, "Input discovery: " + code);
            }
            return;
        }
        var present = ids.ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var id in inputs.Keys.Where(id => !present.Contains(id)).ToArray()) Close(id);
        failedInputs.RemoveWhere(id => !present.Contains(id));
        foreach (var id in present)
        {
            if (inputs.ContainsKey(id) || failedInputs.Contains(id)) continue;
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            timeout.CancelAfter(TimeSpan.FromSeconds(5));
            try
            {
                var port = await MidiInPort.FromIdAsync(id).AsTask(timeout.Token)
                    ?? throw new InvalidOperationException("Windows could not open the MIDI input.");
                var input = new Input(port);
                input.Handler = (_, args) => Receive(input, id, args.Message);
                try { port.MessageReceived += input.Handler; }
                catch { port.Dispose(); throw; }
                inputs.Add(id, input);
                lock (gate)
                {
                    opened++;
                    Append(DateTimeOffset.Now, $"transport=USB endpoint={report.Id(id)} input=opened");
                }
            }
            catch (Exception e) when (e is not OperationCanceledException || !token.IsCancellationRequested)
            {
                failedInputs.Add(id);
                var detail = e is OperationCanceledException ? "Opening the MIDI input timed out." : DeviceDiagnosticsReport.ErrorCode(e);
                Error(id, detail);
            }
        }
    }

    public void RecordSend(MidiDestination endpoint, IReadOnlyList<byte[]> frames)
    {
        if (endpoint.Type != ConnectionType.Usb ||
            !endpoint.Id.Equals(Device.MidiEndpointId, StringComparison.OrdinalIgnoreCase) ||
            !endpoint.InstanceId.Equals(Device.InstanceId, StringComparison.OrdinalIgnoreCase)) return;
        lock (gate)
        {
            foreach (var frame in frames) Frame(DateTimeOffset.Now, "TX", endpoint.Id, frame, " status=request");
        }
    }

    public string Summary()
    {
        lock (gate)
        {
            if (candidates > 0) return $"USB SysEx · 0x04 candidates: {candidates}. Battery format unknown.";
            if (errors > 0 && opened == 0) return "USB SysEx · MIDI input discovery or opening failed.";
            if (opened == 0) return IsRecording ? "USB SysEx · waiting for the selected keyboard's MIDI input." : "USB SysEx · MIDI input did not open.";
            return $"USB SysEx · RX frames: {received} · other MIDI messages: {ordinary}. No 0x04 candidates.";
        }
    }

    public string Render()
    {
        lock (gate)
        {
            return $"USB SysEx · PopuConnect {version}\r\n" +
                $"Device={report.Name(Device.Name)} MIDI={report.Id(Device.MidiEndpointId)} instance={report.Id(Device.InstanceId)}\r\n" +
                $"Start={started:O} End={(ended.HasValue ? ended.Value.ToString("O") : "still recording")}\r\n" +
                $"Inputs opened this session={opened} Currently open={inputs.Count} Errors={errors}\r\n" +
                $"SysEx RX={received} Other MIDI={ordinary} 0x04 candidates={candidates} Incomplete or invalid frames={discarded + inputs.Values.Sum(i => i.Assembler.DiscardedFrames)}\r\n" +
                $"Log lines omitted={overflow}\r\n" + Summary() + "\r\n" + journal;
        }
    }

    private void Receive(Input input, string id, IMidiMessage message)
    {
        lock (gate)
        {
            if (!input.Active) return;
            try
            {
                if (message.Type != MidiMessageType.SystemExclusive)
                {
                    ordinary++;
                    if (!input.Assembler.HasPendingFrame) return;
                }
                using var reader = DataReader.FromBuffer(message.RawData);
                if (reader.UnconsumedBufferLength > 1_048_576)
                {
                    input.Assembler.DiscardPending();
                    Error(id, "The MIDI input buffer exceeded 1 MiB.");
                    return;
                }
                var bytes = new byte[reader.UnconsumedBufferLength];
                reader.ReadBytes(bytes);
                var now = DateTimeOffset.Now;
                input.Assembler.Push(bytes, frame =>
                {
                    received++;
                    bool candidate = MidiSysExAssembler.IsBatteryCandidate(frame);
                    if (candidate) candidates++;
                    Frame(now, "RX", id, frame, candidate ? " batteryCandidate=0x04 format=unknown" : "");
                });
            }
            catch (Exception e)
            {
                input.Assembler.DiscardPending();
                Error(id, DeviceDiagnosticsReport.ErrorCode(e));
            }
        }
    }

    private void Frame(DateTimeOffset time, string direction, string id, byte[] frame, string detail)
    {
        var decoded = frame.Length >= 4 ? $"component={frame[1]:X2},command={frame[2]:X2}" : "—";
        Append(time, $"transport=USB direction={direction} endpoint={report.Id(id)} length={frame.Length} decodedSysEx={decoded}{detail} rawHex={PopuPianoLighting.Hex(frame)}");
    }

    private void Error(string id, string detail)
    {
        lock (gate)
        {
            errors++;
            Append(DateTimeOffset.Now, $"transport=USB direction=RX endpoint={report.Id(id)} error={detail}");
        }
    }

    private void Append(DateTimeOffset now, string entry)
    {
        if (journal.Length + entry.Length > 262_144) overflow++;
        else journal.AppendLine($"{now:O}  {entry}");
    }

    private void Close(string id)
    {
        var input = inputs[id];
        lock (gate)
        {
            input.Active = false;
            input.Assembler.DiscardPending();
            discarded += input.Assembler.DiscardedFrames;
            inputs.Remove(id);
            Append(DateTimeOffset.Now, $"transport=USB endpoint={report.Id(id)} input=closed");
        }
        try
        {
            try { input.Port.MessageReceived -= input.Handler; }
            finally { input.Port.Dispose(); }
        }
        catch (Exception e) { Error(id, "Closing MIDI input: " + DeviceDiagnosticsReport.ErrorCode(e)); }
    }

    public void Dispose()
    {
        if (!IsRecording) return;
        foreach (var id in inputs.Keys.ToArray()) Close(id);
        ended = DateTimeOffset.Now;
    }
}
