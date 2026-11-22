import type JSZip from 'jszip';

const maxXmlBytes = 5 * 1024 * 1024;

class MxlEntryTooLarge extends Error {}

async function readMxlEntry(entry: JSZip.JSZipObject): Promise<string> {
  // JSZip documents internalStream on entries but omits it from JSZipObject's types.
  const streamEntry = entry as JSZip.JSZipObject & {
    internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
  };
  const stream = streamEntry.internalStream('uint8array');
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let byteCount = 0;
    stream.on('data', chunk => {
      byteCount += chunk.byteLength;
      if (byteCount > maxXmlBytes) {
        stream.pause();
        chunks.length = 0;
        reject(new MxlEntryTooLarge('The unpacked MXL entry exceeds 5 MiB.'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      try {
        const bytes = new Uint8Array(byteCount);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        let encoding = 'utf-8';
        if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
        if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
        resolve(new TextDecoder(encoding, { fatal: true }).decode(bytes));
      } catch (error) {
        reject(error);
      }
    });
    stream.resume();
  });
}

async function unpackMxl(file: File): Promise<string> {
  const { default: JSZip } = await import('jszip');
  const archive = await JSZip.loadAsync(await file.arrayBuffer());
  const container = archive.file('META-INF/container.xml');
  if (!container) throw new Error('Missing MXL container.');

  const manifest = new DOMParser().parseFromString(await readMxlEntry(container), 'application/xml');
  const path = manifest.querySelector('container > rootfiles > rootfile')?.getAttribute('full-path');
  const score = path ? archive.file(path) : null;
  if (!score) throw new Error('Missing MXL score.');
  return readMxlEntry(score);
}

export async function readScoreFile(file: File): Promise<Document> {
  const extension = /\.([^.]+)$/.exec(file.name)?.[1].toLowerCase();
  const compressed = extension === 'mxl';
  if (!compressed && extension !== 'musicxml' && extension !== 'xml') {
    throw new Error('Choose a .musicxml, .xml, or .mxl file.');
  }

  const maxBytes = compressed ? 1024 * 1024 : maxXmlBytes;
  if (file.size > maxBytes) {
    throw new Error(compressed ? 'Choose a compressed score under 1 MiB.' : 'Choose a score under 5 MiB.');
  }

  let xml: string;
  try {
    xml = compressed ? await unpackMxl(file) : await file.text();
  } catch (error) {
    if (error instanceof MxlEntryTooLarge) throw error;
    throw new Error(compressed ? 'Could not unpack this MXL file. It may be damaged.' : 'Could not read this file.');
  }

  const score = new DOMParser().parseFromString(xml, 'application/xml');
  if (score.getElementsByTagName('parsererror').length) {
    throw new Error('This file contains damaged or invalid XML.');
  }
  if (score.documentElement.localName === 'score-timewise') {
    throw new Error('Export this score as partwise MusicXML to open it here.');
  }
  if (score.documentElement.localName !== 'score-partwise') {
    throw new Error('This XML file is not a MusicXML score.');
  }

  // Keep the score local even when it contains linked images or other external resources.
  for (const element of Array.from(score.querySelectorAll('image, credit-image, link, bookmark'))) {
    element.remove();
  }
  return score;
}

