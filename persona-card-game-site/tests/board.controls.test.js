/**
 * @vitest-environment jsdom
 *
 * Every new mechanic has to be reachable with a mouse, not only through
 * `getLegalActions`. This drives the Gallows panel, the Showtime button and the
 * Providence picker the way a player would.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMatch, applyAction, CONFIG } from '../src/engine/index.js';
import { createController } from '../src/ui/game/controller.js';
import { mountBoard } from '../src/ui/game/board.js';
import { setField, setHand, activeOf, uidOf } from './helpers.js';

let root;
let unmount;
let controller;

function boot(prepare) {
  let state = createMatch({
    seed: 24,
    players: [
      { name: 'You', deckId: 'p5', controller: 'human' },
      { name: 'Them', deckId: 'p4', controller: 'human' },
    ],
  });
  state = applyAction(state, { type: 'CHOOSE_STARTER', player: 0, cardId: state.starterOptions[0][0] });
  state = applyAction(state, { type: 'CHOOSE_STARTER', player: 1, cardId: state.starterOptions[1][0] });
  prepare?.(state);

  controller = createController({ state, botPlayer: null });
  unmount = mountBoard(root, { controller, viewer: 0, title: 'Test', onExit() {} });
  return controller;
}

const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const byText = (sel, re) => $$(sel).find((n) => re.test(n.textContent));
/** The Gallows panel has two rows of buttons: eaters, then meals. */
const gallowsRow = (index) => [...$$('.gallows__row')[index].querySelectorAll('.btn')];
const inRow = (index, re) => gallowsRow(index).find((n) => re.test(n.textContent));

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  unmount?.();
  controller?.destroy();
  root?.remove();
  unmount = null;
  controller = null;
  root = null;
  vi.useRealTimers();
});

describe('the Gallows panel', () => {
  const prepare = (state) => {
    setField(state, 0, [
      { cardId: 'silky', level: 20, active: true },
      { cardId: 'nekomata', level: 18 },
    ]);
    setField(state, 1, [{ cardId: 'angel', active: true }]);
    state.players[0].hand = [];
  };

  it('is on the action bar and flags a meal worth a level', () => {
    boot(prepare);
    const btn = byText('.action-bar .btn', /Gallows/);
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
    expect(btn.classList.contains('gallows-btn--ready')).toBe(true);
  });

  it('walks eater then food, and feeds on the second click', () => {
    const controller = boot(prepare);
    const before = activeOf(controller.getState(), 0).level;

    click(byText('.action-bar .btn', /Gallows/));
    expect($('.modal__head h3').textContent).toBe('The Gallows');

    // Nothing to eat until an eater is chosen.
    expect($$('.gallows__heading')).toHaveLength(1);
    click(inRow(0, /Silky/));

    expect($$('.gallows__heading')).toHaveLength(2);
    const meal = inRow(1, /Nekomata/);
    expect(meal.textContent).toMatch(/\+1 level/);
    click(meal);

    const state = controller.getState();
    expect(activeOf(state, 0).level).toBe(before + CONFIG.GALLOWS_LEVELS);
    expect(state.players[0].field.some((p) => p.cardId === 'nekomata')).toBe(false);
    expect(state.turnState.gallowsUsed).toBe(1);
  });

  it('says what a meal too weak to teach anything is actually worth', () => {
    boot((state) => {
      setField(state, 0, [
        { cardId: 'silky', level: 30, active: true },
        { cardId: 'pixie', level: 3 },
      ]);
      setField(state, 1, [{ cardId: 'angel', active: true }]);
      state.players[0].hand = [];
    });

    click(byText('.action-bar .btn', /Gallows/));
    click(inRow(0, /Silky/));
    expect(inRow(1, /Pixie/).textContent).toMatch(
      new RegExp(`\\+${Math.round(CONFIG.GALLOWS_JUNK_HEAL * 100)}% HP`)
    );
  });

  it('is disabled with nothing to feed', () => {
    boot((state) => {
      setField(state, 0, [{ cardId: 'silky', level: 20, active: true }]);
      setField(state, 1, [{ cardId: 'angel', active: true }]);
      state.players[0].hand = [];
    });
    expect(byText('.action-bar .btn', /Gallows/).disabled).toBe(true);
  });

  it('spells out all three tiers before you have chosen anything', () => {
    boot(prepare);
    click(byText('.action-bar .btn', /Gallows/));

    const tiers = $$('.gallows-tier');
    expect(tiers).toHaveLength(3);
    expect(tiers.map((t) => t.querySelector('.gallows-tier__name').textContent)).toEqual([
      'Feast',
      'Meal',
      'Junk',
    ]);
    // The one that matters most is the one nobody would guess.
    expect(tiers[2].textContent).toMatch(/costs no action/);
    expect(tiers[0].textContent).toMatch(new RegExp(`\\+${CONFIG.GALLOWS_FEAST_LEVELS} levels`));
  });

  it('previews the tier of every candidate meal before you commit', () => {
    boot((state) => {
      setField(state, 0, [
        { cardId: 'silky', level: 20, active: true },
        { cardId: 'angel', level: 22 }, // at/above -> feast
        { cardId: 'nekomata', level: 18 }, // just below -> meal
        { cardId: 'pixie', level: 3 }, // far below -> junk
      ]);
      setField(state, 1, [{ cardId: 'ara-mitama', active: true }]);
      state.players[0].hand = [];
    });

    click(byText('.action-bar .btn', /Gallows/));
    click(inRow(0, /Silky/));

    const tierOf = (re) => inRow(1, re).dataset.tier;
    expect(tierOf(/Angel/)).toBe('feast');
    expect(tierOf(/Nekomata/)).toBe('meal');
    expect(tierOf(/Pixie/)).toBe('junk');

    // Each one says what it is worth AND what it costs, in the button itself.
    expect(inRow(1, /Angel/).textContent).toMatch(
      new RegExp(`\\+${CONFIG.GALLOWS_FEAST_LEVELS} levels.*costs your action`)
    );
    expect(inRow(1, /Pixie/).textContent).toMatch(/free/);

    // Best tier first, so the strongest meal is never buried.
    expect(gallowsRow(1).map((n) => n.dataset.tier)).toEqual(['feast', 'meal', 'junk']);
  });

  it('leaves your action unspent after a junk meal, so you can still attack', () => {
    const controller = boot((state) => {
      setField(state, 0, [
        { cardId: 'silky', level: 30, active: true },
        { cardId: 'pixie', level: 3 },
      ]);
      setField(state, 1, [{ cardId: 'angel', active: true }]);
      state.players[0].hand = [];
    });

    click(byText('.action-bar .btn', /Gallows/));
    click(inRow(0, /Silky/));
    click(inRow(1, /Pixie/));

    const state = controller.getState();
    expect(state.turnState.gallowsUsed).toBe(1);
    expect(state.turnState.actionsRemaining).toBe(1);
    // ...and the board agrees: attacking is still on the table.
    expect(controller.legalActions(0).some((a) => a.type === 'ATTACK')).toBe(true);
  });
});

describe('the Showtime button', () => {
  const prepare = (state) => {
    setField(state, 0, [
      { cardId: 'pixie', level: 20, active: true },
      { cardId: 'jack-frost', level: 20 },
    ]);
    setField(state, 1, [{ cardId: 'silky', level: 20, maxHp: 400, hp: 400, active: true }]);
    state.players[0].hand = [];
  };

  it('appears in the skill bar when both partners are standing', () => {
    boot(prepare);
    const btn = $('.skill-btn--showtime');
    expect(btn).toBeTruthy();
    expect(btn.dataset.showtimeId).toBe('duo-hee-ho-hop');
    expect(btn.textContent).toContain('Hee-Ho Hop');
    expect(btn.textContent).toContain('Pixie & Jack Frost');
  });

  it('fires the duo and is gone afterwards', () => {
    const controller = boot(prepare);
    const before = controller.getState().players[1].field[0].hp;

    click($('.skill-btn--showtime'));

    const state = controller.getState();
    expect(state.players[1].field[0].hp).toBeLessThan(before);
    expect(state.players[0].showtimesUsed).toEqual(['duo-hee-ho-hop']);
    expect($('.skill-btn--showtime')).toBe(null);
  });

  it('is absent with only half the pair on the board', () => {
    boot((state) => {
      setField(state, 0, [{ cardId: 'pixie', level: 20, active: true }]);
      setField(state, 1, [{ cardId: 'silky', active: true }]);
      state.players[0].hand = [];
    });
    expect($('.skill-btn--showtime')).toBe(null);
  });
});

describe('the Providence picker', () => {
  const prepare = (state) => {
    setField(state, 0, [{ cardId: 'silky', level: 20, active: true }]);
    setField(state, 1, [{ cardId: 'angel', active: true }]);
    state.players[0].deck = ['pixie', 'medicine', 'anzu', 'silky', 'bead', 'nekomata'];
    setHand(state, 0, ['providence']);
  };

  it('lays out the top of the deck and bins only what you clicked', () => {
    const controller = boot(prepare);

    const tile = $$('.hand-tile').find((t) => t.dataset.cardId === 'providence');
    click(tile);
    click([...document.querySelectorAll('.card-detail-overlay button')].find((b) => /Play Providence/.test(b.textContent)));

    const cards = $$('.modal__cards .card');
    expect(cards).toHaveLength(CONFIG.PROVIDENCE_LOOK);

    click(cards[0]); // Pixie
    click(cards[3]); // Silky
    expect(cards[0].classList.contains('card--discarding')).toBe(true);
    expect($('.providence__summary').textContent).toMatch(/Discarding 2/);

    click(byText('.modal .btn', /Confirm/));

    const state = controller.getState();
    expect(state.players[0].deck).toEqual(['medicine', 'anzu', 'bead', 'nekomata']);
    expect(state.players[0].discard).toContain('pixie');
    expect(state.players[0].discard).toContain('silky');
  });

  it('can be confirmed with nothing selected', () => {
    const controller = boot(prepare);
    const deck = [...controller.getState().players[0].deck];

    const tile = $$('.hand-tile').find((t) => t.dataset.cardId === 'providence');
    click(tile);
    click([...document.querySelectorAll('.card-detail-overlay button')].find((b) => /Play Providence/.test(b.textContent)));
    click(byText('.modal .btn', /Confirm/));

    expect(controller.getState().players[0].deck).toEqual(deck);
  });
});
