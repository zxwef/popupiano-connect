let audio: AudioContext | undefined;
let output: DynamicsCompressorNode | undefined;

export async function enableSound(): Promise<void> {
  if (!audio) {
    audio = new AudioContext();
    output = audio.createDynamicsCompressor();
    output.connect(audio.destination);
  }
  if (audio.state !== 'running') await audio.resume();
}

function voice(note: number, at: number, strength: number): (releaseAt?: number) => void {
  const context = audio!;
  const oscillator = context.createOscillator();
  const overtone = context.createOscillator();
  const overtones = context.createGain();
  const envelope = context.createGain();
  const frequency = 440 * 2 ** ((note - 69) / 12);
  oscillator.type = 'triangle';
  oscillator.frequency.value = frequency;
  overtone.frequency.value = frequency * 2;
  overtones.gain.setValueAtTime(0.22, at);
  overtones.gain.setTargetAtTime(0.002, at + 0.025, 0.12);
  envelope.gain.setValueAtTime(0, at);
  envelope.gain.linearRampToValueAtTime(strength, at + 0.009);
  envelope.gain.setTargetAtTime(0.0001, at + 0.009, 0.8);
  oscillator.connect(envelope);
  overtone.connect(overtones).connect(envelope);
  envelope.connect(output!);
  oscillator.start(at);
  overtone.start(at);
  oscillator.onended = () => {
    oscillator.disconnect();
    overtone.disconnect();
    overtones.disconnect();
    envelope.disconnect();
  };
  let released = false;
  return (releaseAt = context.currentTime) => {
    if (released) return;
    released = true;
    const end = Math.max(releaseAt, at + 0.009);
    envelope.gain.setTargetAtTime(0.0001, end, 0.06);
    oscillator.stop(end + 0.32);
    overtone.stop(end + 0.32);
  };
}

export async function holdNote(note: number, velocity: number): Promise<() => void> {
  await enableSound();
  return voice(note, audio!.currentTime, 0.28 * (velocity / 127) ** 1.5);
}

export async function playNotes(notes: readonly number[], step = 0): Promise<void> {
  await enableSound();
  const start = audio!.currentTime + 0.01;
  const strength = step ? 0.22 : 0.23 / Math.sqrt(notes.length);
  notes.forEach((note, index) => {
    const at = start + index * step;
    voice(note, at, strength)(at + (step || 0.65));
  });
}
