using System.Text.Json;

namespace PopuConnect.Core;

public sealed class Settings
{
    public string BluetoothDeviceId { get; set; } = "";
    public string DeviceName { get; set; } = "PopuPiano";
    public string MidiEndpointId { get; set; } = "";
    public bool AutoConnect { get; set; } = true;
    public bool AutoLightsOff { get; set; }
    public int ColorRgb { get; set; } = 0x65C7F7;
    public string RetentionConfiguredFor { get; set; } = "";
    // Missing fields in older JSON retain the Bluetooth selection and enable USB preference.
    public ConnectionPreference ConnectionPreference { get; set; } = ConnectionPreference.Automatic;
    public string UsbEndpointId { get; set; } = "";
    public string UsbDeviceInstanceId { get; set; } = "";
    public string UsbDeviceName { get; set; } = "";
    public string WindowsBluetoothEndpointId { get; set; } = "";
    public string WindowsBluetoothInstanceId { get; set; } = "";
    public string WindowsBluetoothDeviceName { get; set; } = "";
}

public sealed class SettingsStore(string path)
{
    public static string DefaultPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PopuConnect", "settings.json");
    public Settings Load()
    {
        if (!File.Exists(path)) return new();
        return JsonSerializer.Deserialize<Settings>(File.ReadAllText(path)) ?? throw new InvalidDataException("The settings file is empty.");
    }
    public void Save(Settings settings)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        var temp = path + ".tmp";
        try
        {
            File.WriteAllText(temp, JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true }));
            File.Move(temp, path, true);
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
}
