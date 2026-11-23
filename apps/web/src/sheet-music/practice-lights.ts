import { mainPianoNotes, patternFrames, sendFinalFrame, sendFrames, type LightingOutput } from '../lighting';

export function createPracticeLights(showError: (message: string) => void) {
  const color = '#63dfbe';
  const clearFrame = patternFrames([], color)[0];
  const storageKey = 'popuconnect.practiceLightOutputs';
  let connectedOutputs = new Map<string, LightingOutput>();
  const possiblyLit = new Set<string>();
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? '[]');
    if (Array.isArray(stored)) {
      for (const id of stored) if (typeof id === 'string') possiblyLit.add(id);
    }
  } catch {
    // Keep tracking writes in memory when session storage is unavailable.
  }
  let requested: { output: LightingOutput; notes: number[]; key: string } | undefined;
  let sent: typeof requested;
  let sends = new AbortController();
  let pending = false;
  let sending = false;
  let flushed = Promise.resolve();

  function rememberLitOutputs(): void {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify([...possiblyLit]));
    } catch {
      // The page can still clear outputs while it is open.
    }
  }

  async function flush(): Promise<void> {
    sending = true;
    while (pending) {
      pending = false;
      const target = requested;
      const signal = sends.signal;
      showError('');
      for (const id of possiblyLit) {
        const output = connectedOutputs.get(id);
        if (!output || output.state !== 'connected' || id === requested?.output.id) continue;
        try {
          await sendFrames(output, [clearFrame], signal);
          if (signal.aborted) break;
          possiblyLit.delete(id);
          rememberLitOutputs();
          if (sent?.output.id === id) sent = undefined;
        } catch {
          if (signal.aborted) break;
          showError('Could not clear the practice lights. Check the MIDI output.');
        }
      }
      if (!signal.aborted && target && target !== sent && target === requested && target.output.state === 'connected') {
        // An assignment may already have been queued when a port starts to fail.
        possiblyLit.add(target.output.id);
        rememberLitOutputs();
        try {
          await sendFrames(target.output, patternFrames(target.notes, color), signal);
          if (!signal.aborted) sent = target;
        } catch {
          if (!signal.aborted) showError('Could not send the practice lights. Check the MIDI output and SysEx permission.');
        }
      }
    }
    sending = false;
  }

  window.addEventListener('pagehide', () => {
    sends.abort();
    sends = new AbortController();
    pending = false;
    requested = sent = undefined;
    for (const id of possiblyLit) {
      const output = connectedOutputs.get(id);
      if (!output || output.state !== 'connected') continue;
      void sendFinalFrame(output, clearFrame).catch(() => {});
    }
    // Keep the IDs across reload because a browser may drop queued writes on unload.
  });

  function needsClear(): boolean {
    return [...possiblyLit].some(id => id !== requested?.output.id && connectedOutputs.get(id)?.state === 'connected');
  }

  return async (output: LightingOutput | undefined, notes: readonly number[], outputs?: readonly LightingOutput[]): Promise<boolean> => {
    if (outputs) connectedOutputs = new Map(outputs.map(port => [port.id, port]));

    const mapped = mainPianoNotes.filter(note => notes.includes(note));
    const key = mapped.join(',');
    if (output && mapped.length) {
      if (requested?.output !== output || requested.key !== key) {
        requested = { output, notes: mapped, key };
      }
    } else {
      requested = undefined;
    }
    if (requested !== sent || needsClear()) pending = true;
    if (!sending && pending) flushed = flush();
    await flushed;
    return !needsClear();
  };
}
