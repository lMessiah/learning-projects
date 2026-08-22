/**
 * The admin unlock.
 *
 * Setting the display name to `n--admin` opens everything: every Story Mode
 * battle becomes playable, every trophy is awarded, and the Persona 1 colour
 * scheme — which is not otherwise obtainable — becomes selectable and is
 * switched on.
 *
 * ── What "permanently" means here ─────────────────────────────────────────
 *
 * The trigger is the name, but the STATE is not. Once activated, a flag is
 * written to localStorage and the unlocks stay: rename yourself back to
 * anything you like and the battles are still open, the shelf is still full and
 * the P1 theme is still in Settings. That is the whole point of the flag — a
 * feature that switched off the moment you changed your name would be a costume
 * rather than an unlock.
 *
 * There is a way back (`deactivateAdmin`, surfaced in Settings once unlocked),
 * because a one-way door with no handle on the inside is a bug waiting to be
 * reported. It clears the flag and the theme; it deliberately does NOT take
 * back the battles or the trophies, which are ordinary saved progress by then
 * and belong to the player.
 *
 * ── Scope ─────────────────────────────────────────────────────────────────
 *
 * Local only, like everything else in this app. There is no server, no account
 * and nothing to authenticate against, so this is a convenience for whoever is
 * sitting at the machine — a debug switch with a nice coat on, not a security
 * boundary. It grants no capability a player could not already reach by editing
 * localStorage by hand.
 */
import { BATTLE_COUNT } from './story/campaign.js';
import { unlockAllBattles } from './story/progress.js';
import { TROPHY_IDS } from './story/trophies.js';
import { awardTrophies } from './story/trophyStore.js';
import { ADMIN_THEME, applyThemeFor, setThemeOverride } from './theme.js';

/** The display name that opens it. Compared case-insensitively, trimmed. */
export const ADMIN_NAME = 'n--admin';

const KEY = 'pcg.admin';

let cache = null;

const normalise = (name) => String(name ?? '').trim().toLowerCase();

/** Is this the magic name? */
export function isAdminName(name) {
  return normalise(name) === ADMIN_NAME;
}

/** Has the unlock ever been activated on this device? */
export function isAdminUnlocked() {
  if (cache !== null) return cache;
  try {
    cache = localStorage.getItem(KEY) === '1';
  } catch {
    cache = false; // storage blocked — no unlock, and no crash
  }
  return cache;
}

/**
 * Turn it on and grant everything. Idempotent.
 *
 * @returns true if this call was the one that activated it, false if it was
 *          already on — which is what lets the caller show the banner once.
 */
export function activateAdmin() {
  const wasUnlocked = isAdminUnlocked();

  cache = true;
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    /* storage blocked — admin lasts for this session only */
  }

  // Granted every time rather than only on first activation: progress can be
  // reset from Settings, and an admin who resets and finds half the campaign
  // locked again would reasonably call that broken.
  unlockAllBattles();
  awardTrophies([...TROPHY_IDS]);
  setThemeOverride(ADMIN_THEME);

  return !wasUnlocked;
}

/**
 * Give the flag back.
 *
 * The theme goes with it, because it is the one grant that is otherwise
 * unobtainable and would look like a bug sitting in a non-admin Settings
 * screen. Battles and trophies stay: by now they are just saved progress.
 */
export function deactivateAdmin() {
  cache = false;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  setThemeOverride(null);
  applyThemeFor({});
  return false;
}

/**
 * Reconcile the unlock with a display name.
 *
 * Called wherever the name is set, and once at startup so a name that was
 * already `n--admin` activates on load rather than needing a re-type.
 *
 * @returns true if this call activated it for the first time.
 */
export function syncAdmin(name) {
  if (!isAdminName(name)) return false;
  return activateAdmin();
}

/** Test seam: drop the in-process cache without touching what is stored. */
export function reloadAdmin() {
  cache = null;
  return isAdminUnlocked();
}

/** Everything the unlock grants, for the Settings blurb. */
export const ADMIN_GRANTS = Object.freeze([
  `All ${BATTLE_COUNT} Story Mode battles unlocked`,
  'Every trophy awarded',
  // Not a separate grant so much as a consequence of the one above — but it is
  // the one an admin is least likely to go looking for, so it is named.
  'Custom victory and knockout messages, on the Trophy Shelf',
  'The Persona 1 colour scheme',
]);
