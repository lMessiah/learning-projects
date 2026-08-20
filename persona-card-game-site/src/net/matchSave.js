/**
 * Online match persistence, so a reload does not destroy a match in progress —
 * or lose the result of one that has already finished.
 *
 * Two separate things live here, both about surviving a page load:
 *
 *   the HOST SAVE     the full authoritative state, host only
 *   the OUTCOME       a few bytes saying how a match ended, written by both
 *
 * The outcome record exists for the player who comes back to a match that
 * resolved while they were away. Their seat is gone and the relay has forgotten
 * the room, so reconnecting gets them "that match code is unknown" — which is
 * true, and useless. With the outcome in hand the same dead end becomes "this
 * match ended, here is what happened", which is what the player actually needs.
 *
 * THE PROBLEM THIS SOLVES. The host holds the only authoritative state, and it
 * holds it in a closure (see createHostSession). A network blip leaves that
 * closure intact and the reconnecting transport simply carries on. A page
 * RELOAD does not: the tab is torn down, the closure with it, and there is
 * nothing left to resume even though the guest is still sitting there waiting.
 * Without this file, "the host refreshed" is unrecoverable in a way "the host
 * lost wifi for ten seconds" is not, which is a strange thing to explain to a
 * player.
 *
 * This works for the same reason hotseatSave.js works: the engine state is a
 * plain JSON value — no classes, no functions, no Maps, and an RNG that is
 * literally `{ s }`. Round-tripping it through JSON gives back a state that
 * `applyAction` accepts.
 *
 * WHAT IS DELIBERATELY NOT SAVED: the seat token. It lives in sessionStorage
 * alongside, because it identifies a CONNECTION rather than a match, and a token
 * restored into a different tab would have two of them fighting over one seat.
 *
 * A save is only ever offered back for a short window. The relay releases the
 * seat after SEAT_RESERVATION_MS whatever happens here, so a save older than
 * that describes a match that cannot be rejoined and would only raise hopes.
 */
import { TIMING } from './presence.js';

const KEY = 'pcg.online.host';

/**
 * Bumped whenever a saved match could no longer be resumed correctly — an
 * engine state shape change, or a change to what is stored alongside it. A save
 * that does not match is dropped rather than repaired.
 */
const SAVE_VERSION = 1;

/** Storage that never throws: private mode, quota and disabled stores are all fine. */
function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Persist the authoritative state against the match code.
 *
 * Called after every action, which sounds heavy but is the same thing the
 * hot-seat mode already does — a match state is a few tens of KB and the write
 * is synchronous but small.
 */
export function saveHostMatch({ state, code, token = '', now = () => Date.now() }) {
  if (!state || !code) return false;
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(
      KEY,
      JSON.stringify({ version: SAVE_VERSION, savedAt: now(), code, token, state }),
    );
    return true;
  } catch {
    // The match carries on in memory; it just cannot survive a reload.
    return false;
  }
}

/**
 * The saved match, or null if there is not a usable one.
 *
 * A FINISHED match is still returned, unlike the hot-seat save. That is the
 * point of the `resolved` flag: a player coming back to a match that ended
 * while they were away needs to be shown the result, not a blank menu that
 * silently forgets a match they were in the middle of.
 */
export function loadHostMatch({ now = () => Date.now(), maxAgeMs = TIMING.SEAT_RESERVATION_MS } = {}) {
  const store = storage();
  if (!store) return null;

  let parsed;
  try {
    const raw = store.getItem(KEY);
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || parsed.version !== SAVE_VERSION) {
    clearHostMatch();
    return null;
  }
  const { state, code, token, savedAt } = parsed;
  if (!state || !code || !Array.isArray(state.players) || state.players.length !== 2) {
    clearHostMatch();
    return null;
  }

  const resolved = state.winner !== null && state.winner !== undefined;
  const age = now() - (savedAt ?? 0);

  // Too old to rejoin. A finished match is kept a little longer regardless,
  // because showing someone how their match ended costs nothing and the
  // alternative is a result they never got to see.
  if (!resolved && age > maxAgeMs) {
    clearHostMatch();
    return null;
  }

  return { state, code, token: token ?? '', savedAt: savedAt ?? null, resolved, age };
}

/** Is there a host match worth offering to resume? */
export function hasResumableHostMatch(options) {
  const saved = loadHostMatch(options);
  return Boolean(saved) && !saved.resolved;
}

export function clearHostMatch() {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ *
 * Match outcomes
 * ------------------------------------------------------------------ */

const OUTCOME_KEY = 'pcg.online.outcomes';
/** Outcomes are only interesting to somebody who might still be coming back. */
const OUTCOME_TTL_MS = 30 * 60 * 1000;
/** A handful is plenty; this is a courtesy, not a match history. */
const OUTCOME_LIMIT = 8;

function readOutcomes() {
  const store = storage();
  if (!store) return {};
  try {
    const parsed = JSON.parse(store.getItem(OUTCOME_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Record how a match ended, so returning to it later shows a result rather than
 * an error. Written by BOTH sides — each knows its own outcome, and whichever
 * one reloads is the one that needs it.
 */
export function rememberOutcome({ code, winner, seat, reason, names = null, now = () => Date.now() }) {
  const store = storage();
  if (!store || !code) return false;
  const key = String(code).toUpperCase();
  const outcomes = readOutcomes();
  outcomes[key] = { winner, seat, reason, names, endedAt: now() };

  // Keep the newest few and drop the rest, so this can never grow without bound.
  const trimmed = Object.entries(outcomes)
    .sort((a, b) => (b[1]?.endedAt ?? 0) - (a[1]?.endedAt ?? 0))
    .slice(0, OUTCOME_LIMIT);

  try {
    store.setItem(OUTCOME_KEY, JSON.stringify(Object.fromEntries(trimmed)));
    return true;
  } catch {
    return false;
  }
}

/** How a match ended, if this browser saw it end. */
export function recallOutcome(code, { now = () => Date.now() } = {}) {
  if (!code) return null;
  const record = readOutcomes()[String(code).toUpperCase()];
  if (!record) return null;
  if (now() - (record.endedAt ?? 0) > OUTCOME_TTL_MS) return null;
  return record;
}

export function clearOutcomes() {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(OUTCOME_KEY);
  } catch {
    /* ignore */
  }
}
