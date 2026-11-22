# PopuConnect Web

A static application built with Vanilla TypeScript, Vite, and BEM CSS. Play the C3–E5 virtual keyboard with Web Audio or use the computer keys `A W S E D F T G Y H U J K` in the selected octave. To explore chords, inversions, and scales, turn on **Show chords and scales** in **Settings**. The browser remembers your choice.

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

## MusicXML and practice

Click **Load MusicXML** and choose or drop a local partwise `.musicxml`, `.xml`, or `.mxl` file. The score appears above the piano on the same page. The arrow buttons move the cursor, and **Bar** jumps to a measure. **Full score preview** opens the entire score in a scrollable dialog. **Settings** offers zoom and a permanent **Full score** view. The default view shows the current line.

Plain XML files use UTF-8 and can be up to 5 MiB. MXL archives can be up to 1 MiB. The browser stops unpacking the score or container manifest if its entry exceeds 5 MiB. The browser stores the latest successfully opened file on this device and opens it again after a reload. It remembers each file's position, part, staff, key range, view, zoom, and learning hints. **Remove score** clears the file that opens automatically. Your settings are available when you choose that file again.

Open **Settings** to select a part and staff and start practice. The virtual piano, computer keyboard, and selected PopuPiano input all work in practice. Play chord tones in any order. Rests and tie continuations pass automatically. Practice details, repeat, and pause are in **Settings**.

Enable **Show played notes on a staff** in **Settings** to see the notes currently held on the virtual piano, computer keyboard, or MIDI input. The live staff sits above the keyboard and also works without a score.

The default **With ExtraPiano (53 keys)** range covers the configured C1–B2 extension and the C3–E5 main module. Use **Key range** in **Settings** to select the 29-key layout. Enable **Learning hints** in **Settings** to show the score cursor and highlight the expected keys on the virtual keyboard. During practice, this option also lights the main module through the selected PopuPiano MIDI output. The extension MIDI range comes from the existing configuration and needs confirmation on the instrument. ExtraPiano gets virtual hints. Its individual color assignments need hardware verification.

Practice follows written score order. For a part with a constant MusicXML transposition, it expects the sounding pitches. Export parts with staff-specific or changing transposition or octave doubling in concert pitch to practice them. Practice skips cue and grace notes. Expand ornaments in the score if you want to practice their individual notes. Positions with microtonal or unpitched notes can be skipped. Timewise MusicXML should be exported in partwise format. Future work includes timed playback, tempo control, and passage looping.

## Test in a browser

```powershell
npx.cmd playwright install chromium
npm.cmd run test:browser
```

Set `POPUCONNECT_TEST_BROWSER_CHANNEL` to `msedge` if Microsoft Edge is already installed. The browser tests exercise the production build under `/PopuConnect/`, including local loading, SVG and cursor movement, practice input, and a mock MIDI device. For a manual check, try a longer score exported from your notation editor and navigate between systems at mobile and desktop widths.

On a real PopuPiano, verify both MIDI port selections, the exact notes sent by the magnetic extension, and the main LED hints while starting, pausing, changing the output, and leaving the score. Run those checks over USB and Bluetooth where the browser lists the instrument.

## Deploy to GitHub Pages

In the GitHub repository, open **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**. To publish, open **Actions → Deploy PopuConnect Web → Run workflow** and select the branch to publish. If the `github-pages` environment restricts deployment branches, add the branch under **Settings → Environments → github-pages** first. The deployment updates the existing Pages site. [GitHub Pages source configuration](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site#publishing-with-a-custom-github-actions-workflow)

Run the Web tests locally before publishing. The workflow installs dependencies, builds the site, and publishes `apps/web/dist`. Vite uses relative URLs so the site works under the repository path. The deployment URL appears in the workflow's `github-pages` environment. [Deployment workflow](../../.github/workflows/deploy-pages.yml)
