import assert from 'node:assert/strict';
import test from 'node:test';
import { chords, chordNotes, firstNote, lastNote, scaleNotes, scales } from '../src/music.ts';

test('chord inversions preserve the pitch classes and change the bass', () => {
  assert.deepEqual(chordNotes(48, chords[0].intervals, 0), [48, 52, 55]);
  assert.deepEqual(chordNotes(48, chords[0].intervals, 1), [52, 55, 60]);
  assert.deepEqual(chordNotes(48, chords[0].intervals, 2), [55, 60, 64]);
  for (let root = firstNote; root < firstNote + 12; root++) {
    for (const chord of chords) {
      for (let inversion = 0; inversion < chord.intervals.length; inversion++) {
        const notes = chordNotes(root, chord.intervals, inversion);
        assert.ok(notes.every(note => note >= firstNote && note <= lastNote));
        assert.ok(notes.every((note, index) => index === 0 || note > notes[index - 1]));
        assert.equal(notes[0] % 12, (root + chord.intervals[inversion]) % 12);
        assert.deepEqual(new Set(notes.map(note => note % 12)), new Set(chord.intervals.map(interval => (root + interval) % 12)));
      }
    }
  }
});

test('scale highlights matching pitches across the 29-key range', () => {
  const cMajor = scaleNotes(48, scales[0].intervals);
  assert.equal(cMajor.length, 17);
  assert.equal(cMajor[0], 48);
  assert.equal(cMajor.at(-1), 76);
  assert.ok(!cMajor.includes(49) && cMajor.includes(60));
  const bMinor = scaleNotes(59, scales[1].intervals);
  assert.ok(bMinor.includes(59) && bMinor.includes(71) && !bMinor.includes(63));
});
