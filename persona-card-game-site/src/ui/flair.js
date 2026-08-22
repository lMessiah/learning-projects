/**
 * Custom messages — the two things the full trophy shelf unlocks.
 *
 * A player who has earned every trophy (or holds the admin unlock, which awards
 * every trophy anyway) gets to write two lines of their own:
 *
 *   win        replaces "Victory" on the result screen of a match you win.
 *   knockout   pops up as a small note whenever you knock out one of your
 *              opponent's Personas — shown to you AND sent to them.
 *
 * Both are pure decoration. They change no rule, no timing and no number; the
 * knockout note is the only thing in the game that crosses the wire without
 * being part of the match state, and all the receiving side ever does with it
 * is put the text in a box for a few seconds.
 *
 * ── Where the unlock check lives, and why it is not in here ───────────────
 *
 * `src/ui/game/board.js` is shared by every mode — online, hot-seat, tutorial,
 * Story Mode, Vs Bot — and it reads this file to find out what to print. So
 * this file imports NOTHING. Asking "has this player earned every trophy" needs
 * the trophy store and the admin flag, which between them pull in the whole
 * Story Mode campaign, and dragging that into the board's module graph for the
 * sake of a cosmetic string would be a genuinely bad trade — `ui/story/index.js`
 * imports the board, so it would also be a cycle.
 *
 * The gate therefore sits at the one place the text can be WRITTEN — the Trophy
 * Shelf, which already imports both (see `isFlairUnlocked` in
 * ui/story/trophyScreen.js). What the board finds here is simply "some text, or
 * none". A player who reaches into localStorage by hand can set it without the
 * trophies; so can a player who edits their save to award themselves the
 * trophies directly. There is no server and nothing to defend, and the honest
 * design is to gate the UI rather than pretend the data is trustworthy.
 *
 * ── Storage ──────────────────────────────────────────────────────────────
 *
 * One localStorage key on this device, like everything else here. Kept separate
 * from the trophy record on purpose: wiping the shelf is a decision about
 * trophies, and it should not silently delete something the player wrote.
 */

/** Longest each message may be. The win line becomes a heading; keep it short. */
export const FLAIR_LIMITS = Object.freeze({ win: 48, knockout: 80 });

/** The fields, in the order the editor shows them. */
export const FLAIR_FIELDS = Object.freeze(['win', 'knockout']);

const KEY = 'pcg.flair';
const SAVE_VERSION = 1;
const EMPTY = Object.freeze({ win: '', knockout: '' });

let cache = null;

/**
 * Make a string safe to drop into a heading or a bubble.
 *
 * Whitespace — including newlines and tabs, which a paste can easily carry —
 * collapses to single spaces, because both places this text lands are one-line
 * layouts. Control characters go entirely. Then it is cut to the field's limit.
 *
 * Applied on the way IN (what the player typed), on the way OUT (what was
 * stored, which may have been edited by hand) and to anything arriving from an
 * opponent over the network, which is the case that actually matters: a peer
 * can send whatever they like, and "whatever they like" gets 80 characters of
 * plain text in a box.
 */
export function cleanFlairText(text, field = 'win') {
  const limit = FLAIR_LIMITS[field] ?? FLAIR_LIMITS.win;
  return String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
    .trim();
}

function read() {
  let parsed = null;
  try {
    const raw = localStorage.getItem(KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    return { ...EMPTY };
  }
  if (!parsed || parsed.version !== SAVE_VERSION) return { ...EMPTY };
  return {
    win: cleanFlairText(parsed.win, 'win'),
    knockout: cleanFlairText(parsed.knockout, 'knockout'),
  };
}

/** `{ win, knockout }`, always both keys, always strings. Treat as read-only. */
export function getFlair() {
  if (!cache) cache = read();
  return cache;
}

/** Has the player written anything at all? */
export function hasFlair(flair = getFlair()) {
  return Boolean(flair.win || flair.knockout);
}

/**
 * Write one or both messages. Missing keys are left alone, so the editor can
 * save a field the moment it changes without knowing about the other one.
 *
 * @returns the stored record, cleaned — which is what the input should show.
 */
export function setFlair(patch = {}) {
  const next = { ...getFlair() };
  for (const field of FLAIR_FIELDS) {
    if (!Object.hasOwn(patch, field)) continue;
    next[field] = cleanFlairText(patch[field], field);
  }
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify({ version: SAVE_VERSION, ...next }));
  } catch {
    /* storage blocked — the messages last for this session only */
  }
  return cache;
}

/** Throw both away. */
export function clearFlair() {
  cache = { ...EMPTY };
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return cache;
}

/** Test seam: drop the in-process cache without touching what is stored. */
export function reloadFlair() {
  cache = null;
  return getFlair();
}
