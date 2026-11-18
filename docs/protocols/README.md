# PopuPiano protocols

## First-generation lighting

The frame `F0 <module> 20 <pair count> <index slot> … F7` assigns palette slots to keys. Slot `00` turns a key's light off. The main module `03` has 29 keys indexed 0–28. ExtraPiano `04` has 24 keys indexed 0–23. Both frames go to the same MIDI output. [Frame format](https://github.com/allen4z/PartykeysProtocol/blob/2ea97de315aeb1e151c8e39dcff258f4cc8147ad/popupiano_LED_PROTOCOL.md) · [Module addresses](https://github.com/Goggs77/partykeys-protocol/blob/96e53e197a78b265e7748ede4c589e049f007cd3/docs/led-protocol.md)

The lights-off frames for both modules were verified over USB MIDI on a PopuPiano with `VID_2CF9&PID_001F`. Exact frames are available as test fixtures. [Shared MIDI fixtures](../../tests/fixtures/README.md)
