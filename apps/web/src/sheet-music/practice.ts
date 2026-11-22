export function matchNote(expected: readonly number[], matched: Set<number>, note: number) {
  if (!expected.includes(note)) return 'wrong';
  if (matched.has(note)) return 'duplicate';
  matched.add(note);
  return matched.size === expected.length ? 'complete' : 'matched';
}
