export function applyPreference(control: HTMLInputElement | HTMLSelectElement, value: unknown): void {
  if (control instanceof HTMLInputElement) {
    if (typeof value === 'boolean') control.checked = value;
  } else if (typeof value === 'string' && Array.from(control.options).some(option => option.value === value)) {
    control.value = value;
  }
}

export function rememberPreference(
  name: string,
  control: HTMLInputElement | HTMLSelectElement,
  canSave = () => true,
): () => void {
  const key = 'popuconnect.' + name;
  try {
    const value = localStorage.getItem(key);
    if (value !== null) {
      applyPreference(control, control instanceof HTMLInputElement ? value === 'true' : value);
    }
  } catch {
    // Defaults still work when storage is unavailable.
  }
  let preference = control instanceof HTMLInputElement ? control.checked : control.value;
  control.addEventListener('change', () => {
    if (!canSave()) return;
    preference = control instanceof HTMLInputElement ? control.checked : control.value;
    try {
      localStorage.setItem(key, String(preference));
    } catch {
      // Keep this session's choice.
    }
  });
  return () => applyPreference(control, preference);
}
