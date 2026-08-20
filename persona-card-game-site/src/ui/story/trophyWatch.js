/**
 * Watching one story battle for the facts the trophies need.
 *
 * Most of what a trophy asks about is already on the finished state: One Mores,
 * fusions, knockouts. Three things are not, because they are properties of the
 * match *as it happened* rather than of its final position:
 *
 *   longestOneMore    the engine tracks One Mores granted THIS TURN and resets
 *                     it every turn. The longest chain is therefore only
 *                     observable by watching.
 *   lowestHpFraction  "you were nearly dead and won anyway" is invisible at the
 *                     end, because you are not nearly dead any more.
 *   biggestPhysHit    `stats.biggestHit` records the hardest blow but not what
 *                     type it was, and Wallbreaker asks specifically for Phys.
 *
 * ── Why this wraps the controller ─────────────────────────────────────────
 *
 * Subscribing gives states, not the actions between them, and the damage type of
 * a hit lives in the action. So the human's dispatches are observed by wrapping
 * `dispatch`: the damage the player's ledger gained across one call is that
 * one action's damage, and the action says which skill threw it.
 *
 * The alternative was adding a `biggestPhysHit` counter to the engine. That is a
 * change to the rules layer for the sake of an achievement, and it would be paid
 * for by every mode and every test. This is confined to Story Mode.
 *
 * Nothing here mutates the controller or the state — it only reads.
 */
import { SKILLS } from '../../data/cards.js';

/** Basic ATTACK has no skill id; the engine resolves it as Phys. */
function isPhysAction(action) {
  if (!action) return false;
  if (action.type === 'ATTACK') return true;
  if (action.type !== 'USE_SKILL') return false;
  return SKILLS[action.skillId]?.type === 'phys';
}

/** Total HP across a player's field, as a fraction of its maximum. */
function fieldHpFraction(state, playerId) {
  const field = state.players[playerId]?.field ?? [];
  let hp = 0;
  let maxHp = 0;
  for (const persona of field) {
    hp += Math.max(0, persona.hp ?? 0);
    maxHp += persona.maxHp ?? 0;
  }
  // An empty field is not "0% HP" — it is a player between Personas, and
  // counting it would hand Comeback to anybody who ever traded down.
  return maxHp > 0 ? hp / maxHp : 1;
}

/**
 * Wrap a controller so a story battle can be summarised afterwards.
 *
 * @returns { controller, summary, stop } — pass `controller` to mountBoard in
 *          place of the real one, and call `summary()` once the match is over.
 */
export function watchBattle(controller, viewer) {
  let longestOneMore = 0;
  let biggestPhysHit = 0;
  let lowestHpFraction = 1;
  let stopped = false;

  function sample(state) {
    if (stopped || !state) return;
    // One Mores are granted to whoever is acting, so only count the player's.
    if (state.activePlayer === viewer) {
      longestOneMore = Math.max(longestOneMore, state.turnState?.oneMoresGranted ?? 0);
    }
    if (state.phase === 'playing') {
      lowestHpFraction = Math.min(lowestHpFraction, fieldHpFraction(state, viewer));
    }
  }

  const unsubscribe = controller.subscribe(sample);
  sample(controller.getState());

  const wrapped = {
    ...controller,
    // Bound explicitly: the spread above copies the closures off the controller
    // object, and anything added to it later would be missed, so the methods the
    // board actually calls are named here.
    getState: () => controller.getState(),
    isBotTurn: () => controller.isBotTurn(),
    isBusy: () => controller.isBusy(),
    legalActions: (playerId) => controller.legalActions(playerId),
    subscribe: (listener) => controller.subscribe(listener),
    start: () => controller.start(),
    setSpeed: (next) => controller.setSpeed(next),
    destroy: () => controller.destroy(),

    dispatch(action) {
      const before = controller.getState();
      const next = controller.dispatch(action);
      if (!stopped && action?.player === viewer && isPhysAction(action)) {
        const dealt = (next.players[viewer]?.stats?.damageDealt ?? 0) - (before.players[viewer]?.stats?.damageDealt ?? 0);
        biggestPhysHit = Math.max(biggestPhysHit, dealt);
      }
      return next;
    },
  };

  return {
    controller: wrapped,

    /** Everything a trophy trigger can ask about this match. */
    summary(state = controller.getState()) {
      const stats = state.players[viewer]?.stats ?? {};
      return {
        oneMores: stats.oneMores ?? 0,
        fusions: stats.fusions ?? 0,
        gallows: stats.gallows ?? 0,
        technicals: stats.technicals ?? 0,
        weaknessHits: stats.weaknessHits ?? 0,
        personasLost: state.players[viewer]?.koCount ?? 0,
        longestOneMore,
        biggestPhysHit,
        lowestHpFraction,
      };
    },

    stop() {
      stopped = true;
      unsubscribe();
    },
  };
}
