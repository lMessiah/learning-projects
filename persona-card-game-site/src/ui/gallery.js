/**
 * Card gallery.
 *
 * Renders every card in the database so the whole set can be inspected visually,
 * plus reference panels for the three starter decks and the fusion recipes.
 */
import {
  PERSONAS,
  ITEMS,
  SPECIALS,
  ALL_CARDS,
  DECKS,
  FUSION_RECIPES,
  STARTER_POOL,
  getCard,
} from '../data/cards.js';
import {
  ARCHETYPES,
  DECK_SHAPE,
  DECK_SIZE,
  MAX_COPIES,
  poolFor,
  exclusivesFor,
  validateAll,
} from '../data/archetypes.js';
import { renderCard } from './cardView.js';
import { arcanaStyle, personaSymbol } from './arcana.js';
import { CONFIG } from '../engine/index.js';

const TYPE_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'persona', label: `Personas (${PERSONAS.length})` },
  { id: 'item', label: `Items (${ITEMS.length})` },
  { id: 'special', label: `Specials (${SPECIALS.length})` },
  { id: 'starter', label: `Starter pool (${STARTER_POOL.length})` },
  { id: 'fusion', label: 'Fusion-only' },
];

const GAME_FILTERS = [
  { id: 'all', label: 'Any' },
  { id: 'p3', label: 'P3' },
  { id: 'p4', label: 'P4' },
  { id: 'p5', label: 'P5' },
];

const SORTS = [
  { id: 'level', label: 'Level (low → high)' },
  { id: 'level-desc', label: 'Level (high → low)' },
  { id: 'name', label: 'Name (A → Z)' },
  { id: 'arcana', label: 'Arcana' },
];

const state = {
  type: 'all',
  game: 'all',
  arcana: 'all',
  sort: 'level',
  search: '',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function matchesType(card) {
  switch (state.type) {
    case 'all':
      return true;
    case 'starter':
      return STARTER_POOL.includes(card.id);
    case 'fusion':
      return Boolean(card.fusionOnly);
    default:
      return card.type === state.type;
  }
}

function matchesSearch(card) {
  if (!state.search) return true;
  const needle = state.search.toLowerCase();
  const haystack = [
    card.name,
    card.arcana || '',
    card.description || '',
    card.flavor || '',
    ...(card.skills || []).map((s) => `${s.name} ${s.type} ${s.description}`),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

function filteredCards() {
  let cards = ALL_CARDS.filter(
    (card) =>
      matchesType(card) &&
      matchesSearch(card) &&
      (state.game === 'all' || card.game === state.game || card.game === 'common' || !card.game) &&
      (state.arcana === 'all' || card.arcana === state.arcana)
  );

  // Support cards have no level/arcana; keep them in a stable trailing block.
  const rank = (c) => (c.type === 'persona' ? 0 : c.type === 'item' ? 1 : 2);
  const cmp = {
    level: (a, b) => rank(a) - rank(b) || (a.level ?? 0) - (b.level ?? 0) || a.name.localeCompare(b.name),
    'level-desc': (a, b) => rank(a) - rank(b) || (b.level ?? 0) - (a.level ?? 0) || a.name.localeCompare(b.name),
    name: (a, b) => a.name.localeCompare(b.name),
    arcana: (a, b) =>
      rank(a) - rank(b) || (a.arcana || '').localeCompare(b.arcana || '') || (a.level ?? 0) - (b.level ?? 0),
  }[state.sort];

  return [...cards].sort(cmp);
}

function pillRow(options, current, onPick) {
  const row = el('div', 'filter__row');
  for (const opt of options) {
    const btn = el('button', `pill${opt.id === current ? ' pill--on' : ''}`, opt.label);
    btn.type = 'button';
    btn.addEventListener('click', () => onPick(opt.id));
    row.appendChild(btn);
  }
  return row;
}

function renderFilters(rerender) {
  const bar = el('div', 'gallery__filters');

  const typeFilter = el('div', 'filter');
  typeFilter.appendChild(el('span', 'filter__label', 'Card type'));
  typeFilter.appendChild(
    pillRow(TYPE_FILTERS, state.type, (id) => {
      state.type = id;
      rerender();
    })
  );
  bar.appendChild(typeFilter);

  const gameFilter = el('div', 'filter');
  gameFilter.appendChild(el('span', 'filter__label', 'Game flavour'));
  gameFilter.appendChild(
    pillRow(GAME_FILTERS, state.game, (id) => {
      state.game = id;
      rerender();
    })
  );
  bar.appendChild(gameFilter);

  const arcanaFilter = el('div', 'filter');
  arcanaFilter.appendChild(el('span', 'filter__label', 'Arcana'));
  const select = el('select');
  const arcanaInUse = [...new Set(PERSONAS.map((p) => p.arcana))].sort();
  for (const opt of ['all', ...arcanaInUse]) {
    const option = el('option', null, opt === 'all' ? 'All arcana' : `${arcanaStyle(opt).symbol} ${opt}`);
    option.value = opt;
    if (opt === state.arcana) option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener('change', () => {
    state.arcana = select.value;
    rerender();
  });
  arcanaFilter.appendChild(select);
  bar.appendChild(arcanaFilter);

  const sortFilter = el('div', 'filter');
  sortFilter.appendChild(el('span', 'filter__label', 'Sort'));
  const sortSelect = el('select');
  for (const opt of SORTS) {
    const option = el('option', null, opt.label);
    option.value = opt.id;
    if (opt.id === state.sort) option.selected = true;
    sortSelect.appendChild(option);
  }
  sortSelect.addEventListener('change', () => {
    state.sort = sortSelect.value;
    rerender();
  });
  sortFilter.appendChild(sortSelect);
  bar.appendChild(sortFilter);

  const searchFilter = el('div', 'filter');
  searchFilter.appendChild(el('span', 'filter__label', 'Search'));
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Name, skill, arcana…';
  input.value = state.search;
  input.addEventListener('input', () => {
    state.search = input.value.trim();
    rerender({ keepFocus: true });
  });
  searchFilter.appendChild(input);
  bar.appendChild(searchFilter);

  return bar;
}

function renderDeckReference() {
  const wrap = el('section');
  const head = el('div', 'section-head');
  head.appendChild(el('h2', null, 'Deck pools'));
  head.appendChild(
    el('span', null, `${DECK_SIZE} cards built per match · max ${MAX_COPIES} copies · ${ARCHETYPES.length} play styles`)
  );
  wrap.appendChild(head);

  wrap.appendChild(
    el(
      'p',
      'ref-note',
      'Decks are generated, not hand-built. Picking a flavour picks the pool below; picking a play style ' +
        'weights which of those cards fill the 30 slots. Every card is tagged 0–3 for each style.'
    )
  );

  const grid = el('div', 'ref-grid');
  for (const deck of DECKS) {
    const pool = poolFor(deck.id);
    const box = el('div', 'ref-card');
    box.style.borderLeftColor = 'var(--accent)';
    box.appendChild(el('h3', null, `${deck.name} (${deck.game.toUpperCase()})`));
    box.appendChild(el('p', 'ref-card__tagline', deck.tagline));
    if (deck.playstyle) box.appendChild(el('p', 'ref-card__playstyle', deck.playstyle));

    const exclusives = exclusivesFor(deck.id);
    if (exclusives.length) {
      const row = el('p', 'ref-card__exclusives');
      row.appendChild(el('span', 'card__tag card__tag--exclusive', 'ONLY HERE'));
      row.appendChild(document.createTextNode(` ${exclusives.map((c) => c.name).join(' · ')}`));
      box.appendChild(row);
    }

    const list = el('ul', 'ref-list');
    const groups = [
      ['Personas', 'persona'],
      ['Items', 'item'],
      ['Specials', 'special'],
    ];
    for (const [label, type] of groups) {
      const cards = pool[type];
      if (!cards.length) continue;
      list.appendChild(el('li', 'ref-list__group', `${label} — ${cards.length} in pool, ${DECK_SHAPE[type]} drawn`));
      for (const card of cards) {
        const row = el('li');
        row.appendChild(el('span', null, card.type === 'persona' ? `${card.name} · Lv${card.level}` : card.name));
        // The affinity block IS the archetype weighting, so show it.
        const best = ARCHETYPES.filter((a) => (card.affinity?.[a.id] ?? 0) >= 2).map((a) => a.icon);
        row.appendChild(el('span', null, best.length ? best.join('') : '·'));
        list.appendChild(row);
      }
    }
    box.appendChild(list);
    grid.appendChild(box);
  }
  wrap.appendChild(grid);

  const styles = el('div', 'ref-card');
  styles.appendChild(el('h3', null, 'Play styles'));
  const styleList = el('ul', 'ref-list');
  for (const archetype of ARCHETYPES) {
    const row = el('li');
    row.appendChild(el('span', null, `${archetype.icon} ${archetype.name}`));
    row.appendChild(el('span', null, archetype.blurb));
    styleList.appendChild(row);
  }
  styles.appendChild(styleList);
  wrap.appendChild(styles);

  return wrap;
}

function renderFusionReference() {
  const wrap = el('section');
  const head = el('div', 'section-head');
  head.appendChild(el('h2', null, 'Fusion recipes'));
  head.appendChild(el('span', null, 'sacrifice 2 Personas · result enters at printed level'));
  wrap.appendChild(head);

  const box = el('div', 'ref-card');
  const list = el('ul', 'ref-list');
  for (const recipe of FUSION_RECIPES) {
    const result = getCard(recipe.result);
    const row = el('li');
    row.appendChild(
      el('span', null, `${personaSymbol(result)} ${result.name} · Lv${result.level}`)
    );
    row.appendChild(el('span', null, recipe.description));
    list.appendChild(row);
  }
  box.appendChild(list);
  wrap.appendChild(box);
  return wrap;
}

function renderValidationBanner() {
  const errors = validateAll();
  if (errors.length === 0) {
    return el(
      'div',
      'notice notice--ok',
      `Card database OK — ${PERSONAS.length} Personas, ${ITEMS.length} Items, ${SPECIALS.length} Specials, ` +
        `${FUSION_RECIPES.length} fusion recipes, ${DECKS.length} flavours x ${ARCHETYPES.length} play styles.`
    );
  }
  const box = el('div', 'notice notice--error');
  box.appendChild(el('strong', null, `Card database has ${errors.length} problem(s):`));
  const list = el('ul');
  for (const err of errors) list.appendChild(el('li', null, err));
  box.appendChild(list);
  return box;
}

/** Quick reference for what a single turn allows, straight from the engine config. */
function renderTurnRules() {
  const rules = [
    `Draw ${CONFIG.DRAW_PER_TURN}`,
    `${CONFIG.ACTIONS_PER_TURN} action (attack / skill / guard / fuse / pass)`,
    `${CONFIG.ITEMS_PER_TURN} Item card`,
    `${CONFIG.SPECIALS_PER_TURN} Special card`,
    `${CONFIG.PERSONA_CHANGES_PER_TURN} Persona change (+1 on a One More)`,
    `Personas to the field up to ${CONFIG.FIELD_CAP}`,
    `Hand limit ${CONFIG.HAND_LIMIT}`,
  ];
  return el('div', 'notice', `Per turn you may: ${rules.join(' · ')}.`);
}

export function renderGallery(root) {
  root.innerHTML = '';

  const topbar = el('div', 'topbar');
  const back = el('button', 'btn btn--ghost', '← Menu');
  back.addEventListener('click', () => {
    window.location.hash = '#/';
  });
  topbar.appendChild(back);
  const titleWrap = el('div');
  titleWrap.appendChild(el('h1', 'topbar__title', 'Card Gallery'));
  titleWrap.appendChild(el('div', 'topbar__sub', 'Every card in the database'));
  topbar.appendChild(titleWrap);
  topbar.appendChild(el('div', 'topbar__spacer'));
  root.appendChild(topbar);

  root.appendChild(renderValidationBanner());
  root.appendChild(renderTurnRules());

  const filterHost = el('div');
  const grid = el('div', 'gallery__grid');
  const countLabel = el('div', 'gallery__count');
  root.appendChild(filterHost);
  root.appendChild(grid);

  const rerender = (opts = {}) => {
    const activeValue = document.activeElement?.type === 'search' ? document.activeElement.value : null;
    filterHost.innerHTML = '';
    const bar = renderFilters(rerender);
    bar.appendChild(countLabel);
    filterHost.appendChild(bar);

    if (opts.keepFocus && activeValue !== null) {
      const input = bar.querySelector('input[type="search"]');
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }

    const cards = filteredCards();
    countLabel.textContent = `${cards.length} card${cards.length === 1 ? '' : 's'}`;
    grid.innerHTML = '';
    if (cards.length === 0) {
      grid.appendChild(el('div', 'gallery__empty', 'No cards match those filters.'));
      return;
    }
    for (const card of cards) {
      grid.appendChild(renderCard(card, { showAllHidden: true }));
    }
  };

  rerender();

  root.appendChild(renderDeckReference());
  root.appendChild(renderFusionReference());
}
