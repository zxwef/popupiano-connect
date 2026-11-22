import { noteName, pitchClasses } from './music';

const staffLineGap = 5;
const noteSpacing = 24;
const staffWidth = 224;
const staffHeight = 116;
const lowestWrittenNote = 24; // C1
const highestWrittenNote = 84; // C6
const middleC = 60;
const treble = { top: 25, topPitch: 38 };
const bass = { top: 58, topPitch: 26 };

function staffLines(top: number, right: number): string {
  return Array.from({ length: 5 }, (_, index) => {
    const y = top + index * staffLineGap;
    return `M 8,${y} H ${right}`;
  }).join(' ');
}

function drawNote(note: number, x: number): string {
  let writtenNote = note;
  // Move pitches beyond the staff's viewport by octaves and show their original names.
  while (writtenNote < lowestWrittenNote) writtenNote += 12;
  while (writtenNote > highestWrittenNote) writtenNote -= 12;
  const pitch = pitchClasses[writtenNote % 12];
  const octave = Math.floor(writtenNote / 12) - 1;
  const diatonicPitch = octave * 7 + 'CDEFGAB'.indexOf(pitch[0]);
  const staff = writtenNote >= middleC ? treble : bass;
  const step = staff.topPitch - diatonicPitch;
  const y = staff.top + step * staffLineGap / 2;

  let ledgerLines = '';
  for (let line = -2; line >= step; line -= 2) {
    ledgerLines += `M ${x - 7},${staff.top + line * staffLineGap / 2} h 14 `;
  }
  for (let line = 10; line <= step; line += 2) {
    ledgerLines += `M ${x - 7},${staff.top + line * staffLineGap / 2} h 14 `;
  }
  const accidental = pitch[1]
    ? `<text class="played-staff__accidental" x="${x - 8}" y="${y + 3}">${pitch[1]}</text>`
    : '';
  const octaveLabel = writtenNote === note ? '' :
    `<text class="played-staff__octave" x="${x}" y="${note < writtenNote ? 114 : 9}">${noteName(note)}</text>`;
  return `<g data-note="${note}" data-clef="${staff === treble ? 'treble' : 'bass'}">
    <path class="played-staff__ledger" d="${ledgerLines}"/>
    ${accidental}
    <ellipse cx="${x}" cy="${y}" rx="4.6" ry="3.1" transform="rotate(-16 ${x} ${y})"/>
    ${octaveLabel}
  </g>`;
}

export function renderPlayedStaff(svg: SVGSVGElement, heldNotes: Iterable<number>): void {
  const notes = [...new Set(heldNotes)].sort((a, b) => a - b);
  const width = Math.max(staffWidth, 64 + notes.length * noteSpacing);
  const firstX = (width + 26 - (notes.length - 1) * noteSpacing) / 2;
  svg.setAttribute('viewBox', `0 0 ${width} ${staffHeight}`);
  svg.setAttribute('width', String(width));
  svg.toggleAttribute('data-compact', width === staffWidth);
  svg.setAttribute('aria-label', notes.length ? 'Played notes: ' + notes.map(noteName).join(', ') : 'Played notes');
  svg.innerHTML = `
    <path class="played-staff__lines" d="${staffLines(treble.top, width - 8)} ${staffLines(bass.top, width - 8)} M 8,${treble.top} V ${bass.top + 4 * staffLineGap}"/>
    <text class="played-staff__clef" x="13" y="48">&#119070;</text>
    <text class="played-staff__clef played-staff__clef--bass" x="13" y="74">&#119074;</text>
    ${notes.map((note, index) => drawNote(note, firstX + index * noteSpacing)).join('')}
  `;
}
