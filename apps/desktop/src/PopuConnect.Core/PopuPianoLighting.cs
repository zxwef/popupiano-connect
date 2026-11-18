namespace PopuConnect.Core;

public static class PopuPianoLighting
{
    public const int KeyCount = 29;
    public static byte To7Bit(byte value) => (byte)Math.Min(127, Math.Round(value / 2.0, MidpointRounding.AwayFromZero));
    public static byte[] Palette(byte r, byte g, byte b) => [0xF0, 0x03, 0x1E, 1, 1, To7Bit(r), To7Bit(g), To7Bit(b), 0xF7];
    public static byte[] AllOff() => Keys(Enumerable.Range(0, KeyCount), 0);
    public static byte[] AllOn() => Keys(Enumerable.Range(0, KeyCount), 1);
    public static byte[] ExtraPianoOff() => LampFrame(4, Enumerable.Range(0, 24).ToArray(), 0);

    public static byte[][] OffFrames() => [AllOff(), ExtraPianoOff()];

    public static string Hex(byte[] frame) => BitConverter.ToString(frame).Replace('-', ' ');

    public static byte[] Keys(IEnumerable<int> keys, int slot)
    {
        ArgumentNullException.ThrowIfNull(keys);
        if (slot is < 0 or > 127) throw new ArgumentOutOfRangeException(nameof(slot));
        var indices = keys.ToArray();
        if (indices.Length is < 1 or > KeyCount || indices.Any(k => k is < 0 or >= KeyCount) || indices.Distinct().Count() != indices.Length)
            throw new ArgumentException("Key indices must be unique and between 0 and 28.", nameof(keys));
        return LampFrame(3, indices, (byte)slot);
    }

    private static byte[] LampFrame(byte module, int[] indices, byte slot)
    {
        var result = new byte[5 + indices.Length * 2];
        result[0] = 0xF0; result[1] = module; result[2] = 0x20; result[3] = (byte)indices.Length;
        for (var i = 0; i < indices.Length; i++) { result[4 + i * 2] = (byte)indices[i]; result[5 + i * 2] = (byte)slot; }
        result[^1] = 0xF7;
        return result;
    }
}
