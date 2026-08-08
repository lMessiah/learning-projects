/**
 * Player settings — persisted in localStorage, applied immediately.
 *
 * Reads are cheap and always current, so any view can call `getSettings()`
 * during render and pick up a change without a reload.
 */
const KEY = 'pcg.settings';

export const ANIMATION_SPEEDS = Object.freeze([
  { id: 'off', label: 'Off', scale: 0, blurb: 'No animations. Also removes the auto-end-turn delay.' },
  { id: 'fast', label: 'Fast', scale: 1.8, blurb: 'Everything, roughly twice as quick.' },
  { id: 'normal', label: 'Normal', scale: 1, blurb: 'The default pacing.' },
]);

export const DEFAULTS = Object.freeze({
  theme: null, // null = follow the deck you picked
  animationSpeed: 'normal',
  autoEndTurn: false,
  autoSkipChoices: true,
  // Optional rendezvous server for six-character match codes. Empty means the
  // serverless copy-paste handshake, which is the default.
  rendezvousUrl: '',
});

/** Suggested value for someone running the bundled server locally. */
export const DEFAULT_RENDEZVOUS = 'http://localhost:8787';

let cache = null;
const listeners = new Set();

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS }; // storage blocked or corrupt — fall back silently
  }
}

export function getSettings() {
  if (!cache) cache = read();
  return cache;
}

export function setSetting(key, value) {
  const next = { ...getSettings(), [key]: value };
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  for (const listener of listeners) listener(next);
  return next;
}

export function resetSettings() {
  cache = { ...DEFAULTS };
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  for (const listener of listeners) listener(cache);
  return cache;
}

export function onSettingsChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The multiplier the animation layer and CSS use. 0 disables animation. */
export function animationScale(settings = getSettings()) {
  return (ANIMATION_SPEEDS.find((s) => s.id === settings.animationSpeed) ?? ANIMATION_SPEEDS[2]).scale;
}

/** Configured rendezvous base URL, or '' when short codes are not in use. */
export function getRendezvousUrl(settings = getSettings()) {
  return String(settings.rendezvousUrl || '').trim().replace(/\/+$/, '');
}

/** Auto-end-turn delay in ms. No delay when animations are off. */
export function autoEndDelay(settings = getSettings()) {
  return animationScale(settings) === 0 ? 0 : 1000;
}
