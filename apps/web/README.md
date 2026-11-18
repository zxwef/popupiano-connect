# PopuConnect Web

A static application built with Vanilla TypeScript, Vite, and BEM CSS. Play the C3–E5 virtual keyboard with Web Audio or use the computer keys `A W S E D F T G Y H U J K` in the selected octave. Choose a chord, inversion, or scale, listen to a preview, and apply the pattern to PopuPiano.

The PopuMusic developer site is a reference for workflows. [PopuPiano developer site](https://developer.popumusic.com/) · [PopuPiano protocols](../../docs/protocols/README.md)

## Run and test

From `apps/web`, use Node.js 22.12 or later and run the following in PowerShell.

```powershell
npm.cmd ci
npm.cmd run test
npm.cmd run dev
```

Tests cover intervals, inversions, MIDI Note On and Off, multicolor palettes, SysEx ordering, and compatibility with the shared lights-off fixtures in `tests/fixtures`.

## Connect PopuPiano

Open the site over HTTPS or on localhost in a browser with Web MIDI. Connect PopuPiano to the computer running the browser. Select **Connect MIDI**, allow SysEx access, and choose the input and output ports if multiple ports are available. The input plays notes at their MIDI velocity and highlights held keys on screen. Select **No MIDI input** to disable incoming notes. If the browser lists a custom port name, restore its original PopuPiano name in your MIDI settings. [Web MIDI API](https://www.w3.org/TR/webmidi/)

**Light up notes** sends the palette and the pattern to the 29-key main module. **Individual note colors** lets you assign a color to each pitch class across octaves. **Turn off lights** sends lights-off frames to the main module and ExtraPiano. **SysEx commands** shows the current pattern as hexadecimal bytes.

## Build for GitHub Pages

```powershell
npm.cmd run build
npm.cmd run preview
```

Publish `dist/`. The build uses relative URLs so it can run from a GitHub Pages subdirectory. In GitHub Actions, build from `apps/web` and upload `apps/web/dist` as the Pages artifact. [Vite guide to GitHub Pages](https://vite.dev/guide/static-deploy.html#github-pages)
