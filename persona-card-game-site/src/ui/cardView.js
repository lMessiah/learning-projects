/**
 * Card renderer — placeholder CSS art only.
 *
 * Returns DOM elements rather than strings so later phases can attach click
 * handlers directly. Pure presentation: it reads a card definition (and an
 * optional live in-match `instance`) and never mutates game state.
 *
 * Options:
 *   compact         - smaller card, skills hidden (bench/hand rows in later phases)
 *   revealed        - Set/array of damage types revealed to the viewer; when
 *                     provided, unrevealed weaknesses/resists render as "?"
 *   showAllHidden   - force-reveal everything (gallery, own cards)
 *   instance        - live persona instance { level, hp, sp, ... } to display
 *                     instead of the printed values
 */
import { arcanaStyle, typeIcon, typeLabel, CARD_TYPE_STYLE } from './arcana.js';
import { getSkillDefinition } from '../data/cards.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function costLabel(skill) {
  if (skill.type === 'phys') return `${skill.hpCost} HP`;
  if (skill.spCost === 0) return 'Free';
  return `${skill.spCost} SP`;
}

function powerLabel(skill) {
  const { effect } = skill;
  if (effect.kind === 'instakill') return `${Math.round(effect.chance * 100)}% KO`;
  if (effect.kind === 'heal') return effect.amount >= 9999 ? 'Full' : `+${effect.amount}`;
  if (effect.kind === 'buff') return effect.direction === 'up' ? '+40%' : '−40%';
  if (!skill.power) return '—';
  return String(skill.power);
}

function renderSkillRow(skill, unlocked, badge = null) {
  const row = el('li', `skill${unlocked ? '' : ' skill--locked'}${badge ? ' skill--inherited' : ''}`);
  row.appendChild(el('span', 'skill__icon', typeIcon(skill.type)));

  const main = el('div', 'skill__main');
  const top = el('div', 'skill__top');
  top.appendChild(el('span', 'skill__name', skill.name));
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

function renderAffinities(persona, opts) {
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

  wrap.appendChild(line('WEAK', persona.weaknesses, 'weak'));
  wrap.appendChild(line('RESIST', persona.resists, 'resist'));
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
