export type MidiNoteEvent =
  | { kind: 'press'; channel: number; note: number; velocity: number }
  | { kind: 'release'; channel: number; note: number }
  | { kind: 'releaseChannel'; channel: number };

export function readNoteEvent(data: ArrayLike<number> | null): MidiNoteEvent | undefined {
  if (!data || data.length !== 3) return;
  const status = data[0] >> 4;
  const channel = data[0] & 15;
  const note = data[1];
  const velocity = data[2];
  if (note > 127 || velocity > 127) return;
  if (status === 9 && velocity > 0) return { kind: 'press', channel, note, velocity };
  if (status === 8 || status === 9) return { kind: 'release', channel, note };
  if (status === 11 && (note === 120 || note === 123)) return { kind: 'releaseChannel', channel };
}
