interface SavedScore {
  id: string;
  file: File;
}

interface ScoreSettings {
  keyRange: string;
  scoreView: string;
  scoreZoom: string;
  learningHints: boolean;
  part: number;
  staff: number;
  position: number;
}

let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('popuconnect-scores', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('scores');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readLastScore(): Promise<SavedScore | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('scores').objectStore('scores').get('last');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function writeLastScore(score: SavedScore): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('scores', 'readwrite');
    transaction.objectStore('scores').put(score, 'last');
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function removeLastScore(id: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('scores', 'readwrite');
    const store = transaction.objectStore('scores');
    const request = store.get('last');
    request.onsuccess = () => {
      if (request.result?.id === id) store.delete('last');
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function scoreFileId(file: File): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    return JSON.stringify([file.name, file.size, file.lastModified]);
  }
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function readScoreSettings(id: string): ScoreSettings | undefined {
  try {
    return JSON.parse(localStorage.getItem('popuconnect.score.' + id) ?? 'null') ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeScoreSettings(id: string, settings: ScoreSettings): void {
  try {
    localStorage.setItem('popuconnect.score.' + id, JSON.stringify(settings));
  } catch {
    // The score and its settings remain usable in this session.
  }
}
