export const firstNote = 48;
export const lastNote = 76;

export const pitchClasses = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'] as const;

export const chords = [
  { label: 'Major', intervals: [0, 4, 7] },
  { label: 'Minor', intervals: [0, 3, 7] },
  { label: 'Diminished', intervals: [0, 3, 6] },
  { label: 'Augmented', intervals: [0, 4, 8] },
  { label: 'Sus2', intervals: [0, 2, 7] },
  { label: 'Sus4', intervals: [0, 5, 7] },
  { label: 'Dominant seventh', intervals: [0, 4, 7, 10] },
  { label: 'Major seventh', intervals: [0, 4, 7, 11] },
  { label: 'Minor seventh', intervals: [0, 3, 7, 10] },
  { label: 'Diminished seventh', intervals: [0, 3, 6, 9] },
  { label: 'Minor-major seventh', intervals: [0, 3, 7, 11] },
  { label: 'Major ninth', intervals: [0, 4, 7, 11, 14] },
] as const;

export const scales = [
  { label: 'Major', intervals: [0, 2, 4, 5, 7, 9, 11] },
  { label: 'Natural minor', intervals: [0, 2, 3, 5, 7, 8, 10] },
  { label: 'Harmonic minor', intervals: [0, 2, 3, 5, 7, 8, 11] },
  { label: 'Major pentatonic', intervals: [0, 2, 4, 7, 9] },
  { label: 'Minor pentatonic', intervals: [0, 3, 5, 7, 10] },
  { label: 'Blues', intervals: [0, 3, 5, 6, 7, 10] },
  { label: 'Dorian', intervals: [0, 2, 3, 5, 7, 9, 10] },
  { label: 'Mixolydian', intervals: [0, 2, 4, 5, 7, 9, 10] },
  { label: 'Melodic minor (ascending)', intervals: [0, 2, 3, 5, 7, 9, 11] },
  { label: 'Phrygian', intervals: [0, 1, 3, 5, 7, 8, 10] },
  { label: 'Lydian', intervals: [0, 2, 4, 6, 7, 9, 11] },
  { label: 'Locrian', intervals: [0, 1, 3, 5, 6, 8, 10] },
  { label: 'Whole tone', intervals: [0, 2, 4, 6, 8, 10] },
] as const;

export function noteName(note: number): string {
  return pitchClasses[note % 12] + (Math.floor(note / 12) - 1);
}

export function chordNotes(tonic: number, intervals: readonly number[], inversion: number): number[] {
  const bassInterval = intervals[inversion];
  const notes = inversion === 0
    ? intervals.map(interval => tonic + interval)
    : intervals.map(interval => tonic + bassInterval + (interval % 12 - bassInterval % 12 + 12) % 12)
      .sort((left, right) => left - right);
  const octavesDown = Math.max(0, Math.ceil(((notes.at(-1) ?? tonic) - lastNote) / 12));
  return notes.map(note => note - octavesDown * 12);
}

export function scaleNotes(tonic: number, intervals: readonly number[]): number[] {
  const classes = new Set(intervals.map(interval => (tonic + interval) % 12));
  return Array.from({ length: lastNote - firstNote + 1 }, (_, index) => firstNote + index)
    .filter(note => classes.has(note % 12));
}
