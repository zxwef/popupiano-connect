const mainModule = { address: 0x03, count: 29, firstMidiNote: 48 };
const extensionModule = { address: 0x04, count: 24, firstMidiNote: 24 };

export const mainPianoNotes = Array.from({ length: mainModule.count }, (_, key) => mainModule.firstMidiNote + key);
export const extraPianoNotes = Array.from({ length: extensionModule.count }, (_, key) => extensionModule.firstMidiNote + key);

function lamps(module: typeof mainModule, slots?: ReadonlyMap<number, number>): number[] {
  const bytes = [0xf0, module.address, 0x20, module.count];
  for (let key = 0; key < module.count; key++) {
    bytes.push(key, slots?.get(module.firstMidiNote + key) ?? 0);
  }
  return [...bytes, 0xf7];
}

function rgb7(color: string): number[] {
  if (!/^#[a-f0-9]{6}$/i.test(color)) throw new Error('Expected an RGB color.');
  return [1, 3, 5].map(offset => {
    const channel = Number.parseInt(color.slice(offset, offset + 2), 16);
    return Math.min(127, Math.round(channel / 2));
  });
}

export function patternFrames(notes: readonly number[], color: string, noteColors?: ReadonlyMap<number, string>): number[][] {
  const colors = new Map<string, number>();
  const palette: number[] = [];
  const slots = new Map<number, number>();
  for (const note of notes) {
    if (!mainPianoNotes.includes(note)) continue;
    const channels = rgb7(noteColors?.get(note % 12) ?? color);
    const key = channels.join(',');
    let slot = colors.get(key);
    if (slot === undefined) {
      slot = colors.size + 1;
      colors.set(key, slot);
      palette.push(...channels);
    }
    slots.set(note, slot);
  }
  const assignment = lamps(mainModule, slots);
  return colors.size ? [[0xf0, 0x03, 0x1e, colors.size, 1, ...palette, 0xf7], assignment] : [assignment];
}

export function lightsOffFrames(): number[][] {
  return [lamps(mainModule), lamps(extensionModule)];
}

export function popuPianoPorts<Port extends MIDIPort>(ports: Iterable<Port>): Port[] {
  return [...ports].filter(port =>
    port.state === 'connected' && /popu[\s_-]*piano/i.test(port.name ?? ''));
}

const lastSend = new WeakMap<MIDIOutput, number>();

export function sendFinalFrame(output: MIDIOutput, frame: number[]): void {
  if ('clear' in output && typeof output.clear === 'function') {
    output.clear();
    output.send(frame);
  } else {
    // Put the final frame after any writes already queued by this page.
    output.send(frame, Math.max(performance.now(), (lastSend.get(output) ?? -25) + 25));
  }
}

export async function sendFrames(output: MIDIOutput, frames: readonly number[][], signal?: AbortSignal): Promise<void> {
  await output.open();
  if (signal?.aborted) return;
  let at = Math.max(performance.now(), (lastSend.get(output) ?? -25) + 25);
  for (const frame of frames) {
    output.send(frame, at);
    lastSend.set(output, at);
    at += 25;
  }
}
