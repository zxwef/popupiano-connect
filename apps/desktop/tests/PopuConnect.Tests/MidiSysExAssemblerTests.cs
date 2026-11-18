using PopuConnect.Core;
using Xunit;

namespace PopuConnect.Tests;

public sealed class MidiSysExAssemblerTests
{
    [Fact]
    public void ReassemblesSplitFramesAndIgnoresMidiRealtimeBytes()
    {
        var received = new List<byte[]>();
        var parser = new MidiSysExAssembler();
        parser.Push([0x90, 0x30, 0x70, 0xF0, 0x03], received.Add);
        Assert.Empty(received);
        parser.Push([0xF8, 0x04, 0x01], received.Add);
        parser.Push([0xFE, 0x64, 0xF7, 0xF0, 0x04, 0x20, 0xF7], received.Add);
        Assert.Collection(received,
            candidate =>
            {
                Assert.Equal(new byte[] { 0xF0, 0x03, 0x04, 0x01, 0x64, 0xF7 }, candidate);
                Assert.True(MidiSysExAssembler.IsBatteryCandidate(candidate));
            },
            extraPiano => Assert.False(MidiSysExAssembler.IsBatteryCandidate(extraPiano)));
        Assert.False(parser.HasPendingFrame);
        Assert.Equal(0, parser.DiscardedFrames);
    }

    [Fact]
    public void DiscardsInterruptedAndOversizedMessagesThenRecovers()
    {
        var received = new List<byte[]>();
        var parser = new MidiSysExAssembler(maxLength: 5);
        parser.Push([0xF0, 0x03, 0x90, 0xF7], received.Add);
        parser.Push([0xF0, 0x03, 0x20, 0x00, 0x01, 0xF7], received.Add);
        parser.Push([0xF0, 0x03, 0xF0, 0x03, 0x04, 0x63, 0xF7], received.Add);
        Assert.Equal(new byte[] { 0xF0, 0x03, 0x04, 0x63, 0xF7 }, Assert.Single(received));
        parser.Push([0xF0, 0x03], received.Add);
        parser.DiscardPending();
        Assert.Equal(4, parser.DiscardedFrames);
        Assert.False(parser.HasPendingFrame);
    }

    [Fact]
    public async Task CaptureSectionIsIncludedInDiagnosticExport()
    {
        var report = new DeviceDiagnosticsReport { UsbSysExCapture = "USB SysEx\r\ntransport=USB direction=RX endpoint=#1234 length=5 rawHex=F0 03 04 00 F7" };
        string path = Path.GetTempFileName();
        try
        {
            await report.ExportAsync(path, CancellationToken.None);
            Assert.Contains(report.UsbSysExCapture, await File.ReadAllTextAsync(path));
        }
        finally { File.Delete(path); }
    }
}
