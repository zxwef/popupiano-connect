namespace PopuConnect.Core;

public record UsbNode(string Id, string Parent, Guid Container, bool IsHub = false);

public sealed class UsbDeviceTree(IEnumerable<UsbNode> devices)
{
    private readonly Dictionary<string, UsbNode> nodes = devices.ToDictionary(n => n.Id, StringComparer.OrdinalIgnoreCase);
    private static readonly Guid ComputerContainer = new("00000000-0000-0000-ffff-ffffffffffff");

    public UsbNode? PhysicalDevice(string instance)
    {
        nodes.TryGetValue(instance, out var selected);
        foreach (var node in Ancestors(instance))
        {
            if (node.IsHub || node.Id.StartsWith("BTH", StringComparison.OrdinalIgnoreCase)) return null;
            if (IsPhysicalUsb(node)) return node;
        }
        if (selected == null || selected.Container == Guid.Empty || selected.Container == ComputerContainer) return null;
        var matches = nodes.Values.Where(n => n.Container == selected.Container && !n.IsHub && IsPhysicalUsb(n)).Take(2).ToArray();
        return matches.Length == 1 ? matches[0] : null;
    }

    public bool IsPartOf(string instance, UsbNode root) =>
        Ancestors(instance).Any(n => n.Id.Equals(root.Id, StringComparison.OrdinalIgnoreCase));

    private IEnumerable<UsbNode> Ancestors(string instance)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        while (seen.Add(instance) && nodes.TryGetValue(instance, out var node))
        {
            yield return node;
            instance = node.Parent;
        }
    }

    private static bool IsPhysicalUsb(UsbNode node)
    {
        var parts = node.Id.Split('\\');
        return parts is [var bus, var hw, _] && bus.Equals("USB", StringComparison.OrdinalIgnoreCase)
            && hw.StartsWith("VID_", StringComparison.OrdinalIgnoreCase) && hw.Contains("&PID_", StringComparison.OrdinalIgnoreCase)
            && !hw.Contains("&MI_", StringComparison.OrdinalIgnoreCase);
    }
}

