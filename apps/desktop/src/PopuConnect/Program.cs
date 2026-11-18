namespace PopuConnect;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        using var mutex = new Mutex(true, @"Local\PopuConnect", out var first);
        if (!first) { MessageBox.Show("PopuConnect is already running.", "PopuConnect"); return; }
        Application.Run(new MainForm());
    }
}
