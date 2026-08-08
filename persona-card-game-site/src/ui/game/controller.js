/**
 * Game controller — the only mutable thing in the app.
 *
 * It holds the current engine state, applies actions to get the next one, and
 * drives the bot's turn one action at a time so the player can follow along.
 * All rules live in the engine; this file only decides *when* to call it.
 */
import { applyAction, getLegalActions, createRng } from '../../engine/index.js';
import { chooseBotAction, explainBotActions } from '../../engine/bot.js';

/** Opt-in bot diagnostics: append ?debugBot=1 to the URL. */
function debugEnabled() {
  try {
    return new URLSearchParams(window.location.search).has('debugBot');
  } catch {
    return false;
  }
}

export function createController({ state, botPlayer = null, difficulty = 'medium', botSeed = 1, speed = 1, debug = debugEnabled() }) {
  let current = state;
  let botRng = createRng(botSeed);
  let timer = null;
  let destroyed = false;
  const listeners = new Set();

  const stepDelay = () => Math.max(80, Math.round(520 / speed));

  function notify() {
    for (const listener of listeners) listener(current);
  }

  function isBotTurn() {
    if (botPlayer === null || current.winner !== null) return false;
    if (current.phase === 'starterSelect') return current.players[botPlayer].field.length === 0;
    return current.phase === 'playing' && current.activePlayer === botPlayer;
  }

  /** Apply one bot action, then queue the next until the turn passes back. */
  function botStep() {
    timer = null;
    if (destroyed || !isBotTurn()) return;

    if (debug) {
      const scored = explainBotActions(current, botPlayer, difficulty);
      console.groupCollapsed(
        `[bot:${difficulty}] turn ${current.turn} — ${scored.length} legal action(s), action budget ${current.turnState?.actionsRemaining ?? '-'}`
      );
      console.table(
        scored.map(({ action, score }) => ({
          score,
          type: action.type,
          detail: action.skillId || action.cardId || action.targetUid || action.recipeId || '',
        }))
      );
      console.groupEnd();
    }

    const [action, nextRng] = chooseBotAction(current, botPlayer, difficulty, botRng);
    botRng = nextRng;
    if (!action) return;
    if (debug) console.log(`[bot:${difficulty}] chose`, action.type, action.skillId || action.cardId || '');

    try {
      current = applyAction(current, action);
    } catch (error) {
      // A bot should never produce an illegal action; if it somehow does, end
      // its turn rather than wedging the match.
      console.error('Bot produced an illegal action', action, error);
      const bail = getLegalActions(current, botPlayer).find((a) => a.type === 'END_TURN');
      if (bail) current = applyAction(current, bail);
    }

    notify();
    scheduleBot();
  }

  function scheduleBot() {
    if (destroyed || timer !== null || !isBotTurn()) return;
    timer = setTimeout(botStep, stepDelay());
  }

  return {
    getState: () => current,
    isBotTurn,
    isBusy: () => timer !== null,

    /** Apply a human action. Throws if the engine rejects it. */
    dispatch(action) {
      if (destroyed) return current;
      // Only ever refuse to act *on the bot's behalf*. Both players choose a
      // starter independently, so this must not be an "is it the bot's turn"
      // check — that would swallow the player's starter pick.
      if (botPlayer !== null && action.player === botPlayer) return current;
      current = applyAction(current, action);
      notify();
      scheduleBot();
      return current;
    },

    legalActions(playerId) {
      return getLegalActions(current, playerId);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Kick things off (the bot may need to choose its starter first). */
    start() {
      scheduleBot();
      notify();
    },

    setSpeed(next) {
      speed = next;
    },

    destroy() {
      destroyed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      listeners.clear();
    },
  };
}
