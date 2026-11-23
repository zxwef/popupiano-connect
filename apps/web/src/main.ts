import './styles.css';
import { chordNotes, chords, firstNote, lastNote, noteName, pitchClasses, scaleNotes, scales } from './music';
import { lightsOffFrames, patternFrames, popuPianoPorts, sendFrames, type LightingOutput } from './lighting';
import { chooseBluetoothPiano, connectBluetoothPiano, type BluetoothMidiConnection } from './bluetooth';
import { readNoteEvent } from './midi-input';
import { enableSound, holdNote, playNotes } from './sound';
import { mountSheetMusic } from './sheet-music/sheet-music';
import { extraPianoNotes, mainPianoNotes } from './lighting';
import { rememberPreference } from './preferences';
import { renderPlayedStaff } from './played-staff';

const controls = {
  chord: document.querySelector<HTMLButtonElement>('#mode-chord')!,
  scale: document.querySelector<HTMLButtonElement>('#mode-scale')!,
  tonic: document.querySelector<HTMLSelectElement>('#tonic')!,
  pattern: document.querySelector<HTMLSelectElement>('#pattern')!,
  inversion: document.querySelector<HTMLSelectElement>('#inversion')!,
  inversionField: document.querySelector<HTMLLabelElement>('#inversion-field')!,
  listen: document.querySelector<HTMLButtonElement>('#listen')!,
  audioStatus: document.querySelector<HTMLParagraphElement>('#audio-status')!,
  keyboard: document.querySelector<HTMLDivElement>('#keys')!,
  computerOctave: document.querySelector<HTMLSelectElement>('#computer-octave')!,
  noteList: document.querySelector<HTMLUListElement>('#note-list')!,
  customColor: document.querySelector<HTMLInputElement>('#custom-color')!,
  swatches: document.querySelectorAll<HTMLButtonElement>('.palette__swatch'),
  noteColors: document.querySelector<HTMLDivElement>('#note-colors')!,
  resetColors: document.querySelector<HTMLButtonElement>('#reset-colors')!,
  connect: document.querySelector<HTMLButtonElement>('#connect-midi')!,
  bluetooth: document.querySelector<HTMLButtonElement>('#connect-bluetooth')!,
  connectionFeedback: document.querySelector<HTMLParagraphElement>('#connection-feedback')!,
  midiStatus: document.querySelector<HTMLSpanElement>('#midi-status')!,
  output: document.querySelector<HTMLSelectElement>('#output')!,
  outputField: document.querySelector<HTMLLabelElement>('#output-field')!,
  input: document.querySelector<HTMLSelectElement>('#input')!,
  inputField: document.querySelector<HTMLLabelElement>('#input-field')!,
  ports: document.querySelector<HTMLDivElement>('#midi-ports')!,
  lightsHint: document.querySelector<HTMLParagraphElement>('#lights-hint')!,
  lightsStatus: document.querySelector<HTMLParagraphElement>('#lights-status')!,
  apply: document.querySelector<HTMLButtonElement>('#apply-lights')!,
  off: document.querySelector<HTMLButtonElement>('#lights-off')!,
  sysex: document.querySelector<HTMLPreElement>('#sysex')!,
};

let mode: 'chord' | 'scale' = 'chord';
const choices = { chord: 0, scale: 0, inversion: 0 };
let scheduledNotes: number[] = [];
let highlightedNotes: number[] = [];
let midiAccess: MIDIAccess | undefined;
let bluetooth: BluetoothMidiConnection | undefined;
let connectionBusy = false;
let connectionPrompt: { transport: 'MIDI' | 'Bluetooth'; controller: AbortController } | undefined;
let switchingTransport = false;
let outputId = '';
let inputId: string | undefined;
let inputPort: MIDIInput | undefined;
let sendInProgress = false;
const pianoKeys = new Map<number, HTMLButtonElement>();
const playingTimers = new Map<number, number>();
interface HeldKey { note: number; release?: (fast?: boolean) => void }
const heldKeys = new Map<string, HeldKey>();
const noteColors = new Map<number, string>();
const notePickers = new Map<number, HTMLInputElement>();
const computerKeys = 'awsedftgyhujk';
const blackClasses = new Set([1, 3, 6, 8, 10]);

function paintPressed(note: number): void {
  const active = playingTimers.has(note) || [...heldKeys.values()].some(key => key.note === note);
  pianoKeys.get(note)?.classList.toggle('keyboard__key--playing', active);
}

function releaseKey(source: string, fast = false): void {
  const held = heldKeys.get(source);
  if (!held) return;
  heldKeys.delete(source);
  held.release?.(fast);
  paintPressed(held.note);
  updatePlayedStaff();
}

function releaseKeys(prefix: string, fast = false): void {
  for (const source of heldKeys.keys()) {
    if (source.startsWith(prefix)) releaseKey(source, fast);
  }
}

function releaseMidiInput(): void {
  releaseKeys('midi:', true);
}

function audioError(): void {
  controls.audioStatus.textContent = 'The browser could not play audio. Try pressing a key again.';
  controls.audioStatus.hidden = false;
}

function pressKey(source: string, note: number, velocity: number, duration?: number): void {
  const newPress = duration !== undefined || heldKeys.get(source)?.note !== note;
  releaseKey(source);
  controls.audioStatus.hidden = true;
  const held: HeldKey = { note };
  heldKeys.set(source, held);
  paintPressed(note);
  updatePlayedStaff();
  try {
    held.release = holdNote(note, velocity, audioError);
  } catch {
    audioError();
  }
  if (duration !== undefined) {
    window.setTimeout(() => {
      if (heldKeys.get(source) === held) releaseKey(source);
    }, duration);
  }
  if (newPress) sheetMusic.pressNote(note);
}

function animateNote(note: number, duration = 280): void {
  window.clearTimeout(playingTimers.get(note));
  playingTimers.set(note, window.setTimeout(() => {
    playingTimers.delete(note);
    paintPressed(note);
  }, duration));
  paintPressed(note);
}

async function play(notes: readonly number[], step = 0): Promise<void> {
  controls.audioStatus.hidden = true;
  try {
    await playNotes(notes, step);
    notes.forEach((note, index) => window.setTimeout(() => animateNote(note), index * step * 1000));
  } catch {
    audioError();
  }
}

controls.tonic.replaceChildren(...pitchClasses.map((name, index) => new Option(name, String(index))));

const extendedPianoNotes = [...new Set([...extraPianoNotes, ...mainPianoNotes])].sort((left, right) => left - right);
let whiteKeys = 0;
for (const note of extendedPianoNotes) {
  if (note === firstNote) whiteKeys = 0;
  const name = noteName(note);
  const black = blackClasses.has(note % 12);
  const key = document.createElement('button');
  key.type = 'button';
  key.className = 'keyboard__key' + (black ? ' keyboard__key--sharp' : '');
  key.setAttribute('aria-label', name);
  key.title = name;
  if (black) key.style.setProperty('--position', (whiteKeys / 17 * 100) + '%');
  else key.style.gridColumn = String(++whiteKeys);
  if (note % 12 === 0 || note === lastNote) key.textContent = name;
  key.hidden = !mainPianoNotes.includes(note);
  key.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    key.setPointerCapture(event.pointerId);
    pressKey('pointer:' + event.pointerId, note, 94);
  });
  key.addEventListener('lostpointercapture', event => releaseKey('pointer:' + event.pointerId));
  key.addEventListener('click', event => {
    if (event.detail === 0) pressKey('button:' + note, note, 94, 180);
  });
  pianoKeys.set(note, key);
  controls.keyboard.append(key);
}

const keyboardRange = document.querySelector<HTMLParagraphElement>('.keyboard__range')!;
const pianoOctaves = Array.from(controls.computerOctave.options);

function setKeyboardRange(extended: boolean): void {
  const notes = extended ? extendedPianoNotes : mainPianoNotes;
  const whiteCount = notes.filter(note => !blackClasses.has(note % 12)).length;
  let whiteKeys = 0;
  for (const [note, key] of pianoKeys) {
    key.hidden = !notes.includes(note);
    if (key.hidden) continue;
    if (blackClasses.has(note % 12)) key.style.setProperty('--position', (whiteKeys / whiteCount * 100) + '%');
    else key.style.gridColumn = String(++whiteKeys);
  }

  const range = noteName(notes[0]) + '–' + noteName(notes[notes.length - 1]);
  keyboardRange.textContent = range + ' · ' + notes.length + ' keys';
  controls.keyboard.setAttribute('aria-label', 'Virtual keyboard from ' + range);
  controls.keyboard.classList.toggle('keyboard__keys--extended', extended);
  controls.keyboard.style.setProperty('--white-key-count', String(whiteCount));

  const octave = controls.computerOctave.value;
  const octaves = [...pianoOctaves];
  if (extended) octaves.unshift(new Option('C1–C2', '24'), new Option('C2–C3', '36'));
  octaves.push(new Option('C5–E5', '72'));
  controls.computerOctave.replaceChildren(...octaves);
  controls.computerOctave.value = octaves.some(option => option.value === octave) ? octave : '60';
}

controls.keyboard.closest('.keyboard')!.after(controls.audioStatus);
const sheetMusic = mountSheetMusic(pianoKeys, setKeyboardRange, renderPattern, selectedOutput);

function renderPattern(): void {
  if (!showChordsAndScales.checked || workbench.hasAttribute('data-score-open')) return;
  const root = firstNote + Number(controls.tonic.value);
  const color = controls.customColor.value;
  const group = mode === 'chord' ? chords[choices.chord] : scales[choices.scale];
  if (mode === 'chord') {
    const names = ['Root position', 'First inversion', 'Second inversion', 'Third inversion', 'Fourth inversion'];
    const inversion = Math.min(choices.inversion, group.intervals.length - 1);
    controls.inversion.replaceChildren(...group.intervals.map((_, index) => new Option(names[index], String(index))));
    controls.inversion.value = String(inversion);
    choices.inversion = inversion;
    scheduledNotes = chordNotes(root, group.intervals, inversion);
    highlightedNotes = scheduledNotes;
  } else {
    scheduledNotes = [...group.intervals.map(interval => root + interval), root + 12];
    highlightedNotes = scaleNotes(root, group.intervals, extendedPianoNotes[0]);
  }
  const labels = mode === 'chord' ? scheduledNotes.map(noteName) : group.intervals.map(interval => pitchClasses[(root + interval) % 12]);
  controls.noteList.replaceChildren(...labels.map(label => {
    const item = document.createElement('li');
    item.className = 'keyboard__note';
    item.textContent = label;
    return item;
  }));
  for (const [note, key] of pianoKeys) {
    key.classList.toggle('keyboard__key--selected', highlightedNotes.includes(note));
    key.style.setProperty('--note-color', noteColors.get(note % 12) ?? color);
  }
  controls.sysex.textContent = patternFrames(highlightedNotes, color, noteColors)
    .map(frame => frame.map(byte => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ')).join('\n\n');
}

function setMode(next: typeof mode): void {
  mode = next;
  for (const [name, button] of [['chord', controls.chord], ['scale', controls.scale]] as const) {
    const active = name === mode;
    button.classList.toggle('mode-switch__button--active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  const patterns = mode === 'chord' ? chords : scales;
  controls.pattern.replaceChildren(...patterns.map((pattern, index) => new Option(pattern.label, String(index))));
  controls.pattern.value = String(choices[mode]);
  controls.inversionField.hidden = mode !== 'chord';
  renderPattern();
}

controls.chord.addEventListener('click', () => setMode('chord'));
controls.scale.addEventListener('click', () => setMode('scale'));
controls.tonic.addEventListener('change', renderPattern);
controls.pattern.addEventListener('change', () => {
  choices[mode] = Number(controls.pattern.value);
  renderPattern();
});
controls.inversion.addEventListener('change', () => {
  choices.inversion = Number(controls.inversion.value);
  renderPattern();
});
controls.listen.addEventListener('click', async () => {
  const notes = [...scheduledNotes];
  const step = mode === 'scale' ? 0.22 : 0;
  controls.listen.disabled = true;
  await play(notes, step);
  window.setTimeout(() => { controls.listen.disabled = false; }, step ? notes.length * step * 1000 : 400);
});
document.addEventListener('keydown', event => {
  if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || document.querySelector('dialog[open]') ||
    (event.target instanceof HTMLElement && event.target.closest('input, select, textarea, [contenteditable]'))) return;
  if (!event.code.startsWith('Key')) return;
  const index = computerKeys.indexOf(event.code.slice(3).toLowerCase());
  if (index < 0) return;
  const note = Number(controls.computerOctave.value) + index;
  if (note > lastNote) return;
  event.preventDefault();
  pressKey('pc:' + event.code, note, 94);
});
document.addEventListener('keyup', event => releaseKey('pc:' + event.code));
window.addEventListener('blur', () => {
  releaseKeys('pc:');
  releaseKeys('pointer:');
});

function setColor(color: string): void {
  controls.customColor.value = color;
  document.documentElement.style.setProperty('--note-color', color);
  for (const swatch of controls.swatches) swatch.setAttribute('aria-pressed', String(swatch.dataset.color === color));
  for (const [pitch, picker] of notePickers) {
    if (!noteColors.has(pitch)) picker.value = color;
  }
  renderPattern();
}

for (const swatch of controls.swatches) {
  swatch.addEventListener('click', () => setColor(swatch.dataset.color!));
}
controls.customColor.addEventListener('input', () => setColor(controls.customColor.value));

for (const [pitch, name] of pitchClasses.entries()) {
  const field = document.createElement('label');
  field.className = 'palette-editor__note';
  field.textContent = name;
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.className = 'palette-editor__input';
  picker.setAttribute('aria-label', name + ' note color');
  picker.value = controls.customColor.value;
  picker.addEventListener('input', () => {
    noteColors.set(pitch, picker.value);
    renderPattern();
  });
  notePickers.set(pitch, picker);
  field.append(picker);
  controls.noteColors.append(field);
}
controls.resetColors.addEventListener('click', () => {
  noteColors.clear();
  setColor(controls.customColor.value);
});

const workbench = document.querySelector<HTMLElement>('.workbench')!;
const showPlayedStaff = document.querySelector<HTMLInputElement>('#show-played-staff')!;
const playedStaffPanel = document.querySelector<HTMLElement>('.played-staff')!;
const playedStaff = document.querySelector<SVGSVGElement>('#played-staff')!;
controls.keyboard.closest('.keyboard')!.before(playedStaffPanel);
const showChordsAndScales = document.querySelector<HTMLInputElement>('#show-chords-scales')!;

function updatePlayedStaff(): void {
  if (showPlayedStaff.checked) {
    renderPlayedStaff(playedStaff, Array.from(heldKeys.values(), key => key.note));
  }
}

function updatePlayedStaffVisibility(): void {
  playedStaffPanel.hidden = !showPlayedStaff.checked;
  workbench.toggleAttribute('data-show-played-staff', showPlayedStaff.checked);
  updatePlayedStaff();
}

rememberPreference('showPlayedStaff', showPlayedStaff);
showPlayedStaff.addEventListener('change', updatePlayedStaffVisibility);
updatePlayedStaffVisibility();

function updatePatternVisibility(): void {
  const enabled = showChordsAndScales.checked;
  workbench.toggleAttribute('data-show-patterns', enabled);
  if (enabled) renderPattern();
  else {
    for (const key of pianoKeys.values()) key.classList.remove('keyboard__key--selected');
  }
}

rememberPreference('showChordsAndScales', showChordsAndScales);
showChordsAndScales.addEventListener('change', updatePatternVisibility);
workbench.toggleAttribute('data-show-patterns', showChordsAndScales.checked);

const topbar = document.querySelector<HTMLElement>('.topbar')!;
topbar.inert = workbench.inert = true;
document.body.dataset.appLoading = 'restoring';
void sheetMusic.ready.then(() => {
  topbar.inert = workbench.inert = false;
  document.body.removeAttribute('data-app-loading');
});

function selectedOutput(): LightingOutput | undefined {
  if (switchingTransport) return;
  if (bluetooth) return bluetooth.output;
  const output = midiAccess?.outputs.get(outputId);
  return output ? popuPianoPorts([output])[0] : undefined;
}

function handleMidiMessage(data: ArrayLike<number> | null): void {
  const noteEvent = readNoteEvent(data);
  if (!noteEvent) return;
  const prefix = 'midi:' + noteEvent.channel + ':';
  if (noteEvent.kind === 'releaseChannel') releaseKeys(prefix, data?.[1] === 120);
  else if (noteEvent.kind === 'release') releaseKey(prefix + noteEvent.note);
  else pressKey(prefix + noteEvent.note, noteEvent.note, noteEvent.velocity);
}

async function listenOn(input: MIDIInput | undefined): Promise<void> {
  if (inputPort === input) return;
  const old = inputPort;
  inputPort = input;
  if (old) {
    old.onmidimessage = null;
    releaseMidiInput();
  }
  if (input) input.onmidimessage = event => handleMidiMessage(event.data);
  if (old) await old.close().catch(() => {});
}

function updateMidiButtons(): void {
  const canLight = Boolean(selectedOutput());
  workbench.toggleAttribute('data-lighting-output', canLight);
  controls.apply.disabled = controls.off.disabled = sendInProgress || !canLight;
  controls.connect.disabled = connectionBusy || Boolean(bluetooth) || connectionPrompt?.transport === 'MIDI';
  controls.bluetooth.disabled = connectionBusy || sendInProgress || connectionPrompt?.transport === 'Bluetooth';
  controls.bluetooth.textContent = bluetooth ? 'Disconnect Bluetooth' : 'Connect Bluetooth';
}

function showLightsStatus(message: string): void {
  controls.lightsStatus.textContent = message;
  controls.lightsStatus.hidden = !message;
}

function connectionFeedback(message: string): void {
  controls.connectionFeedback.textContent = message;
  controls.connectionFeedback.hidden = !message;
}

async function waitForBrowser<T>(request: Promise<T>, milliseconds: number, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  let timer: number | undefined;
  let cancel: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new DOMException('The browser did not respond in time.', 'TimeoutError')), milliseconds);
    if (signal) {
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
    }
  });
  try {
    return await Promise.race([request, deadline]);
  } finally {
    window.clearTimeout(timer);
    if (cancel) signal?.removeEventListener('abort', cancel);
  }
}

async function requestBrowserAccess<T>(
  transport: 'MIDI' | 'Bluetooth', request: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  connectionPrompt?.controller.abort();
  const prompt = { transport, controller: new AbortController() };
  connectionPrompt = prompt;
  updateMidiButtons();
  connectionFeedback(transport === 'Bluetooth'
    ? 'Waiting for the browser’s Bluetooth device picker. Select PopuPiano there.'
    : 'Waiting for MIDI permission. Check your browser’s permission prompt.');
  try {
    const result = await request(prompt.controller.signal);
    prompt.controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (!prompt.controller.signal.aborted) throw error;
  } finally {
    if (connectionPrompt === prompt) {
      connectionPrompt = undefined;
      updateMidiButtons();
    }
  }
}

async function refreshOutputs(): Promise<boolean> {
  const outputs = midiAccess ? popuPianoPorts(midiAccess.outputs.values()) : [];
  const inputs = midiAccess ? popuPianoPorts(midiAccess.inputs.values()) : [];
  if (!outputId && outputs.length === 1) outputId = outputs[0].id;
  if (inputId === undefined && inputs.length === 1) inputId = inputs[0].id;
  for (const [select, ports, id, placeholder] of [
    [controls.output, outputs, outputId, 'Select a PopuPiano output'],
    [controls.input, inputs, inputId, 'No MIDI input'],
  ] as const) {
    select.replaceChildren(new Option(placeholder, ''), ...ports.map(port => new Option(port.name ?? 'PopuPiano', port.id)));
    select.value = ports.some(port => port.id === id) ? id! : '';
  }
  controls.outputField.hidden = outputs.length === 0;
  controls.inputField.hidden = inputs.length === 0;
  controls.ports.hidden = switchingTransport || Boolean(bluetooth) || (!outputs.length && !inputs.length);
  const inputClosed = listenOn(bluetooth || switchingTransport ? undefined : inputs.find(input => input.id === inputId));
  const availableOutputs = bluetooth ? (bluetooth.output ? [bluetooth.output] : []) : outputs;
  const lightsUpdated = sheetMusic.outputChanged(availableOutputs);
  const selected = selectedOutput();
  controls.midiStatus.textContent = switchingTransport ? 'Switching connection…'
    : bluetooth ? bluetooth.name + (selected ? ' · Bluetooth connected' : ' · Bluetooth input only')
    : selected && inputPort ? 'MIDI input and output selected'
    : selected ? 'MIDI output selected' : inputPort ? 'MIDI input selected'
    : outputs.length || inputs.length ? 'Select a MIDI port' : midiAccess ? 'PopuPiano not found' : 'MIDI disconnected';
  controls.midiStatus.classList.toggle('topbar__status--ready', !switchingTransport && Boolean(selected || inputPort || bluetooth));
  controls.lightsHint.textContent = selected
    ? 'The pattern applies to the 29 main keys. Turn off lights also clears ExtraPiano.'
    : 'Turn on PopuPiano and connect it to the device running this browser.';
  updateMidiButtons();
  const [, lightsCleared] = await Promise.all([inputClosed, lightsUpdated]);
  return lightsCleared;
}

controls.connect.addEventListener('click', async () => {
  if (connectionBusy || bluetooth || connectionPrompt?.transport === 'MIDI') return;
  connectionFeedback('');
  if (!navigator.requestMIDIAccess) {
    controls.midiStatus.textContent = 'Web MIDI unavailable';
    connectionFeedback('Open the site over HTTPS or localhost in a browser that supports Web MIDI.');
    return;
  }
  void enableSound().catch(audioError);
  try {
    if (!midiAccess) {
      midiAccess = await requestBrowserAccess('MIDI', signal =>
        waitForBrowser(navigator.requestMIDIAccess({ sysex: true }), 30000, signal));
      if (!midiAccess) return;
      midiAccess.onstatechange = () => {
        if (!bluetooth && !switchingTransport) void refreshOutputs();
      };
    } else {
      connectionPrompt?.controller.abort();
    }
    connectionFeedback('');
    controls.connect.textContent = 'Refresh ports';
    showLightsStatus('');
    void refreshOutputs();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      connectionFeedback('MIDI permission timed out. Close any pending browser prompt and try again.');
      return;
    }
    controls.midiStatus.textContent = 'MIDI access denied';
    connectionFeedback('Allow MIDI SysEx access in the site settings.');
  }
});

controls.bluetooth.addEventListener('click', async () => {
  if (connectionBusy || sendInProgress || connectionPrompt?.transport === 'Bluetooth') return;
  if (!navigator.bluetooth) {
    connectionFeedback('Direct Bluetooth requires Web Bluetooth. Open the site over HTTPS or localhost in Chrome or Edge with Bluetooth enabled.');
    return;
  }
  void enableSound().catch(audioError);
  let device: BluetoothDevice | undefined;
  let changingRoute = false;
  try {
    if (!bluetooth) {
      device = await requestBrowserAccess('Bluetooth', async signal => {
        try {
          return await waitForBrowser(chooseBluetoothPiano(), 30000, signal);
        } catch (error) {
          if (!(error instanceof DOMException) || error.name !== 'NotFoundError' || /disabled|blocked/i.test(error.message)) throw error;
          const availability = navigator.bluetooth.getAvailability?.();
          if (availability && await waitForBrowser(availability, 1500, signal).catch(() => undefined) === false) {
            throw new Error('The browser could not access a Bluetooth adapter. Check that Bluetooth is on in Windows.');
          }
          throw error;
        }
      });
      if (!device) return;
    }
    changingRoute = connectionBusy = true;
    connectionFeedback('');
    switchingTransport = true;
    releaseMidiInput();
    const cleared = await refreshOutputs();
    if (bluetooth) {
      const lightsCleared = cleared || await refreshOutputs();
      bluetooth?.disconnect();
      bluetooth = undefined;
      if (!lightsCleared) {
        connectionFeedback('Bluetooth disconnected. The practice lights may still be on. Reconnect and select Turn off lights.');
      }
    } else if (device) {
      for (const output of midiAccess?.outputs.values() ?? []) {
        if (output.connection === 'open') await output.close();
      }
      connectionFeedback('Connecting to ' + (device.name || 'the selected keyboard') + '…');
      const setup = new AbortController();
      const connection = connectBluetoothPiano(device, data => {
        if (bluetooth && !switchingTransport) handleMidiMessage(data);
      }, () => {
        if (!bluetooth) return;
        bluetooth = undefined;
        releaseMidiInput();
        connectionFeedback('Bluetooth disconnected. Turn on the keyboard and select Connect Bluetooth to reconnect.');
        void refreshOutputs();
      }, setup.signal);
      try {
        bluetooth = await waitForBrowser(connection, 15000);
        connectionFeedback('');
      } catch (error) {
        setup.abort();
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      connectionFeedback(device
        ? 'Bluetooth connection timed out. Turn the keyboard off and back on, then try again.'
        : 'The Bluetooth device picker did not respond. Close any pending browser prompt and try again.');
    } else if (!device && error instanceof DOMException && error.name === 'NotFoundError') {
      connectionFeedback(/disabled|blocked/i.test(error.message)
        ? 'Web Bluetooth is disabled or blocked in this browser. Try Chrome or Edge.'
        : 'No keyboard selected. Turn on Bluetooth and make PopuPiano discoverable to try again.');
    } else {
      connectionFeedback('Could not connect via Bluetooth. Check Bluetooth permissions, close other apps using the piano, and try again. ' +
        (error instanceof Error ? error.message : ''));
    }
  } finally {
    if (changingRoute) {
      switchingTransport = false;
      connectionBusy = false;
      void refreshOutputs();
    }
  }
});
controls.output.addEventListener('change', () => {
  outputId = controls.output.value;
  showLightsStatus('');
  refreshOutputs();
});
controls.input.addEventListener('change', () => {
  inputId = controls.input.value;
  refreshOutputs();
});

async function applyLights(frames: number[][]): Promise<void> {
  const output = selectedOutput();
  if (!output || sendInProgress) return;
  sendInProgress = true;
  updateMidiButtons();
  showLightsStatus('');
  try {
    await sendFrames(output, frames);
    showLightsStatus('Commands sent to the selected MIDI output.');
  } catch {
    showLightsStatus('Could not send the lighting commands. Check the MIDI output and SysEx permission.');
  } finally {
    sendInProgress = false;
    updateMidiButtons();
  }
}

controls.apply.addEventListener('click', () => void applyLights(patternFrames(highlightedNotes, controls.customColor.value, noteColors)));
controls.off.addEventListener('click', () => void applyLights(lightsOffFrames()));
setMode('chord');
