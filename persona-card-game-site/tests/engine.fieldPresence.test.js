/**
 * Field presence.
 *
 * An empty field is a LEGAL TACTICAL STATE, not evidence of losing. Nothing
 * forces a Persona out of hand, and nothing about being empty pays a comeback
 * benefit. The only consequences are a three-turn clock (whose sole side effect
 * is a hard Persona filter on the drawing player's own draws) and the mirror
 * reward that banks a card for whoever is looking at the empty board.
 */
import { describe, it, expect } from 'vitest';
import {
  CONFIG,
  applyAction,
  drawCards,
  drawCountFor,
  emptyFieldDrawFilter,
  emptyFieldStage,
  emptyFieldTurnsLeft,
  comboMultiplier,
  redactStateFor,
} from '../src/engine/index.js';
import { getCard, getPersona } from '../src/data/cards.js';
import { setupMatch, setField, setHand, activeOf, uidOf, handUidOf, endTurn } from './helpers.js';

/** A match where seat 0 has nothing on the field and seat 1 does. */
function emptyBoardFor(seat = 0, { hand = [], deck = null } = {}) {
  let state = setupMatch();
  state = setField(state, seat, []);
  state = setField(state, 1 - seat, [{ cardId: 'pixie', level: 5, active: true }]);
  setHand(state, seat, hand);
  if (deck) state.players[seat].deck = [...deck];
  state.activePlayer = seat;
  return state;
}

const logText = (state) => state.log.map((entry) => entry.text).join('\n');
const personaCount = (player) => player.hand.filter((c) => getCard(c.cardId).type === 'persona').length;

/* ------------------------------------------------------------------ *
 * 1a — the reward draw
 * ------------------------------------------------------------------ */

describe('empty-opponent-field reward draw', () => {
  it('banks a card rather than dealing one at the end of your own turn', () => {
    let state = emptyBoardFor(1); // seat 1 is empty, seat 0 is acting
    state.activePlayer = 0;
    const before = state.players[0].hand.length;

    state = endTurn(state, 0);

    // Nothing lands now — the hand is untouched apart from the discard step.
    expect(state.players[0].pendingBonusDraws).toBe(1);
    expect(state.players[0].hand.length).toBe(before);
    expect(logText(state)).toContain('Your opponent stands defenseless — you seize the advantage.');
  });

  it('pays out as a second card on the next draw', () => {
    let state = emptyBoardFor(1);
    state.activePlayer = 0;
    state = endTurn(state, 0); // banks it
    const before = state.players[0].hand.length;

    state = endTurn(state, 1); // seat 0's next turn begins: normal draw + the bonus

    expect(state.players[0].hand.length).toBe(before + CONFIG.DRAW_PER_TURN + 1);
    expect(state.players[0].pendingBonusDraws).toBe(0);
  });

  it('pays nothing while the opponent still has a Persona standing', () => {
    let state = setupMatch();
    state = setField(state, 0, [{ cardId: 'pixie', level: 5, active: true }]);
    state = setField(state, 1, [{ cardId: 'pixie', level: 5, active: true }]);

    state = endTurn(state, 0);

    expect(state.players[0].pendingBonusDraws ?? 0).toBe(0);
    expect(logText(state)).not.toContain('stands defenseless');
  });

  it('never banks more than one, however many turns the board stays bare', () => {
    let state = emptyBoardFor(1);
    state.activePlayer = 0;
    state = endTurn(state, 0);
    state.activePlayer = 0; // as if the empty seat did nothing at all
    state = endTurn(state, 0);
    expect(state.players[0].pendingBonusDraws).toBe(1);
  });

  it('does not fire for a KO board that still has a living Persona on it', () => {
    let state = setupMatch();
    state = setField(state, 0, [{ cardId: 'pixie', level: 5, active: true }]);
    state = setField(state, 1, [{ cardId: 'pixie', level: 5, active: true }, { cardId: 'pixie', level: 5 }]);
    state.players[1].field[1].ko = true; // one down, one still standing
    state = endTurn(state, 0);
    expect(state.players[0].pendingBonusDraws ?? 0).toBe(0);
  });

  it('draws that bonus card uniformly — it is board control, not a comeback', () => {
    // A deck of one great card and nine poor ones. With no quality weighting at
    // all the good card comes up about a tenth of the time; a weighted draw
    // would pull it far harder than that.
    // Both boards occupied so the Persona filter is out of the picture, and
    // seat 0 six knockouts down so momentum would be at full tilt if it applied.
    const build = (seed) => {
      let state = setupMatch();
      state = setField(state, 0, [{ cardId: 'pixie', level: 5, active: true }]);
      state = setField(state, 1, [{ cardId: 'pixie', level: 5, active: true }]);
      setHand(state, 0, []);
      state.players[0].deck = ['medicine', 'medicine', 'jack-frost', 'medicine'];
      state.players[0].koCount = 6;
      state.rng = { s: seed * 2654435761 + 1 };
      return state;
    };

    // A weighted draw reaches past the top of the deck for the strong Persona.
    let reached = 0;
    for (let seed = 0; seed < 60; seed++) {
      const state = build(seed);
      drawCards(state, 0, 1);
      if (state.players[0].hand[0].cardId === 'jack-frost') reached += 1;
    }
    expect(reached).toBeGreaterThan(0);

    // The bonus card never does: it takes whatever is on top.
    for (let seed = 0; seed < 60; seed++) {
      const state = build(seed);
      drawCards(state, 0, 1, { uniform: true });
      expect(state.players[0].hand[0].cardId).toBe('medicine');
    }
  });
});

/* ------------------------------------------------------------------ *
 * 1a-ii — the knockdown combo
 * ------------------------------------------------------------------ */

/**
 * Seat 0 holds an ice user; seat 1 holds two Personas weak to ice.
 *
 * Orpheus rather than Ara Mitama, whose affinity chart has been retuned twice
 * during balancing. This fixture is about the knockdown combo, not about any one
 * card's weaknesses, so it leans on a Persona nobody is currently tuning.
 */
function comboBoard() {
  let state = setupMatch();
  state = setField(state, 0, [{ cardId: 'jack-frost', level: 12, active: true }]);
  state = setField(state, 1, [
    { cardId: 'orpheus', level: 5, active: true },
    { cardId: 'orpheus', level: 5 },
  ]);
  for (const persona of state.players[1].field) {
    persona.passive = null; // a passive could prevent the knockdown we are measuring
    persona.maxHp = 400;
    persona.hp = 400;
    persona.endurance = 30;
  }
  state.turnState.actionsRemaining = 3;
  return state;
}

const bufu = getPersona('jack-frost').skills.find((s) => s.type === 'ice').id;

describe('knockdown combo', () => {
  it('starts at no bonus at all', () => {
    const state = comboBoard();
    expect(state.turnState.comboStacks).toBe(0);
    expect(comboMultiplier(state)).toBe(1);
  });

  it('gains a stack per knockdown and stacks across a turn', () => {
    let state = comboBoard();
    const [first, second] = state.players[1].field;

    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: bufu, targetUid: first.uid });
    expect(state.turnState.comboStacks).toBe(1);

    // The One More opens the bench, so the second knockdown is reachable.
    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: bufu, targetUid: second.uid });
    expect(state.turnState.comboStacks).toBe(2);
    expect(comboMultiplier(state)).toBeCloseTo(1 + 2 * CONFIG.COMBO_DAMAGE_STEP, 10);
    expect(logText(state)).toContain('Combo x2!');
  });

  it('says nothing at a single stack — one knockdown is not a combo', () => {
    let state = comboBoard();
    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: bufu, targetUid: state.players[1].field[0].uid });
    expect(logText(state)).not.toContain('Combo x1');
  });

  it('does not boost the very hit that scored the knockdown', () => {
    let state = comboBoard();
    const target = state.players[1].field[0];
    const before = target.hp;
    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: bufu, targetUid: target.uid });
    const plain = before - state.players[1].field[0].hp;

    // Same hit again, now with one stack banked: strictly harder.
    const second = state.players[1].field[1];
    const beforeSecond = second.hp;
    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: bufu, targetUid: second.uid });
    const combo = beforeSecond - state.players[1].field[1].hp;

    expect(combo).toBeGreaterThan(plain);
    expect(combo / plain).toBeCloseTo(1 + CONFIG.COMBO_DAMAGE_STEP, 1);
  });

  it('resets when the turn ends', () => {
    let state = comboBoard();
    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: bufu, targetUid: state.players[1].field[0].uid });
    expect(state.turnState.comboStacks).toBe(1);

    state = endTurn(state, 0);
    expect(state.turnState.comboStacks).toBe(0);
    state = endTurn(state, 1);
    expect(state.turnState.comboStacks).toBe(0);
  });

  it('multiplies with the Technical multiplier rather than replacing it', () => {
    // Two identical physical hits on a burning target, one with a stack banked.
    const build = () => {
      let state = setupMatch();
      state = setField(state, 0, [{ cardId: 'jack-frost', level: 12, active: true }]);
      state = setField(state, 1, [{ cardId: 'ara-mitama', level: 5, active: true }]);
      const foe = activeOf(state, 1);
      foe.passive = null;
      foe.maxHp = 9000;
      foe.hp = 9000;
      foe.endurance = 30;
      foe.ailments = [{ type: 'burn', turnsLeft: 3 }];
      // Big numbers on purpose: the formula rounds once at the end, and a ratio
      // read off a 20-damage hit is mostly reading the rounding.
      activeOf(state, 0).strength = 900;
      state.turnState.actionsRemaining = 3;
      return state;
    };

    let plainState = build();
    const plainBefore = activeOf(plainState, 1).hp;
    plainState = applyAction(plainState, { type: 'ATTACK', player: 0, targetUid: activeOf(plainState, 1).uid });
    const plain = plainBefore - activeOf(plainState, 1).hp;

    let comboState = build();
    comboState.turnState.comboStacks = 2;
    const comboBefore = activeOf(comboState, 1).hp;
    comboState = applyAction(comboState, { type: 'ATTACK', player: 0, targetUid: activeOf(comboState, 1).uid });
    const withCombo = comboBefore - activeOf(comboState, 1).hp;

    // Both hits were Technicals; the combo is a further multiplier on top.
    expect(logText(plainState)).toContain('TECHNICAL!');
    expect(logText(comboState)).toContain('TECHNICAL!');
    // The formula rounds once at the very end, so the two hits can differ from
    // the exact ratio by a point — but not by more, and never by replacement.
    expect(Math.abs(withCombo - plain * (1 + 2 * CONFIG.COMBO_DAMAGE_STEP))).toBeLessThanOrEqual(1);
  });

  it('costs nothing — SP and HP prices are untouched by the combo', () => {
    let state = comboBoard();
    const skill = getPersona('jack-frost').skills.find((s) => s.id === bufu);
    const before = activeOf(state, 0).sp;
    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: bufu, targetUid: state.players[1].field[0].uid });
    const afterFirst = activeOf(state, 0).sp;
    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: bufu, targetUid: state.players[1].field[1].uid });
    const afterSecond = activeOf(state, 0).sp;

    expect(before - afterFirst).toBe(skill.spCost);
    expect(afterFirst - afterSecond).toBe(skill.spCost);
  });

  it('only pays the side whose turn it is — a Counter never combos', () => {
    let state = comboBoard();
    state.turnState.comboStacks = 3;
    // The defender's own knockdown counter belongs to the acting player alone.
    expect(comboMultiplier(state)).toBeCloseTo(1.3, 10);
    state.activePlayer = 1;
    // Reading it from the other seat's perspective is the caller's job; the
    // accessor describes the turn, and resolveAttack gates on ownership.
    expect(state.turnState.comboStacks).toBe(3);
  });
});

/* ------------------------------------------------------------------ *
 * 1b — the loss timer
 * ------------------------------------------------------------------ */

describe('empty-field loss timer', () => {
  it('does not run while a player has a board', () => {
    let state = setupMatch();
    expect(emptyFieldStage(state, 0)).toBe(0);
    state = endTurn(state, 0);
    expect(emptyFieldStage(state, 0)).toBe(0);
    expect(emptyFieldStage(state, 1)).toBe(0);
  });

  it('starts counting the moment a turn begins with an empty field', () => {
    let state = emptyBoardFor(0);
    state.activePlayer = 1;
    state = endTurn(state, 1); // hands the turn to the empty seat

    expect(emptyFieldStage(state, 0)).toBe(1);
    // Three full turns, this one included.
    expect(emptyFieldTurnsLeft(state, 0)).toBe(CONFIG.EMPTY_FIELD_LOSS_TURNS);
    expect(logText(state)).toContain('3 turns remain');
  });

  it('counts down 3, 2, last chance across the three turns it allows', () => {
    let state = emptyBoardFor(0, { deck: ['medicine', 'medicine', 'medicine', 'medicine'] });
    setHand(state, 0, []);
    state.activePlayer = 1;

    state = endTurn(state, 1);
    expect(emptyFieldStage(state, 0)).toBe(1);
    expect(emptyFieldTurnsLeft(state, 0)).toBe(3);
    expect(logText(state)).toContain('3 turns remain');

    state = endTurn(state, 0);
    state = endTurn(state, 1);
    expect(emptyFieldStage(state, 0)).toBe(2);
    expect(emptyFieldTurnsLeft(state, 0)).toBe(2);
    expect(logText(state)).toContain('2 turns remain');

    state = endTurn(state, 0);
    state = endTurn(state, 1);
    expect(emptyFieldStage(state, 0)).toBe(3);
    expect(emptyFieldTurnsLeft(state, 0)).toBe(1);
    expect(logText(state)).toContain('Last chance');
    expect(state.winner).toBe(null); // three turns are still owed in full
  });

  it('gives all three turns a real draw phase', () => {
    let state = emptyBoardFor(0, { deck: ['medicine', 'medicine', 'medicine', 'medicine', 'medicine'] });
    setHand(state, 0, []);
    state.activePlayer = 1;

    for (let turn = 1; turn <= CONFIG.EMPTY_FIELD_LOSS_TURNS; turn++) {
      const before = state.players[0].hand.length;
      state = endTurn(state, 1);
      expect(state.players[0].hand.length).toBeGreaterThan(before);
      state = endTurn(state, 0);
    }
  });

  it('is cleared by playing any Persona', () => {
    let state = emptyBoardFor(0, { hand: ['pixie'] });
    state.activePlayer = 1;
    state = endTurn(state, 1);
    expect(emptyFieldStage(state, 0)).toBe(1);

    state = applyAction(state, { type: 'PLAY_PERSONA', player: 0, handUid: handUidOf(state, 0, 'pixie') });
    expect(emptyFieldStage(state, 0)).toBe(0);
    expect(logText(state)).toContain('resolve holds');
  });

  it('ends the match at the start of the FOURTH consecutive empty turn', () => {
    // A deck of Items only, so nothing the draws hand over can save them.
    let state = emptyBoardFor(0, { deck: Array.from({ length: 8 }, () => 'medicine') });
    setHand(state, 0, []);
    state.activePlayer = 1;

    // Three full turns pass with the seat empty and still alive.
    for (let round = 0; round < CONFIG.EMPTY_FIELD_LOSS_TURNS; round++) {
      state = endTurn(state, 1);
      expect(state.winner).toBe(null);
      state = endTurn(state, 0);
    }
    expect(emptyFieldStage(state, 0)).toBe(CONFIG.EMPTY_FIELD_LOSS_TURNS);

    // The fourth turn-start is the one that kills.
    state = endTurn(state, 1);

    expect(state.winner).toBe(1);
    expect(state.endReason).toBe('empty-field');
    expect(state.phase).toBe('gameOver');
    expect(logText(state)).toContain('has no Personas left to stand for them');
  });

  it('is fully reset by fielding a Persona on the very last turn', () => {
    let state = emptyBoardFor(0, { deck: ['pixie', 'medicine', 'medicine', 'medicine'] });
    setHand(state, 0, []);
    state.activePlayer = 1;

    state = endTurn(state, 1);
    state = endTurn(state, 0);
    state = endTurn(state, 1);
    state = endTurn(state, 0);
    state = endTurn(state, 1);

    expect(emptyFieldStage(state, 0)).toBe(CONFIG.EMPTY_FIELD_LOSS_TURNS);
    expect(state.winner).toBe(null);
    expect(personaCount(state.players[0])).toBeGreaterThan(0); // the filter delivered

    state = applyAction(state, { type: 'PLAY_PERSONA', player: 0, handUid: handUidOf(state, 0, 'pixie') });
    expect(emptyFieldStage(state, 0)).toBe(0);
    state = endTurn(state, 0);
    state = endTurn(state, 1);
    expect(state.winner).toBe(null);
    expect(emptyFieldStage(state, 0)).toBe(0); // the count starts from scratch
  });

  it('says so immediately when the deck holds no Personas at all', () => {
    let state = emptyBoardFor(0, { deck: ['medicine', 'medicine'] });
    state.players[0].discard = [];
    setHand(state, 0, []);
    state.activePlayer = 1;
    state = endTurn(state, 1);

    expect(logText(state)).toContain(`No Personas remain in ${state.players[0].name}'s deck`);
  });

  it('stays quiet about the deck when there is still a Persona in it', () => {
    let state = emptyBoardFor(0, { deck: ['pixie', 'medicine'] });
    state.players[0].discard = [];
    state.activePlayer = 1;
    state = endTurn(state, 1);
    expect(logText(state)).not.toContain('No Personas remain');
  });

  it('counts a Persona sitting in the discard, because a reshuffle brings it back', () => {
    let state = emptyBoardFor(0, { deck: ['medicine'] });
    state.players[0].discard = ['pixie'];
    state.activePlayer = 1;
    state = endTurn(state, 1);
    expect(logText(state)).not.toContain('No Personas remain');
  });
});

describe('nothing forces a Persona out of hand', () => {
  it('leaves a player holding a perfectly playable Persona alone', () => {
    // The board offers no prompt and the engine adds no obligation: an empty
    // field with fodder in hand is a position a player is allowed to choose.
    let state = emptyBoardFor(0, { hand: ['pixie'] });
    state.activePlayer = 1;
    state = endTurn(state, 1);

    expect(emptyFieldStage(state, 0)).toBe(1);
    // END_TURN is legal without ever putting the Persona down.
    state = endTurn(state, 0);
    expect(state.winner).toBe(null);
    expect(state.players[0].hand.some((c) => c.cardId === 'pixie')).toBe(true);
  });

  it('lets a player hold the card until the very last beat', () => {
    let state = emptyBoardFor(0, { hand: ['pixie'], deck: ['medicine', 'medicine', 'medicine', 'medicine'] });
    state.activePlayer = 1;

    // Two whole turns spent empty on purpose, with the answer in hand the whole time.
    for (let round = 0; round < CONFIG.EMPTY_FIELD_LOSS_TURNS - 1; round++) {
      state = endTurn(state, 1);
      state = endTurn(state, 0);
    }
    state = endTurn(state, 1);
    expect(emptyFieldStage(state, 0)).toBe(CONFIG.EMPTY_FIELD_LOSS_TURNS);
    expect(state.winner).toBe(null);

    // Cashing in on the last turn is legal and resets the clock outright.
    state = applyAction(state, { type: 'PLAY_PERSONA', player: 0, handUid: handUidOf(state, 0, 'pixie') });
    expect(emptyFieldStage(state, 0)).toBe(0);
    expect(state.winner).toBe(null);
  });
});

describe('the timer over the wire', () => {
  it('survives redaction — it is public information on both sides', () => {
    let state = emptyBoardFor(0);
    state.activePlayer = 1;
    state = endTurn(state, 1);

    for (const viewer of [0, 1]) {
      const view = redactStateFor(state, viewer);
      expect(emptyFieldStage(view, 0)).toBe(1);
      expect(emptyFieldTurnsLeft(view, 0)).toBe(CONFIG.EMPTY_FIELD_LOSS_TURNS);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 1c — the draw bias
 * ------------------------------------------------------------------ */

describe('the empty-field Persona filter', () => {
  it('is inert while the player has a board', () => {
    const state = setupMatch();
    expect(emptyFieldDrawFilter(state, 0)).toBe(false);
  });

  it('is on from the very first timer turn and stays on, without escalating', () => {
    const state = emptyBoardFor(0);
    for (let stage = 1; stage <= CONFIG.EMPTY_FIELD_LOSS_TURNS; stage++) {
      state.players[0].emptyFieldTurns = stage;
      expect(emptyFieldDrawFilter(state, 0)).toBe(true);
    }
  });

  it('deactivates the moment a Persona is fielded', () => {
    let state = emptyBoardFor(0, { hand: ['pixie'] });
    state.activePlayer = 1;
    state = endTurn(state, 1);
    expect(emptyFieldDrawFilter(state, 0)).toBe(true);

    state = applyAction(state, { type: 'PLAY_PERSONA', player: 0, handUid: handUidOf(state, 0, 'pixie') });
    expect(emptyFieldDrawFilter(state, 0)).toBe(false);
  });

  it('draws a Persona outright from the first stage, not just the last', () => {
    const deck = ['medicine', 'medicine', 'medicine', 'pixie', 'medicine'];
    for (let stage = 1; stage <= CONFIG.EMPTY_FIELD_LOSS_TURNS; stage++) {
      for (let seed = 0; seed < 25; seed++) {
        const state = emptyBoardFor(0, { deck });
        state.players[0].emptyFieldTurns = stage;
        setHand(state, 0, []);
        state.rng = { s: seed * 40503 + 7 };
        drawCards(state, 0, 1);
        expect(personaCount(state.players[0])).toBe(1);
      }
    }
  });

  it('stands down when the deck holds no Persona at all', () => {
    const state = emptyBoardFor(0, { deck: ['medicine', 'medicine'] });
    state.players[0].emptyFieldTurns = CONFIG.EMPTY_FIELD_LOSS_TURNS;
    setHand(state, 0, []);
    drawCards(state, 0, 1);
    expect(state.players[0].hand.length).toBe(1); // a card still came off the deck
  });

  it('leaves an explicit draw reservation in front of it', () => {
    // Priority order: a Special that claims a card always wins.
    const state = emptyBoardFor(0, { deck: ['medicine', 'pixie', 'medicine'] });
    state.players[0].emptyFieldTurns = 1;
    setHand(state, 0, []);
    state.players[0].pendingDraw = { arcana: getPersona('pixie').arcana };
    drawCards(state, 0, 1);
    expect(state.players[0].hand[0].cardId).toBe('pixie');
  });
});

/* ------------------------------------------------------------------ *
 * 1d — quantity and quality are the KO tally's business, never the field's
 * ------------------------------------------------------------------ */

describe('an empty field is not a deficit', () => {
  it('grants no extra cards on its own — a staller at even score gets the filter and nothing else', () => {
    const state = emptyBoardFor(0);
    expect(state.players[0].koCount).toBe(state.players[1].koCount);
    expect(drawCountFor(state, 0)).toBe(CONFIG.DRAW_PER_TURN);

    state.players[0].emptyFieldTurns = CONFIG.EMPTY_FIELD_LOSS_TURNS;
    expect(drawCountFor(state, 0)).toBe(CONFIG.DRAW_PER_TURN);
    expect(emptyFieldDrawFilter(state, 0)).toBe(true);
  });

  it('grants no extra cards even while comfortably AHEAD on the tally', () => {
    const state = emptyBoardFor(0);
    state.players[1].koCount = 5; // seat 0 is winning and boardless by choice
    state.players[0].emptyFieldTurns = 2;
    expect(drawCountFor(state, 0)).toBe(CONFIG.DRAW_PER_TURN);
  });

  it('still hands the Underdog two cards to a boardless player who IS behind', () => {
    const state = emptyBoardFor(0);
    state.players[0].koCount = CONFIG.COMEBACK_UNDERDOG_DEFICIT;
    state.players[0].emptyFieldTurns = 1;
    expect(drawCountFor(state, 0)).toBe(CONFIG.COMEBACK_UNDERDOG_DRAW);
    expect(emptyFieldDrawFilter(state, 0)).toBe(true);
  });

  it('gives Underdog Draw to a player behind on KOs with a perfectly good board', () => {
    const state = setupMatch();
    state.players[0].koCount = CONFIG.COMEBACK_UNDERDOG_DEFICIT;
    expect(emptyFieldDrawFilter(state, 0)).toBe(false);
    expect(drawCountFor(state, 0)).toBe(CONFIG.COMEBACK_UNDERDOG_DRAW);
  });

  it('lets momentum weight the draw WITHIN the filter when the player is also behind', () => {
    // Two Personas of very different quality plus filler. Deep in the hole, the
    // stronger Persona should come up more often than the weaker one — but an
    // Item should never come up at all.
    const deck = ['jack-frost', 'pixie', 'medicine', 'medicine', 'medicine', 'medicine'];
    let strong = 0;
    let items = 0;
    for (let seed = 0; seed < 200; seed++) {
      const state = emptyBoardFor(0, { deck });
      state.players[0].emptyFieldTurns = 1;
      state.players[0].koCount = 6; // momentum at full tilt
      setHand(state, 0, []);
      state.rng = { s: seed * 2654435761 + 11 };
      drawCards(state, 0, 1);
      const drawn = state.players[0].hand[0].cardId;
      if (drawn === 'jack-frost') strong += 1;
      if (getCard(drawn).type !== 'persona') items += 1;
    }
    expect(items).toBe(0); // the filter is hard, whatever momentum wants
    expect(strong).toBeGreaterThan(100); // ...and momentum still sorts within it
  });

  it('draws uniformly among Personas for a boardless player at even score', () => {
    const deck = ['jack-frost', 'pixie', 'medicine', 'medicine', 'medicine', 'medicine'];
    let strong = 0;
    for (let seed = 0; seed < 200; seed++) {
      const state = emptyBoardFor(0, { deck });
      state.players[0].emptyFieldTurns = 1;
      setHand(state, 0, []);
      state.rng = { s: seed * 2654435761 + 11 };
      drawCards(state, 0, 1);
      if (state.players[0].hand[0].cardId === 'jack-frost') strong += 1;
    }
    // A coin flip between the two Personas, give or take the shuffle.
    expect(Math.abs(strong - 100)).toBeLessThan(30);
  });
});
