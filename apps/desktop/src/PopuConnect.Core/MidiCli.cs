using System.ComponentModel;
using System.Diagnostics;
using System.Text;

namespace PopuConnect.Core;

public interface IMidiCli
{
    Task<string> RunAsync(CancellationToken cancellationToken, params string[] arguments);
}

public sealed class MidiCli(Action<string> log, string executable = "midi.exe", TimeSpan? timeout = null) : IMidiCli
{
    public async Task<string> RunAsync(CancellationToken cancellationToken, params string[] arguments)
    {
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        start.Environment["NO_COLOR"] = "1";
        using var process = new Process { StartInfo = start };
        log($"> midi {string.Join(' ', arguments)}");
        try { process.Start(); }
        catch (Win32Exception e) { throw new InvalidOperationException($"Could not start {executable}. Windows error {e.NativeErrorCode}: {e.Message}", e); }
        process.StandardInput.Close();
        // Drain both pipes concurrently; cancellation kills the child before awaiting the pipes.
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(timeout ?? TimeSpan.FromSeconds(35));
        try { await process.WaitForExitAsync(deadline.Token); }
        catch (OperationCanceledException)
        {
            try { process.Kill(true); } catch (InvalidOperationException) { }
            await process.WaitForExitAsync(CancellationToken.None);
            log(await stdout); log(await stderr);
            cancellationToken.ThrowIfCancellationRequested();
            throw new TimeoutException("The MIDI CLI timed out. Check Bluetooth and Windows MIDI Services.");
        }
        var output = await stdout;
        var error = await stderr;
        log(output); if (!string.IsNullOrWhiteSpace(error)) log(error);
        if (process.ExitCode != 0)
        {
            var errorResult = new InvalidOperationException($"The MIDI CLI failed (exit code {process.ExitCode}). See Diagnostics for details.");
            errorResult.Data["ExitCode"] = process.ExitCode;
            throw errorResult;
        }
        return output;
    }
}
