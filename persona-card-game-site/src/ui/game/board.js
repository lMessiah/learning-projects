/**
 * The match board.
 *
 * Pure presentation + input: it reads engine state, renders it, and turns
 * clicks into engine actions. Every control is built from `getLegalActions`,
 * so the UI can never offer a move the rules forbid.
 *
 * Layout budget: the whole battle state fits one viewport at 1440x900 with no
 * page scrolling, so Personas are drawn as compact board tiles and bench slots
 * as minis. The full card is always one hover (tooltip) or one click (detail
 * overlay) away — see inspect.js.
 */
import {
  CONFIG,
  getActive,
  livingField,
  benchOf,
  koedField,
  personaSkills,
  opponentOf,
  playableLevelCap,
} from '../../engine/index.js';
import { getCard, getPersona, PERSONAS } from '../../data/cards.js';
import { renderCard } from '../cardView.js';
import { arcanaStyle, typeIcon, typeLabel } from '../arcana.js';
import { makeInspectable, openCardDetail, hideTooltip, fullPersonaCard, fullHandCard } from './inspect.js';
import { diffStates, playEffects } from './anim.js';
import { renderFusionPanel, hasSatisfiableFusion } from './fusionPanel.js';
import { getSettings, animationScale, autoEndDelay } from '../settings.js';
import { renderRulesContent } from '../rules.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, className, onClick, { disabled = false, title = '' } = {}) {
  const node = el('button', className, label);
  node.type = 'button';
  node.disabled = disabled;
  if (title) node.title = title;
  if (!disabled) node.addEventListener('click', onClick);
  return node;
}

const nameOf = (persona) => getPersona(persona.cardId).name;

// Flat skill id -> display name map, built once for the fusion dropdowns.
const SKILL_NAMES = new Map();
for (const card of PERSONAS) {
  for (const skill of card.skills) {
    if (!SKILL_NAMES.has(skill.id)) SKILL_NAMES.set(skill.id, skill.name);
  }
}
const skillNameOf = (skillId) => SKILL_NAMES.get(skillId) || skillId;

/* ------------------------------------------------------------------ *
 * Mount
 * ------------------------------------------------------------------ */

export function mountBoard(root, options) {
  const { controller, onExit } = options;
  // `viewer` may be a fixed seat (vs bot) or a function of state (hot-seat,
  // where the viewpoint follows whoever is holding the device).
  const viewerOf = typeof options.viewer === 'function' ? options.viewer : () => options.viewer;

  // Transient interaction state, cleared whenever the game state changes.
  let ui = { targeting: null, modal: null, fusion: null };
  let previousState = null;
  let pendingEffects = null;
  let autoEndTimer = null;

  const screen = el('div', 'board-screen');
  root.innerHTML = '';
  root.appendChild(screen);
  // Board mode hands the viewport over to the match: no page scrolling.
  document.body.classList.add('board-mode');

  const rerender = () => {
    const state = controller.getState();
    const viewer = viewerOf(state);
    const settings = getSettings();
    const scale = animationScale(settings);

    hideTooltip();
    if (autoEndTimer !== null) {
      clearTimeout(autoEndTimer);
      autoEndTimer = null;
    }
    screen.innerHTML = '';
    // 0 would divide by zero in the CSS durations, so park it very high instead.
    screen.style.setProperty('--anim-scale', String(scale || 1000));
    screen.classList.toggle('board-screen--no-anim', scale === 0);
    screen.appendChild(renderTop(state, { ...options, setUi }, viewer));

    if (state.phase === 'starterSelect') {
      const wrap = el('div', 'board-main board-main--single');
      wrap.appendChild(renderStarterSelect(state, viewer, act));
      wrap.appendChild(renderLog(state));
      screen.appendChild(wrap);
      return;
    }

    const main = el('div', 'board-main');
    main.appendChild(renderPlayArea(state, viewer, controller, ui, act, setUi, settings));
    main.appendChild(renderLog(state));
    screen.appendChild(main);

    if (ui.modal) screen.appendChild(ui.modal(state, { ui, act, setUi, viewer }));
    if (state.winner !== null) screen.appendChild(renderGameOver(state, viewer, options));

    if (pendingEffects) {
      playEffects(screen, pendingEffects, scale);
      pendingEffects = null;
    }

    scheduleAutoEndTurn(state, viewer, settings);
  };

  /**
   * Auto-end turn: only when the turn is genuinely spent. A One More or an
   * unspent Baton Pass change is a decision the player still owns, so the
   * timer never fires over the top of one.
   */
  function scheduleAutoEndTurn(state, viewer, settings) {
    if (!settings.autoEndTurn) return;
    if (state.winner !== null || state.phase !== 'playing') return;
    if (state.activePlayer !== viewer || controller.isBotTurn()) return;
    if (ui.modal || ui.targeting) return;

    const turn = state.turnState;
    const oneMorePending = turn.oneMoreUsed && turn.actionsRemaining > 0;
    const batonPending = turn.personaChangesRemaining > CONFIG.PERSONA_CHANGES_PER_TURN;
    if (oneMorePending || batonPending) return;

    const legal = controller.legalActions(viewer);
    const endTurn = legal.find((a) => a.type === 'END_TURN');
    if (!endTurn || endTurn.needsChoice) return; // a forced discard is a choice
    if (legal.length !== 1) return; // something else is still playable

    autoEndTimer = setTimeout(() => {
      autoEndTimer = null;
      if (controller.getState() === state) act(endTurn);
    }, autoEndDelay(settings));
  }

  function setUi(next) {
    ui = { ...ui, ...next };
    rerender();
  }

  function act(action) {
    ui = { targeting: null, modal: null, fusion: null };
    try {
      controller.dispatch(action);
    } catch (error) {
      console.error('Rejected action', action, error);
      flash(screen, error.message.replace(/^Illegal action:\s*/, ''));
      rerender();
    }
  }

  const unsubscribe = controller.subscribe((state) => {
    pendingEffects = diffStates(previousState, state);
    previousState = state;
    ui = { targeting: null, modal: null, fusion: null };
    rerender();
  });

  previousState = controller.getState();
  rerender();
  controller.start();

  return () => {
    unsubscribe();
    hideTooltip();
    if (autoEndTimer !== null) clearTimeout(autoEndTimer);
    document.body.classList.remove('board-mode');
    root.innerHTML = '';
  };
}

function flash(screen, message) {
  const toast = el('div', 'toast', message);
  screen.appendChild(toast);
  setTimeout(() => toast.remove(), 2600);
}

/* ------------------------------------------------------------------ *
 * Top bar
 * ------------------------------------------------------------------ */

function renderTop(state, { onExit, title, subtitle, neutralResult, setUi }, viewer) {
  const bar = el('div', 'topbar topbar--game');
  bar.appendChild(button('☰ Menu', 'btn btn--ghost btn--small', () => setUi({ modal: gameMenuModal(onExit) })));

  const titles = el('div');
  titles.appendChild(el('h1', 'topbar__title', title || 'Vs Bot'));
  if (subtitle) titles.appendChild(el('div', 'topbar__sub', subtitle));
  bar.appendChild(titles);
  bar.appendChild(el('div', 'topbar__spacer'));

  const turn = el('div', 'turn-indicator');
  if (state.winner !== null) {
    turn.classList.add('turn-indicator--over');
    turn.textContent = neutralResult
      ? `${state.players[state.winner].name} wins`
      : state.winner === viewer ? 'Victory' : 'Defeat';
  } else if (state.phase === 'starterSelect') {
    turn.textContent = 'Choose your Persona';
  } else {
    const yours = state.activePlayer === viewer;
    turn.classList.add(yours ? 'turn-indicator--you' : 'turn-indicator--them');
    turn.textContent = `T${state.turn} · ${yours ? 'Your turn' : `${state.players[state.activePlayer].name} thinking…`}`;
  }
  bar.appendChild(turn);
  return bar;
}

/* ------------------------------------------------------------------ *
 * Starter selection
 * ------------------------------------------------------------------ */

function renderStarterSelect(state, viewer, act) {
  const wrap = el('section', 'starter-select');
  const chosen = state.players[viewer].field.length > 0;

  wrap.appendChild(el('h2', null, chosen ? 'Waiting for your opponent…' : 'Choose your starting Persona'));
  wrap.appendChild(
    el('p', 'starter-select__hint', 'This Persona joins you in addition to your 30-card deck. It is your opening active.')
  );

  const row = el('div', 'starter-select__row');
  for (const cardId of state.starterOptions[viewer]) {
    const card = renderCard(getCard(cardId), { showAllHidden: true });
    if (!chosen) {
      card.classList.add('card--clickable');
      card.addEventListener('click', () => act({ type: 'CHOOSE_STARTER', player: viewer, cardId }));
    }
    row.appendChild(card);
  }
  wrap.appendChild(row);
  return wrap;
}

/* ------------------------------------------------------------------ *
 * Play area
 * ------------------------------------------------------------------ */

function renderPlayArea(state, viewer, controller, ui, act, setUi, settings) {
  const foe = opponentOf(viewer);
  const yourTurn = state.activePlayer === viewer && state.winner === null && !controller.isBotTurn();
  const legal = yourTurn ? controller.legalActions(viewer) : [];
  const ctx = { state, viewer, ui, act, setUi, legal, yourTurn, settings };

  const area = el('section', 'board-play');
  area.appendChild(renderSide(ctx, foe, true));
  area.appendChild(renderMiddle(state, viewer, ui, yourTurn, setUi));
  area.appendChild(renderSide(ctx, viewer, false));
  area.appendChild(renderSkillBar(ctx));
  area.appendChild(renderHand(ctx));
  area.appendChild(renderActionBar(ctx));
  return area;
}

function renderSide(ctx, playerId, enemy) {
  const { state, viewer } = ctx;
  const player = state.players[playerId];
  const active = getActive(state, playerId);
  const bench = benchOf(state, playerId);
  const fallen = koedField(state, playerId);

  const side = el('section', `side ${enemy ? 'side--enemy' : 'side--you'}`);

  const header = el('div', 'side__header');
  header.appendChild(el('span', 'side__name', enemy ? player.name : `${player.name} (you)`));
  header.appendChild(renderKoTally(player));
  const meta = `Deck ${player.deck.length} · Hand ${player.hand.length}` +
    (player.fatigue ? ` · Fatigue x${player.fatigue}` : '');
  header.appendChild(el('span', 'side__meta', meta));
  side.appendChild(header);

  const body = el('div', 'side__body');

  const activeSlot = el('div', 'active-slot');
  activeSlot.appendChild(el('span', 'slot__label', 'Active'));
  activeSlot.appendChild(
    active ? boardTile(ctx, active, { active: true }) : el('div', 'slot__empty', 'None')
  );
  body.appendChild(activeSlot);

  const benchSlot = el('div', 'bench-slot');
  benchSlot.appendChild(el('span', 'slot__label', `Bench ${bench.length}/${CONFIG.FIELD_CAP - 1}`));
  const strip = el('div', 'bench-strip');
  if (!bench.length && !fallen.length) strip.appendChild(el('div', 'slot__empty slot__empty--thin', 'Empty'));
  for (const persona of [...bench, ...fallen]) strip.appendChild(boardTile(ctx, persona, { active: false }));
  benchSlot.appendChild(strip);
  body.appendChild(benchSlot);

  side.appendChild(body);
  return side;
}

function renderKoTally(player) {
  const wrap = el('div', 'ko-tally');
  wrap.title = `${player.name} has lost ${player.koCount} of ${CONFIG.KO_TARGET} Personas`;
  const pips = el('div', 'ko-tally__pips');
  for (let i = 0; i < CONFIG.KO_TARGET; i++) {
    pips.appendChild(el('span', `pip${i < player.koCount ? ' pip--on' : ''}`));
  }
  wrap.appendChild(pips);
  wrap.appendChild(el('span', 'ko-tally__count', `${player.koCount}/${CONFIG.KO_TARGET}`));
  return wrap;
}

/* ------------------------------------------------------------------ *
 * Board tiles (compact) — the full card lives in the tooltip/overlay
 * ------------------------------------------------------------------ */

function hpBar(persona) {
  const bar = el('div', 'tile__bar tile__bar--hp');
  const fill = el('div', 'tile__fill');
  const pct = persona.maxHp ? (persona.hp / persona.maxHp) * 100 : 0;
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (pct <= 30) fill.classList.add('tile__fill--low');
  bar.appendChild(fill);
  return bar;
}

function spBar(persona) {
  const bar = el('div', 'tile__bar tile__bar--sp');
  const fill = el('div', 'tile__fill');
  const pct = persona.maxSp ? (persona.sp / persona.maxSp) * 100 : 0;
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  bar.appendChild(fill);
  return bar;
}

function statusDots(persona) {
  const wrap = el('div', 'tile__status');
  for (const buff of persona.buffs) {
    wrap.appendChild(
      el('span', `dot dot--${buff.direction === 'up' ? 'buff' : 'debuff'}`,
        `${buff.direction === 'up' ? '▲' : '▼'}${buff.stat === 'atk' ? 'A' : 'D'}${buff.turnsLeft}`)
    );
  }
  for (const ailment of persona.ailments) {
    wrap.appendChild(el('span', `dot dot--${ailment.type}`, ailment.type === 'burn' ? `🔥${ailment.turnsLeft}` : '⚡'));
  }
  for (const charge of persona.charges) {
    wrap.appendChild(el('span', 'dot dot--charge', charge === 'charge' ? '💥' : '🌀'));
  }
  if (persona.guarding) wrap.appendChild(el('span', 'dot dot--guard', '🛡️'));
  return wrap;
}

/**
 * A Persona on the board. Compact by design — hover for the full card, click
 * for the detail overlay (which also carries whatever actions are legal).
 */
function boardTile(ctx, persona, { active }) {
  const { state, viewer, ui, act, setUi, legal } = ctx;
  const card = getPersona(persona.cardId);
  const style = arcanaStyle(card.arcana);
  const own = persona.owner === viewer;

  const targeting = ui.targeting;
  const match = targeting ? targeting.candidates.find((c) => c[targeting.key] === persona.uid) : null;

  const tile = el('div', `tile ${active ? 'tile--active' : 'tile--bench'}`);
  tile.dataset.uid = persona.uid;
  tile.style.setProperty('--arcana', style.color);
  if (persona.knockedDown) tile.classList.add('tile--down');
  if (persona.ko) tile.classList.add('tile--ko');
  if (match) tile.classList.add('tile--targetable');
  if (own) tile.classList.add('tile--own');

  const head = el('div', 'tile__head');
  head.appendChild(el('span', 'tile__symbol', style.symbol));
  head.appendChild(el('span', 'tile__name', card.name));
  head.appendChild(el('span', 'tile__level', `${persona.level}`));
  tile.appendChild(head);

  tile.appendChild(hpBar(persona));
  if (active) {
    tile.appendChild(el('span', 'tile__hp-text', `${persona.hp}/${persona.maxHp} HP`));
    tile.appendChild(spBar(persona));
    tile.appendChild(el('span', 'tile__sp-text', `${persona.sp}/${persona.maxSp} SP`));
    tile.appendChild(renderAffinityStrip(persona, own));
  } else {
    tile.appendChild(el('span', 'tile__hp-text', `${persona.hp}/${persona.maxHp}`));
  }
  tile.appendChild(statusDots(persona));
  if (persona.ko) tile.appendChild(el('span', 'tile__ko-flag', 'KO'));

  // Inspection + actions
  const swap = !own || !legal.length ? null : legal.find((a) => a.type === 'CHANGE_ACTIVE' && a.targetUid === persona.uid);
  const detailActions = [];
  if (swap) {
    detailActions.push({
      label: `Switch ${card.name} in`,
      primary: true,
      hint: 'Uses your Persona change for this turn',
      onPick: () => act(swap),
    });
  }
  for (const action of legal) {
    if (action.targetUid !== persona.uid) continue;
    if (action.type === 'CHANGE_ACTIVE') continue;
    const label =
      action.type === 'PLAY_ITEM' || action.type === 'PLAY_SPECIAL'
        ? `Use ${getCard(action.cardId).name}`
        : action.type === 'USE_SKILL'
          ? `${skillNameOf(action.skillId)} this Persona`
          : action.type === 'ATTACK'
            ? 'Attack this Persona'
            : null;
    if (label) detailActions.push({ label, onPick: () => act(action) });
  }

  makeInspectable(tile, {
    buildCard: () => fullPersonaCard(persona, viewer),
    detail: () =>
      openCardDetail(document.body, {
        buildCard: () => fullPersonaCard(persona, viewer),
        title: card.name,
        subtitle: `${card.arcana} · Level ${persona.level}${persona.ko ? ' · knocked out' : ''}`,
        actions: detailActions,
      }),
    // In targeting mode the prompt is explicit, so a click commits directly.
    onDirectClick: match ? () => targeting.onPick(match) : null,
  });

  return tile;
}

/** Weaknesses/resists the viewer is allowed to see, as a compact strip. */
function renderAffinityStrip(persona, own) {
  const card = getPersona(persona.cardId);
  const revealed = new Set(persona.revealedTypes);
  const wrap = el('div', 'tile__affinity');

  const known = (type) => own || revealed.has(type);
  const shown = [
    ...card.weaknesses.map((t) => ({ type: t, kind: 'weak' })),
    ...card.resists.map((t) => ({ type: t, kind: 'resist' })),
  ].filter((entry) => known(entry.type));

  if (!shown.length) {
    wrap.appendChild(el('span', 'mini-chip mini-chip--unknown', '? ? ?'));
    return wrap;
  }
  for (const entry of shown) {
    wrap.appendChild(el('span', `mini-chip mini-chip--${entry.kind}`, `${entry.kind === 'weak' ? '▼' : '▲'}${typeIcon(entry.type)}`));
  }
  return wrap;
}

/* ------------------------------------------------------------------ *
 * Middle strip
 * ------------------------------------------------------------------ */

function renderMiddle(state, viewer, ui, yourTurn, setUi) {
  const mid = el('div', 'board-mid');

  if (state.turnState && state.activePlayer === viewer && state.turnState.oneMoreUsed && state.turnState.actionsRemaining > 0) {
    mid.appendChild(el('div', 'one-more', 'ONE MORE! Extra action + extra Persona change'));
  }

  if (ui.targeting) {
    const prompt = el('div', 'prompt');
    prompt.appendChild(el('span', null, ui.targeting.prompt));
    prompt.appendChild(button('Cancel', 'btn btn--ghost btn--small', () => setUi({ targeting: null })));
    mid.appendChild(prompt);
  } else if (yourTurn) {
    const turn = state.turnState;
    const strip = el('div', 'allowances');
    for (const chip of [
      `Action ${turn.actionsRemaining}`,
      `Swap ${turn.personaChangesRemaining}`,
      `Item ${CONFIG.ITEMS_PER_TURN - turn.itemsPlayed}`,
      `Special ${CONFIG.SPECIALS_PER_TURN - turn.specialsPlayed}`,
      `Play ≤ Lv${playableLevelCap(state, viewer)}`,
    ]) {
      strip.appendChild(el('span', 'allowance', chip));
    }
    if (turn.canTargetBench) strip.appendChild(el('span', 'allowance allowance--hot', 'Bench targetable'));
    mid.appendChild(strip);
  }

  return mid;
}

/* ------------------------------------------------------------------ *
 * Skills
 * ------------------------------------------------------------------ */

function renderSkillBar(ctx) {
  const { state, viewer, legal, yourTurn, act, setUi, settings } = ctx;
  const active = getActive(state, viewer);
  const bar = el('div', 'skill-bar');
  if (!active) return bar;

  bar.appendChild(el('span', 'skill-bar__label', nameOf(active)));

  const list = el('div', 'skill-bar__list');
  const basic = legal.filter((a) => a.type === 'ATTACK');
  list.appendChild(
    skillButton({ name: 'Attack', type: 'phys', power: CONFIG.BASIC_ATTACK_POWER, costLabel: 'Free' },
      basic, act, setUi, yourTurn && basic.length > 0, 'Basic physical strike — costs nothing', settings)
  );

  for (const skill of personaSkills(state, active)) {
    const candidates = legal.filter((a) => a.type === 'USE_SKILL' && a.skillId === skill.id);
    const costLabel = skill.type === 'phys' ? `${skill.hpCost} HP` : `${skill.spCost} SP`;
    const affordable = candidates.length > 0;
    const reason = !yourTurn
      ? 'Not your turn'
      : affordable
        ? skill.description
        : skill.type === 'phys' ? 'Not enough HP' : 'Not enough SP';
    list.appendChild(skillButton({ ...skill, costLabel }, candidates, act, setUi, yourTurn && affordable, reason, settings));
  }

  bar.appendChild(list);
  return bar;
}

function skillButton(skill, candidates, act, setUi, enabled, title, settings) {
  const node = el('button', 'skill-btn');
  node.type = 'button';
  node.disabled = !enabled;
  node.title = title || '';

  node.appendChild(el('span', 'skill-btn__icon', typeIcon(skill.type)));
  const body = el('span', 'skill-btn__body');
  body.appendChild(el('span', 'skill-btn__name', skill.name));
  body.appendChild(el('span', 'skill-btn__meta', `${typeLabel(skill.type)}${skill.power ? ` ${skill.power}` : ''}`));
  node.appendChild(body);
  node.appendChild(el('span', 'skill-btn__cost', skill.costLabel));

  if (enabled) {
    node.addEventListener('click', () => chooseTarget(candidates, `Choose a target for ${skill.name}`, act, setUi, 'targetUid', settings));
  }
  return node;
}

/**
 * One legal way to play it -> just do it, unless the player has turned off
 * "auto-skip impossible choices" and wants to confirm even a forced target.
 */
function chooseTarget(candidates, prompt, act, setUi, key = 'targetUid', settings = getSettings()) {
  if (!candidates.length) return;
  if (candidates.length === 1 && settings.autoSkipChoices !== false) return act(candidates[0]);
  setUi({ targeting: { candidates, key, prompt, onPick: (action) => act(action) } });
}

/* ------------------------------------------------------------------ *
 * Hand
 * ------------------------------------------------------------------ */

function renderHand(ctx) {
  const { state, viewer, legal, act, setUi, settings } = ctx;
  const player = state.players[viewer];
  const wrap = el('div', 'hand');

  const header = el('div', 'hand__header');
  header.appendChild(el('span', 'hand__label', `Hand ${player.hand.length}/${CONFIG.HAND_LIMIT}`));
  if (player.hand.length > CONFIG.HAND_LIMIT) {
    header.appendChild(el('span', 'hand__warn', `Discard ${player.hand.length - CONFIG.HAND_LIMIT} at end of turn`));
  }
  header.appendChild(el('span', 'hand__hint', 'Hover to inspect · click for detail'));
  wrap.appendChild(header);

  const row = el('div', 'hand__row');
  if (!player.hand.length) row.appendChild(el('div', 'slot__empty slot__empty--thin', 'Your hand is empty'));

  for (const entry of player.hand) {
    row.appendChild(handTile(ctx, entry));
  }
  wrap.appendChild(row);
  return wrap;
}

function handTile(ctx, entry) {
  const { state, viewer, legal, act, setUi, settings } = ctx;
  const card = getCard(entry.cardId);
  const candidates = legal.filter((a) => a.handUid === entry.uid);
  const playable = candidates.length > 0;

  const tile = el('div', `hand-tile hand-tile--${card.type}`);
  tile.dataset.cardId = card.id;
  tile.dataset.handUid = entry.uid;
  if (!playable) tile.classList.add('hand-tile--disabled');

  const style = card.type === 'persona' ? arcanaStyle(card.arcana) : { symbol: card.type === 'item' ? '🧪' : '🌀', color: card.type === 'item' ? '#3fb8b0' : '#e63946' };
  tile.style.setProperty('--arcana', style.color);

  tile.appendChild(el('span', 'hand-tile__symbol', style.symbol));
  tile.appendChild(el('span', 'hand-tile__name', card.name));
  tile.appendChild(
    el('span', 'hand-tile__meta', card.type === 'persona' ? `Lv ${card.level} · ${card.arcana}` : card.type === 'item' ? 'Item' : 'Special')
  );

  const blocked = playable ? null : whyUnplayable(state, viewer, card);
  if (blocked) tile.appendChild(el('span', 'hand-tile__blocked', blocked));

  const actions = [];
  if (playable) {
    actions.push({
      label: card.type === 'persona' ? 'Play to the field' : `Play ${card.name}`,
      primary: true,
      onPick: () => playHandCard(card, candidates, act, setUi, settings),
    });
  }

  makeInspectable(tile, {
    buildCard: () => fullHandCard(entry.cardId),
    detail: () =>
      openCardDetail(document.body, {
        buildCard: () => fullHandCard(entry.cardId),
        title: card.name,
        subtitle: card.type === 'persona' ? `${card.arcana} · Level ${card.level}` : card.type === 'item' ? 'Item card' : 'Special card',
        actions: actions.length ? actions : [],
        ...(blocked ? { subtitle: blocked } : {}),
      }),
  });

  return tile;
}

function whyUnplayable(state, viewer, card) {
  const turn = state.turnState;
  if (state.activePlayer !== viewer) return 'Not your turn';
  if (card.type === 'item' && turn.itemsPlayed >= CONFIG.ITEMS_PER_TURN) return 'Item already used';
  if (card.type === 'special' && turn.specialsPlayed >= CONFIG.SPECIALS_PER_TURN) return 'Special already used';
  if (card.type === 'persona') {
    if (livingField(state, viewer).length >= CONFIG.FIELD_CAP) return 'Field is full';
    const cap = playableLevelCap(state, viewer);
    if (card.level > cap) return `Needs Lv ${cap} board`;
  }
  if (card.usesAction && turn.actionsRemaining <= 0) return 'No action left';
  return 'No valid target';
}

/** SP Transfer needs two Personas, so it gets a two-step selection. */
function playHandCard(card, candidates, act, setUi, settings) {
  if (card.effect?.kind === 'transferSp') {
    const sources = [...new Set(candidates.map((a) => a.fromUid))];
    if (sources.length <= 1) return chooseTarget(candidates, 'Move the SP to which Persona?', act, setUi, 'toUid', settings);
    return setUi({
      targeting: {
        candidates,
        key: 'fromUid',
        prompt: 'Take SP from which Persona?',
        onPick: (picked) => {
          const remaining = candidates.filter((a) => a.fromUid === picked.fromUid);
          chooseTarget(remaining, 'Move the SP to which Persona?', act, setUi, 'toUid', settings);
        },
      },
    });
  }
  chooseTarget(candidates, `Choose a target for ${card.name}`, act, setUi, 'targetUid', settings);
}

/* ------------------------------------------------------------------ *
 * Action bar
 * ------------------------------------------------------------------ */

function renderActionBar(ctx) {
  const { legal, yourTurn, act, setUi, settings } = ctx;
  const bar = el('div', 'action-bar');
  const byType = (type) => legal.filter((a) => a.type === type);

  const guard = byType('GUARD');
  bar.appendChild(button('🛡️ Guard', 'btn', () => act(guard[0]), {
    disabled: !yourTurn || !guard.length,
    title: 'Take half damage and resist knockdown until your next turn',
  }));

  const pass = byType('PASS');
  bar.appendChild(button('⏭️ Pass (+1 card)', 'btn', () => act(pass[0]), {
    disabled: !yourTurn || !pass.length,
    title: 'Give up your action and draw an extra card',
  }));

  // Fusion is always reachable on your turn: the panel itself explains what a
  // recipe still needs, which is the only way to learn the system.
  const ready = yourTurn && hasSatisfiableFusion(ctx.state, ctx.viewer);
  const fusionBtn = button('🌀 Fusion', `btn fusion-btn${ready ? ' fusion-btn--ready' : ''}`,
    () => setUi({ modal: fusionModal(), fusion: { recipeId: null, pairIndex: null, inherit: [] } }), {
      disabled: !yourTurn,
      title: ready ? 'A fusion is available' : 'Browse fusion recipes and see what each one needs',
    });
  if (ready) fusionBtn.appendChild(el('span', 'fusion-btn__badge', '!'));
  bar.appendChild(fusionBtn);

  const endTurn = byType('END_TURN')[0];
  // With auto-end off, hint that the turn is spent instead of ending it for them.
  const onlyMoveLeft = yourTurn && legal.length === 1 && legal[0].type === 'END_TURN';
  const endClass = `btn btn--primary${onlyMoveLeft && !settings?.autoEndTurn ? ' btn--suggested' : ''}`;
  bar.appendChild(button('End turn ▸', endClass, () => {
    if (endTurn.needsChoice) setUi({ modal: discardModal(endTurn, act, setUi) });
    else act(endTurn);
  }, { disabled: !yourTurn || !endTurn, title: 'Pass the turn to your opponent' }));

  return bar;
}

/* ------------------------------------------------------------------ *
 * Modals
 * ------------------------------------------------------------------ */

function modalShell(title, body, onClose) {
  const overlay = el('div', 'modal-overlay');
  const box = el('div', 'modal');
  const head = el('div', 'modal__head');
  head.appendChild(el('h3', null, title));
  head.appendChild(button('✕', 'btn btn--ghost btn--small', onClose));
  box.appendChild(head);
  box.appendChild(body);
  overlay.appendChild(box);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) onClose();
  });
  return overlay;
}

/** The guided fusion panel. Step state lives in `ui.fusion`. */
function fusionModal() {
  return (state, { ui, act, setUi, viewer }) => {
    const { body, title } = renderFusionPanel({
      state,
      playerId: viewer,
      draft: ui.fusion || { recipeId: null, pairIndex: null, inherit: [] },
      skillNameOf,
      onDraft: (fusion) => setUi({ fusion }),
      onConfirm: (action) => act(action),
    });
    return modalShell(title, body, () => setUi({ modal: null, fusion: null }));
  };
}

/** Read-only recipe reference, reachable from the in-match menu. */
function recipeReferenceModal() {
  return (state, { setUi, viewer }) => {
    const { body, title } = renderFusionPanel({
      state,
      playerId: viewer,
      draft: {},
      readOnly: true,
      skillNameOf,
    });
    return modalShell(title, body, () => setUi({ modal: null }));
  };
}

/** Rules and FAQ, as a modal so it never navigates away from a live match. */
function rulesModal() {
  return (state, { setUi }) => {
    const body = el('div', 'modal__body');
    body.appendChild(renderRulesContent());
    return modalShell('Rules & FAQ', body, () => setUi({ modal: null }));
  };
}

/** In-match menu: reference material and the way out. */
function gameMenuModal(onExit) {
  return (state, { setUi }) => {
    const body = el('div', 'modal__body');
    body.appendChild(el('p', 'modal__hint', 'The match stays exactly where it is while this is open.'));

    const list = el('div', 'menu-list');
    list.appendChild(button('📖 Rules & FAQ', 'btn', () => setUi({ modal: rulesModal() })));
    list.appendChild(button('🌀 Fusion recipes', 'btn', () => setUi({ modal: recipeReferenceModal() })));
    // Deliberately NOT a link to the Settings route: routing away destroys the
    // match. Everything you need mid-match is available here as a modal.
    list.appendChild(button('← Quit to main menu', 'btn btn--ghost', onExit));
    body.appendChild(list);

    return modalShell('Menu', body, () => setUi({ modal: null }));
  };
}

function discardModal(endTurn, act, setUi) {
  return (state) => {
    const player = state.players[endTurn.player];
    const need = endTurn.discardCount;
    const picked = new Set();

    const body = el('div', 'modal__body');
    body.appendChild(el('p', 'modal__hint', `Your hand limit is ${CONFIG.HAND_LIMIT}. Choose ${need} card(s) to discard.`));

    const row = el('div', 'modal__cards');
    const confirm = button('Discard & end turn', 'btn btn--primary',
      () => act({ type: 'END_TURN', player: endTurn.player, discard: [...picked] }));
    confirm.disabled = true;

    for (const entry of player.hand) {
      const node = renderCard(getCard(entry.cardId), { compact: true, showAllHidden: true });
      node.classList.add('card--clickable');
      node.addEventListener('click', () => {
        if (picked.has(entry.uid)) picked.delete(entry.uid);
        else if (picked.size < need) picked.add(entry.uid);
        node.classList.toggle('card--selected', picked.has(entry.uid));
        confirm.disabled = picked.size !== need;
      });
      row.appendChild(node);
    }
    body.appendChild(row);
    body.appendChild(confirm);

    return modalShell('Discard down to the hand limit', body, () => setUi({ modal: null }));
  };
}

/* ------------------------------------------------------------------ *
 * Log & game over
 * ------------------------------------------------------------------ */

// A long match produces thousands of log lines and the board re-renders on
// every action, so only the recent tail is kept in the DOM.
const LOG_TAIL = 150;

function renderLog(state) {
  const panel = el('aside', 'log-panel');
  panel.appendChild(el('h3', 'log-panel__title', 'Battle log'));

  const list = el('div', 'log-panel__list');
  const hidden = Math.max(0, state.log.length - LOG_TAIL);
  if (hidden > 0) list.appendChild(el('div', 'log-entry log-entry--system', `… ${hidden} earlier entries`));
  for (const entry of state.log.slice(-LOG_TAIL)) {
    list.appendChild(el('div', `log-entry log-entry--${entry.kind}`, entry.text));
  }
  panel.appendChild(list);

  const pin = () => {
    list.scrollTop = list.scrollHeight;
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(pin);
  else pin();
  return panel;
}

function renderGameOver(state, viewer, { onExit, onRematch, neutralResult }) {
  const won = state.winner === viewer;
  const overlay = el('div', 'modal-overlay modal-overlay--result');
  const box = el('div', `modal result ${neutralResult || won ? 'result--win' : 'result--lose'}`);

  box.appendChild(el('h2', null, neutralResult ? `${state.players[state.winner].name} wins` : won ? 'Victory' : 'Defeat'));
  box.appendChild(el('p', 'result__reason', {
    'ko-target': `${state.players[won ? viewer : opponentOf(viewer)].name} knocked out ${CONFIG.KO_TARGET} Personas.`,
    'simultaneous-ko-hp': 'Simultaneous knockout — decided on remaining HP.',
    'sudden-death': 'Sudden death — decided by the next knockout.',
  }[state.endReason] || 'The match is over.'));

  const stats = el('div', 'result__stats');
  for (const player of state.players) {
    const row = el('div', 'result__row');
    row.appendChild(el('span', null, player.name));
    row.appendChild(el('span', null, `${player.koCount}/${CONFIG.KO_TARGET} lost`));
    row.appendChild(el('span', null, `${livingField(state, player.id).length} standing`));
    stats.appendChild(row);
  }
  box.appendChild(stats);

  const actions = el('div', 'result__actions');
  if (onRematch) actions.appendChild(button('Rematch', 'btn btn--primary', onRematch));
  actions.appendChild(button('Back to menu', 'btn', onExit));
  box.appendChild(actions);

  overlay.appendChild(box);
  return overlay;
}
