/**
 * Building a tutorial board.
 *
 * A lesson has to land the same way every time — the same Personas, the same
 * cards in hand, the same weakness waiting to be hit — or the text describing
 * it is a lie. So a scenario is *authored*, not dealt.
 *
 * ── Why this writes to the state directly ─────────────────────────────────
 *
 * Everywhere else in the app, state changes only ever come out of
 * `applyAction`. This file is the exception, and deliberately so: there is no
 * legal sequence of moves that produces "turn 1, and the opponent happens to
 * have a level 9 Jack Frost on 40 HP". The alternative would be a set of
 * engine actions that exist only to let the tutorial cheat, which is a worse
 * thing to have in the rules than a fixture builder is to have in the UI.
 *
 * The constraints that keep it honest:
 *
 *   1. It runs ONCE, before the board is mounted and before any action is
 *      applied. From the first click onward the tutorial is an ordinary match.
 *   2. It builds on top of a real `createMatch` and real `CHOOSE_STARTER`
 *      actions, so the phase transition, the turn state, the decks and the
 *      opening draw are all the engine's work, not ours.
 *   3. It only ever writes `field`, `activeUid` and `hand` — the three things
 *      a fixture needs. It never touches turn budgets, RNG or the log.
 *
 * This is the same shape as `tests/helpers.js`, for the same reason.
 */
import { createMatch, applyAction, createPersonaInstance, levelUp } from '../../engine/index.js';

/**
 * @param spec.seed      fixed, so the decks behind the scripted board are
 *                       reproducible too
 * @param spec.players   [{ deckId, archetype, name, starter }]
 * @param spec.field     [[...ownSpecs], [...foeSpecs]] — each
 *                       { cardId, level?, hp?, sp?, active?, inheritedSkills? }
 * @param spec.hand      [[...ownCardIds], [...foeCardIds]]
 * @param spec.turn      the turn number to start on (fusion unlocks at 4)
 */
export function buildScenario(spec) {
  let state = createMatch({
    seed: spec.seed ?? 20260819,
    players: spec.players.map((p) => ({
      name: p.name,
      deckId: p.deckId,
      archetype: p.archetype ?? 'tactical',
      controller: p.controller ?? 'human',
      difficulty: p.difficulty,
    })),
  });

  // Choose starters through the engine so it does the phase transition, the
  // opening draw and the first turn's setup. The offer is narrowed to the one
  // card the lesson wants, which CHOOSE_STARTER then validates as normal.
  for (let i = 0; i < 2; i++) {
    const starter = spec.players[i].starter ?? state.starterOptions[i][0];
    state.starterOptions[i] = [starter];
    state = applyAction(state, { type: 'CHOOSE_STARTER', player: i, cardId: starter });
  }

  // From here the board is painted. Everything above was the engine's.
  for (let i = 0; i < 2; i++) {
    if (spec.field?.[i]) setField(state, i, spec.field[i]);
    if (spec.hand?.[i]) setHand(state, i, spec.hand[i]);
  }
  if (spec.turn != null) state.turn = spec.turn;

  return state;
}

/**
 * Paint a field, with Personas that are genuinely the level they claim.
 *
 * `createPersonaInstance`'s `level` option sets the NUMBER and nothing else —
 * stats stay printed. That is fine for a unit test asserting a formula, and
 * quietly wrong for a lesson: a "level 10" Ara Mitama carrying level-4
 * Endurance would make the wall the tutorial describes out of tissue paper, and
 * every damage figure the coach talks about would be off.
 *
 * So levels are applied through `levelUp`, the same path a knockout or a Gallows
 * meal uses. The Persona gets the stats and the skill unlocks those levels are
 * really worth. The log lines it emits are trimmed afterwards — this is board
 * construction, not something that happened in the match.
 */
function setField(state, playerId, specs) {
  const player = state.players[playerId];
  player.field = [];
  player.activeUid = null;
  const logMark = state.log.length;

  for (const spec of specs) {
    const persona = createPersonaInstance(state, spec.cardId, playerId, {
      inheritedSkills: spec.inheritedSkills,
    });
    const target = spec.level ?? persona.level;
    if (target > persona.level) levelUp(state, persona, target - persona.level);

    // HP/SP overrides come last, so a lesson can hand over a hurt Persona
    // without fighting the growth it just applied.
    if (spec.maxHp != null) persona.maxHp = spec.maxHp;
    if (spec.hp != null) persona.hp = spec.hp;
    else persona.hp = Math.min(persona.hp, persona.maxHp);
    if (spec.sp != null) persona.sp = spec.sp;

    player.field.push(persona);
    if (spec.active) player.activeUid = persona.uid;
  }

  state.log.length = logMark;
  if (!player.activeUid && player.field.length) player.activeUid = player.field[0].uid;
}

function setHand(state, playerId, cardIds) {
  state.players[playerId].hand = cardIds.map((cardId) => ({ uid: `t${state.nextUid++}`, cardId }));
}
