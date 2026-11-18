import assert from 'node:assert/strict';
import test from 'node:test';
import { readNoteEvent } from '../src/midi-input.ts';

test('keeps channel and velocity when parsing note-on', () => {
  assert.deepEqual(readNoteEvent([0x94, 60, 105]), { kind: 'press', channel: 4, note: 60, velocity: 105 });
});

test('handles both note-off encodings and all notes off', () => {
  const release = { kind: 'release', channel: 4, note: 60 };
  assert.deepEqual(readNoteEvent([0x84, 60, 22]), release);
  assert.deepEqual(readNoteEvent([0x94, 60, 0]), release);
  assert.deepEqual(readNoteEvent([0xb4, 123, 0]), { kind: 'releaseChannel', channel: 4 });
  assert.equal(readNoteEvent([0xf8]), undefined);
  assert.equal(readNoteEvent([0x94, 60, 128]), undefined);
});
