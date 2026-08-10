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
  getLegalActions,
  affinitiesOf,
  twistSacrifice,
  comboMultiplier,
  emptyFieldStage,
  emptyFieldTurnsLeft,
  passiveDefinition,
} from '../../engine/index.js';
import { getCard, getPersona, PERSONAS } from '../../data/cards.js';
import { renderCard } from '../cardView.js';
import { arcanaStyle, typeIcon, typeLabel } from '../arcana.js';
import { makeInspectable, openCardDetail, hideTooltip, fullPersonaCard, fullHandCard } from './inspect.js';
import { diffStates, playEffects, statusTokens, cssDurationVars } from './anim.js';
import { renderFusionPanel, hasSatisfiableFusion } from './fusionPanel.js';
import { getSettings, animationScale, autoEndDelay } from '../settings.js';
import { renderRulesContent } from '../rules.js';
import { renderTips, analyseMatch, STRATEGY_TIPS, GENERAL_TIPS } from '../tips.js';
import { renderMatchStats, mvpOf } from '../matchStats.js';

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

/**
 * Pins a corner badge to a button.
 *
 * The badge is absolutely positioned, which means it anchors to the nearest
 * POSITIONED ancestor rather than to the button — so a badge added to a button
 * that is not itself `position: relative` escapes the action bar entirely and
 * lands in the corner of `.board-screen`. Adding the marker class and the badge
 * in one place is the only way to make that impossible to get wrong the next
 * time a button earns a badge.
 */
function badgeButton(node, text = '!') {
  node.classList.add('btn--badged');
  node.appendChild(el('span', 'btn__badge', text));
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
  // `resultTab` deliberately sits outside the group that `act` resets: which
  // half of the end-of-match screen you were reading is not part of a move.
  // `outroDone` starts true so that MOUNTING onto a finished match — a reload,
  // a spectator joining late — shows the scoreboard immediately. The outro is a
  // reaction to the match ending in front of you, not a property of a finished
  // state, so only the subscription below arms it.
  let ui = { targeting: null, modal: null, fusion: null, gallows: null, outroDone: true, resultTab: 'summary' };
  let previousState = null;
  let pendingEffects = null;
  let autoEndTimer = null;
  // The end-of-match outro's auto-advance. Cleared on every re-render for the
  // same reason autoEndTimer is: a timer that outlives the node it belongs to
  // would fire into a board that has already moved on.
  let outroTimer = null;
  // Survives re-renders so the log keeps its place while you read it.
  const logScroll = { pinned: true, top: 0 };

  const screen = el('div', 'board-screen');
  // The base durations come from the one table in anim.js; the stylesheet only
  // divides them by --anim-scale. Stamped once, since they never change.
  for (const [name, value] of Object.entries(cssDurationVars())) {
    screen.style.setProperty(name, value);
  }
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
    if (outroTimer !== null) {
      clearTimeout(outroTimer);
      outroTimer = null;
    }
    screen.innerHTML = '';
    // 0 would divide by zero in the CSS durations, so park it very high instead.
    screen.style.setProperty('--anim-scale', String(scale || 1000));
    screen.classList.toggle('board-screen--no-anim', scale === 0);
    screen.appendChild(renderTop(state, { ...options, setUi }, viewer));

    // Resigning is offered whenever the match is live — including on your
    // opponent's turn, which is exactly when you are most likely to want it.
    const logOptions = {
      onResign: state.winner === null ? () => setUi({ modal: resignModal(viewer) }) : null,
    };

    if (state.phase === 'starterSelect') {
      const wrap = el('div', 'board-main board-main--single');
      wrap.appendChild(renderStarterSelect(state, viewer, act));
      wrap.appendChild(renderLog(state, logScroll, logOptions));
      screen.appendChild(wrap);
      // The resign dialog is reachable from here too, so modals have to render
      // before this early return, not only on the play screen.
      if (ui.modal) screen.appendChild(ui.modal(state, { ui, act, setUi, viewer }));
      return;
    }

    const main = el('div', 'board-main');
    main.appendChild(renderPlayArea(state, viewer, controller, ui, act, setUi, settings));
    main.appendChild(renderLog(state, logScroll, logOptions));
    screen.appendChild(main);

    // Full Analysis floats OVER the board rather than being inserted into it —
    // an inline panel would shove every tile down the moment it appeared.
    const peek = renderPeek(state, viewer);
    if (peek) screen.appendChild(peek);

    if (ui.modal) screen.appendChild(ui.modal(state, { ui, act, setUi, viewer }));

    // DESIGN NOTE: there is deliberately no "your field is empty, play one of
    // these" prompt. An empty field is a legal state a player may choose to be
    // in — holding Personas back as fusion or Gallows fodder, or waiting for
    // the level cap to reach the card they actually want to land. The countdown
    // in the header is the whole of the enforcement, and it is loud enough.

    // The end of a match gets a beat of its own before the numbers arrive. The
    // outro is skipped outright when animations are off, and a click anywhere on
    // it cuts to the scoreboard.
    if (state.winner !== null) {
      if (scale === 0 || ui.outroDone) {
        screen.appendChild(renderGameOver(state, viewer, options, ui, setUi));
      } else {
        const { node, duration } = matchOutro(state, viewer, options);
        const finish = () => setUi({ outroDone: true });
        node.addEventListener('click', finish);
        outroTimer = setTimeout(finish, Math.round(duration / scale));
        screen.appendChild(node);
      }
    }

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
    const oneMorePending = turn.oneMoreActive;
    const batonPending = turn.personaChangesRemaining > CONFIG.PERSONA_CHANGES_PER_TURN;
    if (oneMorePending || batonPending) return;

    // Resign is legal on every turn and is never a reason to keep the turn
    // open, so it does not count as "something else is still playable".
    const legal = controller.legalActions(viewer).filter((a) => a.type !== 'RESIGN');
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
    ui = { targeting: null, modal: null, fusion: null, gallows: null, outroDone: true };
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
    // The one transition the outro exists for: the match was live a moment ago
    // and is not any more.
    const justEnded = Boolean(previousState) && previousState.winner === null && state.winner !== null;
    previousState = state;
    ui = { targeting: null, modal: null, fusion: null, gallows: null, outroDone: !justEnded };
    rerender();
  });

  previousState = controller.getState();
  rerender();
  controller.start();

  return () => {
    unsubscribe();
    hideTooltip();
    if (autoEndTimer !== null) clearTimeout(autoEndTimer);
    if (outroTimer !== null) clearTimeout(outroTimer);
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

  // Before you pick, all three pulse as valid targets. After you pick, the one
  // you took wears the selected ring and the two you passed on dim out, so the
  // waiting screen still says what you chose.
  const takenId = chosen ? state.players[viewer].field[0]?.cardId : null;

  const row = el('div', 'starter-select__row');
  for (const cardId of state.starterOptions[viewer]) {
    const card = renderCard(getCard(cardId), {
      showAllHidden: true,
      targetable: !chosen,
      selected: chosen && cardId === takenId,
      disabled: chosen && cardId !== takenId,
    });
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
  // The empty-field countdown. Public information — an empty board is the most
  // visible thing on it — so it is drawn on whichever side is on the clock,
  // for both players to see.
  const timer = renderFieldTimer(state, playerId);
  if (timer) header.appendChild(timer);
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

/**
 * Full Analysis: a look at the opponent's hand for the turn.
 *
 * The engine decides whether the cards are readable at all (redaction honours
 * the effect); this only shows what it was handed. It is positioned over the
 * board rather than inside it, so appearing and disappearing moves nothing.
 */
function renderPeek(state, viewer) {
  if (!state.turnState?.peekHand || state.activePlayer !== viewer) return null;
  const foe = state.players[opponentOf(viewer)];

  const peek = el('div', 'peek');
  peek.appendChild(el('span', 'peek__label', `${foe.name}'s hand — Full Analysis`));
  const cards = el('div', 'peek__row');
  for (const entry of foe.hand) {
    if (!entry.cardId) continue; // still hidden: not this player's peek
    cards.appendChild(el('span', 'peek__card', getCard(entry.cardId).name));
  }
  if (!cards.childElementCount) cards.appendChild(el('span', 'peek__card', 'Nothing to see'));
  peek.appendChild(cards);
  return peek;
}

/**
 * The empty-field countdown: how many turns this player has left to put a
 * Persona down before the match is decided without a single further knockout.
 *
 * Returns null when the timer is not running, which is almost always — it is a
 * loud element precisely because it should be rare.
 */
function renderFieldTimer(state, playerId) {
  const stage = emptyFieldStage(state, playerId);
  if (stage <= 0) return null;
  const left = emptyFieldTurnsLeft(state, playerId);

  const wrap = el('div', `field-timer${left <= 1 ? ' field-timer--critical' : ''}`);
  wrap.title =
    `${state.players[playerId].name} has started ${stage} turn${stage === 1 ? '' : 's'} in a row with an empty field. ` +
    `Starting a ${CONFIG.EMPTY_FIELD_LOSS_TURNS + 1}th loses the match. Playing any Persona clears it. ` +
    'While the clock runs, every draw is a Persona for as long as the deck has one.';
  wrap.appendChild(el('span', 'field-timer__label', 'Empty field'));

  // One pip per turn of the allowance, filling up as they are spent.
  const pips = el('div', 'field-timer__pips');
  for (let i = 0; i < CONFIG.EMPTY_FIELD_LOSS_TURNS; i++) {
    pips.appendChild(el('span', `pip${i < stage ? ' pip--on' : ''}`));
  }
  wrap.appendChild(pips);
  wrap.appendChild(el('span', 'field-timer__count', left > 1 ? `${left} turns left` : 'last chance'));
  return wrap;
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

/**
 * The status pips. The token list is shared with anim.js, which needs to be
 * able to redraw this row as it was a moment ago to fade out what expired.
 */
function statusDots(persona) {
  const wrap = el('div', 'tile__status');
  for (const token of statusTokens(persona)) wrap.appendChild(el('span', token.cls, token.text));
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
  // While a prompt is open, everything that is NOT a legal target is dimmed —
  // the pulsing ring says "these", the dimming says "not these".
  if (match) tile.classList.add('tile--targetable');
  else if (targeting) tile.classList.add('tile--dimmed');
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
  // The instance, not the card: a rewritten Persona is no longer what it says.
  const { weaknesses, resists } = affinitiesOf(persona);
  const revealed = new Set(persona.revealedTypes);
  const wrap = el('div', 'tile__affinity');

  const known = (type) => own || revealed.has(type);
  const shown = [
    ...weaknesses.map((t) => ({ type: t, kind: 'weak' })),
    ...resists.map((t) => ({ type: t, kind: 'resist' })),
  ].filter((entry) => known(entry.type));

  if (persona.rewritten) {
    const flag = el('span', 'mini-chip mini-chip--rewritten', '↻');
    flag.title = 'Rewritten — its printed weaknesses and resists no longer apply.';
    wrap.appendChild(flag);
  }
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

/**
 * The strip between the two sides.
 *
 * DESIGN NOTE: this used to grow a full-width ONE MORE banner, which pushed
 * every tile on the board down and back up again mid-turn. The announcement is
 * now the transform-only splash from anim.js plus a chip in the strip below,
 * and the strip itself has a fixed height so swapping between the allowance
 * chips and a targeting prompt cannot move anything either.
 */
function renderMiddle(state, viewer, ui, yourTurn, setUi) {
  const mid = el('div', 'board-mid');

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
    if (turn.oneMoreActive) {
      strip.appendChild(
        el(
          'span',
          'allowance allowance--onemore',
          turn.oneMoresGranted > 1 ? `ONE MORE ×${turn.oneMoresGranted} — bench open` : 'ONE MORE — bench open'
        )
      );
    } else if (turn.canTargetBench) {
      strip.appendChild(el('span', 'allowance allowance--hot', 'Bench targetable'));
    }
    // The knockdown combo, priced the same way the damage formula prices it.
    if (turn.comboStacks > 0) {
      const chip = el(
        'span',
        'allowance allowance--combo',
        `Combo ×${turn.comboStacks} · +${Math.round((comboMultiplier(state) - 1) * 100)}% damage`
      );
      chip.title = 'Every knockdown you score this turn makes the rest of the turn hit harder. It resets when the turn ends.';
      strip.appendChild(chip);
    }
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
 *
 * The board-targeting overlay highlights tiles by looking each candidate's
 * `key` up against a Persona uid. If the candidates do not actually carry that
 * key — because the card asks for something that is not a Persona at all — the
 * overlay would light nothing up and strand the player at a prompt with no
 * valid answer. That was the Lesser Theurgy bug. Rather than trust every caller
 * to remember, the guard lives here: a prompt that could not possibly be
 * answered is never opened.
 */
function chooseTarget(candidates, prompt, act, setUi, key = 'targetUid', settings = getSettings()) {
  if (!candidates.length) return;
  if (candidates.length === 1 && settings.autoSkipChoices !== false) return act(candidates[0]);

  if (!candidates.every((a) => a[key] != null)) {
    // Not reachable from any current card — playHandCard routes all of them —
    // but a new effect shape must fail loudly rather than wedge a turn.
    console.error('Board targeting asked for a key its candidates do not carry', { key, candidates });
    return act(candidates[0]);
  }

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
      onPick: () => playHandCard(card, candidates, act, setUi, settings, { state, viewer }),
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
function playHandCard(card, candidates, act, setUi, settings, { state, viewer } = {}) {
  // Fortune's Draw asks for an Arcana, not a Persona on the board, so the
  // board-targeting overlay has nothing to highlight — it gets a list instead.
  if (card.effect?.kind === 'guaranteedDraw') {
    if (candidates.length === 1 && settings.autoSkipChoices !== false) return act(candidates[0]);
    return setUi({ modal: arcanaModal(card, candidates, act, setUi) });
  }

  // Providence lets you bin any subset of what it shows you. The legal-action
  // list only carries the "throw away the k weakest" ladder (see legal.js), so
  // the UI builds the real choice itself and dispatches whatever you picked.
  if (card.effect?.kind === 'providence') {
    return setUi({ modal: providenceModal(card, candidates[0], act, setUi) });
  }

  // Lesser Theurgy asks WHICH AILMENT, not which Persona — the target is always
  // the enemy active. Its actions are keyed on `ailment`, so the board-targeting
  // overlay has nothing to highlight and it needs a list of its own.
  if (card.effect?.kind === 'inflict') {
    if (candidates.length === 1 && settings.autoSkipChoices !== false) return act(candidates[0]);
    return setUi({
      modal: optionModal(card, candidates, act, setUi, {
        prompt: 'Which ailment?',
        label: (a) => AILMENT_LABELS[a.ailment] ?? a.ailment,
        hint: (a) => AILMENT_HINTS[a.ailment] ?? '',
      }),
    });
  }

  // Twist of Fate asks for an ELEMENT. The list is already filtered to what is
  // legal — nothing they resist, nothing they are already weak to — so the
  // picker can never offer something the engine would then refuse.
  if (card.effect?.kind === 'twistFate') {
    const foe = getActive(state, opponentOf(viewer));
    const given = foe ? twistSacrifice(foe) : null;
    return setUi({
      modal: optionModal(card, candidates, act, setUi, {
        prompt: given
          ? `Name the new weakness — ${nameOf(foe)} will give up ${typeLabel(given)} for it`
          : 'Name the new weakness',
        label: (a) => `${typeIcon(a.element)} ${typeLabel(a.element)}`,
        hint: () => null,
      }),
    });
  }

  // Shuffle Time asks which of the cards it showed you to keep — also not a
  // Persona on the board, and the same soft-lock without this.
  if (card.effect?.kind === 'shuffleTime') {
    if (candidates.length === 1 && settings.autoSkipChoices !== false) return act(candidates[0]);
    return setUi({
      modal: optionModal(card, candidates, act, setUi, {
        prompt: 'Which one do you keep?',
        label: (a) => getCard(a.keepCardId).name,
        hint: (a) => cardKindLabel(getCard(a.keepCardId)),
      }),
    });
  }

  // Traesto asks two board questions in a row: who comes back, and — only if
  // that was the active Persona and the bench has more than one answer — who
  // steps into the slot it left. The second picker is skipped whenever the
  // engine's default is the only legal answer, so the common case stays a
  // single click.
  if (card.effect?.kind === 'retreat') {
    return setUi({
      targeting: {
        candidates,
        key: 'targetUid',
        prompt: 'Pull which Persona back to your hand?',
        onPick: (picked) => {
          if (!picked.needsChoice) return act(picked);
          const options = picked.promoteOptions.map((option) => ({ ...picked, promoteUid: option.uid }));
          chooseTarget(options, 'Who steps up to take the slot?', act, setUi, 'promoteUid', settings);
        },
      },
    });
  }

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
      title: ready
        ? 'A fusion is available — it costs no action, so you can fuse and still attack'
        : 'Browse fusion recipes and see what each one needs',
    });
  if (ready) badgeButton(fusionBtn);
  bar.appendChild(fusionBtn);

  // The Gallows: the small sibling of fusion, and reachable the same way.
  const gallows = byType('GALLOWS');
  const feast = gallows.some((a) => a.tier === 'feast');
  const worthALevel = gallows.some((a) => a.nourishing);
  const gallowsBtn = button(
    '⚰️ Gallows',
    `btn gallows-btn${worthALevel ? ' gallows-btn--ready' : ''}`,
    () => setUi({ modal: gallowsModal(), gallows: { eaterUid: null, foodKey: null, inherit: undefined } }),
    {
      disabled: !yourTurn || !gallows.length,
      title: feast
        ? `A feast is on: food at or above the eater's level is worth +${CONFIG.GALLOWS_FEAST_LEVELS} levels`
        : worthALevel
          ? `Feed a Persona to another of yours for +${CONFIG.GALLOWS_LEVELS} level`
          : 'Bin a Persona the board has outgrown — no levels, but it heals and costs no action',
    }
  );
  if (worthALevel) badgeButton(gallowsBtn);
  bar.appendChild(gallowsBtn);

  const endTurn = byType('END_TURN')[0];
  // With auto-end off, hint that the turn is spent instead of ending it for
  // them. Resign is always on the list and is not a move, so it does not count.
  const playable = legal.filter((a) => a.type !== 'RESIGN');
  const onlyMoveLeft = yourTurn && playable.length === 1 && playable[0].type === 'END_TURN';
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

/**
 * The Gallows panel: pick who eats, then pick what it eats.
 *
 * Every option comes from `getLegalActions`, and each one already says whether
 * the meal is worth a level or only the HP — so the panel never has to re-derive
 * the rule, it only has to show it.
 */
const GALLOWS_TIER_TEXT = {
  feast: 'at or above its level',
  meal: `within ${CONFIG.COMEBACK_FARM_GAP} levels below it`,
  junk: `more than ${CONFIG.COMEBACK_FARM_GAP} levels below it`,
};

/** What a chosen meal is worth, in words, before anything is committed. */
function gallowsPayoff(option) {
  if (option.tier === 'junk') {
    return `+${Math.round(CONFIG.GALLOWS_JUNK_HEAL * 100)}% HP · free`;
  }
  const bump = option.statBump ? ` · +${option.statBumpAmount} ${option.statBump}` : '';
  return `+${option.levels} level${option.levels === 1 ? '' : 's'}${bump} · costs your action`;
}

const foodKey = (option) => `${option.food.zone}:${option.food.uid}`;

/**
 * The confirm step: exactly what this sacrifice buys, spelled out, plus the one
 * choice the engine cannot make for you — which skill (if any) to keep.
 *
 * Everything shown is read straight off the legal action. The engine already
 * decided the tier, the levels, whether a skill can be inherited and which stat
 * a feast raises; the panel only has to say so.
 */
function gallowsConfirm(option, eater, draft, { act, setUi }) {
  const box = el('div', 'gallows-confirm');
  const foodName = getPersona(option.foodCardId).name;
  box.appendChild(
    el('h4', 'gallows__heading', `${foodName} → ${nameOf(eater)}`)
  );

  const lines = el('ul', 'gallows-confirm__lines');
  const line = (label, value) => {
    const row = el('li', 'gallows-confirm__line');
    row.appendChild(el('span', 'gallows-confirm__label', label));
    row.appendChild(el('span', 'gallows-confirm__value', value));
    lines.appendChild(row);
  };

  line('Tier', option.tier === 'junk' ? 'Junk' : option.tier === 'meal' ? 'Meal' : 'Feast');
  line(
    'Levels',
    option.levels ? `+${option.levels} (Lv ${eater.level} → ${eater.level + option.levels})` : 'none'
  );
  if (option.tier === 'junk') line('Heals', `+${option.heal} HP`);
  line(
    'Stat',
    option.statBump ? `+${option.statBumpAmount} ${option.statBump}, permanently` : 'unchanged'
  );
  line('Costs', option.usesAction ? 'your action' : 'nothing');
  line(
    'Inherits',
    option.canInherit
      ? option.inheritOptions.length
        ? 'pick one, below'
        : 'nothing left to learn'
      : 'junk food teaches nothing'
  );
  line(
    'Passive',
    option.canInheritPassive
      ? option.inheritOptions.some((o) => o.kind === 'passive')
        ? 'can be taken instead of a skill'
        : 'nothing to take'
      : 'only a feast can move one'
  );
  box.appendChild(lines);

  // `undefined` means "the player has not touched this yet", which is not the
  // same as choosing to keep nothing — so the engine's default stands until
  // they say otherwise.
  const chosen = draft.inherit === undefined ? option.inherit : draft.inherit;
  const chosenOption = option.inheritOptions.find((o) => o.id === chosen) ?? null;
  // Taking a passive over one the eater already has needs saying out loud, and
  // the engine refuses the action without the confirmation flag.
  const replacing =
    chosenOption?.kind === 'passive' && option.eaterPassive && option.eaterPassive !== chosenOption.passiveId;

  if (option.canInherit && option.inheritOptions.length) {
    const picker = el('div', 'gallows__row gallows__row--skills');
    const choose = (id) => setUi({ gallows: { ...draft, inherit: id } });
    picker.appendChild(button('Take nothing', `btn btn--small${chosen ? '' : ' btn--on'}`, () => choose(null)));
    for (const entry of option.inheritOptions) {
      const label = entry.kind === 'passive' ? `${entry.name} (passive)` : entry.name;
      picker.appendChild(
        button(label, `btn btn--small${chosen === entry.id ? ' btn--on' : ''}`, () => choose(entry.id))
      );
    }
    box.appendChild(picker);
  }

  if (replacing) {
    box.appendChild(
      el(
        'p',
        'gallows-confirm__warning',
        `${nameOf(eater)} will LOSE ${passiveDefinition(option.eaterPassive)?.name ?? option.eaterPassive} — ` +
          'a Persona carries only one passive.'
      )
    );
  }

  const buttons = el('div', 'gallows__row gallows__row--confirm');
  buttons.appendChild(
    button(replacing ? 'Feed it and replace the passive' : 'Feed it', 'btn btn--primary', () =>
      act({
        ...option,
        inherit: option.canInherit ? chosen ?? null : null,
        replacePassive: replacing,
      })
    )
  );
  buttons.appendChild(
    button('Pick something else', 'btn btn--ghost', () =>
      setUi({ gallows: { eaterUid: draft.eaterUid, foodKey: null, inherit: undefined } })
    )
  );
  box.appendChild(buttons);
  return box;
}

function gallowsModal() {
  return (state, { ui, act, setUi, viewer }) => {
    const options = getLegalActions(state, viewer).filter((a) => a.type === 'GALLOWS');
    const draft = ui.gallows || { eaterUid: null, foodKey: null, inherit: undefined };

    const body = el('div', 'modal__body');
    body.appendChild(
      el(
        'p',
        'modal__hint',
        'Sacrifice one Persona to feed another. What you get back depends entirely on how the food compares ' +
          'with the eater. A fed Persona is never a knockout. One nourishing meal and one free junk ' +
          'disposal per turn — they are counted separately.'
      )
    );

    // The three tiers, stated up front — the panel is where this rule is learnt.
    const ladder = el('ul', 'gallows-tiers');
    for (const [tier, gains] of [
      ['feast', `+${CONFIG.GALLOWS_FEAST_LEVELS} levels, a skill, +${CONFIG.GALLOWS_STAT_BUMP} stat — costs your action`],
      ['meal', `+${CONFIG.GALLOWS_LEVELS} level and a skill — costs your action`],
      ['junk', `no levels, no skill, +${Math.round(CONFIG.GALLOWS_JUNK_HEAL * 100)}% HP — and costs no action`],
    ]) {
      const row = el('li', `gallows-tier gallows-tier--${tier}`);
      row.appendChild(el('span', 'gallows-tier__name', tier === 'junk' ? 'Junk' : tier === 'meal' ? 'Meal' : 'Feast'));
      row.appendChild(el('span', 'gallows-tier__when', `Food ${GALLOWS_TIER_TEXT[tier]}`));
      row.appendChild(el('span', 'gallows-tier__gain', gains));
      ladder.appendChild(row);
    }
    body.appendChild(ladder);

    if (!options.length) {
      body.appendChild(el('p', 'modal__hint', 'Nothing to feed, or nothing to feed it to.'));
      return modalShell('The Gallows', body, () => setUi({ modal: null, gallows: null }));
    }

    const eaters = [...new Set(options.map((a) => a.eaterUid))];
    body.appendChild(el('h4', 'gallows__heading', 'Who eats?'));
    const eaterRow = el('div', 'gallows__row');
    for (const uid of eaters) {
      const persona = state.players[viewer].field.find((p) => p.uid === uid);
      const label = `${nameOf(persona)} · Lv ${persona.level}`;
      const node = button(label, `btn btn--small${draft.eaterUid === uid ? ' btn--on' : ''}`, () =>
        setUi({ gallows: { eaterUid: uid, foodKey: null, inherit: undefined } })
      );
      eaterRow.appendChild(node);
    }
    body.appendChild(eaterRow);

    if (draft.eaterUid) {
      // Best tier first, so the strongest meal is never buried in the list.
      const rank = { feast: 0, meal: 1, junk: 2 };
      const meals = options
        .filter((a) => a.eaterUid === draft.eaterUid)
        .sort((a, b) => rank[a.tier] - rank[b.tier]);

      body.appendChild(el('h4', 'gallows__heading', 'And what does it eat?'));
      const mealRow = el('div', 'gallows__row gallows__row--meals');
      for (const option of meals) {
        const card = getPersona(option.foodCardId);
        const from = option.food.zone === 'hand' ? 'hand' : 'field';
        const chosen = draft.foodKey === foodKey(option);
        const node = button(
          '',
          `btn btn--small gallows-meal gallows-meal--${option.tier}${chosen ? ' btn--on' : ''}${
            option.tier === 'feast' && !draft.foodKey ? ' btn--suggested' : ''
          }`,
          // Picking a meal no longer commits it: the confirm step below spells
          // out exactly what lands before anything is eaten.
          () => setUi({ gallows: { eaterUid: draft.eaterUid, foodKey: foodKey(option), inherit: undefined } }),
          { title: `${option.tier.toUpperCase()} — ${gallowsPayoff(option)}` }
        );
        node.dataset.tier = option.tier;
        node.appendChild(el('span', 'gallows-meal__name', `${card.name} (${from})`));
        node.appendChild(el('span', 'gallows-meal__tier', option.tier === 'junk' ? 'Junk' : option.tier === 'meal' ? 'Meal' : 'Feast'));
        node.appendChild(el('span', 'gallows-meal__gain', gallowsPayoff(option)));
        mealRow.appendChild(node);
      }
      body.appendChild(mealRow);

      const picked = meals.find((option) => foodKey(option) === draft.foodKey);
      if (picked) {
        const eater = state.players[viewer].field.find((p) => p.uid === draft.eaterUid);
        body.appendChild(gallowsConfirm(picked, eater, draft, { act, setUi }));
      }
    }

    return modalShell('The Gallows', body, () => setUi({ modal: null, gallows: null }));
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

/** Every tip in the game, playstyle plans first. */
function tipsModal() {
  return (state, { setUi }) => {
    const body = el('div', 'modal__body');
    body.appendChild(
      el('p', 'modal__hint', 'Six plans that actually work, then the rules of thumb behind them.')
    );
    body.appendChild(renderTips(STRATEGY_TIPS, { heading: 'Ways to win' }));
    body.appendChild(renderTips(GENERAL_TIPS, { heading: 'Rules of thumb' }));
    return modalShell('Tips', body, () => setUi({ modal: null }));
  };
}

/** In-match menu: reference material and the two ways out. */
function gameMenuModal(onExit) {
  return (state, { setUi, viewer }) => {
    const body = el('div', 'modal__body');
    body.appendChild(el('p', 'modal__hint', 'The match stays exactly where it is while this is open.'));

    const list = el('div', 'menu-list');
    list.appendChild(button('📖 Rules & FAQ', 'btn', () => setUi({ modal: rulesModal() })));
    list.appendChild(button('💡 Tips', 'btn', () => setUi({ modal: tipsModal() })));
    list.appendChild(button('🌀 Fusion recipes', 'btn', () => setUi({ modal: recipeReferenceModal() })));
    if (state.winner === null) {
      list.appendChild(button('🏳️ Resign the match', 'btn', () => setUi({ modal: resignModal(viewer) })));
    }
    // Deliberately NOT a link to the Settings route: routing away destroys the
    // match. Everything you need mid-match is available here as a modal.
    list.appendChild(button('← Quit to main menu', 'btn btn--ghost', onExit));
    body.appendChild(list);

    return modalShell('Menu', body, () => setUi({ modal: null }));
  };
}

/**
 * Resigning is irreversible and reachable from two places, so it always goes
 * through this confirmation — and the confirm button is never the one your
 * finger is already resting on.
 */
function resignModal(viewer) {
  return (state, { act, setUi }) => {
    const body = el('div', 'modal__body');
    body.appendChild(
      el(
        'p',
        'modal__hint',
        `Resigning ends the match right now and hands the win to ${state.players[opponentOf(viewer)].name}. There is no undo.`
      )
    );

    const list = el('div', 'menu-list');
    list.appendChild(button('Keep playing', 'btn btn--primary', () => setUi({ modal: null })));
    list.appendChild(
      button('🏳️ Yes, resign', 'btn btn--danger', () => act({ type: 'RESIGN', player: viewer }))
    );
    body.appendChild(list);

    return modalShell('Resign the match?', body, () => setUi({ modal: null }));
  };
}

const AILMENT_LABELS = { burn: '🔥 Burn', shock: '⚡ Shock' };
const AILMENT_HINTS = {
  burn: `${CONFIG.BURN_DAMAGE} damage at the end of each of its turns, and sets up a fire/wind Technical`,
  shock: 'It loses its next turn, takes more damage, and sets up a physical Technical right now',
};

const cardKindLabel = (card) =>
  card.type === 'persona' ? `Lv ${card.level} · ${card.arcana}` : card.type === 'item' ? 'Item' : 'Special';

/**
 * A card that needs a choice which is NOT a Persona on the board.
 *
 * These are the ones that used to strand the player: the legal actions are
 * keyed on something else entirely (`ailment`, `keepIndex`), so the targeting
 * overlay had no tile to highlight and no way to answer the prompt. They get a
 * list — with a Cancel that costs nothing, because nothing has been dispatched
 * until one of these buttons is pressed.
 */
function optionModal(card, candidates, act, setUi, { prompt, label, hint }) {
  return () => {
    const body = el('div', 'modal__body');
    body.appendChild(el('p', 'modal__hint', card.description));
    body.appendChild(el('h4', 'gallows__heading', prompt));

    const row = el('div', 'option-choices');
    for (const candidate of candidates) {
      const node = button('', 'btn option-choice', () => act(candidate));
      node.appendChild(el('span', 'option-choice__label', label(candidate)));
      const detail = hint?.(candidate);
      if (detail) node.appendChild(el('span', 'option-choice__hint', detail));
      row.appendChild(node);
    }
    body.appendChild(row);
    body.appendChild(button('Cancel', 'btn btn--ghost', () => setUi({ modal: null })));

    return modalShell(card.name, body, () => setUi({ modal: null }));
  };
}

/** Fortune's Draw: name an Arcana still sitting in your deck. */
function arcanaModal(card, candidates, act, setUi) {
  return () => {
    const body = el('div', 'modal__body');
    body.appendChild(el('p', 'modal__hint', card.description));

    const row = el('div', 'arcana-choices');
    for (const candidate of candidates) {
      const style = arcanaStyle(candidate.arcana);
      const node = button(`${style.symbol} ${candidate.arcana}`, 'btn arcana-choice', () => act(candidate));
      node.style.setProperty('--arcana', style.color);
      row.appendChild(node);
    }
    body.appendChild(row);

    return modalShell(card.name, body, () => setUi({ modal: null }));
  };
}

/**
 * Providence: the top of your deck, laid out, with any number of them binnable.
 * Everything you leave stays on top in the order it was already in, so the
 * cards are shown left-to-right in draw order.
 */
function providenceModal(card, base, act, setUi) {
  return () => {
    const top = base.providenceTop ?? [];
    const picked = new Set();

    const body = el('div', 'modal__body');
    body.appendChild(el('p', 'modal__hint', card.description));

    const confirm = button('Confirm', 'btn btn--primary', () =>
      act({ ...base, discardIndexes: [...picked].sort((a, b) => a - b) })
    );
    const summary = el('p', 'modal__hint providence__summary');
    const refresh = () => {
      summary.textContent = picked.size
        ? `Discarding ${picked.size} — the other ${top.length - picked.size} stay on top, in order.`
        : 'Keeping all of them. Click a card to throw it away.';
    };
    refresh();

    const row = el('div', 'modal__cards');
    top.forEach((cardId, index) => {
      const node = renderCard(getCard(cardId), { compact: true, showAllHidden: true, targetable: true });
      node.classList.add('card--clickable');
      node.appendChild(el('span', 'providence__order', `${index + 1}`));
      node.addEventListener('click', () => {
        if (picked.has(index)) picked.delete(index);
        else picked.add(index);
        node.classList.toggle('card--discarding', picked.has(index));
        refresh();
      });
      row.appendChild(node);
    });

    body.appendChild(row);
    body.appendChild(summary);
    body.appendChild(confirm);

    return modalShell(card.name, body, () => setUi({ modal: null }));
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

    const nodes = [];
    for (const entry of player.hand) {
      const node = renderCard(getCard(entry.cardId), { compact: true, showAllHidden: true, targetable: true });
      node.classList.add('card--clickable');
      node.addEventListener('click', () => {
        if (picked.has(entry.uid)) picked.delete(entry.uid);
        else if (picked.size < need) picked.add(entry.uid);
        node.classList.toggle('card--selected', picked.has(entry.uid));
        confirm.disabled = picked.size !== need;
        // Once the quota is met, the cards you did not pick stop pulsing and
        // dim — the only useful click left is on one of your own choices.
        const full = picked.size === need;
        for (const other of nodes) {
          const chosen = other.classList.contains('card--selected');
          other.classList.toggle('card--targetable', !chosen && !full);
          other.classList.toggle('card--dimmed', !chosen && full);
        }
      });
      nodes.push(node);
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

// How close to the bottom still counts as "following along". Anything above
// this and the reader is deliberately looking at something older, so the feed
// stops yanking them back down.
const LOG_PIN_SLACK = 24;

/**
 * The battle log: a scrolling feed of everything that happened, styled by kind.
 *
 * It lives in its own fixed-width grid column with its own scroll container, so
 * however much it says it can never move a single pixel of the board. That is
 * the entire reason it exists in this shape — the feedback that used to be
 * shown as banners *inside* the board is now either a line in here or a
 * transform-only overlay, and neither can reflow anything.
 *
 * `scroll` is owned by the mount and survives re-renders, so the log keeps
 * following the newest entry unless the player has scrolled up to read.
 */
function renderLog(state, scroll, { onResign = null } = {}) {
  const panel = el('aside', 'log-panel');
  const head = el('div', 'log-panel__head');
  head.appendChild(el('h3', 'log-panel__title', 'Battle log'));
  if (onResign) {
    head.appendChild(
      button('🏳️ Resign', 'btn btn--ghost btn--small log-panel__resign', onResign, {
        title: 'Concede the match to your opponent',
      })
    );
  }
  panel.appendChild(head);

  const list = el('div', 'log-panel__list');
  const hidden = Math.max(0, state.log.length - LOG_TAIL);
  if (hidden > 0) list.appendChild(el('div', 'log-entry log-entry--system', `… ${hidden} earlier entries`));
  for (const entry of state.log.slice(-LOG_TAIL)) {
    list.appendChild(el('div', `log-entry log-entry--${entry.kind}`, entry.text));
  }
  panel.appendChild(list);

  list.addEventListener('scroll', () => {
    scroll.top = list.scrollTop;
    scroll.pinned = list.scrollHeight - list.scrollTop - list.clientHeight <= LOG_PIN_SLACK;
  });

  const settle = () => {
    if (scroll.pinned) list.scrollTop = list.scrollHeight;
    else list.scrollTop = Math.min(scroll.top, list.scrollHeight);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(settle);
  else settle();
  return panel;
}

/**
 * The whole battle log, start to finish, for the end-of-match screen.
 *
 * The sidebar keeps only the recent tail in the DOM because the board
 * re-renders constantly; nothing re-renders after the match, so this shows the
 * lot. It is the same feed with the same per-kind styling — a match you just
 * lost is exactly when you want to scroll back and find out where it went.
 */
function renderFullLog(state) {
  const wrap = el('div', 'result-log');
  wrap.appendChild(
    el('p', 'modal__hint', `Every one of the ${state.log.length} entries, from the opening draw to the last knockout.`)
  );

  const list = el('div', 'result-log__list');
  for (const entry of state.log) {
    list.appendChild(el('div', `log-entry log-entry--${entry.kind}`, entry.text));
  }
  wrap.appendChild(list);
  return wrap;
}

/**
 * The end-of-match flourish, shown for one beat before the scoreboard.
 *
 * Entirely CSS: the only JavaScript here is choosing which of two variants to
 * build and which card to put in the middle. Every animation is declared in
 * board.css against `--anim-scale`, so the animation-speed setting governs it
 * exactly as it governs everything else, and "Off" skips the outro outright
 * (see the caller) rather than playing it instantly.
 *
 * Two variants and no third: you either won or you did not. A resigner sees the
 * defeat side and the player they resigned to sees the victory side, because
 * both read `state.winner` against their own seat — nothing about resignation
 * needs a special case. Hot-seat is the one exception: with both players at one
 * screen there is no "you", so it announces the winner by name.
 *
 * @returns {{node: HTMLElement, duration: number}} `duration` is in unscaled ms;
 *          the caller divides it by the animation scale, the same as the CSS.
 */
function matchOutro(state, viewer, { neutralResult } = {}) {
  const neutral = Boolean(neutralResult);
  const won = neutral || state.winner === viewer;
  const node = el('div', `match-outro match-outro--${won ? 'win' : 'lose'}`);
  node.appendChild(el('div', 'match-outro__scrim'));
  // The desaturation sweep is a single element that wipes across the darkened
  // board. Victory has no equivalent — it has the particles instead.
  if (!won) node.appendChild(el('div', 'match-outro__sweep'));

  const stage = el('div', 'match-outro__stage');

  // The Persona that carried the match, front and centre. On a defeat it is the
  // winner's, which is the honest answer to "what beat me".
  const mvp = mvpOf(state, won && !neutral ? viewer : state.winner);
  if (mvp) {
    const card = el('div', 'match-outro__card');
    card.appendChild(renderCard(getPersona(mvp.persona.cardId), { level: mvp.persona.level }));
    if (won) card.appendChild(el('div', 'match-outro__shine'));
    stage.appendChild(card);
  }

  const banner = el('div', 'match-outro__banner');
  banner.appendChild(
    el('span', 'match-outro__word', neutral ? state.players[state.winner].name.toUpperCase() : won ? 'VICTORY' : 'DEFEAT')
  );
  if (mvp) {
    banner.appendChild(
      el('span', 'match-outro__mvp', `${getPersona(mvp.persona.cardId).name} — ${mvp.damage} damage, ${mvp.kos} KO${mvp.kos === 1 ? '' : 's'}`)
    );
  }
  stage.appendChild(banner);

  if (won) {
    // Twelve particles, thrown outward on angles set inline so the stylesheet
    // does not need twelve near-identical keyframe blocks. Themed by the same
    // CSS variables as the rest of the board, so each deck's burst is its own.
    const burst = el('div', 'match-outro__particles');
    for (let i = 0; i < 12; i++) {
      const spark = el('span', 'match-outro__spark');
      spark.style.setProperty('--angle', `${i * 30}deg`);
      spark.style.setProperty('--delay', `${i * 40}ms`);
      burst.appendChild(spark);
    }
    stage.appendChild(burst);
  }

  node.appendChild(stage);
  node.appendChild(el('p', 'match-outro__hint', 'Click to skip'));
  return { node, duration: 2600 };
}

function renderGameOver(state, viewer, { onExit, onRematch, neutralResult }, ui = {}, setUi = () => {}) {
  const won = state.winner === viewer;
  const tab = ui.resultTab === 'log' ? 'log' : 'summary';
  const overlay = el('div', 'modal-overlay modal-overlay--result');
  const box = el('div', `modal result ${neutralResult || won ? 'result--win' : 'result--lose'}`);

  box.appendChild(el('h2', null, neutralResult ? `${state.players[state.winner].name} wins` : won ? 'Victory' : 'Defeat'));
  const resignedBy = state.players[opponentOf(state.winner)].name;
  box.appendChild(el('p', 'result__reason', {
    'ko-target': `${state.players[won ? viewer : opponentOf(viewer)].name} knocked out ${CONFIG.KO_TARGET} Personas.`,
    'simultaneous-ko-hp': 'Simultaneous knockout — decided on remaining HP.',
    'sudden-death': 'Sudden death — decided by the next knockout.',
    'empty-field': `${state.players[opponentOf(state.winner)].name} spent ${CONFIG.EMPTY_FIELD_LOSS_TURNS} turns with an empty field.`,
    resign: neutralResult
      ? `${resignedBy} resigned.`
      : won
        ? `${resignedBy} resigned — you win!`
        : 'You resigned.',
  }[state.endReason] || 'The match is over.'));

  // The result overlay sits on top of the board and blurs it, which used to
  // take the battle log away at exactly the moment it is most worth reading.
  // It gets its own view here instead.
  const tabs = el('div', 'result-tabs');
  for (const [id, label] of [['summary', 'Summary'], ['log', `Battle log (${state.log.length})`]]) {
    const node = button(label, `btn btn--small result-tab${tab === id ? ' result-tab--on' : ''}`, () =>
      setUi({ resultTab: id })
    );
    node.dataset.tab = id;
    tabs.appendChild(node);
  }
  box.appendChild(tabs);

  if (tab === 'log') {
    box.appendChild(renderFullLog(state));
  } else {
    const standing = el('div', 'result__stats');
    for (const player of state.players) {
      const row = el('div', 'result__row');
      row.appendChild(el('span', null, player.name));
      row.appendChild(el('span', null, `${player.koCount}/${CONFIG.KO_TARGET} lost`));
      row.appendChild(el('span', null, `${livingField(state, player.id).length} standing`));
      standing.appendChild(row);
    }
    box.appendChild(standing);

    // Losing is the moment advice is worth reading. Tips are off for the neutral
    // hot-seat result, where "you" is ambiguous — the scoreboard is not, because
    // it never says "you" in the first place.
    if (!neutralResult && !won && state.players[viewer]?.stats) {
      box.appendChild(renderTips(analyseMatch(state, viewer), { heading: 'What to try next time' }));
    }

    box.appendChild(renderMatchStats(state));
  }

  const actions = el('div', 'result__actions');
  if (onRematch) actions.appendChild(button('▶ Play again', 'btn btn--primary', onRematch));
  actions.appendChild(button('Main menu', 'btn', onExit));
  box.appendChild(actions);

  overlay.appendChild(box);
  return overlay;
}
