import './styles.css';

const notes = [
  { name: 'C4', midi: 60, position: 1 },
  { name: 'C♯4', midi: 61, blackAfter: 1 },
  { name: 'D4', midi: 62, position: 2 },
  { name: 'D♯4', midi: 63, blackAfter: 2 },
  { name: 'E4', midi: 64, position: 3 },
  { name: 'F4', midi: 65, position: 4 },
  { name: 'F♯4', midi: 66, blackAfter: 4 },
  { name: 'G4', midi: 67, position: 5 },
  { name: 'G♯4', midi: 68, blackAfter: 5 },
  { name: 'A4', midi: 69, position: 6 },
  { name: 'A♯4', midi: 70, blackAfter: 6 },
  { name: 'B4', midi: 71, position: 7 },
  { name: 'C5', midi: 72, position: 8 },
];
const keyboard = document.querySelector<HTMLDivElement>('#keys')!;
const status = document.querySelector<HTMLParagraphElement>('#audio-status')!;
let audio: AudioContext | undefined;

async function playNote(note: number): Promise<void> {
  audio ??= new AudioContext();
  if (audio.state !== 'running') await audio.resume();

  const start = audio.currentTime;
  const oscillator = audio.createOscillator();
  const envelope = audio.createGain();
  oscillator.type = 'triangle';
  oscillator.frequency.value = 440 * 2 ** ((note - 69) / 12);
  envelope.gain.setValueAtTime(0, start);
  envelope.gain.linearRampToValueAtTime(0.18, start + 0.015);
  envelope.gain.exponentialRampToValueAtTime(0.001, start + 0.55);
  oscillator.connect(envelope).connect(audio.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.55);
  oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
}

for (const note of notes) {
  const key = document.createElement('button');
  key.type = 'button';
  key.className = note.blackAfter ? 'key key--black' : 'key';
  key.textContent = note.name;
  if (note.blackAfter) key.style.left = (note.blackAfter * 12.5) + '%';
  if (note.position) key.style.gridColumn = String(note.position);
  key.addEventListener('click', async () => {
    try {
      await playNote(note.midi);
      status.hidden = true;
    } catch {
      status.textContent = 'Браузер не смог воспроизвести звук.';
      status.hidden = false;
    }
  });
  keyboard.append(key);
}
