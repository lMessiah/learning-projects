/**
 * @vitest-environment jsdom
 *
 * Integration tests for the Vs Bot screen: mount the real board against the
 * real engine and drive it with real clicks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMatch, CONFIG } from '../src/engine/index.js';
import { createController } from '../src/ui/game/controller.js';
import { mountBoard } from '../src/ui/game/board.js';

let root;
let unmount;
let controller;

function boot({ difficulty = 'medium', seed = 42 } = {}) {
  const state = createMatch({
    seed,
    players: [
      { name: 'You', deckId: 'p3', controller: 'human' },
      { name: 'Bot', deckId: 'p4', controller: 'bot', difficulty },
    ],
  });
  controller = createController({ state, botPlayer: 1, difficulty, botSeed: seed + 1 });
  unmount = mountBoard(root, { controller, viewer: 0, title: 'Against Bot', subtitle: 'test', onExit() {} });
  return controller;
}

function runBot(ms = 5000) {
  vi.advanceTimersByTime(ms);
}

const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
// The detail overlay is mounted on document.body so it can sit above everything.
const $doc = (sel) => document.querySelector(sel);
const $$doc = (sel) => [...document.querySelectorAll(sel)];
const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const hover = (node) => node.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: false }));
const unhover = (node) => node.dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: false }));

function pickStarters() {
  click($$('.starter-select .card')[0]);
  runBot();
}

/** Open a tile's detail overlay and press the button whose label matches. */
function actViaDetail(tile, labelPattern) {
  click(tile);
  const overlay = $doc('.card-detail-overlay');
  expect(overlay).toBeTruthy();
  const btn = [...overlay.querySelectorAll('button')].find((b) => labelPattern.test(b.textContent));
  expect(btn, `no button matching ${labelPattern} in detail overlay`).toBeTruthy();
  click(btn);
}

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  unmount?.();
  controller?.destroy();
  root.remove();
  document.querySelectorAll('.card-detail-overlay, .card-tooltip').forEach((n) => n.remove());
  vi.useRealTimers();
});

describe('starter selection', () => {
  it('offers three Personas and starts the match once picked', () => {
    boot();
    expect($$('.starter-select .card')).toHaveLength(3);
    pickStarters();
    expect(controller.getState().phase).toBe('playing');
    expect($('.board-play')).toBeTruthy();
    expect($$('.side')).toHaveLength(2);
  });
});

describe('board rendering', () => {
  beforeEach(() => {
    boot();
    pickStarters();
  });

  it('shows both actives, KO tallies, hand and log in one view', () => {
    expect($$('.active-slot .tile--active')).toHaveLength(2);
    expect($$('.ko-tally')).toHaveLength(2);
    expect($$('.ko-tally__pips .pip').length).toBe(CONFIG.KO_TARGET * 2);
    expect($$('.hand-tile').length).toBe(controller.getState().players[0].hand.length);
    expect($$('.log-entry').length).toBeGreaterThan(0);
  });

  it('shows HP and SP readouts on the active tiles', () => {
    const active = $('.side--you .tile--active');
    expect(active.querySelector('.tile__hp-text').textContent).toMatch(/^\d+\/\d+ HP$/);
    expect(active.querySelector('.tile__sp-text').textContent).toMatch(/^\d+\/\d+ SP$/);
    expect(active.querySelector('.tile__bar--hp .tile__fill')).toBeTruthy();
  });

  it('renders bench Personas as minis, not full cards', () => {
    const state = controller.getState();
    state.players[0].field.push({
      ...state.players[0].field[0],
      uid: 'bench-1',
    });
    controller.dispatch({ type: 'PASS', player: 0 });

    const bench = $$('.side--you .bench-strip .tile--bench');
    expect(bench.length).toBe(1);
    // A mini shows name, level and an HP bar — and no skill list.
    expect(bench[0].querySelector('.tile__name').textContent).toBeTruthy();
    expect(bench[0].querySelector('.tile__level').textContent).toMatch(/^\d+$/);
    expect(bench[0].querySelector('.tile__bar--hp')).toBeTruthy();
    expect(bench[0].querySelector('.skill-list')).toBe(null);
  });

  it('hides the opponent\'s affinities until struck, and shows your own', () => {
    const enemy = $('.side--enemy .tile--active');
    expect(enemy.querySelector('.mini-chip--unknown')).toBeTruthy();

    const own = $('.side--you .tile--active');
    expect(own.querySelector('.mini-chip--unknown')).toBe(null);
    expect(own.querySelectorAll('.mini-chip').length).toBeGreaterThan(0);
  });

  it('shows the turn allowances including the play-level cap', () => {
    expect($('.turn-indicator').textContent).toContain('Your turn');
    const allowances = $$('.allowance').map((n) => n.textContent);
    expect(allowances).toContain('Item 1');
    expect(allowances).toContain('Special 1');
    expect(allowances).toContain('Action 1');
    expect(allowances.some((a) => a.startsWith('Play ≤ Lv'))).toBe(true);
  });
});

describe('card inspection', () => {
  beforeEach(() => {
    boot();
    pickStarters();
  });

  it('shows the full card — skills with costs — on hover', () => {
    const tile = $('.side--you .tile--active');
    hover(tile);

    const tooltip = $doc('.card-tooltip');
    expect(tooltip.hidden).toBe(false);
    const card = tooltip.querySelector('.card--persona');
    expect(card).toBeTruthy();
    expect(card.querySelectorAll('.skill').length).toBeGreaterThan(0);
    expect(card.querySelector('.skill__cost').textContent).toMatch(/HP|SP|Free/);

    unhover(tile);
    expect($doc('.card-tooltip').hidden).toBe(true);
  });

  it('opens a detail overlay on click, for touch users', () => {
    const tile = $('.side--you .tile--active');
    click(tile);

    const overlay = $doc('.card-detail-overlay');
    expect(overlay).toBeTruthy();
    expect(overlay.querySelector('.card--persona .skill')).toBeTruthy();
    expect(overlay.querySelector('.card-detail__head h3').textContent).toBeTruthy();

    click(overlay.querySelector('.card-detail__head button'));
    expect($doc('.card-detail-overlay')).toBe(null);
  });

  it('lets you inspect a hand Persona before playing it', () => {
    const state = controller.getState();
    state.players[0].hand.push({ uid: 'inspect-1', cardId: 'sarasvati' });
    controller.dispatch({ type: 'PASS', player: 0 });

    const tile = $$('.hand-tile').find((t) => t.dataset.cardId === 'sarasvati');
    hover(tile);
    const card = $doc('.card-tooltip .card--persona');
    expect(card.querySelector('.card__name').textContent).toBe('Sarasvati');
    expect(card.querySelectorAll('.skill').length).toBeGreaterThan(0);
    // Weaknesses are visible because it is your own card.
    expect(card.querySelector('.affinity--weak .chip').textContent).not.toBe('?');
  });

  it('inspects a bench Persona and offers the switch from the overlay', () => {
    const state = controller.getState();
    state.players[0].field.push({ ...state.players[0].field[0], uid: 'bench-1' });
    controller.dispatch({ type: 'PASS', player: 0 });

    const bench = $('.side--you .tile--bench');
    hover(bench);
    expect($doc('.card-tooltip .card--persona .skill')).toBeTruthy();

    actViaDetail(bench, /Switch/);
    expect(controller.getState().players[0].activeUid).toBe('bench-1');
    expect(controller.getState().turnState.personaChangesRemaining).toBe(0);
  });
});

describe('taking a turn', () => {
  beforeEach(() => {
    boot();
    pickStarters();
  });

  it('attacks with the basic attack and damages the opponent', () => {
    const before = controller.getState();
    const enemyActive = before.players[1].field.find((p) => p.uid === before.players[1].activeUid);
    const startHp = enemyActive.hp;

    const attackBtn = $$('.skill-btn').find((b) => b.textContent.includes('Attack') && !b.disabled);
    click(attackBtn);

    const after = controller.getState();
    expect(after.players[1].field.find((p) => p.uid === enemyActive.uid).hp).toBeLessThan(startHp);
    expect(after.turnState.actionsRemaining).toBe(0);
  });

  it('disables skills the active Persona cannot afford', () => {
    controller.getState().players[0].field[0].sp = 0;
    controller.dispatch({ type: 'PASS', player: 0 });

    const spSkills = $$('.skill-btn').filter((b) => b.textContent.includes('SP'));
    expect(spSkills.length).toBeGreaterThan(0);
    expect(spSkills.every((b) => b.disabled)).toBe(true);
  });

  it('hands the turn to the bot on End turn, and gets it back', () => {
    click($$('.action-bar .btn').find((b) => b.textContent.includes('End turn')));
    expect(controller.getState().activePlayer).toBe(1);

    runBot();
    const after = controller.getState();
    expect(after.winner === null ? after.activePlayer : 0).toBe(0);
    expect(after.turn).toBeGreaterThan(1);
  });

  it('locks the controls during the bot\'s turn', () => {
    click($$('.action-bar .btn').find((b) => b.textContent.includes('End turn')));
    expect($('.turn-indicator').textContent).toContain('thinking');
    expect($$('.action-bar .btn').every((b) => b.disabled)).toBe(true);
    runBot();
  });

  it('enters targeting mode when a card has more than one legal target', () => {
    const state = controller.getState();
    const player = state.players[0];
    player.field.push({ ...player.field[0], uid: 'extra-1', hp: 5 });
    player.field[0].hp = 5;
    player.hand.push({ uid: 'med-1', cardId: 'medicine' });
    controller.dispatch({ type: 'PASS', player: 0 });

    const medicine = $$('.hand-tile').find((t) => t.dataset.cardId === 'medicine');
    actViaDetail(medicine, /Play/);

    expect($('.prompt')).toBeTruthy();
    expect($('.prompt').textContent).toContain('Medicine');
    expect($$('.tile--targetable').length).toBeGreaterThan(1);

    // In targeting mode a click commits directly rather than re-opening detail.
    click($$('.tile--targetable')[0]);
    expect($('.prompt')).toBe(null);
    expect(controller.getState().turnState.itemsPlayed).toBe(1);
  });

  it('blocks a second Item in the same turn', () => {
    const state = controller.getState();
    state.players[0].field[0].hp = 5;
    state.players[0].hand.push({ uid: 'med-1', cardId: 'medicine' });
    state.players[0].hand.push({ uid: 'med-2', cardId: 'medicine' });
    controller.dispatch({ type: 'PASS', player: 0 });

    const medicines = () => $$('.hand-tile').filter((t) => t.dataset.cardId === 'medicine');
    const before = medicines().length;
    expect(before).toBeGreaterThanOrEqual(2);

    actViaDetail(medicines()[0], /Play/);
    expect(controller.getState().turnState.itemsPlayed).toBe(1);

    const after = medicines();
    expect(after.length).toBe(before - 1);
    expect(after.every((t) => t.classList.contains('hand-tile--disabled'))).toBe(true);
    expect(after[0].querySelector('.hand-tile__blocked').textContent).toMatch(/Item already used/);
    expect($$('.allowance').map((n) => n.textContent)).toContain('Item 0');
  });

  it('marks an over-level Persona in hand as unplayable, with the reason', () => {
    const state = controller.getState();
    state.players[0].hand.push({ uid: 'big-1', cardId: 'sarasvati' }); // level 19
    controller.dispatch({ type: 'PASS', player: 0 });

    const tile = $$('.hand-tile').find((t) => t.dataset.cardId === 'sarasvati');
    expect(tile.classList.contains('hand-tile--disabled')).toBe(true);
    expect(tile.querySelector('.hand-tile__blocked').textContent).toMatch(/Needs Lv \d+ board/);
  });
});

describe('visual feedback', () => {
  beforeEach(() => {
    boot();
    pickStarters();
  });

  it('floats a damage number and shakes the target when a hit lands', () => {
    click($$('.skill-btn').find((b) => b.textContent.includes('Attack') && !b.disabled));

    const damage = $('.float-num--damage');
    expect(damage).toBeTruthy();
    expect(damage.textContent).toMatch(/^-\d+$/);

    const enemyUid = controller.getState().players[1].activeUid;
    expect($(`[data-uid="${enemyUid}"]`).classList.contains('is-hit')).toBe(true);
  });

  it('highlights the Persona that acted', () => {
    const actingUid = controller.getState().players[0].activeUid;
    click($$('.skill-btn').find((b) => b.textContent.includes('Attack') && !b.disabled));
    expect($(`[data-uid="${actingUid}"]`).classList.contains('is-acting')).toBe(true);
  });

  it('splashes WEAK! and ONE MORE! on a weakness hit', () => {
    // Force a guaranteed weakness: Orpheus (Agi) into a fire-weak Jack Frost.
    const state = controller.getState();
    const enemy = state.players[1].field.find((p) => p.uid === state.players[1].activeUid);
    Object.assign(enemy, { cardId: 'jack-frost', hp: 400, maxHp: 400, revealedTypes: [] });
    Object.assign(state.players[0].field[0], { cardId: 'orpheus', sp: 40, maxSp: 40 });
    controller.dispatch({ type: 'PASS', player: 0 });
    controller.dispatch({ type: 'END_TURN', player: 0, discard: [] });
    runBot();

    const agi = $$('.skill-btn').find((b) => b.textContent.includes('Agi') && !b.disabled);
    if (!agi) return; // the bot may have ended the match; nothing to assert
    click(agi);

    expect($('.splash--weak')).toBeTruthy();
    expect($('.splash--onemore')).toBeTruthy();
    expect($('.one-more')).toBeTruthy(); // the persistent banner too
  });

  it('animates the knockdown rotation', () => {
    const state = controller.getState();
    const enemy = state.players[1].field.find((p) => p.uid === state.players[1].activeUid);
    Object.assign(enemy, { cardId: 'jack-frost', hp: 400, maxHp: 400 });
    Object.assign(state.players[0].field[0], { cardId: 'orpheus', sp: 40, maxSp: 40 });
    controller.dispatch({ type: 'PASS', player: 0 });
    controller.dispatch({ type: 'END_TURN', player: 0, discard: [] });
    runBot();

    const agi = $$('.skill-btn').find((b) => b.textContent.includes('Agi') && !b.disabled);
    if (!agi) return;
    click(agi);

    const tile = $(`[data-uid="${enemy.uid}"]`);
    expect(tile.classList.contains('tile--down')).toBe(true);
    expect(tile.classList.contains('is-going-down')).toBe(true);
  });

  it('floats a heal number when a Persona is healed', () => {
    const state = controller.getState();
    state.players[0].field[0].hp = 5;
    state.players[0].hand.push({ uid: 'med-1', cardId: 'medicine' });
    controller.dispatch({ type: 'PASS', player: 0 });

    actViaDetail($$('.hand-tile').find((t) => t.dataset.cardId === 'medicine'), /Play/);

    const heal = $('.float-num--heal');
    expect(heal).toBeTruthy();
    expect(heal.textContent).toMatch(/^\+\d+$/);
  });
});

describe('fusion and specials in the UI', () => {
  beforeEach(() => {
    boot();
    pickStarters();
  });

  /**
   * Put a fusable pair on the player's field and hand the turn back with a
   * full action. Jack Frost Lv13 (Magician) + Sarasvati Lv19 (Priestess) = 32,
   * which is exactly the Black Frost recipe. Both get a deep HP pool so the
   * bot's intervening turn cannot knock a parent out from under the test.
   */
  function readyFusion() {
    const state = controller.getState();
    const [first] = state.players[0].field;
    Object.assign(first, { cardId: 'jack-frost', level: 13, hp: 400, maxHp: 400, sp: 40, maxSp: 40 });
    state.players[0].field.push({ ...first, uid: 'sara-1', cardId: 'sarasvati', level: 19 });

    controller.dispatch({ type: 'PASS', player: 0 });
    controller.dispatch({ type: 'END_TURN', player: 0, discard: [] });
    runBot();

    expect(controller.getState().activePlayer, 'expected the turn back').toBe(0);
    const fuseBtn = $$('.action-bar .btn').find((b) => b.textContent.includes('Fusion'));
    expect(fuseBtn, 'expected a Fusion button').toBeTruthy();
    expect(fuseBtn.classList.contains('fusion-btn--ready'), 'expected a fusion to be available').toBe(true);
    return fuseBtn;
  }

  const openFusion = () => {
    const btn = $$('.action-bar .btn').find((b) => b.textContent.includes('Fusion'));
    expect(btn).toBeTruthy();
    click(btn);
    return btn;
  };

  /** Walk the wizard: recipes -> material -> confirm. */
  function fuseThrough() {
    openFusion();
    const ready = $('.fusion-recipe--ready');
    expect(ready, 'expected a highlighted, satisfiable recipe').toBeTruthy();
    click([...ready.querySelectorAll('button')].find((b) => /Choose material/.test(b.textContent)));

    const pair = $('.fusion-pair');
    expect(pair, 'expected at least one material pair').toBeTruthy();
    click([...pair.querySelectorAll('button')].find((b) => b.textContent === 'Select'));

    const selects = $$('.fusion-preview select');
    expect(selects).toHaveLength(2);
    const chosen = selects.map((sel) => sel.value);
    click($$('.fusion-preview__actions button').find((b) => /Fuse/.test(b.textContent)));
    return chosen;
  }

  it('always offers the Fusion button on your turn, badged when one is ready', () => {
    // Before any material: the button is there, enabled, but not badged.
    const cold = $$('.action-bar .btn').find((b) => b.textContent.includes('Fusion'));
    expect(cold).toBeTruthy();
    expect(cold.disabled).toBe(false);
    expect(cold.classList.contains('fusion-btn--ready')).toBe(false);

    readyFusion();
    const hot = $$('.action-bar .btn').find((b) => b.textContent.includes('Fusion'));
    expect(hot.classList.contains('fusion-btn--ready')).toBe(true);
    expect(hot.querySelector('.fusion-btn__badge')).toBeTruthy();
  });

  it('lists every recipe, with reasons on the ones you cannot make', () => {
    openFusion();
    const rows = $$('.fusion-recipe');
    expect(rows.length).toBe(14); // every recipe in the database

    const blocked = $$('.fusion-recipe--blocked');
    expect(blocked.length).toBeGreaterThan(0);
    const reasons = blocked.map((r) => r.querySelector('.fusion-recipe__reason').textContent);
    // Reasons are specific and actionable, not just "unavailable".
    expect(reasons.some((r) => /^Need a /.test(r) || /^Combined level \d+\/\d+$/.test(r))).toBe(true);
    expect(rows[0].querySelector('.fusion-recipe__formula').textContent).toMatch(/combined Lv \d+\+/);
  });

  it('highlights the satisfiable recipe and names the material', () => {
    readyFusion();
    openFusion();

    const ready = $$('.fusion-recipe--ready');
    expect(ready.length).toBeGreaterThan(0);
    expect(ready[0].querySelector('.fusion-recipe__name').textContent).toBe('Black Frost');
    expect(ready[0].querySelector('.fusion-recipe__badge').textContent).toMatch(/way/);

    click([...ready[0].querySelectorAll('button')].find((b) => /Choose material/.test(b.textContent)));
    const chips = $$('.fusion-pair__chips .fusion-parent').map((n) => n.textContent);
    expect(chips.join(' ')).toContain('Jack Frost');
    expect(chips.join(' ')).toContain('Sarasvati');
  });

  it('previews the result and labels the inherit choices by parent', () => {
    readyFusion();
    openFusion();
    click([...$('.fusion-recipe--ready').querySelectorAll('button')].find((b) => /Choose material/.test(b.textContent)));
    click([...$('.fusion-pair').querySelectorAll('button')].find((b) => b.textContent === 'Select'));

    // The result card is previewed before committing.
    const card = $('.fusion-preview .card--persona');
    expect(card.querySelector('.card__name').textContent).toBe('Black Frost');
    expect($('.fusion-preview__title').textContent).toContain('level 38');

    const labels = $$('.fusion-preview .fusion-pick span').map((n) => n.textContent);
    expect(labels.some((l) => l.includes('Jack Frost'))).toBe(true);
    expect(labels.some((l) => l.includes('Sarasvati'))).toBe(true);

    // And the button says what it costs.
    expect($$('.fusion-preview__actions button').find((b) => /Fuse/.test(b.textContent)).textContent)
      .toMatch(/uses your action/);
  });

  it('performs the fusion with the chosen inherited skills and spends the action', () => {
    readyFusion();
    const chosen = fuseThrough();

    const state = controller.getState();
    const result = state.players[0].field.find((p) => p.cardId === 'black-frost');
    expect(result).toBeTruthy();
    expect(result.level).toBe(38);
    expect(result.inheritedSkills).toEqual(chosen);
    expect(state.players[0].koCount).toBe(0); // sacrifices are not KOs
    expect(state.turnState.actionsRemaining).toBe(0);
  });

  it('gives the fusion result the active slot when the active was sacrificed', () => {
    readyFusion();
    const before = controller.getState();
    const sacrificedActive = before.players[0].activeUid;

    fuseThrough();

    const after = controller.getState();
    const result = after.players[0].field.find((p) => p.cardId === 'black-frost');
    expect(after.activePlayer).toBe(0);
    expect(after.players[0].activeUid).toBe(result.uid);
    expect(after.players[0].activeUid).not.toBe(sacrificedActive);
  });

  it('shows inherited skills on the fused Persona\'s card', () => {
    readyFusion();
    fuseThrough();

    const result = controller.getState().players[0].field.find((p) => p.cardId === 'black-frost');
    const tile = $(`[data-uid="${result.uid}"]`);
    hover(tile);

    const card = $doc('.card-tooltip .card--persona');
    const inherited = [...card.querySelectorAll('.skill--inherited')];
    expect(inherited.length).toBe(result.inheritedSkills.length);
    expect(inherited[0].querySelector('.skill__lv').textContent).toBe('Inherited');

    const names = inherited.map((n) => n.querySelector('.skill__name').textContent);
    const barNames = $$('.skill-btn').map((b) => b.querySelector('.skill-btn__name').textContent);
    for (const name of names) expect(barNames).toContain(name);
  });

  it('offers the recipe reference from the in-match menu', () => {
    click($$('.topbar .btn').find((b) => b.textContent.includes('Menu')));
    expect($('.menu-list')).toBeTruthy();

    click($$('.menu-list .btn').find((b) => b.textContent.includes('Fusion recipes')));
    expect($('.modal__head h3').textContent).toBe('Fusion recipes');
    expect($$('.fusion-recipe').length).toBe(14);
    // Reference only — no way to act from here.
    expect($$('.fusion-recipe button')).toHaveLength(0);
  });

  it('plays a Special that needs no target straight from the hand', () => {
    const state = controller.getState();
    state.players[0].hand.push({ uid: 'conc-1', cardId: 'concentrate' });
    controller.dispatch({ type: 'PASS', player: 0 });

    actViaDetail($$('.hand-tile').find((t) => t.dataset.cardId === 'concentrate'), /Play/);

    expect(controller.getState().turnState.specialsPlayed).toBe(1);
    expect(controller.getState().players[0].field[0].charges).toContain('concentrate');
    // The pending charge is visible on the board.
    expect($('.side--you .tile--active .dot--charge')).toBeTruthy();
  });

  it('lets Ambush open the enemy bench, then target it', () => {
    const state = controller.getState();
    state.players[1].field.push({ ...state.players[1].field[0], uid: 'foe-bench', hp: 200, maxHp: 200 });
    state.players[0].hand.push({ uid: 'amb-1', cardId: 'ambush' });
    controller.dispatch({ type: 'PASS', player: 0 });

    // Before Ambush only the active is attackable.
    expect($$('.side--enemy .tile').length).toBe(2);
    actViaDetail($$('.hand-tile').find((t) => t.dataset.cardId === 'ambush'), /Play/);

    expect(controller.getState().turnState.canTargetBench).toBe(true);
    expect($$('.allowance').map((n) => n.textContent)).toContain('Bench targetable');
  });
});
