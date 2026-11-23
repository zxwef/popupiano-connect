import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const practiceScore = fileURLToPath(new URL('../fixtures/practice.musicxml', import.meta.url));
const duetXml = fileURLToPath(new URL('../fixtures/duet.xml', import.meta.url));
const duetMxl = fileURLToPath(new URL('../fixtures/duet.mxl', import.meta.url));

async function openUpload(page) {
  if (!await page.getByRole('dialog', { name: 'Load MusicXML' }).isVisible()) {
    await page.getByRole('button', { name: 'Load MusicXML' }).click();
  }
}

async function uploadScore(page, file) {
  await openUpload(page);
  await page.locator('#score-file').setInputFiles(file);
}

async function openSettings(page) {
  await page.getByRole('button', { name: 'Settings' }).click();
}

async function closeSettings(page) {
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Done' }).click();
}

async function selectSetting(page, name, option) {
  await openSettings(page);
  await page.getByLabel(name, { exact: true }).selectOption(option);
  await closeSettings(page);
}

async function practiceAction(page, name) {
  await openSettings(page);
  await page.getByRole('button', { name }).click();
  if (await page.getByRole('dialog', { name: 'Settings' }).isVisible()) await closeSettings(page);
}

async function loadPracticeScore(page) {
  await page.goto('./');
  await uploadScore(page, practiceScore);
  await expect(page.getByRole('heading', { name: 'Practice Study' })).toBeVisible();
}

async function holdRequest(page, pattern) {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route(pattern, async route => {
    await pending;
    await route.continue();
  }, { times: 1 });
  return release;
}

test('shows the loading screen until the app and saved score are ready', async ({ page }) => {
  const loader = page.locator('.app-loading');
  const keyboard = page.locator('.keyboard');
  const releaseApp = await holdRequest(page, /\/assets\/index-[^/]+\.js$/);
  try {
    await page.goto('./', { waitUntil: 'commit' });
    await expect(loader).toBeVisible();
    await expect(keyboard).toBeHidden();
  } finally {
    releaseApp();
  }
  await expect(loader).toBeHidden();
  await expect(keyboard).toBeVisible();

  await uploadScore(page, practiceScore);
  await expect(page.getByRole('dialog', { name: 'Load MusicXML' })).toBeHidden();
  const releaseScore = await holdRequest(page, /\/assets\/opensheetmusicdisplay[^/]+\.js$/);
  try {
    await page.reload({ waitUntil: 'commit' });
    await expect(page.locator('body')).toHaveAttribute('data-app-loading', 'restoring');
    await expect(loader).toBeVisible();
    await expect(keyboard).toBeHidden();
  } finally {
    releaseScore();
  }
  await expect(loader).toBeHidden();
  await expect(page.getByRole('region', { name: 'Score preview' }).locator('svg').first()).toBeVisible();
  await expect(keyboard).toBeVisible();

  await page.route(/\/assets\/opensheetmusicdisplay[^/]+\.js$/, route => route.abort(), { times: 1 });
  await page.reload();
  await expect(loader).toBeHidden();
  await expect(keyboard).toBeVisible();
});

test('shows a reload message if the app script fails to load', async ({ page }) => {
  await page.route(/\/assets\/index-[^/]+\.js$/, route => route.abort(), { times: 1 });
  await page.goto('./');
  await expect(page.locator('#app-loading-status')).toHaveText(
    'Could not start PopuConnect. Reload the page to try again.',
  );
  await expect(page.locator('.workbench')).toBeHidden();
});

test('shows chords and scales only when enabled in settings and remembers the choice', async ({ page }) => {
  await page.goto('./');
  const composer = page.getByRole('heading', { name: 'Chords and Scales' });
  const highlights = page.locator('.keyboard__key--selected');
  const preference = page.getByRole('checkbox', { name: 'Show chords and scales' });

  await expect(page.getByRole('heading', { name: 'Keyboard Workshop' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Sheet Music' })).toHaveCount(0);
  await expect(composer).toBeHidden();
  await expect(highlights).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Light up notes' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Turn off lights' })).toBeHidden();

  await openSettings(page);
  await expect(preference).not.toBeChecked();
  await preference.check();
  await closeSettings(page);
  await expect(composer).toBeVisible();
  await expect(highlights).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Light up notes' })).toBeVisible();
  await page.reload();
  await expect(composer).toBeVisible();
  await expect(highlights).toHaveCount(3);

  await uploadScore(page, practiceScore);
  await expect(page.getByRole('heading', { name: 'Practice Study' })).toBeVisible();
  await expect(highlights).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove score' }).click();
  await expect(highlights).toHaveCount(3);

  await openSettings(page);
  await expect(preference).toBeChecked();
  await preference.uncheck();
  await closeSettings(page);
  await expect(composer).toBeHidden();
  await expect(highlights).toHaveCount(0);
  await page.reload();
  await expect(composer).toBeHidden();
  await expect(highlights).toHaveCount(0);
});

test('shows only held notes on the optional live staff', async ({ page }) => {
  await page.setViewportSize({ width: 1194, height: 650 });
  await page.goto('./');
  const staff = page.locator('#played-staff');
  await expect(staff).toBeHidden();
  await openSettings(page);
  await page.getByRole('checkbox', { name: 'Show played notes on a staff' }).check();
  await closeSettings(page);
  await expect(staff).toBeVisible();
  await expect(staff.locator('[data-note]')).toHaveCount(0);

  await page.keyboard.down('KeyA');
  await page.keyboard.down('KeyW');
  await expect(staff).toHaveAttribute('aria-label', 'Played notes: C4, C♯4');
  await expect(staff.locator('[data-note="60"]')).toHaveAttribute('data-clef', 'treble');
  await expect(staff.locator('[data-note="60"] path')).toHaveAttribute('d', /,50 h 14/);
  await expect(staff.locator('[data-note="61"] text')).toHaveText('♯');
  await page.keyboard.up('KeyW');

  const middleC = await page.locator('#keys').getByRole('button', { name: 'C4', exact: true }).boundingBox();
  await page.mouse.move(middleC.x + middleC.width / 2, middleC.y + middleC.height - 8);
  await page.mouse.down();
  await expect(staff.locator('[data-note="60"]')).toHaveCount(1);
  await page.keyboard.up('KeyA');
  await expect(staff).toHaveAttribute('aria-label', 'Played notes: C4');
  await page.mouse.up();
  await expect(staff.locator('[data-note]')).toHaveCount(0);

  await uploadScore(page, practiceScore);
  await expect(page.getByRole('dialog', { name: 'Load MusicXML' })).toBeHidden();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Practice Study' })).toBeVisible();
  await expect(staff).toBeVisible();
  await expect(page.locator('.keyboard')).toBeInViewport({ ratio: 1 });
  await page.setViewportSize({ width: 360, height: 650 });
  await expect(staff).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
});

test('renders SVG, follows the cursor and supports note, measure, and zoom navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1194, height: 720 });
  await loadPracticeScore(page);
  const preview = page.getByRole('region', { name: 'Score preview' });
  const svg = preview.locator('svg').first();
  const cursor = preview.locator('img[id^="cursorImg-"]');
  await expect(svg).toBeVisible();
  await expect(cursor).toBeAttached();
  await expect(cursor).toBeHidden();
  await expect(page.locator('#keys').getByRole('button')).toHaveCount(53);
  await expect(page.locator('.keyboard')).toBeInViewport({ ratio: 1 });
  const scoreWindow = page.locator('#score-window');
  await expect(scoreWindow).toHaveAttribute('data-windowed', '');
  expect((await scoreWindow.boundingBox()).height).toBeLessThan((await svg.boundingBox()).height);
  const firstLine = await scoreWindow.getAttribute('style');
  await expect(page.locator('#score-composer')).toHaveText('PopuConnect');
  await expect(page.locator('#score-expected')).toHaveText('Expected notes: C4');
  await expect(page.getByRole('button', { name: 'Previous notes' })).toBeDisabled();
  const start = await cursor.getAttribute('style');

  await page.getByRole('button', { name: 'Next notes' }).click();
  await expect(page.locator('#score-expected')).toHaveText('Expected notes: C3, C♯4, E♭4, G4');
  await expect(cursor).not.toHaveAttribute('style', start);
  await page.getByRole('button', { name: 'Previous notes' }).click();
  await expect(page.locator('#score-expected')).toHaveText('Expected notes: C4');
  await page.locator('#score-measure').selectOption({ value: '1' });
  await expect(page.locator('#score-expected')).toHaveText('No new notes at this position.');
  await expect(page.getByRole('combobox', { name: 'Jump to bar' })).toHaveValue('1');
  await expect(page.locator('#score-measure-count')).toHaveText('/ 3');
  await expect(scoreWindow).not.toHaveAttribute('style', firstLine);
  await page.locator('#score-measure').selectOption({ value: '2' });
  await expect(page.locator('#score-expected')).toHaveText('Expected notes: A6 · Unavailable: A6');
  await expect(page.getByRole('button', { name: 'Next notes' })).toBeDisabled();

  await selectSetting(page, 'Score view', 'full');
  await expect(scoreWindow).not.toHaveAttribute('data-windowed', '');
  await expect(page.locator('.keyboard')).toBeInViewport({ ratio: 1 });
  await selectSetting(page, 'Zoom', '1.5');
  await page.setViewportSize({ width: 385, height: 650 });
  await expect(svg).toBeVisible();
  await expect(page.locator('#score-expected')).toContainText('A6');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(385);
  await expect.poll(() => preview.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await expect(cursor).toBeHidden();
  await page.getByRole('button', { name: 'First notes' }).click();
  await expect(page.locator('#score-expected')).toHaveText('Expected notes: C4');
});

test('opens a scrollable full score preview and returns to the current line', async ({ page }) => {
  await page.setViewportSize({ width: 850, height: 380 });
  await loadPracticeScore(page);
  const openPreview = page.getByRole('button', { name: 'Full score preview' });
  const dialog = page.getByRole('dialog', { name: 'Full score' });
  const scoreWindow = page.locator('#score-window');
  const bar = page.getByRole('combobox', { name: 'Jump to bar' });
  await bar.selectOption({ value: '1' });
  await expect(scoreWindow).toHaveAttribute('data-windowed', '');
  await expect(page.locator('#score-expected')).toHaveText('No new notes at this position.');
  await openPreview.click();
  const preview = dialog.getByRole('region', { name: 'Score preview' });
  await expect(preview.locator('svg').first()).toBeVisible();
  await expect(scoreWindow).not.toHaveAttribute('data-windowed', '');
  expect(await preview.evaluate(node => node.scrollTop)).toBe(0);
  await preview.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => preview.evaluate(node => node.scrollTop)).toBeGreaterThan(0);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(openPreview).toBeFocused();
  await expect(page.locator('#sheet-music #score-window')).toHaveAttribute('data-windowed', '');
  await expect(bar).toHaveValue('1');
  await expect(page.locator('#score-expected')).toHaveText('No new notes at this position.');

  await page.setViewportSize({ width: 360, height: 650 });
  await openPreview.click();
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await expect(preview.locator('svg').first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('#sheet-music #score-window')).toHaveAttribute('data-windowed', '');
  await openSettings(page);
  await expect(page.getByLabel('Score view')).toHaveValue('line');
});

test('returns to the selected music after resizing the full score preview', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 850 });
  await page.goto('./');
  const attributes = '<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>';
  const notes = ['C', 'D', 'E', 'F'].map(step =>
    `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>`).join('');
  const measures = Array.from({ length: 40 }, (_, index) =>
    `<measure number="${index + 1}">${index === 0 ? attributes : ''}${notes}</measure>`).join('');
  const xml = '<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>'
    + '<part id="P1">' + measures + '</part></score-partwise>';
  await uploadScore(page, { name: 'long.musicxml', mimeType: 'application/xml', buffer: Buffer.from(xml) });
  await selectSetting(page, 'Score view', 'full');
  await openSettings(page);
  await page.getByLabel('Learning hints').check();
  await closeSettings(page);
  const bar = page.getByRole('combobox', { name: 'Jump to bar' });
  await bar.selectOption({ value: '30' });
  await page.getByRole('button', { name: 'Full score preview' }).click();
  await page.setViewportSize({ width: 480, height: 700 });
  await page.keyboard.press('Escape');
  const preview = page.locator('#sheet-music #score-viewport');
  await expect(preview).toBeVisible();
  await expect(bar).toHaveValue('30');
  await expect.poll(() => preview.evaluate(node => {
    const cursor = node.querySelector('img[id^="cursorImg-"]').getBoundingClientRect();
    const bounds = node.getBoundingClientRect();
    return cursor.top >= bounds.top && cursor.bottom <= bounds.bottom;
  })).toBe(true);
});

test('removing an older score does not clear the latest file opened in another tab', async ({ page, context }) => {
  await loadPracticeScore(page);
  const otherTab = await context.newPage();
  await otherTab.goto('./');
  await expect(otherTab.getByRole('heading', { name: 'Practice Study' })).toBeVisible();
  await uploadScore(otherTab, duetMxl);
  await expect(otherTab.getByRole('heading', { name: 'Two Parts' })).toBeVisible();
  await expect(otherTab.getByRole('dialog', { name: 'Load MusicXML' })).toBeHidden();
  await page.getByRole('button', { name: 'Remove score' }).click();
  await expect(page.getByRole('heading', { name: 'Practice Study' })).toBeHidden();
  await otherTab.reload();
  await expect(otherTab.getByRole('heading', { name: 'Two Parts' })).toBeVisible();
});

test('restores the last score and remembers the position and settings for each file', async ({ page }) => {
  await loadPracticeScore(page);
  await expect(page.locator('#keys').getByRole('button')).toHaveCount(53);
  await openSettings(page);
  await expect(page.getByLabel('Score view')).toHaveValue('line');
  await page.getByLabel('Key range').selectOption('main');
  await page.getByLabel('Score view').selectOption('full');
  await page.getByLabel('Zoom').selectOption('0.75');
  await page.getByLabel('Staff', { exact: true }).selectOption({ label: 'Upper staff' });
  await page.getByRole('checkbox', { name: 'Learning hints' }).check();
  await closeSettings(page);
  await page.getByRole('button', { name: 'Next notes' }).click();
  const notes = page.locator('#score-expected');
  await expect(notes).toHaveText('Expected notes: C♯4, E♭4, G4');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Practice Study' })).toBeVisible();
  await expect(notes).toHaveText('Expected notes: C♯4, E♭4, G4');
  await expect(page.locator('#keys').getByRole('button')).toHaveCount(29);
  await expect(page.locator('#score-window')).not.toHaveAttribute('data-windowed', '');
  await expect(page.locator('#score-viewport img[id^="cursorImg-"]')).toBeVisible();

  await uploadScore(page, duetMxl);
  await expect(page.getByRole('heading', { name: 'Two Parts' })).toBeVisible();
  await openSettings(page);
  await expect(page.getByLabel('Key range')).toHaveValue('extended');
  await expect(page.getByLabel('Score view')).toHaveValue('line');
  await expect(page.getByRole('checkbox', { name: 'Learning hints' })).not.toBeChecked();
  await page.getByLabel('Part', { exact: true }).selectOption({ label: 'Second Piano' });
  await page.getByLabel('Zoom').selectOption('1.25');
  await closeSettings(page);
  await expect(notes).toHaveText('Expected notes: B4');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Two Parts' })).toBeVisible();
  await expect(notes).toHaveText('Expected notes: B4');
  await expect(page.locator('#keys').getByRole('button')).toHaveCount(53);
  await openSettings(page);
  await expect(page.getByLabel('Zoom')).toHaveValue('1.25');
  await closeSettings(page);

  await uploadScore(page, practiceScore);
  await expect(page.getByRole('heading', { name: 'Practice Study' })).toBeVisible();
  await expect(notes).toHaveText('Expected notes: C♯4, E♭4, G4');
  await openSettings(page);
  await expect(page.getByLabel('Key range')).toHaveValue('main');
  await expect(page.getByLabel('Score view')).toHaveValue('full');
  await expect(page.getByLabel('Zoom')).toHaveValue('0.75');
  await expect(page.getByLabel('Staff', { exact: true }).locator('option:checked')).toHaveText('Upper staff');
  await expect(page.getByRole('checkbox', { name: 'Learning hints' })).toBeChecked();
  await closeSettings(page);
  await page.getByRole('button', { name: 'Remove score' }).click();
  await expect(page.getByRole('heading', { name: 'Practice Study' })).toBeHidden();
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByRole('button', { name: 'Remove score' })).toBeHidden();
  await uploadScore(page, practiceScore);
  await expect(notes).toHaveText('Expected notes: C♯4, E♭4, G4');
});

test('toggles the score cursor and on-screen key hints without stopping practice', async ({ page }) => {
  await loadPracticeScore(page);
  const highlighted = page.locator('.keyboard__key--expected');
  const cursor = page.locator('#score-viewport img[id^="cursorImg-"]');
  const hints = page.getByRole('checkbox', { name: 'Learning hints' });
  await expect(highlighted).toHaveCount(0);
  await expect(cursor).toBeHidden();
  await practiceAction(page, 'Start practice');
  await openSettings(page);
  await expect(hints).not.toBeChecked();
  await hints.check();
  await closeSettings(page);
  await expect(highlighted).toHaveCount(1);
  await expect(cursor).toBeVisible();
  await openSettings(page);
  await hints.uncheck();
  await closeSettings(page);
  await expect(highlighted).toHaveCount(0);
  await expect(cursor).toBeHidden();

  await page.keyboard.press('KeyA');
  await expect(page.locator('#score-expected')).toHaveText('Expected notes: C3, C♯4, E♭4, G4');
  await expect(highlighted).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Practice Study' })).toBeVisible();
  await expect(highlighted).toHaveCount(0);
  await openSettings(page);
  await expect(hints).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Start practice' })).toBeVisible();
});

test('replaces a score with MXL and XML, selects a part, and reports invalid files', async ({ page }) => {
  const unexpectedRequests = [];
  page.on('request', request => {
    if (!request.url().startsWith('http://127.0.0.1:4173/')) unexpectedRequests.push(request.url());
  });
  await loadPracticeScore(page);
  await uploadScore(page, duetMxl);
  await expect(page.getByRole('heading', { name: 'Two Parts' })).toBeVisible();
  await expect(page.locator('#score-composer')).toHaveText('Test Composer');
  await expect(page.locator('#score-expected')).toHaveText('Expected notes: G4');
  await selectSetting(page, 'Part', { label: 'Second Piano' });
  await expect(page.locator('#score-expected')).toHaveText('Expected notes: B4');
  await expect(page.locator('#score-viewport svg')).toHaveCount(1);
  await uploadScore(page, duetXml);
  await expect(page.locator('#score-expected')).toHaveText('Expected notes: G4');
  await practiceAction(page, 'Start practice');
  const source = readFileSync(practiceScore, 'utf8').replace(
    '<part-list>',
    '<credit page="1"><credit-image source="https://example.test/unrequested-image.png" type="image/png"/></credit><part-list>',
  );

  const badFiles = [
    ['wrong.txt', 'hello', 'Choose a .musicxml, .xml, or .mxl file.'],
    ['wrong.xml', 'https://example.test/remote.musicxml', 'damaged or invalid XML'],
    ['wrong.xml', '<not-a-score/>', 'not a MusicXML score'],
    ['broken.musicxml', '<score-partwise><part>', 'damaged or invalid XML'],
    ['broken.mxl', 'not a ZIP', 'Could not unpack this MXL file'],
    ['large.mxl', 'x'.repeat(1024 * 1024 + 1), 'under 1 MiB'],
    ['bad-duration.xml', source.replace('<duration>1</duration>', '<duration>oops</duration>'), 'Could not read bar 1. Invalid Note Duration.'],
    ['bad-alteration.xml', source.replace('<step>C</step>', '<step>C</step><alter>oops</alter>'), 'Could not read bar 1. Invalid alteration'],
  ];
  for (const [name, data, error] of badFiles) {
    await uploadScore(page, { name, mimeType: 'application/octet-stream', buffer: Buffer.from(data) });
    await expect(page.locator('#score-file-status')).toContainText(error);
    await expect(page.locator('#score-viewport svg')).toHaveCount(1);
    await expect(page.locator('#score-heading')).toHaveText('Two Parts');
    await expect(page.locator('#practice-toggle')).toHaveText('Pause practice');
  }
  await page.locator('#score-drop').evaluate((target, source) => {
    const data = new DataTransfer();
    data.items.add(new File([source], 'dropped.musicxml', { type: 'application/xml' }));
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  }, source);
  await expect(page.getByRole('heading', { name: 'Practice Study' })).toBeVisible();
  expect(unexpectedRequests).toEqual([]);
});

test('skips a rest after a bar jump in practice and accepts separate virtual key activations', async ({ page }) => {
  await loadPracticeScore(page);
  await practiceAction(page, 'Start practice');
  await page.getByRole('combobox', { name: 'Jump to bar' }).selectOption({ value: '1' });
  await expect(page.locator('#score-expected')).toHaveText('Expected notes: D4');
  const d4 = page.locator('#keys').getByRole('button', { name: 'D4', exact: true });
  await d4.evaluate(button => {
    button.click();
    button.click();
  });
  await expect(page.locator('#score-expected')).toContainText('A6');
});

test('only silent MusicXML cue notes are skipped for their cue status', async ({ page }) => {
  await page.goto('./');
  const source = readFileSync(duetXml, 'utf8');
  await uploadScore(page, {
    name: 'small-note.xml', mimeType: 'application/xml',
    buffer: Buffer.from(source.replace('<type>whole</type>', '<type size="cue">whole</type>')),
  });
  await expect(page.locator('#score-expected')).toHaveText('Expected notes: G4');
  await uploadScore(page, {
    name: 'cue-note.xml', mimeType: 'application/xml',
    buffer: Buffer.from(source.replace('<note><pitch><step>G', '<note><cue/><pitch><step>G')),
  });
  await expect(page.locator('#score-expected')).toHaveText('No new notes at this position.');
});

test('shows scale notes across the whole extended keyboard', async ({ page }) => {
  await page.goto('./');
  await openSettings(page);
  await page.getByLabel('Show chords and scales').check();
  await closeSettings(page);
  await page.getByRole('button', { name: 'Scale', exact: true }).click();
  const c1 = page.locator('#keys').getByRole('button', { name: 'C1', exact: true });
  await expect(c1).toHaveClass(/keyboard__key--selected/);
  await selectSetting(page, 'Key range', 'main');
  await expect(c1).toBeHidden();
});

test('reads whitespace in an MXL score and stops when an archive entry exceeds the byte limit', async ({ page }) => {
  await page.goto('./');
  const xml = '\n' + readFileSync(duetXml, 'utf8').replace(/^<\?xml[^?]*\?>/, '');
  const manifest = '<container><rootfiles><rootfile full-path="score.musicxml"/></rootfiles></container>';
  const notes = page.locator('#score-expected');
  const openMxl = async (score, container) => {
    const zip = new JSZip();
    zip.file('mimetype', 'application/vnd.recordare.musicxml', { compression: 'STORE' });
    zip.file('META-INF/container.xml', container);
    zip.file('score.musicxml', score);
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(buffer.length).toBeLessThan(1024 * 1024);
    await uploadScore(page, { name: 'score.mxl', mimeType: 'application/vnd.recordare.musicxml', buffer });
  };
  await uploadScore(page, { name: 'score.xml', mimeType: 'application/xml', buffer: Buffer.from(xml) });
  await expect(notes).toHaveText('Expected notes: G4');
  await openMxl(xml, manifest);
  await expect(page.getByRole('dialog', { name: 'Load MusicXML' })).toBeHidden();
  await expect(notes).toHaveText('Expected notes: G4');

  // The inflated text is less than 5 million characters but occupies over 5 MiB in UTF-8.
  const padding = '<!--' + 'é'.repeat(3 * 1024 * 1024) + '-->';
  await openMxl(padding + xml, manifest);
  await expect(page.locator('#score-file-status')).toHaveText('The unpacked MXL entry exceeds 5 MiB.');
  await openMxl(xml, padding + manifest);
  await expect(page.locator('#score-file-status')).toHaveText('The unpacked MXL entry exceeds 5 MiB.');
  await openMxl(xml, manifest);
  await expect(page.getByRole('dialog', { name: 'Load MusicXML' })).toBeHidden();
  await expect(notes).toHaveText('Expected notes: G4');
});

test('practices with computer keys and clicks, skips rests, and supports the configured 53 keys', async ({ page }) => {
  await loadPracticeScore(page);
  const notes = page.locator('#score-expected');
  const status = page.locator('#practice-status');
  const key = name => page.locator('#keys').getByRole('button', { name, exact: true });
  await expect(key('C4')).not.toHaveClass(/keyboard__key--expected/);
  await expect(key('C4')).not.toHaveClass(/keyboard__key--playing/);
  await selectSetting(page, 'Staff', { label: 'Upper staff' });
  await practiceAction(page, 'Start practice');
  await page.keyboard.press('KeyS');
  await expect(status).toContainText('D4 is incorrect');
  await expect(notes).toHaveText('Expected notes: C4');
  await page.keyboard.press('KeyA');
  await expect(notes).toHaveText('Expected notes: C♯4, E♭4, G4');
  await key('E♭4').click();
  await expect(status).toHaveText('1 of 3 notes matched.');
  await key('E♭4').click();
  await expect(status).toHaveText('1 of 3 notes matched.');
  await practiceAction(page, 'Repeat position');
  await key('C♯4').click();
  await key('G4').click();
  await expect(status).toHaveText('2 of 3 notes matched.');
  await key('E♭4').click();
  await expect(notes).toHaveText('Expected notes: C5');
  await key('C5').click();
  await expect(notes).toHaveText('Expected notes: D4');
  await expect(page.getByRole('combobox', { name: 'Jump to bar' })).toHaveValue('1');
  await page.keyboard.press('KeyS');
  await page.keyboard.press('KeyS');
  await expect(notes).toContainText('Unavailable: A6');
  await expect(status).toContainText('outside both keyboard ranges');
  await practiceAction(page, 'Pause practice');
  await expect(status).toHaveText('Practice paused.');
  await page.getByRole('button', { name: 'First notes' }).click();
  await selectSetting(page, 'Staff', { label: 'Lower staff' });
  await selectSetting(page, 'Key range', 'main');
  await practiceAction(page, 'Resume practice');
  await expect(notes).toHaveText('Expected notes: C3');
  await key('C3').click();
  await expect(notes).toHaveText('Expected notes: F2 · Unavailable: F2');
  await selectSetting(page, 'Key range', 'extended');
  await expect(page.locator('#keys').getByRole('button')).toHaveCount(53);
  await expect(notes).toHaveText('Expected notes: F2');
  await key('F2').click();
  await expect(status).toHaveText('Practice complete.');
  await page.getByRole('button', { name: 'Remove score' }).click();
  await expect(page.locator('#keys').getByRole('button')).toHaveCount(53);
  await expect(page.getByRole('heading', { name: 'Chords and Scales' })).toBeHidden();
  await expect(key('C4')).not.toHaveClass(/keyboard__key--expected/);
});

test('reports microtonal and unpitched notes and allows manual skipping', async ({ page }) => {
  await page.goto('./');
  const xml = readFileSync(duetXml, 'utf8')
    .replace('<step>G</step>', '<step>G</step><alter>0.5</alter>')
    .replace('<pitch><step>B</step><octave>4</octave></pitch>', '<unpitched><display-step>C</display-step><display-octave>3</display-octave></unpitched>');
  await uploadScore(page, { name: 'unsupported.musicxml', mimeType: 'application/xml', buffer: Buffer.from(xml) });
  await expect(page.getByRole('heading', { name: 'Two Parts' })).toBeVisible();
  for (const part of ['First Piano', 'Second Piano']) {
    await selectSetting(page, 'Part', { label: part });
    await expect(page.locator('#score-range-warning')).toContainText('cannot be played on piano keys');
    await expect(page.locator('#score-expected')).not.toContainText('Expected notes:');
  }
  await practiceAction(page, 'Start practice');
  await page.keyboard.press('KeyA');
  await expect(page.locator('#practice-status')).toContainText('cannot be played on piano keys');
  await page.getByRole('button', { name: 'Finish practice' }).click();
  await expect(page.locator('#practice-status')).toHaveText('Practice complete.');
  await uploadScore(page, duetXml);
  await expect(page.locator('#score-expected')).toHaveText('Expected notes: G4');
});

test('skips MusicXML tie continuations while requiring new notes of the same chord', async ({ page }) => {
  await page.goto('./');
  const xml = readFileSync(duetXml, 'utf8').replace(
    '<note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>',
    '<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><tie type="start"/><type>quarter</type></note>'
    + '<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><tie type="stop"/><type>quarter</type></note>'
    + '<note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>'
    + '<note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><type>half</type></note>',
  );
  await uploadScore(page, { name: 'ties.musicxml', mimeType: 'application/xml', buffer: Buffer.from(xml) });
  await page.getByRole('dialog', { name: 'Load MusicXML' }).waitFor({ state: 'hidden' });
  await practiceAction(page, 'Start practice');
  await page.keyboard.press('KeyA');
  await expect(page.locator('#score-expected')).toHaveText('Expected notes: E4');
  await page.keyboard.press('KeyD');
  await expect(page.locator('#score-expected')).toHaveText('Expected notes: D4');
});

test('expects the sounding MIDI note of a transposing part', async ({ page }) => {
  await page.goto('./');
  const xml = readFileSync(duetXml, 'utf8')
    .replace('</attributes>', '<transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose></attributes>')
    .replace('<step>G</step>', '<step>C</step>');
  const load = source => uploadScore(page, { name: 'transpose.musicxml', mimeType: 'application/xml', buffer: Buffer.from(source) });
  await load(xml);
  await page.getByRole('dialog', { name: 'Load MusicXML' }).waitFor({ state: 'hidden' });
  await practiceAction(page, 'Start practice');
  await expect(page.locator('#score-expected')).toHaveText('Expected notes: B♭3');
  await page.keyboard.press('KeyA');
  await expect(page.locator('#practice-status')).toContainText('C4 is incorrect');
  await page.locator('#keys').getByRole('button', { name: 'B♭3', exact: true }).click();
  await expect(page.locator('#practice-status')).toHaveText('Practice complete.');

  await load(xml.replace('<transpose>', '<transpose number="1">'));
  await expect(page.locator('#score-range-warning')).toContainText('Practice supports a single transposition for the whole part.');
  await expect(page.locator('#score-expected')).toHaveText('No new notes at this position.');
  await selectSetting(page, 'Part', { label: 'Second Piano' });
  await expect(page.locator('#score-expected')).toHaveText('Expected notes: B4');
});

test('keeps pitched positions and the other staff playable when a note is unpitched', async ({ page }) => {
  await page.goto('./');
  const xml = readFileSync(practiceScore, 'utf8')
    .replace('<pitch><step>C</step><octave>3</octave></pitch>', '<unpitched><display-step>C</display-step><display-octave>3</display-octave></unpitched>');
  await uploadScore(page, { name: 'percussion.musicxml', mimeType: 'application/xml', buffer: Buffer.from(xml) });
  await page.getByRole('dialog', { name: 'Load MusicXML' }).waitFor({ state: 'hidden' });
  await practiceAction(page, 'Start practice');
  await expect(page.locator('#score-expected')).toHaveText('Expected notes: C4');
  await page.keyboard.press('KeyA');
  await expect(page.locator('#practice-status')).toContainText('cannot be played on piano keys');
  await selectSetting(page, 'Staff', { label: 'Upper staff' });
  await expect(page.locator('#score-range-warning')).not.toContainText('percussion');
  await expect(page.locator('#score-expected')).toHaveText('Expected notes: C♯4, E♭4, G4');
  for (const key of ['KeyW', 'KeyE', 'KeyG']) await page.keyboard.press(key);
  await expect(page.locator('#score-expected')).toHaveText('Expected notes: C5');
});

test('uses the selected MIDI ports, ignores duplicate Note On, and clears only the main practice lights', async ({ page }) => {
  await page.addInitScript(() => {
    window.AudioContext = class {
      constructor() { throw new Error('Test audio is unavailable'); }
    };
    const inputs = new Map([['in', { id: 'in', name: 'PopuPiano Input', state: 'connected', async close() {} }]]);
    const frames = [];
    let failNextOpen = false;
    const outputs = new Map(['one', 'two'].map(id => [id, {
      id,
      name: 'PopuPiano ' + id,
      state: 'connected',
      async open() {
        if (!failNextOpen) return;
        failNextOpen = false;
        throw new Error('Temporary port failure');
      },
      send(frame) {
        const entry = { id, frame: Array.from(frame) };
        frames.push(entry);
        sessionStorage.setItem('test.lastMidiFrame', JSON.stringify(entry));
      },
    }]));
    const access = { inputs, outputs, onstatechange: null };
    Object.defineProperty(navigator, 'requestMIDIAccess', { value: async () => access });
    window.mockMidi = {
      frames,
      failNextOpen() { failNextOpen = true; },
      send(data) { inputs.get('in').onmidimessage({ data: Uint8Array.from(data) }); },
      setOutputState(id, state) {
        outputs.set(id, { ...outputs.get(id), state });
        access.onstatechange();
      },
    };
  });
  await loadPracticeScore(page);
  await page.getByRole('button', { name: 'Connect MIDI' }).click();
  await page.getByLabel('MIDI output').selectOption('one');
  await expect(page.getByRole('button', { name: 'Turn off lights' })).toBeEnabled();
  await selectSetting(page, 'Staff', { label: 'Upper staff' });
  await page.locator('#score-measure').selectOption({ value: '1' });
  await practiceAction(page, 'Start practice');
  const frames = () => page.evaluate(() => window.mockMidi.frames);
  const send = data => page.evaluate(data => window.mockMidi.send(data), data);
  expect(await frames()).toEqual([]);
  await page.evaluate(() => window.mockMidi.failNextOpen());
  await openSettings(page);
  await page.getByRole('checkbox', { name: 'Learning hints' }).check();
  await page.getByRole('checkbox', { name: 'Show played notes on a staff' }).check();
  await closeSettings(page);
  await expect(page.locator('#practice-lighting-status')).toContainText('Could not send the practice lights');
  expect(await frames()).toEqual([]);
  await practiceAction(page, 'Repeat position');
  await expect.poll(async () => (await frames()).length).toBe(2);

  const current = page.locator('#score-expected');
  const heldNotes = page.locator('#played-staff [data-note]');
  await send([0x90, 62, 90]);
  await expect(heldNotes).toHaveAttribute('data-note', '62');
  await expect(current).toHaveText('Expected notes: D4');
  await send([0x90, 62, 90]);
  await expect(current).toHaveText('Expected notes: D4');
  expect(await frames()).toHaveLength(2);
  await page.getByLabel('MIDI output').selectOption('two');
  await expect.poll(async () => (await frames()).map(({ id }) => id)).toEqual(['one', 'one', 'one', 'two', 'two']);
  await page.locator('#keys').getByRole('button', { name: 'D4', exact: true }).click();
  await send([0x90, 62, 0]);
  await expect(heldNotes).toHaveCount(0);
  await expect(current).toContainText('Unavailable: A6');
  await expect.poll(async () => (await frames()).length).toBe(6);
  for (const index of [2, 5]) {
    const { frame } = (await frames())[index];
    expect(frame.slice(0, 4)).toEqual([0xf0, 3, 0x20, 29]);
    expect(frame.slice(5, -1).filter((_, offset) => offset % 2 === 0)).toEqual(Array(29).fill(0));
  }
  expect((await frames()).every(({ frame }) => frame[1] === 3)).toBe(true);

  await page.getByRole('button', { name: 'Finish practice' }).click();
  await page.getByRole('button', { name: 'First notes' }).click();
  await selectSetting(page, 'Staff', { label: 'Lower staff' });
  await practiceAction(page, 'Start practice');
  await expect(current).toHaveText('Expected notes: C3');
  await expect.poll(async () => (await frames()).length).toBe(8);
  await send([0x90, 48, 90]);
  await expect(current).toHaveText('Expected notes: F2');
  await expect.poll(async () => (await frames()).length).toBe(9);
  await send([0x90, 41, 90]);
  await expect(heldNotes).toHaveCount(2);
  await expect(page.locator('#played-staff [data-note="41"]')).toHaveAttribute('data-clef', 'bass');
  await expect(page.locator('#practice-status')).toHaveText('Practice complete.');
  expect(await frames()).toHaveLength(9);

  await practiceAction(page, 'Restart practice');
  await expect.poll(async () => (await frames()).length).toBe(11);
  await page.evaluate(() => window.mockMidi.setOutputState('two', 'disconnected'));
  await practiceAction(page, 'Pause practice');
  expect(await frames()).toHaveLength(11);
  await page.evaluate(() => window.mockMidi.setOutputState('two', 'connected'));
  await expect.poll(async () => (await frames()).length).toBe(12);
  const clear = (await frames()).at(-1);
  expect(clear.id).toBe('two');
  expect(clear.frame.slice(0, 4)).toEqual([0xf0, 3, 0x20, 29]);
  expect(clear.frame.slice(5, -1).filter((_, offset) => offset % 2 === 0)).toEqual(Array(29).fill(0));

  await practiceAction(page, 'Resume practice');
  await expect.poll(async () => (await frames()).length).toBe(14);
  await openSettings(page);
  await page.getByRole('checkbox', { name: 'Learning hints' }).uncheck();
  await expect(page.getByRole('button', { name: 'Pause practice' })).toBeVisible();
  await closeSettings(page);
  await expect.poll(async () => (await frames()).at(-1)).toEqual(clear);
  expect(await frames()).toHaveLength(15);
  await page.getByLabel('MIDI input').selectOption('');
  await expect(heldNotes).toHaveCount(0);

  await openSettings(page);
  await page.getByLabel('Learning hints').check();
  await closeSettings(page);
  await expect.poll(async () => (await frames()).length).toBe(17);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Practice Study' })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('test.lastMidiFrame')))).toEqual(clear);
  await page.getByRole('button', { name: 'Connect MIDI' }).click();
  await expect.poll(frames).toEqual([clear]);
});
