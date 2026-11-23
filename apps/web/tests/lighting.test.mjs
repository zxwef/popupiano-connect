import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { lightsOffFrames, patternFrames, popuPianoPorts, sendFrames } from '../src/lighting.ts';

function fixture(name) {
  const hex = readFileSync(new URL('../../../tests/fixtures/' + name, import.meta.url), 'utf8');
  return hex.trim().split(/\s+/).map(byte => Number.parseInt(byte, 16));
}

test('matches the shared main and ExtraPiano shutdown frames', () => {
  assert.deepEqual(lightsOffFrames(), [fixture('main-off.hex'), fixture('extra-piano-off.hex')]);
});

test('assigns the selected 29-key indices after a 7-bit palette update', () => {
  const [palette, lamps] = patternFrames([48, 52, 55, 76], '#FF017F');
  assert.deepEqual(palette, [0xf0, 3, 0x1e, 1, 1, 127, 1, 64, 0xf7]);
  const expected = fixture('main-off.hex');
  for (const key of [0, 4, 7, 28]) expected[5 + key * 2] = 1;
  assert.deepEqual(lamps, expected);
});

test('only offers connected PopuPiano outputs', () => {
  const popu = { name: 'Popu-Piano MIDI', state: 'connected' };
  assert.deepEqual(popuPianoPorts([popu, { name: 'LoopMIDI', state: 'connected' }, { name: 'PopuPiano USB', state: 'disconnected' }]), [popu]);
});

test('joins identical 7-bit colors and maps the same pitch class across octaves', () => {
  const [palette, assignment] = patternFrames([48, 60, 64, 67], '#80ABFF', new Map([[0, '#FF8001'], [4, '#FF7F01']]));
  assert.deepEqual(palette, [0xf0, 3, 0x1e, 2, 1, 127, 64, 1, 64, 86, 127, 0xf7]);
  const expected = fixture('main-off.hex');
  for (const key of [0, 12, 16]) expected[5 + key * 2] = 1;
  expected[5 + 19 * 2] = 2;
  assert.deepEqual(assignment, expected);
});

test('opens the output and keeps palette applied before lamps and clear', async () => {
  const sends = [];
  let opened = false;
  const output = {
    async open() { opened = true; },
    send(frame, at) { assert.equal(opened, true); sends.push({ frame, at }); },
  };
  const pattern = patternFrames([48], '#a9abff');
  const off = lightsOffFrames();
  await sendFrames(output, pattern);
  await sendFrames(output, off);
  assert.ok(performance.now() >= sends.at(-1).at - 1);
  assert.deepEqual(sends.map(entry => entry.frame), [...pattern, ...off]);
  for (let index = 1; index < sends.length; index++) {
    assert.ok(sends[index].at >= sends[index - 1].at + 25);
  }
});
