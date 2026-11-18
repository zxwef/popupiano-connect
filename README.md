# PopuConnect

Tools for the PopuPiano MIDI keyboard.

| Directory | Purpose |
| --- | --- |
| [apps/desktop](apps/desktop/README.md) | C# / WinForms application for USB and Bluetooth MIDI, lighting, diagnostics, and battery checks. |
| [apps/web](apps/web/README.md) | Static HTML, CSS, and TypeScript starter for GitHub Pages. |
| [docs/protocols](docs/protocols/README.md) | Verified SysEx commands and lighting behavior. |
| [docs/research](docs/research/README.md) | Reference documentation and third-party sources. |
| [tests/fixtures](tests/fixtures/README.md) | Shared MIDI test data. |

## Build

```powershell
dotnet build -c Release
dotnet test -c Release --no-build
npm.cmd --prefix apps/web ci
npm.cmd --prefix apps/web run build
```

The Web build goes to `apps/web/dist`. See the Desktop instructions for publishing the EXE and running the UI smoke test. [Build and verification](apps/desktop/README.md#build-and-verification)
