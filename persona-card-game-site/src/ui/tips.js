/**
 * Tips.
 *
 * Three places show these:
 *   - after a loss to the bot, 2-3 tips picked from what actually went wrong;
 *   - on both online connection screens, rotating while you wait;
 *   - in the in-match menu, as a full list.
 *
 * The contextual tips read the per-player `stats` block the engine keeps (see
 * createStats in engine/state.js) rather than mining the match log, because the
 * log is capped and forgets the early game — which is where most of the
 * mistakes worth pointing out happen.
 *
 * `analyseMatch` is pure: state in, tips out. It never mutates anything.
 */
import { CONFIG } from '../engine/index.js';

/**
 * The six playstyle tips. These teach the four deck archetypes plus the two
 * cross-cutting plans (coverage and fusion ramp), so they double as an
 * explanation of what the archetypes are FOR.
 */
export const STRATEGY_TIPS = Object.freeze([
  {
    id: 'turtle',
    title: 'Turtle up',
    text: 'A high-Endurance active with Guard and Rakukaja can wall while you stockpile cards and fusion material.',
  },
  {
    id: 'coverage',
    title: 'Silver bullet squad',
    text: 'Field Personas that together cover every element — scout weaknesses with cheap skills, then swap into the counter for One More chains.',
  },
  {
    id: 'rush',
    title: 'Rush them down',
    text: 'Physical skills cost HP, not SP — an aggressive start can bank KOs before slow decks come online.',
  },
  {
    id: 'control',
    title: 'Control the field',
    text: 'Tarunda, Rakunda, Burn and forced swaps make every enemy turn less efficient. Win the long game.',
  },
  {
    id: 'ramp',
    title: 'Fusion ramp',
    text: "Sacrificed Personas don't count toward your opponent's KO tally — feeding cheap Personas into a monster is safer than fielding them.",
  },
  {
    id: 'carry',
    title: 'Grow a carry',
    text: `KOs level up the victor — but beating Personas ${CONFIG.COMEBACK_FARM_GAP}+ levels below yours teaches it nothing. Fight upward.`,
  },
]);

/** Plain rules-of-thumb, used as filler when nothing specific triggered. */
export const GENERAL_TIPS = Object.freeze([
  {
    id: 'bench',
    title: 'Keep a bench',
    text: `Personas on the bench cost you nothing and are the only thing standing between a knockout and an empty board. The cap is ${CONFIG.FIELD_CAP}.`,
  },
  {
    id: 'pass',
    title: 'Passing is not nothing',
    text: `Passing your action draws an extra card. A turn with no good play is still a turn that grows your hand.`,
  },
  {
    id: 'free-plays',
    title: 'Play before you act',
    text: `Persona cards, ${CONFIG.ITEMS_PER_TURN} Item and ${CONFIG.SPECIALS_PER_TURN} Special are all free — none of them costs your one action. Empty your hand first, then decide what to do with it.`,
  },
  {
    id: 'one-more',
    title: 'Knock them down, not out',
    text: 'A One More comes from knocking a STANDING Persona down with a weakness. A killing blow pays a level-up instead — and hitting something already down pays nothing.',
  },
  {
    id: 'bench-snipe',
    title: 'Reach past the wall',
    text: 'The extra action a One More gives you may target ANY enemy Persona, bench included. It is the only way past their active without an Ambush.',
  },
  {
    id: 'curve',
    title: 'Grow into your hand',
    text: `A Persona card is playable only up to your highest field level + ${CONFIG.PLAY_LEVEL_GAP}. If a card says "Needs Lv N board", win a fight first.`,
  },
  {
    id: 'comeback',
    title: 'Behind is not beaten',
    text: `Falling behind on knockouts weights your draws toward stronger cards, and at ${CONFIG.COMEBACK_UNDERDOG_DEFICIT} down you draw ${CONFIG.COMEBACK_UNDERDOG_DRAW} a turn. The game hands you the tools; you still have to use them.`,
  },
  {
    id: 'passives',
    title: 'Read the passive',
    text: 'Stalwart will not go down above half HP. Counter punishes physical attacks. Check the passive before you commit to a plan.',
  },
]);

export const ALL_TIPS = Object.freeze([...STRATEGY_TIPS, ...GENERAL_TIPS]);

/* ------------------------------------------------------------------ *
 * Contextual analysis
 * ------------------------------------------------------------------ */

/**
 * Each pattern gets a `when` predicate over the loser's own stats and a piece
 * of advice aimed squarely at it. Order is priority order: the first matches
 * are the ones shown.
 */
const PATTERNS = [
  {
    id: 'no-weakness',
    when: (s) => s.attacks >= 5 && s.weaknessHits === 0,
    title: 'You never hit a weakness',
    text: 'Weakness hits do double damage and knock the target down for a One More. Try a cheap skill of each element early to find one, then swap to the Persona that can exploit it.',
  },
  {
    id: 'no-probing',
    when: (s) => s.turnsTaken >= 6 && s.typesUsed.length <= 1,
    title: 'You only ever attacked one way',
    text: 'You used a single damage type all match, so most of their weaknesses stayed hidden. Cheap skills are worth spending purely to find out what hurts.',
  },
  {
    id: 'unspent-sp',
    when: (s) => s.turnsEndedFullSp >= 4,
    title: 'Your SP went unspent',
    text: (s) =>
      `You ended ${s.turnsEndedFullSp} turns with your active Persona's SP untouched. SP only regenerates ${CONFIG.SP_REGEN_PER_TURN} a turn and caps out — hoarding it wastes it.`,
  },
  {
    id: 'empty-bench',
    when: (s) => s.koWithEmptyBench >= 1,
    title: 'Your board ran out',
    text: 'Your active Persona was knocked out with nothing left to send in. Playing Personas costs no action — keep spare bodies on the bench even when you do not need them yet.',
  },
  {
    id: 'no-guard',
    when: (s) => s.guards === 0 && s.heavyHitsTaken >= 3,
    title: 'You never guarded',
    text: (s) =>
      `You took ${s.heavyHitsTaken} heavy hits without once guarding. Guard halves incoming damage AND prevents the knockdown that would hand them a One More.`,
  },
  {
    id: 'unused-fusion',
    when: (s) => s.fusionReadyTurns >= 5 && s.fusions === 0,
    title: 'You had a fusion waiting',
    text: (s) =>
      `A fusion was available on ${s.fusionReadyTurns} of your turns and you never took it. Fusion is the only way to reach the high-tier Personas, and the material does not count as knockouts against you.`,
  },
  {
    id: 'no-one-more',
    when: (s) => s.knockdowns >= 3 && s.oneMores === 0,
    title: 'Your knockdowns paid nothing',
    text: 'You knocked Personas down but earned no One More. Only knocking a Persona that is STANDING pays out — hitting one that is already down is a wasted action.',
  },
];

const resolve = (value, stats) => (typeof value === 'function' ? value(stats) : value);

/**
 * Tips for the player who just lost.
 *
 * @param state   the finished match state
 * @param viewer  the seat to advise
 * @param count   how many tips to return
 */
export function analyseMatch(state, viewer, { count = 3 } = {}) {
  const stats = state?.players?.[viewer]?.stats;
  if (!stats) return generalTips(state?.seed ?? 0, count);

  const matched = PATTERNS.filter((pattern) => {
    try {
      return pattern.when(stats);
    } catch {
      return false;
    }
  }).map((pattern) => ({
    id: pattern.id,
    title: pattern.title,
    text: resolve(pattern.text, stats),
    contextual: true,
  }));

  if (matched.length >= count) return matched.slice(0, count);

  // Nothing (or not enough) triggered — top up with general advice, seeded off
  // the match so a rematch does not repeat the same filler.
  const filler = generalTips(state?.seed ?? 0, count - matched.length, new Set(matched.map((t) => t.id)));
  return [...matched, ...filler];
}

/** A rotating slice of the general + strategy tips, deterministic from `seed`. */
export function generalTips(seed = 0, count = 3, exclude = new Set()) {
  const pool = ALL_TIPS.filter((tip) => !exclude.has(tip.id));
  const start = Math.abs(Math.floor(seed)) % pool.length;
  const out = [];
  for (let i = 0; i < Math.min(count, pool.length); i++) out.push(pool[(start + i) % pool.length]);
  return out;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** A block of tips. */
export function renderTips(tips, { heading = null } = {}) {
  const wrap = el('div', 'tips');
  if (heading) wrap.appendChild(el('h3', 'tips__heading', heading));
  for (const tip of tips) {
    const item = el('div', `tip${tip.contextual ? ' tip--contextual' : ''}`);
    item.appendChild(el('span', 'tip__title', tip.title));
    item.appendChild(el('span', 'tip__text', tip.text));
    wrap.appendChild(item);
  }
  return wrap;
}

/**
 * A single tip that cycles on a timer. Used on the online connection screens,
 * where there is nothing else to look at. Returns { node, stop }.
 */
export function mountRotatingTip(container, { intervalMs = 7000, seed = 0 } = {}) {
  const pool = generalTips(seed, ALL_TIPS.length);
  let index = 0;

  const node = el('div', 'tips tips--rotating');
  const item = el('div', 'tip');
  const title = el('span', 'tip__title');
  const text = el('span', 'tip__text');
  item.appendChild(title);
  item.appendChild(text);
  node.appendChild(item);
  container.appendChild(node);

  const show = () => {
    const tip = pool[index % pool.length];
    title.textContent = `Tip · ${tip.title}`;
    text.textContent = tip.text;
    index += 1;
  };
  show();

  const timer = setInterval(show, intervalMs);
  return {
    node,
    stop() {
      clearInterval(timer);
    },
  };
}
