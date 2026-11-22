import assert from 'node:assert/strict';
import test from 'node:test';
import { matchNote } from '../src/sheet-music/practice.ts';

test('matches each chord tone once in any order and keeps progress after a wrong note', () => {
  const matched = new Set();
  const chord = [60, 64, 67];
  assert.equal(matchNote(chord, matched, 67), 'matched');
  assert.equal(matchNote(chord, matched, 67), 'duplicate');
  assert.equal(matchNote(chord, matched, 72), 'wrong');
  assert.equal(matchNote(chord, matched, 60), 'matched');
  assert.equal(matchNote(chord, matched, 64), 'complete');
  assert.deepEqual([...matched], [67, 60, 64]);
});
