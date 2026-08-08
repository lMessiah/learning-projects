/**
 * Local profile — a display name in localStorage. Nothing else, ever.
 * No signup, no login, no server. Purely cosmetic.
 */
const KEY = 'pcg.profile.name';
const DEFAULT_NAME = 'Wild Card';

export function getProfileName() {
  try {
    return localStorage.getItem(KEY) || DEFAULT_NAME;
  } catch {
    return DEFAULT_NAME; // storage blocked (private mode) — fall back silently
  }
}

export function setProfileName(name) {
  const clean = String(name || '').trim().slice(0, 20) || DEFAULT_NAME;
  try {
    localStorage.setItem(KEY, clean);
  } catch {
    /* ignore */
  }
  return clean;
}

export function resetProfile() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
