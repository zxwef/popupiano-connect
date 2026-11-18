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

## Preview the production build

```powershell
npm.cmd run build
npm.cmd run preview
```

## Deploy to GitHub Pages

In the GitHub repository, open **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**. To publish, open **Actions → Deploy PopuConnect Web → Run workflow** and select `master`. [GitHub Pages source configuration](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site#publishing-with-a-custom-github-actions-workflow)

Run the Web tests locally before publishing. The workflow installs dependencies, builds the site, and publishes `apps/web/dist`. Vite uses relative URLs so the site works under the repository path. The deployment URL appears in the workflow's `github-pages` environment. [Deployment workflow](../../.github/workflows/deploy-pages.yml)
