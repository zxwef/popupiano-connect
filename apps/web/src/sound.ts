import { pianoSamples } from './piano-samples';

let audio: AudioContext | undefined;
let output: DynamicsCompressorNode | undefined;

const decodedSamples = new Map<string, AudioBuffer>();
const loadingSamples = new Map<string, Promise<AudioBuffer>>();

interface PianoSample {
  buffer: AudioBuffer;
  rate: number;
}

function audioContext(): AudioContext {
  if (!audio) {
    audio = new AudioContext();
    output = audio.createDynamicsCompressor();
    const dry = audio.createGain();
    dry.gain.value = 0.82;
    output.connect(dry).connect(audio.destination);

    // Match the light room reverb used by the PopuMusic piano.
    const reverb = audio.createConvolver();
    const impulse = audio.createBuffer(2, Math.round(audio.sampleRate * 2.5), audio.sampleRate);
    for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
      const data = impulse.getChannelData(channel);
      for (let index = 0; index < data.length; index++) {
        data[index] = (2 * Math.random() - 1) * (1 - index / data.length) ** 3;
      }
    }
    reverb.buffer = impulse;
    const wet = audio.createGain();
    wet.gain.value = 0.18;
    output.connect(reverb).connect(wet).connect(audio.destination);
  }
  return audio;
}

export async function enableSound(): Promise<void> {
  const context = audioContext();
  if (context.state !== 'running') await context.resume();
}

async function fetchSample(context: AudioContext, url: string): Promise<AudioBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Could not load piano sample ' + url);
  return context.decodeAudioData(await response.arrayBuffer());
}

function recordingFor(note: number, samples: readonly (readonly [number, string])[] = pianoSamples) {
  const [sampleNote, url] = samples.reduce((nearest, sample) =>
    Math.abs(sample[0] - note) < Math.abs(nearest[0] - note) ? sample : nearest);
  return { url, rate: 2 ** ((note - sampleNote) / 12) };
}

function loadSample(context: AudioContext, url: string): Promise<AudioBuffer> {
  const ready = decodedSamples.get(url);
  if (ready) return Promise.resolve(ready);
  let loading = loadingSamples.get(url);
  if (!loading) {
    loading = fetchSample(context, url).then(buffer => {
      decodedSamples.set(url, buffer);
      return buffer;
    }).finally(() => loadingSamples.delete(url));
    loadingSamples.set(url, loading);
  }
  return loading;
}

function connectVoice(context: AudioContext, source: AudioScheduledSourceNode, at: number, strength: number, fadingIn = false) {
  const envelope = context.createGain();
  envelope.gain.value = fadingIn ? 0 : strength;
  if (fadingIn) envelope.gain.linearRampToValueAtTime(strength, at + 0.008);
  if (source instanceof OscillatorNode) envelope.gain.setTargetAtTime(0, at + 0.01, 0.65);
  source.connect(envelope).connect(output!);
  source.onended = () => {
    source.disconnect();
    envelope.disconnect();
  };
  let released = false;
  return (releaseAt = context.currentTime, fast = false) => {
    if (released) return;
    released = true;
    const end = fast ? releaseAt : Math.max(releaseAt, at + 0.045);
    envelope.gain.cancelScheduledValues(end);
    envelope.gain.setTargetAtTime(0, end, fast ? 0.003 : 0.18);
    source.stop(end + (fast ? 0.015 : 1.2));
  };
}

function voice(context: AudioContext, sample: PianoSample, at: number, strength: number, offset = 0) {
  const source = context.createBufferSource();
  source.buffer = sample.buffer;
  source.playbackRate.value = sample.rate;
  const release = connectVoice(context, source, at, strength, offset > 0);
  source.start(at, offset);
  return release;
}

export function holdNote(note: number, velocity: number, onError: () => void): (fast?: boolean) => void {
  const context = audioContext();
  const at = context.currentTime;
  const { url, rate } = recordingFor(note);
  const strength = 0.65 * (velocity / 127) ** 1.5;
  let held = true;
  const reportError = () => { if (held) onError(); };
  if (context.state !== 'running') void context.resume().catch(reportError);

  const buffer = decodedSamples.get(url);
  let release: ReturnType<typeof connectVoice>;
  if (buffer) {
    release = voice(context, { buffer, rate }, at, strength);
  } else {
    const nearby = pianoSamples.filter(([pitch, url]) => Math.abs(pitch - note) <= 6 && decodedSamples.has(url));
    if (nearby.length) {
      const available = recordingFor(note, nearby);
      release = voice(context, { buffer: decodedSamples.get(available.url)!, rate: available.rate }, at, strength);
    } else {
      // Even the first tap has an attack while the first nearby recording is loading.
      const attack = context.createOscillator();
      attack.type = 'triangle';
      attack.frequency.value = 440 * 2 ** ((note - 69) / 12);
      release = connectVoice(context, attack, at, strength * 0.32, true);
      attack.start(at);
    }
    void loadSample(context, url).then(buffer => {
      if (!held) return;
      const now = context.currentTime;
      const offset = (now - at) * rate;
      release(now, true);
      if (offset < buffer.duration) release = voice(context, { buffer, rate }, now, strength, offset);
    }).catch(reportError);
  }
  return fast => {
    held = false;
    release(context.currentTime, fast);
  };
}

export async function playNotes(notes: readonly number[], step = 0): Promise<void> {
  await enableSound();
  const context = audio!;
  const samples = await Promise.all(notes.map(async note => {
    const { url, rate } = recordingFor(note);
    return { buffer: await loadSample(context, url), rate };
  }));
  const start = context.currentTime + 0.01;
  const strength = step ? 0.42 : 0.5 / Math.sqrt(samples.length);
  samples.forEach((sample, index) => {
    const at = start + index * step;
    voice(context, sample, at, strength)(at + (step || 0.65));
  });
}
