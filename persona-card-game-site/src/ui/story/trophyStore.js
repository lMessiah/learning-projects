/**
 * Trophy state — localStorage, this device, nothing else.
 *
 * Kept in its own key rather than inside the story progress record, because the
 * two have different lifetimes: resetting the campaign puts you back at Battle 1
 * but must NOT take your trophies away. Wiping the shelf is a separate, louder
 * decision.
 */
import { TROPHY_IDS, SHELF_TROPHY_ID } from './trophies.js';

const KEY = 'pcg.story.trophies';
const SAVE_VERSION = 1;

let cache = null;

function read() {
  let parsed = null;
  try {
    const raw = localStorage.getItem(KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    return {};
  }
  if (!parsed || parsed.version !== SAVE_VERSION || typeof parsed.earned !== 'object') return {};

  // Only ids that still exist, so a trophy deleted from trophies.js does not
  // linger as an unrenderable entry.
  const earned = {};
  for (const [id, at] of Object.entries(parsed.earned ?? {})) {
    if (TROPHY_IDS.includes(id)) earned[id] = Number.isFinite(at) ? at : 0;
  }
  return earned;
}

function write(earned) {
  cache = earned;
  try {
    localStorage.setItem(KEY, JSON.stringify({ version: SAVE_VERSION, earned }));
  } catch {
    /* storage blocked — the shelf lives for this session only */
  }
  return cache;
}

/** `{ [trophyId]: earnedAtMs }`. Treat as read-only. */
export function getEarnedTrophies() {
  if (!cache) cache = read();
  return cache;
}

export function hasTrophy(id, earned = getEarnedTrophies()) {
  return Object.hasOwn(earned, id);
}

/**
 * Award trophies, skipping any already held.
 *
 * @returns the ids actually awarded by THIS call, in the order given — which is
 *          what the result screen announces. An empty array means nothing new.
 */
export function awardTrophies(ids) {
  const earned = { ...getEarnedTrophies() };
  const fresh = [];
  for (const id of ids) {
    if (!TROPHY_IDS.includes(id) || Object.hasOwn(earned, id)) continue;
    earned[id] = Date.now();
    fresh.push(id);
  }
  if (fresh.length) write(earned);
  return fresh;
}

/**
 * Is the trophy system revealed to the player at all?
 *
 * Before the first trophy there is no shelf, no button, and no hint that
 * trophies exist — earning that first one IS the reveal. Every piece of trophy
 * UI in the app asks this before rendering anything.
 */
export function isShelfUnlocked(earned = getEarnedTrophies()) {
  return hasTrophy(SHELF_TROPHY_ID, earned);
}

/** Wipe the shelf. Separate from resetting campaign progress, on purpose. */
export function resetTrophies() {
  cache = {};
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return cache;
}

/** Test seam: drop the in-process cache without touching what is stored. */
export function reloadTrophies() {
  cache = null;
  return getEarnedTrophies();
}
