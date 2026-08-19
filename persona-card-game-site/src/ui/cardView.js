/**
 * Card renderer — placeholder CSS art only.
 *
 * Returns DOM elements rather than strings so callers can attach click
 * handlers directly. Pure presentation: it reads a card definition (and an
 * optional live in-match `instance`) and never mutates game state.
 *
 * Options:
 *   compact         - smaller card, skills hidden (bench tiles, hand rows, pickers)
 *   revealed        - Set/array of damage types revealed to the viewer; when
 *                     provided, unrevealed weaknesses/resists render as "?"
 *   showAllHidden   - force-reveal everything (gallery, own cards)
 *   instance        - live persona instance { level, hp, sp, ... } to display
 *                     instead of the printed values
 *   selected        - chosen: strong themed ring (see styles/select.css)
 *   targetable      - a legal choice right now: pulsing ring
 *   disabled        - not a legal choice: dimmed
 */
import { arcanaStyle, typeIcon, typeLabel, CARD_TYPE_STYLE } from './arcana.js';
import { getSkillDefinition } from '../data/cards.js';
import { CONFIG } from '../engine/config.js';
import { passiveDefinition } from '../engine/passives.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** A card only one game's deck can play wears its flavour on its face. */
function exclusiveBadge(flavour) {
  const badge = el('span', `card__tag card__tag--exclusive card__tag--${flavour}`, flavour.toUpperCase());
  badge.title = `Exclusive to the ${flavour.toUpperCase()} deck — no other flavour can run it.`;
  return badge;
}

function costLabel(skill) {
  if (skill.type === 'phys') return `${skill.hpCost} HP`;
  if (skill.spCost === 0) return 'Free';
  return `${skill.spCost} SP`;
}

function powerLabel(skill) {
  const { effect } = skill;
  if (effect.kind === 'heal') return effect.amount >= 9999 ? 'Full' : `+${effect.amount}`;
  if (effect.kind === 'drainSp') return `${effect.amount} SP`;
  // Read off BUFF_MULT rather than printed: this used to say "+40%" in text and
  // drifted the moment the constant moved.
  if (effect.kind === 'buff') {
    const pct = Math.round((CONFIG.BUFF_MULT - 1) * 100);
    return effect.direction === 'up' ? `+${pct}%` : `−${pct}%`;
  }
  if (!skill.power) return '—';
  return String(skill.power);
}

/**
 * The Alacrity mark: two forward chevrons over a return arc — "strike, and come
 * straight back". Drawn from primitives like every other piece of art here, so
 * it inherits the card's arcana colour through `currentColor`, scales with the
 * font rather than a fixed pixel size, and needs no asset.
 *
 * It has to survive being 8px tall next to the keyword, which is why it is two
 * strokes and a curve and nothing more.
 */
function alacrityMark() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 16');
  svg.setAttribute('class', 'keyword__mark');
  // Decorative: the word ALACRITY sits right beside it and carries the meaning.
  svg.setAttribute('aria-hidden', 'true');

  const stroke = (d) => {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  };
  stroke('M3 2.5 L8 8 L3 13.5'); // chevron
  stroke('M9 2.5 L14 8 L9 13.5'); // chevron, again — speed
  stroke('M17 4 A5.5 5.5 0 1 1 12.5 13'); // the arc back round
  return svg;
}

function renderSkillRow(skill, unlocked, badge = null) {
  const row = el('li', `skill${unlocked ? '' : ' skill--locked'}${badge ? ' skill--inherited' : ''}`);
  row.appendChild(el('span', 'skill__icon', typeIcon(skill.type)));

  const main = el('div', 'skill__main');
  const top = el('div', 'skill__top');
  top.appendChild(el('span', 'skill__name', skill.name));
  // Keywords sit next to the name so they read as part of the skill, not as
  // fine print buried in the description.
  if (skill.alacrity) {
    const tag = el('span', 'skill__keyword skill__keyword--alacrity');
    tag.appendChild(alacrityMark());
    tag.appendChild(el('span', null, 'ALACRITY'));
    tag.title = 'Using this refunds your Persona change for the turn.';
    top.appendChild(tag);
  }
  top.appendChild(el('span', 'skill__lv', badge || `Lv${skill.unlockLevel}`));
  main.appendChild(top);
  main.appendChild(el('div', 'skill__desc', skill.description));
  row.appendChild(main);

  const stats = el('div', 'skill__stats');
  stats.appendChild(el('span', 'skill__power', powerLabel(skill)));
  stats.appendChild(el('span', 'skill__cost', costLabel(skill)));
  row.appendChild(stats);

  return row;
}

/**
 * The weakness/resist block.
 *
 * A live Persona can have had its chart rewritten (Turn of the Moon and
 * friends), in which case the instance is the truth and the printed card is
 * not — so the instance wins whenever there is one.
 */
function renderAffinities(persona, opts) {
  const inst = opts.instance;
  const chart = {
    weaknesses: inst?.weaknesses ?? persona.weaknesses,
    resists: inst?.resists ?? persona.resists,
  };
  const wrap = el('div', 'card__affinities');
  const revealAll = opts.showAllHidden || !opts.revealed;
  const revealed = opts.revealed ? new Set(opts.revealed) : null;

  const line = (label, types, modifier) => {
    const row = el('div', `affinity affinity--${modifier}`);
    row.appendChild(el('span', 'affinity__label', label));
    const chips = el('div', 'affinity__chips');
    if (types.length === 0) {
      chips.appendChild(el('span', 'chip chip--none', revealAll ? 'None' : '?'));
    } else {
      for (const type of types) {
        const known = revealAll || revealed.has(type);
        const chip = el('span', `chip chip--${modifier}${known ? '' : ' chip--hidden'}`);
        chip.textContent = known ? `${typeIcon(type)} ${typeLabel(type)}` : '?';
        chips.appendChild(chip);
      }
    }
    row.appendChild(chips);
    return row;
  };

  wrap.appendChild(line('WEAK', chart.weaknesses, 'weak'));
  wrap.appendChild(line('RESIST', chart.resists, 'resist'));
  if (inst?.rewritten) {
    const note = el('div', 'card__rewritten', 'REWRITTEN — this card no longer describes it');
    note.title = 'A rewrite Special replaced this Persona\'s weaknesses and resists.';
    wrap.appendChild(note);
  }
  return wrap;
}

/**
 * Live in-match status: buffs/debuffs with remaining duration, ailments,
 * guard stance and a pending Concentrate/Charge.
 */
function renderStatus(instance) {
  const badges = [];

  for (const buff of instance.buffs || []) {
    const up = buff.direction === 'up';
    badges.push({
      cls: up ? 'badge--buff' : 'badge--debuff',
      text: `${up ? '▲' : '▼'} ${buff.stat === 'atk' ? 'ATK' : 'DEF'}`,
      turns: buff.turnsLeft,
      title: `${buff.stat === 'atk' ? 'Attack' : 'Defense'} ${up ? 'up' : 'down'} — ${buff.turnsLeft} turn(s) left`,
    });
  }

  for (const ailment of instance.ailments || []) {
    badges.push({
      cls: `badge--${ailment.type}`,
      text: ailment.type === 'burn' ? '🔥 Burn' : '⚡ Shock',
      turns: ailment.turnsLeft,
      title:
        ailment.type === 'burn'
          ? `Burn — 5 damage at the end of each of its owner's turns, ${ailment.turnsLeft} turn(s) left`
          : 'Shock — cannot act this turn and takes +50% damage',
    });
  }

  for (const charge of instance.charges || []) {
    badges.push({
      cls: 'badge--charge',
      text: charge === 'charge' ? '💥 Charge' : '🌀 Concentrate',
      title: `Next ${charge === 'charge' ? 'physical' : 'magic'} skill deals x2.5 damage`,
    });
  }

  if (instance.guarding) {
    badges.push({ cls: 'badge--guard', text: '🛡️ Guard', title: 'Halved damage, cannot be knocked down' });
  }
  if (instance.knockedDown) {
    badges.push({ cls: 'badge--down', text: '💫 Down', title: 'Knocked down — cannot act until it stands up' });
  }

  if (!badges.length) return null;

  const wrap = el('div', 'card__status');
  for (const badge of badges) {
    const node = el('span', `badge ${badge.cls}`);
    node.title = badge.title;
    node.appendChild(el('span', null, badge.text));
    if (badge.turns != null) node.appendChild(el('span', 'badge__turns', String(badge.turns)));
    wrap.appendChild(node);
  }
  return wrap;
}

function renderStatBar(label, value, max, modifier) {
  const bar = el('div', `bar bar--${modifier}`);
  bar.appendChild(el('span', 'bar__label', label));
  const track = el('div', 'bar__track');
  const fill = el('div', 'bar__fill');
  fill.style.width = `${max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0}%`;
  track.appendChild(fill);
  bar.appendChild(track);
  bar.appendChild(el('span', 'bar__value', `${value}/${max}`));
  return bar;
}

function renderPersonaCard(persona, opts) {
  const style = arcanaStyle(persona.arcana);
  const inst = opts.instance;
  const level = inst?.level ?? persona.level;

  const classes = ['card', 'card--persona'];
  if (opts.compact) classes.push('card--compact');
  if (inst?.knockedDown) classes.push('card--down'); // rendered rotated sideways
  if (inst?.ko) classes.push('card--ko');
  if (opts.selected) classes.push('card--selected');
  if (opts.targetable) classes.push('card--targetable');
  if (opts.disabled) classes.push('card--disabled');

  const card = el('article', classes.join(' '));
  card.style.setProperty('--arcana', style.color);
  card.style.setProperty('--arcana-ink', style.ink);
  card.dataset.cardId = persona.id;
  card.dataset.arcana = persona.arcana;
  if (inst) card.dataset.uid = inst.uid;

  const header = el('header', 'card__header');
  header.appendChild(el('span', 'card__level', `Lv ${level}`));
  const titles = el('div', 'card__titles');
  titles.appendChild(el('h3', 'card__name', persona.name));
  titles.appendChild(el('span', 'card__arcana', persona.arcana));
  header.appendChild(titles);
  if (persona.fusionOnly) header.appendChild(el('span', 'card__tag card__tag--fusion', 'FUSION'));
  if (persona.exclusive) header.appendChild(exclusiveBadge(persona.exclusive));
  card.appendChild(header);

  // Placeholder "art": arcana symbol on a CSS gradient. No real artwork anywhere.
  const art = el('div', 'card__art');
  art.appendChild(el('span', 'card__symbol', style.symbol));
  card.appendChild(art);

  const gauges = el('div', 'card__gauges');
  gauges.appendChild(renderStatBar('HP', inst?.hp ?? persona.hp, inst?.maxHp ?? persona.hp, 'hp'));
  gauges.appendChild(renderStatBar('SP', inst?.sp ?? persona.sp, inst?.maxSp ?? persona.sp, 'sp'));
  card.appendChild(gauges);

  const stats = el('div', 'card__stats');
  const statEntries = [
    ['STR', inst?.strength ?? persona.strength],
    ['MAG', inst?.magic ?? persona.magic],
    ['END', inst?.endurance ?? persona.endurance],
  ];
  for (const [label, value] of statEntries) {
    const box = el('div', 'stat');
    box.appendChild(el('span', 'stat__label', label));
    box.appendChild(el('span', 'stat__value', String(value)));
    stats.appendChild(box);
  }
  card.appendChild(stats);

  card.appendChild(renderAffinities(persona, opts));

  // The passive is always on and can decide a whole exchange, so it sits with
  // the affinities rather than being buried in the skill list. A fusion can
  // swap it, so the instance wins over the printed one.
  // The card definition is already in hand, so read the instance override
  // directly rather than looking the card up again.
  const passiveId = (inst?.passive !== undefined ? inst.passive : persona.passive) || null;
  const passive = passiveId ? passiveDefinition(passiveId) : null;
  if (passive) {
    const row = el('div', 'card__passive');
    row.title = passive.description;
    row.appendChild(el('span', 'card__passive-tag', 'PASSIVE'));
    row.appendChild(el('span', 'card__passive-name', passive.name));
    if (!opts.compact) row.appendChild(el('span', 'card__passive-desc', passive.description));
    if (passiveId !== (persona.passive || null)) row.appendChild(el('span', 'card__passive-tag', 'INHERITED'));
    card.appendChild(row);
  }

  if (inst) {
    const status = renderStatus(inst);
    if (status) card.appendChild(status);
  }

  if (!opts.compact) {
    const skillsWrap = el('div', 'card__skills');
    skillsWrap.appendChild(el('h4', 'card__section', 'Skills'));
    const list = el('ul', 'skill-list');
    for (const skill of persona.skills) {
      list.appendChild(renderSkillRow(skill, skill.unlockLevel <= level));
    }
    // Skills gained from fusion parents live on the instance, not the card, but
    // they are usable — so the card has to show them or it lies about the Persona.
    const printed = new Set(persona.skills.map((s) => s.id));
    for (const skillId of inst?.inheritedSkills ?? []) {
      if (printed.has(skillId)) continue;
      const definition = getSkillDefinition(skillId);
      if (definition) list.appendChild(renderSkillRow({ ...definition, unlockLevel: 1 }, true, 'Inherited'));
    }
    skillsWrap.appendChild(list);
    card.appendChild(skillsWrap);

    const growth = persona.statGrowth;
    const parts = [];
    if (growth.strength) parts.push(`+${growth.strength} STR`);
    if (growth.magic) parts.push(`+${growth.magic} MAG`);
    if (growth.endurance) parts.push(`+${growth.endurance} END`);
    parts.push(`+${growth.hp} HP`, `+${growth.sp} SP`);
    const growthRow = el('div', 'card__growth');
    growthRow.appendChild(el('span', 'card__growth-label', 'Per level'));
    growthRow.appendChild(el('span', 'card__growth-value', parts.join(' · ')));
    card.appendChild(growthRow);

    if (persona.flavor) card.appendChild(el('p', 'card__flavor', persona.flavor));
  }

  return card;
}

function renderSupportCard(cardDef, opts) {
  const kind = CARD_TYPE_STYLE[cardDef.type];
  const classes = ['card', `card--${cardDef.type}`];
  if (opts.compact) classes.push('card--compact');
  if (opts.selected) classes.push('card--selected');
  if (opts.targetable) classes.push('card--targetable');
  if (opts.disabled) classes.push('card--disabled');

  const card = el('article', classes.join(' '));
  card.style.setProperty('--arcana', kind.color);
  card.dataset.cardId = cardDef.id;

  const header = el('header', 'card__header');
  header.appendChild(el('span', 'card__level', kind.symbol));
  const titles = el('div', 'card__titles');
  titles.appendChild(el('h3', 'card__name', cardDef.name));
  titles.appendChild(el('span', 'card__arcana', kind.label));
  header.appendChild(titles);
  if (cardDef.exclusive) header.appendChild(exclusiveBadge(cardDef.exclusive));
  card.appendChild(header);

  const art = el('div', 'card__art card__art--support');
  art.appendChild(el('span', 'card__symbol', kind.symbol));
  card.appendChild(art);

  if (!opts.compact) {
    const body = el('div', 'card__text');
    body.appendChild(el('p', 'card__desc', cardDef.description));
    card.appendChild(body);

    const footer = el('div', 'card__growth');
    footer.appendChild(el('span', 'card__growth-label', 'Action'));
    footer.appendChild(
      el('span', 'card__growth-value', cardDef.usesAction ? 'Uses up your action' : "Doesn't use your action")
    );
    card.appendChild(footer);

    const limit = el('div', 'card__growth');
    limit.appendChild(el('span', 'card__growth-label', 'Limit'));
    limit.appendChild(
      el('span', 'card__growth-value', `1 ${kind.label} card per turn`)
    );
    card.appendChild(limit);
  }

  return card;
}

/** Render any card definition. */
export function renderCard(cardDef, opts = {}) {
  return cardDef.type === 'persona' ? renderPersonaCard(cardDef, opts) : renderSupportCard(cardDef, opts);
}
