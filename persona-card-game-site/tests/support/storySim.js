/**
 * Playing story battles headlessly, to measure whether a lesson is necessary.
 *
 * The human seat is driven by the bot AI, which gives three useful proxies:
 *
 *   easy    a beginner — plays at random, never aims at a weakness
 *   medium  a competent player — exploits weaknesses, heals, hits hard
 *   brutal  the skill ceiling — knows every affinity from turn one
 *
 * The interesting parameter is `ban`. Removing a class of action from the
 * player's legal set and replaying the same fight is how "you cannot win
 * without this" stops being a design intention and becomes a measurement.
 */
import { applyAction, createRng, getLegalActions } from '../../src/engine/index.js';
import { chooseBotAction } from '../../src/engine/bot.js';
import { SKILLS } from '../../src/data/cards.js';
import { buildStoryBattle, resolvePlayerDeck } from '../../src/ui/story/battleSetup.js';

const HUMAN = 0;
const BOT = 1;
/** A match that has not resolved by here is a stalemate, not a win. */
const MAX_ACTIONS = 4000;

export const BAN_FUSE = (action) => action.type === 'FUSE';
export const BAN_SWAP = (action) => action.type === 'CHANGE_ACTIVE';

/** Ban every attack of one damage type, including the basic attack if Phys. */
export const banType = (type) => (action) => {
  if (action.type === 'ATTACK') return type === 'phys';
  if (action.type !== 'USE_SKILL') return false;
  return SKILLS[action.skillId]?.type === type;
};

export function play(battle, skill, driverSeed, ban = () => false) {
  const player = resolvePlayerDeck(battle, { deckId: 'p3', archetype: 'tactical' });
  let state = buildStoryBattle(battle, player, 'You');
  let humanRng = createRng(driverSeed);
  let botRng = createRng(battle.seed + 977);
  let fusions = 0;
  let guard = 0;

  while (state.winner === null && guard++ < MAX_ACTIONS) {
    if (state.activePlayer === BOT) {
      const [action, next] = chooseBotAction(state, BOT, battle.difficulty, botRng, battle.playstyle);
      botRng = next;
      if (!action) break;
      state = applyAction(state, action);
      continue;
    }

    // The ban is applied to the legal set first, so a banned pick falls back to
    // the best remaining move rather than to passing the turn.
    const legal = getLegalActions(state, HUMAN).filter((a) => !ban(a, state));
    if (!legal.length) break;
    const [chosen, next] = chooseBotAction(state, HUMAN, skill, humanRng);
    humanRng = next;
    const action = chosen && !ban(chosen, state) ? chosen : legal.find((a) => a.type === 'END_TURN') ?? legal[0];
    if (action.type === 'FUSE') fusions++;
    state = applyAction(state, action);
  }

  return { won: state.winner === HUMAN, turns: state.turn, fusions };
}

/** Play one configuration `n` times and summarise it. */
export function arm(battle, skill, n = 12, ban = () => false) {
  const runs = [];
  for (let s = 1; s <= n; s++) runs.push(play(battle, skill, s * 7 + 1, ban));
  const turns = runs.map((r) => r.turns).sort((a, b) => a - b);
  return {
    win: Math.round((runs.filter((r) => r.won).length / n) * 100),
    turns: turns[Math.floor(turns.length / 2)],
    fusions: runs.reduce((a, r) => a + r.fusions, 0),
  };
}
