import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { extraPianoNotes, mainPianoNotes } from '../lighting';
import { noteName } from '../music';
import { applyPreference, rememberPreference } from '../preferences';
import { matchNote } from './practice';
import { createPracticeLights } from './practice-lights';
import { readScoreFile } from './score-file';
import { readLastScore, readScoreSettings, removeLastScore, scoreFileId, writeLastScore, writeScoreSettings } from './score-storage';
import { expectedNotes, partNotes, preparePracticeNotes, readPracticeNoteFlags, scorePositions, type ScorePosition } from './score';
import markup from './sheet-music.html?raw';
import './sheet-music.css';

export function mountSheetMusic(
  pianoKeys: ReadonlyMap<number, HTMLButtonElement>,
  setKeyboardRange: (extended: boolean) => void,
  restorePattern: () => void,
  selectedOutput: () => MIDIOutput | undefined,
) {
  const workbench = document.querySelector<HTMLElement>('.workbench')!;
  workbench.insertAdjacentHTML('afterbegin', markup);
  const controls = {
    openScore: document.querySelector<HTMLButtonElement>('#open-score')!,
    closeScore: document.querySelector<HTMLButtonElement>('#close-score')!,
    openSettings: document.querySelector<HTMLButtonElement>('#open-settings')!,
    upload: document.querySelector<HTMLDialogElement>('#score-upload')!,
    settings: document.querySelector<HTMLDialogElement>('#app-settings')!,
    openFullScore: document.querySelector<HTMLButtonElement>('#open-full-score')!,
    fullScore: document.querySelector<HTMLDialogElement>('#full-score-preview')!,
    panel: document.querySelector<HTMLElement>('#sheet-music')!,
    title: document.querySelector<HTMLHeadingElement>('#score-heading')!,
    composer: document.querySelector<HTMLParagraphElement>('#score-composer')!,
    file: document.querySelector<HTMLInputElement>('#score-file')!,
    drop: document.querySelector<HTMLLabelElement>('#score-drop')!,
    fileStatus: document.querySelector<HTMLParagraphElement>('#score-file-status')!,
    partField: document.querySelector<HTMLLabelElement>('#score-part-field')!,
    part: document.querySelector<HTMLSelectElement>('#score-part')!,
    staffField: document.querySelector<HTMLLabelElement>('#score-staff-field')!,
    staff: document.querySelector<HTMLSelectElement>('#score-staff')!,
    range: document.querySelector<HTMLSelectElement>('#score-range')!,
    layout: document.querySelector<HTMLSelectElement>('#score-layout')!,
    zoom: document.querySelector<HTMLSelectElement>('#score-zoom')!,
    first: document.querySelector<HTMLButtonElement>('#score-first')!,
    previous: document.querySelector<HTMLButtonElement>('#score-previous')!,
    next: document.querySelector<HTMLButtonElement>('#score-next')!,
    measureCount: document.querySelector<HTMLSpanElement>('#score-measure-count')!,
    measure: document.querySelector<HTMLSelectElement>('#score-measure')!,
    viewport: document.querySelector<HTMLDivElement>('#score-viewport')!,
    window: document.querySelector<HTMLDivElement>('#score-window')!,
    practiceControls: document.querySelector<HTMLDivElement>('#practice-controls')!,
    practice: document.querySelector<HTMLButtonElement>('#practice-toggle')!,
    repeat: document.querySelector<HTMLButtonElement>('#practice-repeat')!,
    expected: document.querySelector<HTMLParagraphElement>('#score-expected')!,
    rangeWarning: document.querySelector<HTMLParagraphElement>('#score-range-warning')!,
    practiceStatus: document.querySelector<HTMLParagraphElement>('#practice-status')!,
    practiceFeedback: document.querySelector<HTMLParagraphElement>('#practice-feedback')!,
    learningHints: document.querySelector<HTMLInputElement>('#learning-hints')!,
    lightsStatus: document.querySelector<HTMLParagraphElement>('#practice-lighting-status')!,
  };
  const keyboardViewport = document.querySelector<HTMLElement>('.keyboard__scroll')!;
  let display: OpenSheetMusicDisplay | undefined;
  let scoreId: string | undefined;
  const restoreDefaults = [
    rememberPreference('keyRange', controls.range, () => !scoreId),
    rememberPreference('scoreView', controls.layout, () => !scoreId),
    rememberPreference('scoreZoom', controls.zoom, () => !scoreId),
    rememberPreference('learningHints', controls.learningHints, () => !scoreId),
  ];
  let defaultZoom = Number(controls.zoom.value);
  let loadNumber = 0;
  let positions: ScorePosition[] = [];
  let noteFlags: ReturnType<typeof readPracticeNoteFlags> = new WeakMap();
  let transpositions = new Map<string, number | null>();
  let positionIndex = 0;
  let inlineScroll: { left: number; top: number; position: number; width: number } | undefined;
  let drawnWidth = 0;
  let unitInPixels = 0;
  let practice: 'idle' | 'active' | 'paused' | 'finished' = 'idle';
  let current = { midi: [] as number[], unsupported: false };
  let playableNotes = new Set(mainPianoNotes);
  const matched = new Set<number>();
  let lightingError = '';
  const updateLights = createPracticeLights(message => {
    lightingError = message;
    updateLightingStatus();
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) outputChanged();
  });

  function updateLightingStatus(): void {
    const output = selectedOutput();
    let message = lightingError;
    if (!message && practice === 'active' && controls.learningHints.checked && !output) {
      message = 'Select a PopuPiano MIDI output to use practice lights.';
    }
    controls.lightsStatus.hidden = !message;
    controls.lightsStatus.textContent = message;
  }

  function outputChanged(outputs?: readonly MIDIOutput[]): void {
    const sendHints = practice === 'active' && !controls.panel.hidden && controls.learningHints.checked;
    updateLights(sendHints ? selectedOutput() : undefined, current.midi, outputs);
    updateLightingStatus();
  }

  function selectedPart() {
    return display!.Sheet.Instruments[controls.part.selectedIndex];
  }

  function notesAtCursor() {
    const part = selectedPart();
    const staff = part.Staves[controls.staff.selectedIndex - 1];
    const transpose = transpositions.get(part.IdString);
    return expectedNotes(display!.Cursor.NotesUnderCursor(part), noteFlags, transpose, staff);
  }

  function updateStaves(): void {
    const staves = selectedPart().Staves;
    controls.staff.replaceChildren(new Option('All staves'), ...staves.map((_, index) => {
      if (staves.length === 2) return new Option(index === 0 ? 'Upper staff' : 'Lower staff');
      return new Option('Staff ' + (index + 1));
    }));
    controls.staffField.hidden = staves.length < 2;
  }

  function updateRangeWarning(): void {
    const part = selectedPart();
    const staff = part.Staves[controls.staff.selectedIndex - 1];
    const transpose = transpositions.get(part.IdString);
    const notes = expectedNotes(partNotes(display!.Sheet, part), noteFlags, transpose, staff);
    const unavailable = notes.midi.filter(note => !playableNotes.has(note));
    const warning = [];
    if (unavailable.length) warning.push('Outside the selected key range: ' + unavailable.map(noteName).join(', ') + '.');
    if (transpose === null) {
      warning.push('Practice supports a single transposition for the whole part. Choose another part or export in concert pitch.');
    } else if (notes.unsupported) {
      warning.push('This selection contains pitches or percussion that cannot be played on piano keys.');
    }
    controls.rangeWarning.hidden = !warning.length;
    controls.rangeWarning.textContent = warning.join(' ');
  }

  function updateKeyboard(): void {
    const extended = controls.range.value === 'extended';
    playableNotes = new Set(extended ? [...mainPianoNotes, ...extraPianoNotes] : mainPianoNotes);
    setKeyboardRange(extended);
  }

  function setFileStatus(message: string, error = false): void {
    controls.fileStatus.textContent = message;
    controls.fileStatus.hidden = !message;
    controls.fileStatus.classList.toggle('sheet-music__message--error', error);
  }

  function setPracticeStatus(message: string, error = false, feedback = error): void {
    controls.practiceStatus.textContent = message;
    controls.practiceStatus.classList.toggle('sheet-music__message--error', error);
    controls.practiceFeedback.textContent = feedback ? message : '';
    controls.practiceFeedback.hidden = !feedback;
    controls.practiceFeedback.classList.toggle('sheet-music__message--error', error);
  }

  function showExpectedKeys(notes: readonly number[], reveal = false): void {
    const highlighted = controls.learningHints.checked ? notes : [];
    for (const [note, key] of pianoKeys) {
      key.classList.toggle('keyboard__key--expected', highlighted.includes(note));
    }
    if (!reveal || !highlighted.length) return;
    const visible = highlighted.map(note => pianoKeys.get(note)).filter(key => key && !key.hidden);
    if (!visible.length) return;
    const first = visible[0]!.getBoundingClientRect();
    const last = visible[visible.length - 1]!.getBoundingClientRect();
    const bounds = keyboardViewport.getBoundingClientRect();
    const right = last.right - first.left < bounds.width - 12 ? last.right : first.right;
    if (first.left < bounds.left) keyboardViewport.scrollLeft += first.left - bounds.left - 8;
    else if (right > bounds.right) keyboardViewport.scrollLeft += right - bounds.right + 8;
  }

  function updateCursorVisibility(): void {
    if (display) {
      // Keep the cursor measurable so the score still follows the current position.
      display.Cursor.cursorElement.style.visibility = controls.learningHints.checked ? 'visible' : 'hidden';
    }
  }

  function revealCursor(): void {
    const cursorElement = display!.Cursor.cursorElement;
    const viewport = controls.viewport.getBoundingClientRect();
    const cursor = cursorElement.getBoundingClientRect();
    const centerOffset = Math.max(0, (viewport.height - cursor.height) / 2);
    const margin = Math.min(centerOffset, 48);
    if (cursor.top < viewport.top + margin || cursor.bottom > viewport.bottom - margin) {
      controls.viewport.scrollTop += cursor.top - viewport.top - centerOffset;
    }
    if (cursor.left < viewport.left || cursor.right > viewport.right) {
      controls.viewport.scrollLeft += cursor.left - viewport.left - 24;
    }
  }

  function showScoreWindow(): void {
    if (!display) return;
    // Keep the engraving and cursor on the same SVG. Clip the rendered page to the cursor's system.
    const measure = display.GraphicSheet.findGraphicalMeasure(positions[positionIndex].measure, 0);
    const system = measure?.ParentMusicSystem;
    const bounds = controls.layout.value === 'line' && !controls.fullScore.open
      ? system?.PositionAndShape
      : undefined;
    controls.window.toggleAttribute('data-windowed', Boolean(bounds));
    if (!bounds || !system) return;

    const scale = unitInPixels * display.Zoom;
    const host = controls.window.firstElementChild!;
    const page = display.Drawer.Backends[system.Parent.PageNumber - 1]?.getInnerElement();
    const pageTop = page ? page.getBoundingClientRect().top - host.getBoundingClientRect().top : 0;
    const top = Math.max(0, Math.floor(pageTop + (bounds.AbsolutePosition.y + bounds.BorderMarginTop) * scale) - 6);
    const bottom = Math.ceil(pageTop + (bounds.AbsolutePosition.y + bounds.BorderMarginBottom) * scale) + 6;
    const previousTop = controls.window.style.getPropertyValue('--system-top');
    controls.window.style.setProperty('--system-top', top + 'px');
    controls.window.style.setProperty('--system-height', Math.max(1, bottom - top) + 'px');
    if (previousTop !== top + 'px') controls.viewport.scrollTop = 0;
  }

  function seek(index: number, byMeasure = false): void {
    const cursor = display!.Cursor;
    const target = positions[index];
    const previousMeasure = positions[positionIndex].measure;
    cursor.hide();
    if (index === 0) cursor.reset();
    else if (byMeasure && target.measure === previousMeasure + 1) cursor.nextMeasure();
    else if (byMeasure && target.measure === previousMeasure - 1) cursor.previousMeasure();
    else if (index === positionIndex + 1) cursor.next();
    else if (index === positionIndex - 1) cursor.previous();

    if (cursor.Iterator.EndReached || !cursor.Iterator.CurrentSourceTimestamp.Equals(target.timestamp)) {
      cursor.iterator = display!.Sheet.MusicPartManager.getIterator(target.timestamp);
    }
    positionIndex = index;
  }

  function showPosition(): void {
    if (!display || controls.panel.hidden || !drawnWidth) return;
    display.Cursor.show();
    updateCursorVisibility();
    showScoreWindow();
    if (!controls.fullScore.open) revealCursor();
    current = notesAtCursor();
    showExpectedKeys(current.midi, true);
    const measure = positions[positionIndex].measure;
    controls.measure.value = String(measure);
    controls.first.disabled = controls.previous.disabled = positionIndex === 0;
    const lastPosition = positionIndex === positions.length - 1;
    controls.next.disabled = lastPosition && practice !== 'active';
    const nextLabel = lastPosition && practice === 'active' ? 'Finish practice' : 'Next notes';
    controls.next.setAttribute('aria-label', nextLabel);
    controls.next.title = nextLabel;
    controls.practice.textContent = {
      idle: 'Start practice',
      active: 'Pause practice',
      paused: 'Resume practice',
      finished: 'Restart practice',
    }[practice];
    controls.repeat.disabled = practice === 'idle';
    const unavailable = current.midi.filter(note => !playableNotes.has(note));
    controls.expected.textContent = current.midi.length
      ? 'Expected notes: ' + current.midi.map(noteName).join(', ')
      : 'No new notes at this position.';
    if (unavailable.length) controls.expected.textContent += ' · Unavailable: ' + unavailable.map(noteName).join(', ');

    const skip = lastPosition ? 'Choose Finish practice to skip this position.' : 'Use Next notes to continue.';
    if (practice === 'finished') setPracticeStatus('Practice complete.', false, true);
    else if (practice === 'paused') setPracticeStatus('Practice paused.');
    else if (current.unsupported) setPracticeStatus('This position contains notes that cannot be played on piano keys. ' + skip, false, practice === 'active');
    else if (practice !== 'active') setPracticeStatus('');
    else if (unavailable.length) {
      const canUseExtension = unavailable.every(note => extraPianoNotes.includes(note));
      const rangeHint = canUseExtension ? 'Select With ExtraPiano (53 keys) to play these notes. '
        : 'These notes are outside both keyboard ranges. ';
      setPracticeStatus(rangeHint + skip, false, true);
    }
    else if (!current.midi.length) setPracticeStatus(skip, false, true);
    else if (matched.size) setPracticeStatus(matched.size + ' of ' + current.midi.length + ' notes matched.');
    else setPracticeStatus('Play the expected notes.');
    outputChanged();
    saveSettings();
  }

  function saveSettings(): void {
    if (!scoreId) return;
    writeScoreSettings(scoreId, {
      keyRange: controls.range.value,
      scoreView: controls.layout.value,
      scoreZoom: controls.zoom.value,
      learningHints: controls.learningHints.checked,
      part: controls.part.selectedIndex,
      staff: controls.staff.selectedIndex,
      position: positionIndex,
    });
  }

  function restoreSettings(settings: ReturnType<typeof readScoreSettings>): void {
    if (settings) {
      applyPreference(controls.range, settings.keyRange);
      applyPreference(controls.layout, settings.scoreView);
      applyPreference(controls.zoom, settings.scoreZoom);
      applyPreference(controls.learningHints, settings.learningHints);
      if (Number.isInteger(settings.part) && controls.part.options[settings.part]) {
        controls.part.selectedIndex = settings.part;
      }
      if (Number.isInteger(settings.position) && positions[settings.position]) {
        positionIndex = settings.position;
      }
    }
    updateStaves();
    if (settings && Number.isInteger(settings.staff) && controls.staff.options[settings.staff]) {
      controls.staff.selectedIndex = settings.staff;
    }
    updateKeyboard();
  }

  function renderScore(): void {
    if (!display || controls.panel.hidden || !controls.viewport.clientWidth) return;
    try {
      display.Zoom = Number(controls.zoom.value);
      display.render();
      drawnWidth = controls.viewport.clientWidth;
      seek(positionIndex);
      showPosition();
    } catch {
      clearScore();
      setFileStatus('Could not display this score. Try another MusicXML file.', true);
    }
  }

  function updateScoreViewport(): void {
    if (drawnWidth !== controls.viewport.clientWidth) renderScore();
    else showScoreWindow();
  }

  function openFullScore(): void {
    if (!display || !drawnWidth || inlineScroll) return;
    inlineScroll = {
      left: controls.viewport.scrollLeft,
      top: controls.viewport.scrollTop,
      position: positionIndex,
      width: drawnWidth,
    };
    // Preserve the page layout while the dialog owns the rendered score.
    controls.panel.style.minHeight = controls.panel.offsetHeight + 'px';
    controls.fullScore.showModal();
    controls.fullScore.append(controls.viewport);
    updateScoreViewport();
    controls.viewport.scrollTo(0, 0);
  }

  function restoreInlineScore(): void {
    const savedScroll = inlineScroll;
    if (!savedScroll) return;
    inlineScroll = undefined;
    controls.practiceFeedback.before(controls.viewport);
    controls.panel.style.removeProperty('min-height');
    if (!display) return;
    updateScoreViewport();
    if (!display) return;
    if (positionIndex === savedScroll.position && drawnWidth === savedScroll.width) {
      controls.viewport.scrollTo(savedScroll.left, savedScroll.top);
    } else {
      revealCursor();
    }
  }

  function clearScore(): void {
    practice = 'idle';
    matched.clear();
    current = { midi: [], unsupported: false };
    positions = [];
    noteFlags = new WeakMap();
    transpositions.clear();
    positionIndex = 0;
    drawnWidth = 0;
    display?.clear();
    display?.dispose();
    display = undefined;
    if (controls.fullScore.open) controls.fullScore.close();
    restoreInlineScore();
    if (scoreId) {
      for (const restore of restoreDefaults) restore();
      updateKeyboard();
    }
    scoreId = undefined;
    controls.window.replaceChildren();
    controls.window.removeAttribute('data-windowed');
    controls.window.style.removeProperty('--system-top');
    controls.panel.hidden = true;
    workbench.removeAttribute('data-score-open');
    controls.practiceControls.hidden = true;
    controls.partField.hidden = true;
    controls.staffField.hidden = true;
    controls.title.textContent = '';
    controls.composer.hidden = true;
    setPracticeStatus('');
    showExpectedKeys([]);
    restorePattern();
    outputChanged();
  }

  async function load(file: File, restoredId?: string): Promise<void> {
    const request = ++loadNumber;
    setFileStatus('Opening score…');
    let renderer: OpenSheetMusicDisplay | undefined;
    try {
      const xml = await readScoreFile(file);
      if (request !== loadNumber) return;
      const [osmd, id] = await Promise.all([
        import('opensheetmusicdisplay'),
        restoredId ?? scoreFileId(file),
      ]);
      if (request !== loadNumber) return;
      const practiceNotes = preparePracticeNotes(xml);

      // A pending load owns its container so it cannot replace a newer score.
      const container = document.createElement('div');
      renderer = new osmd.OpenSheetMusicDisplay(container, {
        backend: 'svg',
        autoResize: false,
        drawTitle: false,
        drawComposer: false,
        newSystemFromXML: true,
        keepWarm: false,
        fillEmptyMeasuresWithWholeRest: 1,
        autoGenerateMultipleRestMeasuresFromRestMeasures: false,
      });
      renderer.EngravingRules.CursorIgnoreRepetitions = true;
      try {
        await renderer.load(xml, file.name);
      } catch {
        throw new Error('OSMD could not read this MusicXML score.');
      }
      if (request !== loadNumber) return;

      const sheet = renderer.Sheet;
      const problem = Object.entries(sheet.Errors).find(([, messages]) => messages.length);
      if (problem) {
        const [measure, messages] = problem;
        throw new Error('Could not read bar ' + measure + '. ' + messages[0]);
      }
      const newPositions = scorePositions(sheet);
      if (!sheet.Instruments.length || !newPositions.length) {
        throw new Error('This score has no readable measures or notes.');
      }
      const newNoteFlags = readPracticeNoteFlags(sheet, practiceNotes.markers);
      const settings = readScoreSettings(id);
      let preparedWidth = 0;
      if (display) {
        preparedWidth = controls.viewport.clientWidth;
        const savedZoom = Array.from(controls.zoom.options).find(option => option.value === settings?.scoreZoom);
        renderer.Zoom = savedZoom ? Number(savedZoom.value) : defaultZoom;

        // Test the engraving at its display width before replacing an open score.
        const originalStyle = container.getAttribute('style');
        container.style.cssText = 'position:absolute;visibility:hidden;width:' + preparedWidth + 'px';
        controls.viewport.append(container);
        try {
          renderer.render();
        } catch {
          throw new Error('Could not display this score. Try another MusicXML file.');
        } finally {
          container.remove();
          if (originalStyle === null) container.removeAttribute('style');
          else container.setAttribute('style', originalStyle);
        }
        clearScore();
      }
      display = renderer;
      scoreId = id;
      renderer = undefined;
      unitInPixels = osmd.unitInPixels;
      positions = newPositions;
      noteFlags = newNoteFlags;
      transpositions = practiceNotes.transpositions;
      controls.title.textContent = sheet.TitleString || file.name;
      controls.title.title = controls.title.textContent;
      controls.composer.textContent = sheet.ComposerString;
      controls.composer.hidden = !sheet.ComposerString;
      controls.part.replaceChildren(...sheet.Instruments.map((part, index) => new Option(part.Name || 'Part ' + (index + 1))));
      controls.partField.hidden = sheet.Instruments.length < 2;
      const measures = sheet.SourceMeasures.map((measure, index) =>
        new Option(String(measure.getPrintedMeasureNumber()), String(index)));
      const availableMeasures = new Set(positions.map(position => position.measure));
      measures.forEach((option, index) => { option.disabled = !availableMeasures.has(index); });
      controls.measure.replaceChildren(...measures);
      controls.measureCount.textContent = '/ ' + sheet.SourceMeasures.length;
      controls.window.replaceChildren(container);
      controls.panel.hidden = false;
      controls.practiceControls.hidden = false;
      workbench.setAttribute('data-score-open', '');
      for (const key of pianoKeys.values()) key.classList.remove('keyboard__key--selected');
      setFileStatus('');
      restoreSettings(settings);
      updateRangeWarning();
      if (preparedWidth && preparedWidth === controls.viewport.clientWidth) {
        drawnWidth = preparedWidth;
        seek(positionIndex);
        showPosition();
      } else {
        renderScore();
      }
      if (!display || restoredId) return;
      try {
        await writeLastScore({ id, file });
      } catch {
        if (request === loadNumber) setFileStatus('This browser could not save the score for the next visit.', true);
        return;
      }
      if (request === loadNumber && controls.upload.open) controls.upload.close();
    } catch (error) {
      if (request === loadNumber) {
        setFileStatus(error instanceof Error ? error.message : 'Could not open this score.', true);
      }
    } finally {
      renderer?.clear();
      renderer?.dispose();
    }
  }

  function navigate(index: number, byMeasure = false): void {
    if (!display || !positions[index]) return;
    if (practice === 'finished') practice = 'idle';
    matched.clear();
    seek(index, byMeasure);
    if (byMeasure && practice === 'active') skipEmptyPositions();
    showPosition();
  }

  function skipEmptyPositions(): void {
    while (true) {
      const expected = notesAtCursor();
      if (expected.midi.length || expected.unsupported) return;
      if (positionIndex === positions.length - 1) {
        practice = 'finished';
        return;
      }
      seek(positionIndex + 1);
    }
  }

  function finishPractice(): void {
    matched.clear();
    practice = 'finished';
    showPosition();
  }

  function pressNote(note: number): void {
    if (practice !== 'active' || current.unsupported || !current.midi.length ||
      current.midi.some(expected => !playableNotes.has(expected))) return;
    const result = matchNote(current.midi, matched, note);
    if (result === 'wrong') {
      setPracticeStatus(noteName(note) + ' is incorrect here. Play the expected notes.', true);
    } else if (result === 'matched') {
      setPracticeStatus(matched.size + ' of ' + current.midi.length + ' notes matched.');
    } else if (result === 'complete') {
      matched.clear();
      if (positionIndex === positions.length - 1) practice = 'finished';
      else {
        seek(positionIndex + 1);
        skipEmptyPositions();
      }
      showPosition();
    }
  }

  controls.openScore.addEventListener('click', () => controls.upload.showModal());
  controls.openSettings.addEventListener('click', () => controls.settings.showModal());
  controls.openFullScore.addEventListener('click', openFullScore);
  controls.fullScore.addEventListener('close', restoreInlineScore);
  controls.closeScore.addEventListener('click', async () => {
    const id = scoreId;
    if (!id) return;
    const request = ++loadNumber;
    controls.closeScore.disabled = true;
    let removed = true;
    try {
      await removeLastScore(id);
    } catch {
      removed = false;
    }
    controls.closeScore.disabled = false;
    if (request !== loadNumber) return;
    clearScore();
    if (removed) setFileStatus('Supports .musicxml, .xml and .mxl files.');
    else setFileStatus('This browser could not remove the saved score.', true);
    controls.openScore.focus();
  });
  controls.file.addEventListener('change', () => {
    const file = controls.file.files?.[0];
    controls.file.value = '';
    if (file) void load(file);
  });
  controls.drop.addEventListener('dragover', event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    controls.drop.classList.add('sheet-music__file--dragging');
  });
  controls.drop.addEventListener('dragleave', () => controls.drop.classList.remove('sheet-music__file--dragging'));
  controls.drop.addEventListener('drop', event => {
    event.preventDefault();
    controls.drop.classList.remove('sheet-music__file--dragging');
    const file = event.dataTransfer?.files[0];
    if (file) void load(file);
  });
  controls.first.addEventListener('click', () => navigate(0));
  controls.previous.addEventListener('click', () => navigate(positionIndex - 1));
  controls.next.addEventListener('click', () => {
    if (practice === 'active' && positionIndex === positions.length - 1) finishPractice();
    else navigate(positionIndex + 1);
  });
  controls.measure.addEventListener('change', () => {
    const measure = Number(controls.measure.value);
    navigate(positions.findIndex(position => position.measure === measure), true);
  });
  controls.zoom.addEventListener('change', () => {
    if (!scoreId) defaultZoom = Number(controls.zoom.value);
    renderScore();
  });
  controls.layout.addEventListener('change', () => showPosition());
  for (const field of [controls.part, controls.staff, controls.range]) {
    field.addEventListener('change', () => {
      if (field === controls.part) updateStaves();
      if (field === controls.range) updateKeyboard();
      if (!display) return;
      if (practice === 'finished') practice = 'idle';
      matched.clear();
      updateRangeWarning();
      if (practice === 'active') skipEmptyPositions();
      showPosition();
    });
  }
  controls.practice.addEventListener('click', () => {
    if (!display) return;
    if (practice === 'active') practice = 'paused';
    else {
      if (practice === 'finished') {
        matched.clear();
        seek(0);
      }
      practice = 'active';
      skipEmptyPositions();
      controls.settings.close();
    }
    showPosition();
  });
  controls.repeat.addEventListener('click', () => {
    navigate(positionIndex);
    controls.settings.close();
  });
  controls.learningHints.addEventListener('change', () => {
    updateCursorVisibility();
    showExpectedKeys(current.midi, true);
    outputChanged();
    saveSettings();
  });
  updateKeyboard();
  updateLightingStatus();
  new ResizeObserver(() => {
    if (drawnWidth !== controls.viewport.clientWidth) renderScore();
  }).observe(controls.viewport);
  const ready = readLastScore().then(score => {
    if (score && loadNumber === 0) return load(score.file, score.id);
  }).catch(() => {
    // Local files can still be opened when browser storage is unavailable.
  });

  return { pressNote, outputChanged, ready };
}
