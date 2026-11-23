import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const duet = fileURLToPath(new URL('../fixtures/duet.xml', import.meta.url));

async function mockConnections(page) {
  await page.addInitScript(() => {
    const device = Object.assign(new EventTarget(), { id: 'instrument', name: 'PopuPiano' });
    const io = Object.assign(new EventTarget(), {
      properties: { read: true, writeWithoutResponse: true },
      async readValue() { window.mock.calls.push('read'); },
      async startNotifications() {
        if (window.mock.failSetup) throw new Error('GATT notifications unavailable');
        if (window.mock.holdSetup) await new Promise(resolve => { window.mock.finishSetup = resolve; });
        window.mock.calls.push('notify');
      },
      async writeValueWithoutResponse(packet) {
        if (window.mock.failWrites > 0) {
          window.mock.failWrites--;
          window.mock.failedWrites++;
          throw new Error('Temporary GATT write failure');
        }
        if (window.mock.writing) throw new Error('GATT write in progress');
        if (!device.gatt.connected) throw new Error('GATT disconnected');
        window.mock.writing = true;
        await new Promise(resolve => setTimeout(resolve, 1));
        window.mock.packets.push([...packet]);
        window.mock.writing = false;
      },
    });
    device.gatt = {
      connected: false,
      async connect() { this.connected = true; return this; },
      async getPrimaryService(uuid) {
        if (uuid !== '03b80e5a-ede8-4b33-a751-6ce34ec4c700') throw new Error('Wrong service');
        return { async getCharacteristic(id) {
          if (id !== '7772e5db-3868-4112-a1a9-f2669d106bf3') throw new Error('Wrong characteristic');
          return io;
        } };
      },
      disconnect() {
        this.connected = false;
        device.dispatchEvent(new Event('gattserverdisconnected'));
      },
    };
    const input = { id: 'in', name: 'PopuPiano', state: 'connected', async close() {} };
    const access = { inputs: new Map([['in', input]]), outputs: new Map() };
    Object.defineProperty(navigator, 'requestMIDIAccess', { value: async () => {
      if (window.mock.holdMidi) await new Promise(resolve => { window.mock.finishMidi = resolve; });
      return access;
    } });
    Object.defineProperty(navigator, 'bluetooth', { value: {
      async requestDevice(options) {
        if (!options.optionalServices.includes('03b80e5a-ede8-4b33-a751-6ce34ec4c700')) throw new Error('Missing permission');
        if (window.mock.cancel) throw new DOMException('Cancelled', 'NotFoundError');
        if (window.mock.holdPicker) await new Promise(resolve => { window.mock.finishPicker = resolve; });
        return device;
      },
    } });
    window.mock = {
      device, input, calls: [], packets: [], failWrites: 0, failedWrites: 0,
      notify(bytes) {
        io.value = new DataView(Uint8Array.from(bytes).buffer);
        io.dispatchEvent(new Event('characteristicvaluechanged'));
      },
    };
  });
}

test('a stalled Bluetooth picker leaves Web MIDI available and ignores a late selection', async ({ page }) => {
  await mockConnections(page);
  await page.goto('./');
  await page.evaluate(() => { window.mock.holdPicker = true; });
  const bluetooth = page.getByRole('button', { name: 'Connect Bluetooth' });
  await bluetooth.click();
  await expect(page.locator('#connection-feedback')).toContainText('Waiting for the browser');
  await page.getByRole('button', { name: 'Connect MIDI' }).click();
  await expect(page.locator('#midi-status')).toHaveText('MIDI input selected');
  await expect(bluetooth).toBeEnabled();
  await page.evaluate(() => window.mock.finishPicker());
  await page.waitForFunction(() => window.mock.input.onmidimessage && !window.mock.device.gatt.connected);
  await expect(page.locator('#connection-feedback')).toBeHidden();
});

test('browser permission and Bluetooth setup time out and allow another attempt', async ({ page }) => {
  await mockConnections(page);
  await page.clock.install();
  await page.goto('./');
  const bluetooth = page.getByRole('button', { name: 'Connect Bluetooth' });
  const midi = page.getByRole('button', { name: 'Connect MIDI' });
  const feedback = page.locator('#connection-feedback');

  await page.evaluate(() => { window.mock.holdMidi = true; });
  await midi.click();
  await expect(feedback).toContainText('Waiting for MIDI permission');
  await expect(bluetooth).toBeEnabled();
  await page.clock.fastForward(30000);
  await expect(feedback).toContainText('MIDI permission timed out');
  await expect(midi).toBeEnabled();

  await page.evaluate(() => { window.mock.holdPicker = true; });
  await bluetooth.click();
  await expect(feedback).toContainText('Waiting for the browser');
  await page.clock.fastForward(30000);
  await expect(feedback).toContainText('picker did not respond');
  await expect(bluetooth).toBeEnabled();

  await page.evaluate(() => { window.mock.holdPicker = false; window.mock.holdSetup = true; });
  await bluetooth.click();
  await page.waitForFunction(() => Boolean(window.mock.finishSetup));
  await expect(feedback).toContainText('Connecting to PopuPiano');
  await page.clock.fastForward(15000);
  await expect(feedback).toContainText('Bluetooth connection timed out');
  await expect(midi).toBeEnabled();
  expect(await page.evaluate(() => window.mock.device.gatt.connected)).toBe(false);

  await page.evaluate(() => { window.mock.holdSetup = false; });
  await bluetooth.click();
  await expect(page.locator('#midi-status')).toContainText('Bluetooth connected');
  await page.evaluate(() => {
    window.mock.finishSetup();
    window.mock.finishPicker();
    window.mock.finishMidi();
  });
  await expect(page.locator('#midi-status')).toContainText('Bluetooth connected');
  expect(await page.evaluate(() => window.mock.device.gatt.connected)).toBe(true);
});

test('Bluetooth notes play piano samples, advance practice and send ordered SysEx to both modules', async ({ page }) => {
  await mockConnections(page);
  const audio = [];
  page.on('request', request => { if (request.url().endsWith('.mp3')) audio.push(request.url()); });
  await page.goto('./');
  await page.getByRole('button', { name: 'Connect Bluetooth' }).click();
  await expect(page.locator('#midi-status')).toContainText('Bluetooth connected');
  expect(await page.evaluate(() => window.mock.calls)).toEqual(['read', 'notify']);
  await page.getByRole('button', { name: 'Turn off lights' }).click();
  await expect(page.locator('#lights-status')).toContainText('Commands sent');
  const packets = await page.evaluate(() => window.mock.packets);
  expect(packets.map(packet => packet.length)).toEqual([20, 20, 20, 9, 20, 20, 18]);
  expect(packets[0].slice(2, 6)).toEqual([0xf0, 3, 0x20, 29]);
  expect(packets[4].slice(2, 6)).toEqual([0xf0, 4, 0x20, 24]);

  await page.getByRole('button', { name: 'Load MusicXML' }).click();
  await page.locator('#score-file').setInputFiles(duet);
  await expect(page.getByRole('heading', { name: 'Two Parts' })).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Learning hints').check();
  await page.getByRole('button', { name: 'Start practice' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
  const packetCount = () => page.evaluate(() => window.mock.packets.length);
  await expect.poll(packetCount).toBe(12); // Palette plus four assignment packets
  await page.evaluate(() => window.mock.notify([0x80, 0x80, 0x90, 67, 105]));
  await expect(page.locator('#practice-status')).toHaveText('Practice complete.');
  const pressed = page.locator('.keyboard__key--playing');
  await expect(pressed).toHaveAttribute('aria-label', 'G4');
  await expect.poll(() => audio.length).toBe(1);
  await expect.poll(packetCount).toBe(16); // The last expected note clears the main module.
  await page.evaluate(() => window.mock.notify([0x80, 0x80, 0x90, 67, 0]));
  await expect(pressed).toHaveCount(0);

  await page.evaluate(() => window.mock.notify([0x80, 0x80, 0x90, 24, 94, 60, 94]));
  await expect(pressed).toHaveCount(2);
  await page.evaluate(() => window.mock.device.gatt.disconnect());
  await expect(pressed).toHaveCount(0);
  await expect(page.locator('#connection-feedback')).toContainText('reconnect');
  await page.getByRole('button', { name: 'Connect Bluetooth' }).click();
  await expect(page.locator('#midi-status')).toContainText('Bluetooth connected');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Restart practice' }).click();
  await expect.poll(packetCount).toBe(21);
  await page.evaluate(() => { window.mock.failWrites = 1; });
  await page.getByRole('button', { name: 'Disconnect Bluetooth' }).click();
  await expect(page.locator('#midi-status')).toHaveText('MIDI disconnected');
  expect(await packetCount()).toBe(25); // Clear all four packets before disconnecting GATT.
  await expect(page.locator('#connection-feedback')).toBeHidden();
});

test('keeps the warning visible if both attempts to clear the lights before disconnect fail', async ({ page }) => {
  await mockConnections(page);
  await page.goto('./');
  await page.getByRole('button', { name: 'Connect Bluetooth' }).click();
  await page.getByRole('button', { name: 'Load MusicXML' }).click();
  await page.locator('#score-file').setInputFiles(duet);
  await page.getByRole('heading', { name: 'Two Parts' }).waitFor();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Learning hints').check();
  await page.getByRole('button', { name: 'Start practice' }).click();
  await expect.poll(() => page.evaluate(() => window.mock.packets.length)).toBe(5);
  await page.evaluate(() => { window.mock.failWrites = 2; });
  await page.getByRole('button', { name: 'Disconnect Bluetooth' }).click();
  await expect(page.locator('#midi-status')).toHaveText('MIDI disconnected');
  expect(await page.evaluate(() => window.mock.failedWrites)).toBe(2);
  await expect(page.locator('#connection-feedback')).toContainText('lights may still be on');
  await expect(page.locator('#connection-feedback')).toBeVisible();
});

test('All Sound Off cancels pending recordings only on its MIDI channel', async ({ page }) => {
  await mockConnections(page);
  await page.addInitScript(() => {
    window.recordings = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.recordings.push(this.playbackRate.value);
      return start.apply(this, args);
    };
  });
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  await page.route('**/assets/C4-*.mp3', async route => { await gate; await route.continue(); });
  await page.goto('./');
  await page.getByRole('button', { name: 'Connect Bluetooth' }).click();
  await expect(page.locator('#midi-status')).toContainText('Bluetooth connected');
  try {
    await page.evaluate(() => window.mock.notify([0x80, 0x80, 0x90, 60, 94, 0x80, 0x91, 61, 94, 0x80, 0xb0, 120, 0]));
    await expect(page.locator('.keyboard__key--playing')).toHaveCount(1);
  } finally {
    resume();
  }
  await expect.poll(() => page.evaluate(() => window.recordings.length)).toBe(1);
  expect(await page.evaluate(() => window.recordings[0])).toBeCloseTo(2 ** (1 / 12));
});

test('restores the system MIDI input after picker cancellation, GATT failure and manual disconnect', async ({ page }) => {
  await mockConnections(page);
  await page.goto('./');
  await page.getByRole('button', { name: 'Connect MIDI' }).click();
  const connect = page.getByRole('button', { name: 'Connect Bluetooth' });
  const pressed = page.locator('.keyboard__key--playing');
  await page.evaluate(() => {
    window.mock.input.onmidimessage({ data: [0x90, 60, 94] });
    window.mock.cancel = true;
  });
  await connect.click();
  await expect(pressed).toHaveCount(1);
  await expect(page.locator('#connection-feedback')).toContainText('No keyboard selected');

  await page.evaluate(() => { window.mock.cancel = false; window.mock.failSetup = true; });
  await connect.click();
  await expect(pressed).toHaveCount(0);
  await expect(page.locator('#midi-status')).toHaveText('MIDI input selected');
  await expect(page.locator('#connection-feedback')).toContainText('GATT notifications unavailable');
  expect(await page.evaluate(() => window.mock.device.gatt.connected)).toBe(false);
  await page.evaluate(() => { window.mock.failSetup = false; window.mock.device.name = 'Other MIDI keyboard'; });
  await connect.click();
  await expect(page.locator('#midi-status')).toContainText('Bluetooth input only');
  await expect(page.locator('#lights-off')).toBeDisabled();
  expect(await page.evaluate(() => window.mock.input.onmidimessage)).toBeNull();
  await page.getByRole('button', { name: 'Disconnect Bluetooth' }).click();
  await expect(page.locator('#midi-status')).toHaveText('MIDI input selected');
  await page.evaluate(() => {
    window.mock.notify([0x80, 0x80, 0x90, 67, 105]);
    window.mock.input.onmidimessage({ data: [0x90, 48, 94] });
  });
  await expect(pressed).toHaveAttribute('aria-label', 'C3');
});

test('disconnecting silences notes whose samples are still loading', async ({ page }) => {
  await mockConnections(page);
  await page.addInitScript(() => {
    window.pianoVoices = 0;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.pianoVoices++;
      return start.apply(this, args);
    };
  });
  let resumeFetch;
  const paused = new Promise(resolve => { resumeFetch = resolve; });
  const sampleUrl = '**/assets/C4-*.mp3';
  await page.route(sampleUrl, async route => {
    await paused;
    await route.continue();
  });
  await page.goto('./');
  const connect = page.getByRole('button', { name: 'Connect Bluetooth' });
  await connect.click();
  const request = page.waitForRequest(sampleUrl);
  await page.evaluate(() => window.mock.notify([0x80, 0x80, 0x90, 60, 94]));
  await request;
  try {
    await page.getByRole('button', { name: 'Disconnect Bluetooth' }).click();
    await connect.click();
    await page.evaluate(() => window.mock.notify([0x80, 0x80, 0x90, 60, 94]));
  } finally {
    resumeFetch();
  }
  await expect.poll(() => page.evaluate(() => window.pianoVoices)).toBe(1);
});
