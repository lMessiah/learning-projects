/**
 * Story Mode progress — persisted in localStorage, on this device only.
 *
 * There is no backend and there is never going to be one, so this is the whole
 * of the save system: a small JSON blob under one key, read on demand and
 * written after anything that changes it.
 *
 * ── Forward compatibility ─────────────────────────────────────────────────
 *
 * Later stages of this feature add fields to the record (a retry counter, a
 * checkpoint). `read()` merges the stored blob over DEFAULTS rather than
 * trusting its shape, so a save written today still loads once those fields
 * exist — it simply picks up their defaults. SAVE_VERSION is reserved for the
 * other kind of change: one where an old save would be actively *wrong* rather
 * than merely incomplete. Those get dropped, not repaired.
 */
import { DECKS } from '../../data/cards.js';
import { ARCHETYPES } from '../../data/archetypes.js';
import { BATTLE_COUNT, MAX_RETRIES, checkpointFor, isBattleNumber } from './campaign.js';

const KEY = 'pcg.story.progress';

/** Bump only when an existing save would be misread rather than under-read. */
const SAVE_VERSION = 1;

const DEFAULT_DECK = DECKS[0].id;
const DEFAULT_ARCHETYPE = ARCHETYPES[0].id;

const DEFAULTS = Object.freeze({
  version: SAVE_VERSION,
  /** The furthest battle the player may start. Always 1..BATTLE_COUNT. */
  currentBattle: 1,
  /** Battle numbers already beaten, ascending and unique. */
  cleared: [],
  /**
   * The deck-select screen's last answer.
   *
   * Consulted ONLY by a battle whose `playerDeck` is PLAYER_CHOICE. Every other
   * battle hands the player an assigned loadout and ignores this entirely — see
   * decks.js. It is remembered across battles so that re-entering Nyx does not
   * make you re-pick from scratch every time.
   */
  chosenDeckId: DEFAULT_DECK,
  chosenArchetype: DEFAULT_ARCHETYPE,
  /**
   * Losses on each battle *in the current run*, keyed by battle number.
   *
   * Cleared for a battle when it is beaten, and wiped wholesale when the run
   * falls back to the checkpoint — both of which are "start this fresh".
   */
  attempts: {},
  /**
   * Retries spent across the whole campaign, for the No Continues trophy.
   *
   * Deliberately NOT reset by a checkpoint fallback: falling back is the most
   * expensive thing a retry can buy, and a run that did it has plainly used one.
   * Only a full reset clears this.
   */
  retriesUsed: 0,
  updatedAt: null,
});

/**
 * A fresh copy of the defaults.
 *
 * A shallow spread will not do here: `attempts` is an object, so every caller
 * would be handed the same one and a reset would share its map with a load.
 */
function freshDefaults() {
  return { ...DEFAULTS, attempts: {} };
}

let cache = null;

/**
 * Pull the record into a shape the rest of the mode can trust.
 *
 * Everything here is defensive on purpose: this blob is user-editable (it is
 * localStorage on their own machine), and a hand-edited `currentBattle: 99`
 * should clamp to the end of the campaign rather than route to a battle that
 * does not exist.
 */
function sanitize(raw) {
  const merged = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };

  const cleared = [...new Set((Array.isArray(merged.cleared) ? merged.cleared : []).map(Number).filter(isBattleNumber))].sort(
    (a, b) => a - b
  );

  // A save is only ever as far along as the battles it actually cleared, but it
  // may legitimately be one ahead of them — that is what "unlocked but not yet
  // beaten" is. Anything further is corrupt and gets pulled back.
  const earned = cleared.length ? Math.min(Math.max(...cleared) + 1, BATTLE_COUNT) : 1;
  const stored = Number(merged.currentBattle);
  const currentBattle = isBattleNumber(stored) ? Math.min(Math.max(stored, earned), BATTLE_COUNT) : earned;

  const attempts = {};
  for (const [key, value] of Object.entries(merged.attempts ?? {})) {
    const number = Number(key);
    const losses = Number(value);
    if (!isBattleNumber(number) || !Number.isInteger(losses) || losses <= 0) continue;
    attempts[number] = Math.min(losses, MAX_RETRIES);
  }

  return {
    version: SAVE_VERSION,
    currentBattle,
    cleared,
    attempts,
    retriesUsed: Number.isInteger(merged.retriesUsed) && merged.retriesUsed > 0 ? merged.retriesUsed : 0,
    chosenDeckId: DECKS.some((d) => d.id === merged.chosenDeckId) ? merged.chosenDeckId : DEFAULT_DECK,
    chosenArchetype: ARCHETYPES.some((a) => a.id === merged.chosenArchetype)
      ? merged.chosenArchetype
      : DEFAULT_ARCHETYPE,
    updatedAt: Number.isFinite(merged.updatedAt) ? merged.updatedAt : null,
  };
}

function read() {
  let parsed = null;
  try {
    const rawText = localStorage.getItem(KEY);
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    return freshDefaults(); // storage blocked or corrupt — play unsaved
  }
  if (parsed && parsed.version !== SAVE_VERSION) return freshDefaults();
  return sanitize(parsed);
}

function write(next) {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode, quota, a disabled store — the campaign carries on in memory */
  }
  return cache;
}

/** The current record. Cheap; safe to call during a render. */
export function getStoryProgress() {
  if (!cache) cache = read();
  return cache;
}

/** Merge a patch into the record and persist it. Returns the new record. */
export function saveStoryProgress(patch) {
  return write(sanitize({ ...getStoryProgress(), ...patch, updatedAt: Date.now() }));
}

/**
 * Remember what the deck-select screen was last set to.
 *
 * Only ever reached from a PLAYER_CHOICE battle. Assigned battles never call it.
 */
export function setChosenDeck({ deckId, archetype }) {
  return saveStoryProgress({ chosenDeckId: deckId, chosenArchetype: archetype });
}

/** The remembered pick, in the shape `resolvePlayerDeck` wants. */
export function getChosenDeck(progress = getStoryProgress()) {
  return { deckId: progress.chosenDeckId, archetype: progress.chosenArchetype };
}

/**
 * Mark a battle beaten and open the next one.
 *
 * Idempotent, and safe to call for a battle that was already cleared — a replay
 * of Battle 2 must not drag `currentBattle` back down to 3.
 */
export function recordBattleCleared(number) {
  if (!isBattleNumber(number)) return getStoryProgress();
  const progress = getStoryProgress();
  const cleared = [...new Set([...progress.cleared, number])];
  const currentBattle = Math.max(progress.currentBattle, Math.min(number + 1, BATTLE_COUNT));
  // A beaten battle starts fresh if it is ever played again — carrying its old
  // losses forward would mean a replay began one bad match from a fallback.
  const attempts = { ...progress.attempts };
  delete attempts[number];
  return saveStoryProgress({ cleared, currentBattle, attempts });
}

/**
 * Open every battle without pretending any of them were beaten.
 *
 * "Unlocked" and "cleared" are deliberately different things here: the map
 * draws a cleared battle with a tick and a beaten frontier, and faking those
 * would make an admin save indistinguishable from a finished campaign. This
 * moves the frontier to the end and leaves `cleared` alone, so every fight is
 * playable and none of them claims to have happened.
 */
export function unlockAllBattles() {
  return saveStoryProgress({ currentBattle: BATTLE_COUNT });
}

/* ------------------------------------------------------------------ *
 * Retries and the checkpoint
 * ------------------------------------------------------------------ */

/** Losses taken on this battle since it was last started fresh. */
export function lossesOn(number, progress = getStoryProgress()) {
  return progress.attempts[number] ?? 0;
}

/** What the result screen puts in front of the player. Never below zero. */
export function retriesRemaining(number, progress = getStoryProgress()) {
  return Math.max(0, MAX_RETRIES - lossesOn(number, progress));
}

/**
 * Record a loss.
 *
 * Returns `{ progress, retriesRemaining, failedOut, checkpoint }`. `failedOut`
 * is the whole decision — the caller does not re-derive it — and when it is true
 * the run has ALREADY been rolled back to `checkpoint` by this call. Doing the
 * rollback here rather than on the button press means a player who closes the
 * tab on the "you fell back" screen still comes back to the right battle.
 */
export function recordBattleLost(number) {
  if (!isBattleNumber(number)) {
    return { progress: getStoryProgress(), retriesRemaining: MAX_RETRIES, failedOut: false, checkpoint: null };
  }

  const losses = lossesOn(number) + 1;
  const attempts = { ...getStoryProgress().attempts, [number]: losses };
  const retriesUsed = getStoryProgress().retriesUsed + 1;

  if (losses < MAX_RETRIES) {
    const progress = saveStoryProgress({ attempts, retriesUsed });
    return { progress, retriesRemaining: retriesRemaining(number, progress), failedOut: false, checkpoint: null };
  }

  // Out of retries: fall back, and start everything from the checkpoint clean.
  const checkpoint = checkpointFor(number);
  const progress = saveStoryProgress({
    attempts: {},
    retriesUsed,
    currentBattle: checkpoint,
    // Clearing the battles past the checkpoint is what makes falling back cost
    // something. Without it the map would still show Battle 6 as beaten while
    // sending the player back to 4, which is just confusing.
    cleared: getStoryProgress().cleared.filter((n) => n < checkpoint),
  });
  return { progress, retriesRemaining: 0, failedOut: true, checkpoint };
}

/** May this battle be started? Everything up to and including the frontier. */
export function isBattleUnlocked(number, progress = getStoryProgress()) {
  return isBattleNumber(number) && number <= progress.currentBattle;
}

/** Has this battle already been beaten? */
export function isBattleCleared(number, progress = getStoryProgress()) {
  return progress.cleared.includes(number);
}

/** Every battle beaten — the campaign is finished. */
export function isCampaignComplete(progress = getStoryProgress()) {
  return progress.cleared.length >= BATTLE_COUNT;
}

/** Wipe the campaign back to Battle 1. Keeps nothing. */
export function resetStoryProgress() {
  cache = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  cache = freshDefaults();
  return cache;
}

/** Test seam: drop the in-process cache without touching what is stored. */
export function reloadStoryProgress() {
  cache = null;
  return getStoryProgress();
}
