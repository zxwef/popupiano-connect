import { expect, test } from '@playwright/test';

test('uses locally hosted piano recordings for keys and chord previews', async ({ page }) => {
  await page.addInitScript(() => {
    const start = AudioBufferSourceNode.prototype.start;
    window.playedPianoBuffers = [];
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.playedPianoBuffers.push(this.buffer);
      return start.apply(this, args);
    };
  });
  const sampleRequests = [];
  page.on('request', request => {
    if (request.url().endsWith('.mp3')) sampleRequests.push(new URL(request.url()).pathname);
  });

  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
  expect(sampleRequests).toEqual([]);

  await page.keyboard.down('KeyA');
  const playedCount = () => page.evaluate(() => window.playedPianoBuffers.length);
  await expect.poll(playedCount).toBe(1);
  await page.keyboard.up('KeyA');
  expect(sampleRequests).toEqual([expect.stringMatching(/^\/PopuConnect\/assets\/C4-[\w-]+\.mp3$/)]);
  expect(await page.evaluate(() => window.playedPianoBuffers[0].duration)).toBeGreaterThan(1);

  await page.keyboard.press('KeyW');
  await expect.poll(playedCount).toBe(2);
  expect(sampleRequests).toHaveLength(1);
  expect(await page.evaluate(() => window.playedPianoBuffers[0] === window.playedPianoBuffers[1])).toBe(true);

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Show chords and scales').check();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Play preview' }).click();
  await expect.poll(playedCount).toBe(5);
  await expect(page.locator('#audio-status')).toBeHidden();
});

test('short cold taps sound in order and never restart after key-up', async ({ page }) => {
  await page.addInitScript(() => {
    window.attacks = [];
    window.recordings = [];
    window.decodes = 0;
    const attack = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (...args) {
      window.attacks.push(Math.round(69 + 12 * Math.log2(this.frequency.value / 440)));
      return attack.apply(this, args);
    };
    const play = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.recordings.push(this.playbackRate.value);
      return play.apply(this, args);
    };
    const decode = AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData = async function (...args) {
      const buffer = await decode.apply(this, args);
      window.decodes++;
      return buffer;
    };
  });
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  await page.route('**/assets/C4-*.mp3', async route => {
    await gate;
    await route.continue();
  });
  await page.goto('./');
  await page.locator('body:not([data-app-loading])').waitFor();
  try {
    for (let i = 0; i < 3; i++) await page.keyboard.press('KeyA');
    await page.keyboard.down('KeyD');
    await expect.poll(() => page.evaluate(() => window.recordings.length)).toBe(1);
    await page.keyboard.up('KeyD');
    expect(await page.evaluate(() => window.attacks)).toEqual([60, 60, 60, 64]);
  } finally {
    resume();
  }
  await expect.poll(() => page.evaluate(() => window.decodes)).toBe(2);
  expect(await page.evaluate(() => window.recordings.length)).toBe(1);
  await page.keyboard.press('KeyA');
  expect(await page.evaluate(() => window.recordings.at(-1))).toBe(1);
  expect(await page.evaluate(() => window.recordings.length)).toBe(2);
});

test('a held key starts on a nearby recording and joins its own sample at the elapsed position', async ({ page }) => {
  await page.addInitScript(() => {
    window.voices = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (at, offset) {
      window.voices.push({ context: this.context, buffer: this.buffer, rate: this.playbackRate.value, at, offset });
      return start.call(this, at, offset);
    };
  });
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  await page.route('**/assets/Ds4-*.mp3', async route => { await gate; await route.continue(); });
  await page.goto('./');
  await page.locator('body:not([data-app-loading])').waitFor();
  try {
    await page.keyboard.down('KeyA');
    await page.waitForFunction(() => window.voices.length === 1);
    await page.keyboard.up('KeyA');
    await page.keyboard.down('KeyD');
    await page.waitForFunction(() => window.voices.length === 2 && window.voices[1].context.currentTime - window.voices[1].at > 0.08);
    expect(await page.evaluate(() => window.voices[1].buffer === window.voices[0].buffer)).toBe(true);
    expect(await page.evaluate(() => window.voices[1].rate)).toBeCloseTo(2 ** (4 / 12));
  } finally {
    resume();
  }
  await page.waitForFunction(() => window.voices.length === 3);
  await page.keyboard.up('KeyD');
  const timing = await page.evaluate(() => {
    const [, first, recorded] = window.voices;
    return { different: first.buffer !== recorded.buffer, offset: recorded.offset, elapsed: recorded.at - first.at, rate: recorded.rate };
  });
  expect(timing.different).toBe(true);
  expect(timing.rate).toBeCloseTo(2 ** (1 / 12));
  expect(timing.offset).toBeCloseTo(timing.elapsed * timing.rate, 3);
});
