import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { bluetoothSysExPackets, createBluetoothMidiInput, readBluetoothMidi } from '../src/ble-midi.ts';

function messages(...packets) {
  const result = [];
  for (const packet of packets) readBluetoothMidi(Uint8Array.from(packet), message => result.push([...message]));
  return result;
}

test('reads chords, note releases and channel controllers with packet-local running status', () => {
  assert.deepEqual(messages(
    [0x80, 0x80, 0x91, 60, 64, 64, 65, 0x82, 67, 0],
    [0x80, 0x83, 59, 30],
    [0x80, 0x84, 0x81, 60, 8, 0x85, 0xb1, 123, 0],
  ), [[0x91, 60, 64], [0x91, 64, 65], [0x91, 67, 0], [0x81, 60, 8], [0xb1, 123, 0]]);
});

test('inherits timestamps for chords and advances the high bits when timestampLow wraps', () => {
  const events = [];
  const packet = [0x83, 0xfc, 0x90, 60, 90, 64, 90, 0xfe, 0xf8, 0x85, 60, 0];
  readBluetoothMidi(Uint8Array.from(packet), (message, time) => events.push([message[1], time]));
  assert.deepEqual(events, [[60, 508], [64, 508], [60, 517]]);
});

test('delivers chords together and preserves MIDI time across notifications and a 13-bit wrap', t => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  function advance(ms) {
    now += ms;
    t.mock.timers.tick(ms);
  }
  const events = [];
  const input = createBluetoothMidiInput(message => events.push([message[1], message[2], now]));
  input.read(Uint8Array.from([0xbf, 0xfe, 0x90, 60, 90, 64, 90, 0x82, 67, 90]));
  assert.deepEqual(events, [[60, 90, 100], [64, 90, 100]]);

  advance(2);
  input.read(Uint8Array.from([0x80, 0x82, 0x80, 60, 0, 0x88, 64, 0]));
  assert.equal(events.length, 2);
  advance(2);
  assert.deepEqual(events.slice(2), [[67, 90, 104], [60, 0, 104]]);
  advance(6);
  assert.deepEqual(events.at(-1), [64, 0, 110]);

  // A new packet after several clock wraps starts immediately. Disconnect drops its queued release.
  advance(20000);
  input.read(Uint8Array.from([0xb1, 0x88, 0x90, 72, 90, 0x94, 72, 0]));
  assert.deepEqual(events.at(-1), [72, 90, 20110]);
  input.clear();
  advance(12);
  assert.equal(events.length, 6);
});

test('system messages preserve running status and fragmented SysEx never plays notes', () => {
  assert.deepEqual(messages(
    [0x80, 0x80, 0x90, 60, 64, 0x81, 0xf1, 1, 0x82, 60, 0, 0x83, 0xf0, 3, 0x20],
    [0x80, 60, 64, 0x84, 0xf8, 60, 0],
    [0x80, 0x85, 0xf8, 1, 2, 0xf7, 0xf7, 0x86, 0x90, 64, 70],
  ), [[0x90, 60, 64], [0x90, 60, 0], [0x90, 64, 70]]);
  assert.deepEqual(messages([0, 0x80, 0x90, 60, 127], [0x80, 0x80, 0x90, 60]), []);
});

test('frames both modules within the minimum MTU and timestamps each SysEx boundary', () => {
  for (const [file, sizes] of [['main-off.hex', [20, 20, 20, 9]], ['extra-piano-off.hex', [20, 20, 18]]]) {
    const hex = readFileSync(new URL('../../../tests/fixtures/' + file, import.meta.url), 'utf8');
    const frame = hex.trim().split(/\s+/).map(byte => Number.parseInt(byte, 16));
    const packets = bluetoothSysExPackets(frame, 8191);
    assert.deepEqual(packets.map(packet => packet.length), sizes);
    for (const packet of packets) assert.equal(packet[0], 0xbf);
    const bytes = packets.flatMap(packet => [...packet.slice(1)]);
    assert.deepEqual(bytes, [0xff, ...frame.slice(0, -1), 0xff, 0xf7]);
  }
  const palette = [0xf0, 3, 0x1e, 1, 1, 127, 0, 20, 0xf7];
  assert.deepEqual([...bluetoothSysExPackets(palette, 8192)[0]], [0x80, 0x80, ...palette.slice(0, -1), 0x80, 0xf7]);
});
