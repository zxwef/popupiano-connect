import type { Fraction, Instrument, MusicSheet, Note, Staff } from 'opensheetmusicdisplay';

export type ScorePosition = {
  measure: number;
  timestamp: Fraction;
};

type NoteFlags = {
  cue: boolean;
  tieStop: boolean;
  unpitched: boolean;
};

type NoteMarker = NoteFlags & { originalInstrumentId: string };

export function preparePracticeNotes(xml: Document) {
  const markers = new Map<string, NoteMarker>();
  const transpositions = new Map<string, number | null>();
  const instrumentIds = new Set(Array.from(xml.querySelectorAll('note > instrument[id]'), instrument => instrument.getAttribute('id')));
  let markerNumber = 0;

  for (const part of xml.querySelectorAll('score-partwise > part')) {
    const transposes = Array.from(part.querySelectorAll(':scope > measure > attributes > transpose'));
    const firstTranspose = transposes[0];
    if (firstTranspose) {
      const semitones = (transpose: Element) => Number(transpose.querySelector('chromatic')?.textContent)
        + 12 * Number(transpose.querySelector('octave-change')?.textContent ?? 0);
      const offset = semitones(firstTranspose);
      const firstNote = part.querySelector(':scope > measure > note');
      const startsBeforeNotes = !firstNote
        || Boolean(firstTranspose.compareDocumentPosition(firstNote) & Node.DOCUMENT_POSITION_FOLLOWING);
      const constant = startsBeforeNotes && transposes.every(transpose =>
        !transpose.hasAttribute('number') && !transpose.querySelector('double') && semitones(transpose) === offset);
      transpositions.set(part.getAttribute('id') ?? '', constant ? offset : null);
    }

    for (const note of part.querySelectorAll(':scope > measure > note')) {
      const cue = Boolean(note.querySelector(':scope > cue'));
      const tieStop = Boolean(note.querySelector(':scope > tie[type="stop"]'));
      const unpitched = Boolean(note.querySelector(':scope > unpitched'));
      if (!cue && !tieStop && !unpitched) continue;

      // OSMD exposes a note's instrument ID but does not expose these MusicXML flags.
      const instrument = note.querySelector(':scope > instrument:last-of-type')
        ?? note.appendChild(xml.createElementNS(note.namespaceURI, 'instrument'));
      let marker: string;
      do {
        marker = 'popuconnect-practice-' + ++markerNumber;
      } while (instrumentIds.has(marker));
      markers.set(marker, { originalInstrumentId: instrument.getAttribute('id') ?? '', cue, tieStop, unpitched });
      instrument.setAttribute('id', marker);
    }
  }
  return { markers, transpositions };
}

export function readPracticeNoteFlags(sheet: MusicSheet, markers: ReadonlyMap<string, NoteMarker>): WeakMap<Note, NoteFlags> {
  const flags = new WeakMap<Note, NoteFlags>();
  if (!markers.size) return flags;
  for (const note of partNotes(sheet)) {
    const marker = markers.get(note.PlaybackInstrumentId);
    if (!marker) continue;
    note.PlaybackInstrumentId = marker.originalInstrumentId;
    flags.set(note, marker);
  }
  return flags;
}

export function scorePositions(sheet: MusicSheet): ScorePosition[] {
  const iterator = sheet.MusicPartManager.getIterator();
  const positions: ScorePosition[] = [];
  while (!iterator.EndReached) {
    if (iterator.CurrentVisibleVoiceEntries().length) {
      positions.push({
        measure: iterator.CurrentMeasureIndex,
        timestamp: iterator.CurrentSourceTimestamp,
      });
    }
    iterator.moveToNextVisibleVoiceEntry(false);
  }
  return positions;
}

export function expectedNotes(
  notes: Iterable<Note>,
  flags: Readonly<WeakMap<Note, NoteFlags>>,
  transpose: number | null | undefined,
  staff?: Staff,
): { midi: number[]; unsupported: boolean } {
  const pitches = new Set<number>();
  let unsupported = false;
  for (const note of notes) {
    if (staff && note.ParentStaff !== staff) continue;
    if (note.isRest() || !note.PrintObject || note.IsGraceNote) continue;
    const noteFlags = flags.get(note);
    if (noteFlags?.cue) continue;
    if (noteFlags?.unpitched || transpose === null) {
      unsupported = true;
      continue;
    }
    // OSMD uses an empty type for a sustaining tie. Other ties can represent techniques such as hammer-ons.
    if (noteFlags?.tieStop || note.NoteTies.some(tie => tie.Type === '' && tie.StartNote !== note)) continue;

    // OSMD's semitone numbering places MusicXML C4 at 48. MIDI places it at 60.
    const midi = (note.Pitch?.getHalfTone() ?? NaN) + 12 + (transpose ?? 0);
    if (!Number.isInteger(midi) || midi < 0 || midi > 127) {
      unsupported = true;
    } else {
      pitches.add(midi);
    }
  }
  return { midi: [...pitches].sort((left, right) => left - right), unsupported };
}

export function* partNotes(sheet: MusicSheet, instrument?: Instrument): Iterable<Note> {
  for (const measure of sheet.SourceMeasures) {
    for (const position of measure.VerticalSourceStaffEntryContainers) {
      for (const staffEntry of position.StaffEntries) {
        if (!staffEntry || (instrument && staffEntry.ParentStaff.ParentInstrument !== instrument)) continue;
        for (const voice of staffEntry.VoiceEntries) yield* voice.Notes;
      }
    }
  }
}
