/**
 * The strategic Special cards.
 *
 * Every one of these has to create a decision rather than a number: what to
 * name, who to pull back, what to trade away. The tests below check the rule
 * each card states, and that the card text matches it.
 */
import { describe, it, expect } from 'vitest';
import { applyAction, getLegalActions, redactStateFor, visibleAffinities, drawCards } from '../src/engine/index.js';
import { SPECIALS, getCard } from '../src/data/cards.js';
import { setupMatch, setField, setHand, activeOf, handUidOf, endTurn } from './helpers.js';

const play = (state, cardId, extra = {}) =>
  applyAction(state, { type: 'PLAY_SPECIAL', player: 0, handUid: handUidOf(state, 0, cardId), ...extra });

const special = (id) => SPECIALS.find((s) => s.id === id);

function duel({ own = ['orpheus'], foe = ['jack-frost'] } = {}) {
  const state = setupMatch();
  setField(state, 0, own.map((cardId, i) => ({ cardId, active: i === 0, hp: 400, maxHp: 400 })));
  setField(state, 1, foe.map((cardId, i) => ({ cardId, active: i === 0, hp: 400, maxHp: 400 })));
  return state;
}

describe("Fortune's Draw", () => {
  it('offers one choice per Arcana still in your deck, and honours it', () => {
    let state = duel();
    state.players[0].deck = ['anzu', 'medicine', 'pixie', 'medicine', 'silky'];
    setHand(state, 0, ['fortunes-draw']);

    const options = getLegalActions(state, 0).filter((a) => a.cardId === 'fortunes-draw');
    expect(options.map((a) => a.arcana).sort()).toEqual(['Lovers', 'Priestess', 'Star']);

    state = play(state, 'fortunes-draw', { arcana: 'Priestess' });
    expect(state.players[0].pendingDraw).toEqual({ arcana: 'Priestess', best: false });

    drawCards(state, 0, 1);
    expect(state.players[0].hand.at(-1).cardId).toBe('silky'); // the Priestess, not the top card
    expect(state.players[0].pendingDraw).toBe(null); // and it is spent
  });

  it('refuses an Arcana that is not in the deck', () => {
    const state = duel();
    state.players[0].deck = ['medicine', 'pixie'];
    setHand(state, 0, ['fortunes-draw']);
    expect(() => play(state, 'fortunes-draw', { arcana: 'Death' })).toThrow(/no Death Persona left/);
  });

  it('is not offered when no Persona remains in the deck', () => {
    const state = duel();
    state.players[0].deck = ['medicine', 'soma'];
    setHand(state, 0, ['fortunes-draw']);
    expect(getLegalActions(state, 0).filter((a) => a.cardId === 'fortunes-draw')).toHaveLength(0);
  });

  it('survives a redacted view, where deck ORDER is hidden but contents are not', () => {
    const state = duel();
    state.players[0].deck = ['anzu', 'medicine', 'silky'];
    setHand(state, 0, ['fortunes-draw']);

    const view = redactStateFor(state, 0);
    expect(view.players[0].deck.every((c) => c === null)).toBe(true);
    expect(view.players[0].deckArcana.sort()).toEqual(['Priestess', 'Star']);
    expect(view.players[1].deckArcana).toBeUndefined();
    expect(getLegalActions(view, 0).filter((a) => a.cardId === 'fortunes-draw')).toHaveLength(2);
  });
});

describe('Growth Ritual', () => {
  it('levels the bench and leaves the active Persona alone', () => {
    let state = duel({ own: ['orpheus', 'pixie', 'silky'] });
    setHand(state, 0, ['growth-ritual']);
    const before = state.players[0].field.map((p) => p.level);

    state = play(state, 'growth-ritual');

    const after = state.players[0].field.map((p) => p.level);
    expect(after[0]).toBe(before[0]); // active is busy fighting
    expect(after[1]).toBe(before[1] + 1);
    expect(after[2]).toBe(before[2] + 1);
    expect(state.turnState.actionsRemaining).toBe(1); // costs no action
  });

  it('is not offered with an empty bench', () => {
    const state = duel();
    setHand(state, 0, ['growth-ritual']);
    expect(getLegalActions(state, 0).filter((a) => a.cardId === 'growth-ritual')).toHaveLength(0);
  });
});

describe('Marionette Strings', () => {
  it('drags the enemy active off and puts their best healthy bench Persona in', () => {
    let state = duel({ foe: ['jack-frost', 'pixie', 'anzu'] });
    const foe = state.players[1];
    foe.field[1].hp = 40; // hurt
    foe.field[2].hp = 400; // healthy
    const dragged = foe.activeUid;
    setHand(state, 0, ['marionette-strings']);

    state = play(state, 'marionette-strings');

    expect(state.players[1].activeUid).not.toBe(dragged);
    expect(state.players[1].activeUid).toBe(state.players[1].field[2].uid); // the healthy one
    expect(state.players[1].field.find((p) => p.uid === dragged).ko).toBe(false); // benched, not KO'd
  });

  it('never picks a knocked-down Persona to step up', () => {
    let state = duel({ foe: ['jack-frost', 'anzu', 'pixie'] });
    state.players[1].field[1].knockedDown = true;
    setHand(state, 0, ['marionette-strings']);

    state = play(state, 'marionette-strings');

    expect(state.players[1].activeUid).toBe(state.players[1].field[2].uid);
  });

  it('is not offered when the opponent has nowhere to switch to', () => {
    const state = duel();
    setHand(state, 0, ['marionette-strings']);
    expect(getLegalActions(state, 0).filter((a) => a.cardId === 'marionette-strings')).toHaveLength(0);
  });
});

describe('Third Eye', () => {
  it('reveals the enemy active\'s whole affinity chart', () => {
    let state = duel({ foe: ['pixie'] }); // weak dark, resists elec
    setHand(state, 0, ['third-eye']);
    expect(visibleAffinities(state, activeOf(state, 1), 0).weaknesses).toEqual([]);

    state = play(state, 'third-eye');

    const seen = visibleAffinities(state, activeOf(state, 1), 0);
    expect(seen.weaknesses).toEqual(['dark']);
    expect(seen.resists).toEqual(['elec']);
  });

  it('is not offered against a Persona that has already been read', () => {
    let state = duel({ foe: ['pixie'] });
    setHand(state, 0, ['third-eye']);
    state = play(state, 'third-eye');
    setHand(state, 0, ['third-eye']);
    expect(getLegalActions(state, 0).filter((a) => a.cardId === 'third-eye')).toHaveLength(0);
  });
});

describe('Full Analysis', () => {
  it('opens the opponent\'s hand to you, and only to you, for the turn', () => {
    let state = duel();
    setHand(state, 1, ['medicine', 'soma']);
    setHand(state, 0, ['full-analysis']);

    expect(redactStateFor(state, 0).players[1].hand.every((c) => c.cardId === null)).toBe(true);

    state = play(state, 'full-analysis');

    expect(state.turnState.peekHand).toBe(true);
    expect(redactStateFor(state, 0).players[1].hand.map((c) => c.cardId)).toEqual(['medicine', 'soma']);
    // The opponent gains nothing: your hand stays hidden from them.
    expect(redactStateFor(state, 1).players[0].hand.every((c) => c.cardId === null)).toBe(true);
  });

  it('closes again when the turn ends', () => {
    let state = duel();
    setHand(state, 1, ['medicine']);
    setHand(state, 0, ['full-analysis']);
    state = play(state, 'full-analysis');
    state = endTurn(state, 0);
    expect(state.turnState.peekHand).toBeFalsy();
  });
});

describe('Velvet Summons', () => {
  it('returns a knocked-out Persona to hand without undoing the knockout', () => {
    let state = duel({ own: ['orpheus', 'pixie'] });
    const fallen = state.players[0].field[1];
    fallen.ko = true;
    fallen.hp = 0;
    state.players[0].koCount = 3;
    setHand(state, 0, ['velvet-summons']);

    state = play(state, 'velvet-summons', { targetUid: fallen.uid });

    expect(state.players[0].field.some((p) => p.uid === fallen.uid)).toBe(false);
    expect(state.players[0].hand.some((c) => c.cardId === 'pixie')).toBe(true);
    expect(state.players[0].koCount).toBe(3); // the KO still counts against you
    expect(state.turnState.actionsRemaining).toBe(0); // it uses your action
  });

  it('is not offered with nothing to bring back', () => {
    const state = duel();
    setHand(state, 0, ['velvet-summons']);
    expect(getLegalActions(state, 0).filter((a) => a.cardId === 'velvet-summons')).toHaveLength(0);
  });
});

describe('Soul Inversion', () => {
  it('trades remaining HP for remaining SP', () => {
    let state = duel();
    const me = activeOf(state, 0);
    me.maxHp = 200;
    me.hp = 30;
    me.maxSp = 60;
    me.sp = 50;
    setHand(state, 0, ['soul-inversion']);

    state = play(state, 'soul-inversion');

    expect(activeOf(state, 0).hp).toBe(50);
    expect(activeOf(state, 0).sp).toBe(30);
  });

  it('clamps to the maximums and never kills its own user', () => {
    let state = duel();
    const me = activeOf(state, 0);
    me.maxHp = 40;
    me.hp = 40;
    me.maxSp = 10;
    me.sp = 0;
    setHand(state, 0, ['soul-inversion']);

    state = play(state, 'soul-inversion');

    expect(activeOf(state, 0).hp).toBe(1); // 0 SP would be lethal; floored at 1
    expect(activeOf(state, 0).sp).toBe(10); // 40 HP capped at maxSp
    expect(activeOf(state, 0).ko).toBe(false);
  });
});

describe('Wild Card', () => {
  it('copies the last skill the opponent used, free of cost', () => {
    let state = duel({ own: ['ippon-datara'], foe: ['jack-frost'] });
    // The opponent casts Bufu, so that is what is on the record.
    state = endTurn(state, 0);
    state = applyAction(state, { type: 'USE_SKILL', player: 1, skillId: 'bufu' });
    expect(state.players[1].lastSkillId).toBe('bufu');
    state = endTurn(state, 1);

    setHand(state, 0, ['wild-card']);
    const spBefore = activeOf(state, 0).sp;
    const foeHpBefore = activeOf(state, 1).hp;

    state = play(state, 'wild-card');

    expect(activeOf(state, 1).hp).toBeLessThan(foeHpBefore);
    expect(activeOf(state, 0).sp).toBe(spBefore); // borrowed, not paid for
    expect(state.log.some((l) => l.text.includes('borrows Bufu'))).toBe(true);
  });

  it('is not offered before the opponent has used a skill', () => {
    const state = duel();
    setHand(state, 0, ['wild-card']);
    expect(getLegalActions(state, 0).filter((a) => a.cardId === 'wild-card')).toHaveLength(0);
  });

  it('copies a support skill onto your own side', () => {
    let state = duel({ own: ['ippon-datara'], foe: ['ara-mitama'] }); // knows Tarukaja from level 1
    state = endTurn(state, 0);
    state = applyAction(state, { type: 'USE_SKILL', player: 1, skillId: 'tarukaja' });
    state = endTurn(state, 1);

    setHand(state, 0, ['wild-card']);
    state = play(state, 'wild-card');

    expect(activeOf(state, 0).buffs.some((b) => b.stat === 'atk' && b.direction === 'up')).toBe(true);
  });
});

describe('card text matches behaviour', () => {
  it('states the action cost of every Special truthfully', () => {
    for (const card of SPECIALS) {
      const saysUsesAction = /uses up your action/i.test(card.description);
      expect(saysUsesAction, `${card.name}: usesAction=${card.usesAction}`).toBe(Boolean(card.usesAction));
    }
  });

  it('names a real effect kind for every Special', () => {
    const known = new Set([
      'damage', 'grant', 'transferSp', 'dispel', 'charge',
      'guaranteedDraw', 'growth', 'forceSwitch', 'reveal', 'peekHand', 'recall', 'swapHpSp', 'mimic',
      'phantomStrike', 'shuffleTime', 'evolve', 'darkHour', 'ward',
      'fateFetch', 'providence', 'inflict', 'rewriteAffinities', 'twistFate',
    ]);
    for (const card of SPECIALS) expect(known.has(card.effect.kind), `${card.name}`).toBe(true);
  });

  it('spells out that Velvet Summons does not undo the KO', () => {
    expect(special('velvet-summons').description).toMatch(/does NOT reduce/i);
    expect(getCard('velvet-summons').effect.kind).toBe('recall');
  });
});
