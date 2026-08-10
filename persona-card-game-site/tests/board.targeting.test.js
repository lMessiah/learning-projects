/**
 * @vitest-environment jsdom
 *
 * Targeting prompts, and the two ways they used to go wrong.
 *
 * 1. A card whose legal actions are keyed on something that is NOT a Persona
 *    uid — Lesser Theurgy picks an AILMENT, Shuffle Time picks a CARD — was
 *    routed into the board-targeting overlay anyway. The overlay highlights
 *    tiles by matching `action[key]` against a uid, so nothing lit up and the
 *    prompt could not be answered. Lesser Theurgy only appeared to work when
 *    the enemy already had one ailment, because then there was a single legal
 *    choice and the auto-skip fired before the overlay ever opened.
 *
 * 2. Cancelling. Nothing is dispatched until a choice is made, so a cancel must
 *    always be a complete refund — same state object, same legal actions, no
 *    Special spent. That is asserted here for every prompt in the game.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMatch, applyAction, applyAilment, getLegalActions } from '../src/engine/index.js';
import { createController } from '../src/ui/game/controller.js';
import { mountBoard } from '../src/ui/game/board.js';
import { getCard } from '../src/data/cards.js';
import { setField, setHand, activeOf } from './helpers.js';

let root;
let unmount;
let controller;

function boot(prepare) {
  let state = createMatch({
    seed: 31,
    players: [
      { name: 'You', deckId: 'p4', controller: 'human' },
      { name: 'Them', deckId: 'p5', controller: 'human' },
    ],
  });
  state = applyAction(state, { type: 'CHOOSE_STARTER', player: 0, cardId: state.starterOptions[0][0] });
  state = applyAction(state, { type: 'CHOOSE_STARTER', player: 1, cardId: state.starterOptions[1][0] });
  setField(state, 0, [{ cardId: 'pixie', level: 14, active: true }]);
  setField(state, 1, [{ cardId: 'angel', level: 14, active: true }]);
  state.players[0].hand = [];
  prepare?.(state);

  controller = createController({ state, botPlayer: null });
  unmount = mountBoard(root, { controller, viewer: 0, title: 'Test', onExit() {} });
  return controller;
}

const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const $doc = (sel) => document.querySelector(sel);
const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const byText = (sel, re) => $$(sel).find((n) => re.test(n.textContent));

/** Play a card from hand the way a player does: click the tile, then Play. */
function playFromHand(cardId) {
  const tile = $(`.hand-tile[data-card-id="${cardId}"]`);
  expect(tile, `${cardId} is not in hand`).toBeTruthy();
  click(tile);
  const overlay = $doc('.card-detail-overlay');
  const play = [...overlay.querySelectorAll('button')].find((b) => /^Play/.test(b.textContent));
  expect(play, `${cardId} offers no Play button`).toBeTruthy();
  click(play);
}

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  unmount?.();
  controller?.destroy();
  document.body.innerHTML = '';
  unmount = null;
  controller = null;
  root = null;
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ *
 * Lesser Theurgy
 * ------------------------------------------------------------------ */

describe('Lesser Theurgy', () => {
  const withCard = (state) => setHand(state, 0, ['lesser-theurgy']);

  it('is playable against a perfectly healthy enemy — the bug', () => {
    const controller = boot(withCard);
    const target = activeOf(controller.getState(), 1);
    expect(target.ailments).toHaveLength(0);

    // The engine has always offered both; it was the UI that could not ask.
    const legal = controller.legalActions(0).filter((a) => a.cardId === 'lesser-theurgy');
    expect(legal).toHaveLength(2);
    expect(legal.map((a) => a.ailment).sort()).toEqual(['burn', 'shock']);
  });

  it('asks which ailment, instead of a board prompt with nothing to click', () => {
    boot(withCard);
    playFromHand('lesser-theurgy');

    // The old failure: a targeting prompt open over a board with no valid target.
    expect($('.prompt')).toBe(null);
    expect($$('.tile--targetable')).toHaveLength(0);

    const choices = $$('.option-choice');
    expect(choices).toHaveLength(2);
    expect(choices.map((c) => c.textContent)).toEqual([
      expect.stringContaining('Burn'),
      expect.stringContaining('Shock'),
    ]);
  });

  it('applies the ailment you picked to the enemy active', () => {
    const controller = boot(withCard);
    playFromHand('lesser-theurgy');
    click(byText('.option-choice', /Shock/));

    const target = activeOf(controller.getState(), 1);
    expect(target.ailments.map((a) => a.type)).toContain('shock');
    expect(controller.getState().turnState.specialsPlayed).toBe(1);
  });

  it('offers only the ailment they do not already have, and just does it', () => {
    // This is the case that always worked: one legal choice, auto-skipped.
    const controller = boot((state) => {
      withCard(state);
      applyAilment(state, activeOf(state, 1), 'burn');
    });

    playFromHand('lesser-theurgy');
    const target = activeOf(controller.getState(), 1);
    expect(target.ailments.map((a) => a.type).sort()).toEqual(['burn', 'shock']);
  });

  it('says on the card exactly what it does', () => {
    const text = getCard('lesser-theurgy').description;
    expect(text).toMatch(/Choose Burn or Shock/);
    expect(text).toMatch(/enemy active/i);
    expect(text).toMatch(/always lands/);
    // The rule the implementation actually enforces, printed on the card.
    expect(text).toMatch(/does not already have/);
  });
});

/* ------------------------------------------------------------------ *
 * The same shape, elsewhere
 * ------------------------------------------------------------------ */

describe('every other card that picks something that is not a Persona', () => {
  it('gives Shuffle Time a list rather than a dead board prompt', () => {
    boot((state) => {
      setHand(state, 0, ['shuffle-time']);
      state.players[0].deck = ['pixie', 'jack-frost', 'angel', 'silky'];
    });

    playFromHand('shuffle-time');
    expect($('.prompt')).toBe(null);
    expect($$('.tile--targetable')).toHaveLength(0);
    expect($$('.option-choice')).toHaveLength(3); // look: 3
  });

  it('gives Twist of Fate an element list, and never offers a resisted one', () => {
    const controller = boot((state) => {
      setHand(state, 0, ['twist-of-fate']);
      const target = activeOf(state, 1);
      target.weaknesses = ['ice'];
      target.resists = ['fire', 'elec'];
      target.revealedTypes = [];
    });

    playFromHand('twist-of-fate');
    expect($('.prompt')).toBe(null);

    const labels = $$('.option-choice').map((n) => n.textContent);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.some((t) => /Fire/.test(t)), 'offered a resisted element').toBe(false);
    expect(labels.some((t) => /Elec/.test(t)), 'offered a resisted element').toBe(false);
    expect(labels.some((t) => /Ice/.test(t)), 'offered an existing weakness').toBe(false);
    expect(labels.some((t) => /Dark/.test(t))).toBe(true);

    // The prompt names what the defender is about to give up.
    expect($('.gallows__heading').textContent).toMatch(/give up/i);

    click(byText('.option-choice', /Dark/));
    const target = activeOf(controller.getState(), 1);
    expect(target.weaknesses).toEqual(['dark']);
    expect(target.revealedTypes).toContain('dark');
    expect(target.resists).toEqual(['fire', 'elec']); // the resist is untouched
  });

  it("keeps Fortune's Draw on its own Arcana list", () => {
    boot((state) => {
      setHand(state, 0, ['fortunes-draw']);
      state.players[0].deck = ['pixie', 'jack-frost', 'angel'];
    });

    playFromHand('fortunes-draw');
    expect($('.prompt')).toBe(null);
    expect($$('.arcana-choice').length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * Cancel safety
 * ------------------------------------------------------------------ */

describe('cancelling any prompt costs nothing', () => {
  /**
   * Open a prompt, cancel it, and prove the turn is exactly as it was. The
   * engine state is immutable per action, so an untouched turn is literally the
   * same object — the strongest possible statement of "nothing happened".
   */
  const refunds = (cardId, open, cancel) => {
    const controller = boot((state) => setHand(state, 0, [cardId]));
    const before = controller.getState();
    const legalBefore = getLegalActions(before, 0).length;

    open(cardId);
    cancel();

    const after = controller.getState();
    expect(after, `${cardId} changed the state`).toBe(before);
    expect(getLegalActions(after, 0)).toHaveLength(legalBefore);
    expect(after.turnState.specialsPlayed).toBe(0);
    expect(after.turnState.itemsPlayed).toBe(0);
    expect(after.turnState.actionsRemaining).toBe(1);
    expect(after.players[0].hand.some((e) => e.cardId === cardId)).toBe(true);
    // ...and no prompt is left hanging over the board either.
    expect($('.prompt')).toBe(null);
    expect($('.modal-overlay')).toBe(null);
  };

  it('refunds a list prompt closed with its Cancel button', () => {
    refunds('lesser-theurgy', playFromHand, () => click(byText('.modal .btn', /^Cancel$/)));
  });

  it('refunds a list prompt closed with the ✕', () => {
    refunds('lesser-theurgy', playFromHand, () => click($('.modal__head .btn')));
  });

  it('refunds a list prompt closed by clicking outside it', () => {
    refunds('lesser-theurgy', playFromHand, () => {
      const overlay = $('.modal-overlay');
      overlay.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
  });

  it('refunds a board-targeting prompt', () => {
    // A damage Special with more than one legal target opens the real overlay.
    const controller = boot((state) => {
      setField(state, 1, [
        { cardId: 'angel', level: 14, active: true },
        { cardId: 'silky', level: 14 },
      ]);
      setField(state, 0, [
        { cardId: 'pixie', level: 14, active: true },
        { cardId: 'jack-frost', level: 14 },
      ]);
      setHand(state, 0, ['sp-transfer']);
      // Both are short, so the SP could go either way and the panel has to ask
      // which Persona it comes FROM before it asks where it goes.
      for (const persona of state.players[0].field) persona.sp = 5;
    });
    const before = controller.getState();

    playFromHand('sp-transfer');
    expect($('.prompt'), 'no board prompt opened').toBeTruthy();

    click(byText('.prompt .btn', /Cancel/));
    expect(controller.getState()).toBe(before);
    expect($('.prompt')).toBe(null);
    expect(controller.getState().players[0].hand.some((e) => e.cardId === 'sp-transfer')).toBe(true);
  });

  it('gives every board prompt a Cancel, whatever opened it', () => {
    boot((state) => {
      setField(state, 1, [
        { cardId: 'angel', level: 14, active: true },
        { cardId: 'silky', level: 14 },
      ]);
      state.turnState.canTargetBench = true;
    });

    // A skill with two legal targets.
    const skill = byText('.skill-btn', /Attack/);
    click(skill);
    expect($('.prompt')).toBeTruthy();
    expect(byText('.prompt .btn', /Cancel/), 'a prompt with no way out').toBeTruthy();
  });
});
