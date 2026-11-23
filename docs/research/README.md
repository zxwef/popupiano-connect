# Reference sources

- The manufacturer's site describes the 29-key main module and lighting commands. [PopuPiano developer site](https://developer.popumusic.com/)
- The PartyKeys documentation describes frame formats across keyboard generations. [PartyKeys Protocol](https://github.com/allen4z/PartykeysProtocol)
- LED Lab sends ExtraPiano commands to the same MIDI output. [PopuPiano LED Lab](https://github.com/nachovy/PopuPiano-Visualization-Customizer/tree/6904d2d3c1d541d7b94f955ba2d796973f71ee37)
- First-generation research covers components, commands, and PopuMusic capture methods. [Goggs77's notes](https://github.com/Goggs77/partykeys-protocol/tree/96e53e197a78b265e7748ede4c589e049f007cd3)
- Microsoft documents the MIDI interfaces Desktop uses. [Windows MIDI Services](https://microsoft.github.io/MIDI/) · [WinRT MIDI](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/midi)
- The browser specification defines MIDI and SysEx access and permissions. [Web MIDI](https://www.w3.org/TR/webmidi/)
- The MIDI Association defines Bluetooth MIDI packet encoding and the MIDI GATT service. Chromium documents the browser device picker and GATT notifications. [BLE MIDI 1.0](https://midi.org/midi-over-bluetooth-low-energy-ble-midi) · [Web Bluetooth](https://developer.chrome.com/docs/capabilities/bluetooth)

Keep unverified findings and investigation procedures in a local file such as `docs/research/popupiano.local.md`. Git ignores `docs/research/*.local.md`. Add verified behavior and reproducible evidence to the protocol documentation. [PopuPiano protocols](../protocols/README.md)
