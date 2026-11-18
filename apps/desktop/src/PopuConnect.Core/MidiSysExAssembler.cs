namespace PopuConnect.Core;

public sealed class MidiSysExAssembler(int maxLength = 65_536)
{
    private readonly List<byte> bytes = [];
    public bool HasPendingFrame => bytes.Count > 0;
    public int DiscardedFrames { get; private set; }

    public void Push(ReadOnlySpan<byte> data, Action<byte[]> receive)
    {
        foreach (var value in data)
        {
            // Real-time messages can occur inside a SysEx frame.
            if (value >= 0xF8) continue;
            if (value == 0xF0)
            {
                DiscardPending();
                bytes.Add(value);
                continue;
            }
            if (!HasPendingFrame) continue;
            if (bytes.Count >= maxLength || value is >= 0x80 and < 0xF7)
            {
                DiscardPending();
                continue;
            }
            bytes.Add(value);
            if (value == 0xF7)
            {
                var frame = bytes.ToArray();
                bytes.Clear();
                receive(frame);
            }
        }
    }

    public void DiscardPending()
    {
        if (!HasPendingFrame) return;
        DiscardedFrames++;
        bytes.Clear();
    }

    public static bool IsBatteryCandidate(byte[] frame) => frame is [0xF0, _, 0x04, .., 0xF7];
}
