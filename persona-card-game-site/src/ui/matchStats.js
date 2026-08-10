/**
 * The post-match scoreboard.
 *
 * Everything here is read straight off the finished state — the per-player
 * `stats` block, the `koTimeline`, and the contribution counters on each
 * Persona instance. Nothing is mined out of the log, because the log is capped
 * and a long match has already forgotten its own opening.
 *
 * Pure presentation: state in, DOM out, nothing mutated.
 */
import { CONFIG } from '../engine/index.js';
import { getPersona } from '../data/cards.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const nameOf = (cardId) => getPersona(cardId).name;

/**
 * The Persona that carried a side, by damage, with knockouts as the tiebreak.
 * Returns null for a player whose Personas never landed anything.
 */
export function mvpOf(state, playerId) {
  const field = state.players[playerId]?.field ?? [];
  let best = null;
  for (const persona of field) {
    const damage = persona.dmgDealt ?? 0;
    const kos = persona.kos ?? 0;
    if (damage <= 0 && kos <= 0) continue;
    if (!best || damage > best.damage || (damage === best.damage && kos > best.kos)) {
      best = { persona, damage, kos };
    }
  }
  return best;
}

/** Every number the screen shows for one side, in display order. */
export function summarise(state, playerId) {
  const player = state.players[playerId];
  const stats = player.stats ?? {};
  return {
    name: player.name,
    koCount: player.koCount,
    rows: [
      ['Damage dealt', stats.damageDealt ?? 0],
      ['Damage taken', stats.damageTaken ?? 0],
      ['One Mores', stats.oneMores ?? 0],
      ['Technicals', stats.technicals ?? 0],
      ['Weakness hits', stats.weaknessHits ?? 0],
      ['Fusions', stats.fusions ?? 0],
      ['Gallows', stats.gallows ?? 0],
      ['Showtimes', stats.showtimes ?? 0],
      ['Cards drawn', stats.cardsDrawn ?? 0],
      ['Cards played', stats.cardsPlayed ?? 0],
      ['SP spent', stats.spSpent ?? 0],
    ],
    biggestHit: stats.biggestHit ?? null,
    mvp: mvpOf(state, playerId),
  };
}

function renderSide(summary) {
  const column = el('div', 'stats-col');
  column.appendChild(el('h4', 'stats-col__name', summary.name));
  column.appendChild(el('div', 'stats-col__ko', `${summary.koCount}/${CONFIG.KO_TARGET} Personas lost`));

  const table = el('dl', 'stats-table');
  for (const [label, value] of summary.rows) {
    table.appendChild(el('dt', 'stats-table__label', label));
    table.appendChild(el('dd', 'stats-table__value', String(value)));
  }
  column.appendChild(table);

  const hit = summary.biggestHit;
  column.appendChild(
    el(
      'div',
      'stats-col__note',
      hit
        ? `Biggest hit — ${hit.source} for ${hit.amount}, ${hit.by} on ${hit.target} (turn ${hit.turn})`
        : 'Biggest hit — never landed one'
    )
  );
  column.appendChild(
    el(
      'div',
      'stats-col__note stats-col__note--mvp',
      summary.mvp
        ? `MVP — ${nameOf(summary.mvp.persona.cardId)}: ${summary.mvp.damage} damage, ${summary.mvp.kos} KO${summary.mvp.kos === 1 ? '' : 's'}`
        : 'MVP — nobody landed a blow'
    )
  );
  return column;
}

/** The knockout order, as a single readable strip. */
function renderTimeline(state) {
  const timeline = state.koTimeline ?? [];
  const wrap = el('div', 'ko-timeline');
  wrap.appendChild(el('h4', 'stats__heading', 'Knockout timeline'));

  if (!timeline.length) {
    wrap.appendChild(el('p', 'stats-col__note', 'Nobody was knocked out.'));
    return wrap;
  }

  const list = el('ol', 'ko-timeline__list');
  for (const entry of timeline) {
    const item = el('li', `ko-timeline__item ko-timeline__item--p${entry.owner}`);
    item.appendChild(el('span', 'ko-timeline__turn', `T${entry.turn}`));
    item.appendChild(el('span', 'ko-timeline__who', `${nameOf(entry.cardId)} (Lv ${entry.level})`));
    item.appendChild(
      el('span', 'ko-timeline__by', entry.killerCardId ? `by ${nameOf(entry.killerCardId)}` : 'no killer')
    );
    list.appendChild(item);
  }
  wrap.appendChild(list);
  return wrap;
}

/**
 * The whole scoreboard: both sides, the knockout order, and the headline
 * numbers that belong to the match rather than to either player.
 */
export function renderMatchStats(state) {
  const wrap = el('section', 'stats');
  wrap.appendChild(el('h3', 'stats__heading', 'Match summary'));
  wrap.appendChild(el('p', 'stats__meta', `${state.turn} turns played`));

  const columns = el('div', 'stats__columns');
  for (const player of state.players) columns.appendChild(renderSide(summarise(state, player.id)));
  wrap.appendChild(columns);

  wrap.appendChild(renderTimeline(state));
  return wrap;
}
