/**
 * Hot-seat match persistence.
 *
 * One device, two players, and a Back button that is very easy to hit by
 * accident. Losing a twenty-turn match to a stray gesture is the worst thing
 * the local mode can do to you, so the whole match state is written to
 * localStorage after every action and offered back the next time the route is
 * opened.
 *
 * This works at all only because the engine state is a plain JSON value — no
 * classes, no functions, no Maps, and an RNG that is literally `{ s }`. Round
 * -tripping it through JSON gives back a state `applyAction` accepts, which is
 * the same property that makes the reducer testable and will make the online
 * mode possible. Nothing here reaches into the shape of that state; it stores
 * the blob and hands it back.
 *
 * WHAT IS NOT SAVED: which seat was looking at the board. A resumed match always
 * comes back behind the pass-the-device gate, because the person who reopens the
 * tab is not necessarily the person who closed it — restoring straight onto a
 * board would show them somebody else's hand. See hotseat.js.
 */
const KEY = 'pcg.hotseat.save';

/**
 * Bumped whenever a saved match could no longer be resumed correctly — an
 * engine state shape change, or a change to what `seats` carries. A save that
 * does not match is dropped rather than repaired: a half-understood match is
 * worse than an honest "start a new one".
 */
const SAVE_VERSION = 1;

/** Persist the match. Silently does nothing if storage is unavailable. */
export function saveHotseat({ state, seats }) {
  if (!state || !seats) return false;
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ version: SAVE_VERSION, savedAt: Date.now(), seats, state })
    );
    return true;
  } catch {
    // Private mode, quota, a disabled store — the match carries on in memory.
    return false;
  }
}

/**
 * The saved match, or null if there isn't a usable one.
 *
 * A finished match is deliberately not resumable: there is nothing to go back
 * to, and offering "resume" over a result screen would be a strange thing to
 * greet somebody with.
 */
export function loadHotseat() {
  let parsed;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || parsed.version !== SAVE_VERSION) {
    clearHotseat();
    return null;
  }
  const { state, seats } = parsed;
  if (!state || !Array.isArray(seats) || seats.length !== 2) {
    clearHotseat();
    return null;
  }
  if (!Array.isArray(state.players) || state.players.length !== 2) {
    clearHotseat();
    return null;
  }
  if (state.winner !== null && state.winner !== undefined) {
    clearHotseat();
    return null;
  }

  return { state, seats, savedAt: parsed.savedAt ?? null };
}

/** Is there a match waiting to be resumed? */
export function hasHotseatSave() {
  return loadHotseat() !== null;
}

export function clearHotseat() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
