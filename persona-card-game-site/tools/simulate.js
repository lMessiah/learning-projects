/**
 * Headless balance simulator.
 *
 *   npx vite-node tools/simulate.js [--matches 200] [--grid 25]
 *
 * Runs whole matches with no UI at all: two bots, the real engine, the real
 * deck generator. Everything is seeded, so a run is reproducible — quote the
 * seed range alongside any number this prints.
 *
 * It reports what the design pass asked for:
 *   - blowout rate, average KO gap, average match length
 *   - a 4x4 archetype win-rate grid
 *   - One Mores per turn, overall and for Trickster-fielding sides
 *   - per-passive win-rate delta (fielded vs not) and a paired-seed ablation
 *   - Technicals, Gallows and Showtimes per match
 *   - how many late Persona draws clear the draw-level floor
 *   - the Whims of Fate comeback swing
 *   - SP pressure, fusion reach, scripted strategy matchups
 */
import { createMatch, applyAction, createRng, CONFIG } from '../src/engine/index.js';
import { canAffordBestSkill, drawLevelFloor } from '../src/engine/effects.js';
import { chooseBotAction } from '../src/engine/bot.js';
import { ARCHETYPE_IDS } from '../src/data/archetypes.js';
import { DECKS, getPersona } from '../src/data/cards.js';
import { PASSIVE_LIST } from '../src/engine/passives.js';

const FLAVOURS = DECKS.map((d) => d.id);
const MAX_STEPS = 4000;

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
}

/* ------------------------------------------------------------------ *
 * One match
 * ------------------------------------------------------------------ */

function playMatch({
  seed,
  decks,
  archetypes,
  difficulty = 'brutal',
  suppress = null,
  suppressSeat = 0,
  forceStarter = null,
}) {
  let state = createMatch({
    seed,
    players: [
      { name: 'A', deckId: decks[0], archetype: archetypes[0], controller: 'bot', difficulty },
      { name: 'B', deckId: decks[1], archetype: archetypes[1], controller: 'bot', difficulty },
    ],
  });

  // Narrow seat 1's starter offer to a single card. Used by the ablation pass so
  // the Persona under test is guaranteed on the board from turn one — otherwise
  // most passives simply never come up and every delta reads as zero.
  if (forceStarter) state.starterOptions[0] = [forceStarter];

  let rng = createRng(seed * 31 + 7);
  let steps = 0;

  // Which passives each side actually put on the board, so the per-passive
  // delta compares "fielded it" against "did not" rather than "owned the card".
  const fielded = [new Set(), new Set()];
  const noteField = () => {
    for (const player of state.players) {
      for (const persona of player.field) {
        // Ablation: strip the passive under test the moment its holder reaches
        // the board, so the A/B differs in exactly one thing.
        if (suppress && player.id === suppressSeat && persona.passive === suppress) {
          persona.passive = null;
          fielded[player.id].add(`${suppress}:suppressed`);
          continue;
        }
        const passive = persona.passive ?? getPersona(persona.cardId).passive;
        if (passive) fielded[player.id].add(passive);
      }
    }
  };
  noteField();

  // SP pressure, sampled where it is actually felt: at the moment the player
  // has an action to spend and is choosing what to do with it. Measuring at
  // end of turn instead flatters the economy, because a Persona that just
  // swapped in is sitting on a full pool it has not had a chance to spend.
  let decisions = 0;
  let blocked = 0;

  // Comeback tracking, for the Whims of Fate swing. `maxDeficit` is the worst
  // hole each side dug for itself; `whimsWhileBehind` is whether they reached
  // for the card at the point where it widens.
  const maxDeficit = [0, 0];
  const whimsWhileBehind = [false, false];

  while (state.winner === null && steps < MAX_STEPS) {
    const actor =
      state.phase === 'starterSelect'
        ? state.players.findIndex((p) => p.field.length === 0)
        : state.activePlayer;
    if (actor === -1) break;

    if (state.phase === 'playing' && state.turnState.actionsRemaining > 0) {
      const active = state.players[actor].field.find((p) => p.uid === state.players[actor].activeUid);
      if (active && !active.ko) {
        decisions += 1;
        if (!canAffordBestSkill(state, active)) blocked += 1;
      }
    }

    const [action, next] = chooseBotAction(state, actor, difficulty, rng);
    rng = next;
    if (!action) break;

    if (state.phase === 'playing') {
      for (const id of [0, 1]) {
        const deficit = state.players[id].koCount - state.players[1 - id].koCount;
        if (deficit > maxDeficit[id]) maxDeficit[id] = deficit;
      }
      if (action.type === 'PLAY_SPECIAL' && action.cardId === 'whims-of-fate') {
        const deficit = state.players[actor].koCount - state.players[1 - actor].koCount;
        if (deficit >= CONFIG.WHIMS_DEFICIT) whimsWhileBehind[actor] = true;
      }
    }

    state = applyAction(state, action);
    noteField();
    steps += 1;
  }

  const [a, b] = state.players;
  return {
    seed,
    winner: state.winner,
    stuck: state.winner === null,
    turns: state.turn,
    koCounts: [a.koCount, b.koCount],
    koGap: Math.abs(a.koCount - b.koCount),
    blowout: Math.min(a.koCount, b.koCount) <= 1 && Math.max(a.koCount, b.koCount) >= CONFIG.KO_TARGET,
    stats: [a.stats, b.stats],
    archetypes,
    decks,
    fielded: fielded.map((set) => [...set]),
    decisions,
    blocked,
    maxDeficit,
    whimsWhileBehind,
  };
}

/* ------------------------------------------------------------------ *
 * Reporting helpers
 * ------------------------------------------------------------------ */

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + '%' : '—');
const fixed = (n, places = 2) => (Number.isFinite(n) ? n.toFixed(places) : '—');

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function heading(text) {
  console.log(`\n${text}\n${'-'.repeat(text.length)}`);
}

function flag(condition, message) {
  if (condition) console.log(`  ⚠  ${message}`);
}

/* ------------------------------------------------------------------ *
 * Passes
 * ------------------------------------------------------------------ */

/** Headline: length, blowouts, KO gap, One Mores. */
function headlinePass(count) {
  const results = [];
  for (let i = 0; i < count; i++) {
    const seed = 1000 + i;
    results.push(
      playMatch({
        seed,
        decks: [FLAVOURS[i % FLAVOURS.length], FLAVOURS[(i + 1 + (i % 2)) % FLAVOURS.length]],
        archetypes: [ARCHETYPE_IDS[i % 4], ARCHETYPE_IDS[(i >> 2) % 4]],
      })
    );
  }
  return results;
}

/** Every archetype against every archetype, both seats, both deck orders. */
function gridPass(perCell) {
  const cells = new Map();
  let seed = 500000;

  for (const rowArch of ARCHETYPE_IDS) {
    for (const colArch of ARCHETYPE_IDS) {
      const key = `${rowArch}|${colArch}`;
      const record = { wins: 0, played: 0 };
      for (let i = 0; i < perCell; i++) {
        seed += 1;
        // Alternate which seat each archetype takes, so first-player advantage
        // cannot masquerade as an archetype being strong.
        const swap = i % 2 === 1;
        const archetypes = swap ? [colArch, rowArch] : [rowArch, colArch];
        const decks = [FLAVOURS[i % FLAVOURS.length], FLAVOURS[(i + 1) % FLAVOURS.length]];
        const result = playMatch({ seed, decks, archetypes });
        if (result.winner === null) continue;
        record.played += 1;
        const rowSeat = swap ? 1 : 0;
        if (result.winner === rowSeat) record.wins += 1;
      }
      cells.set(key, record);
    }
  }
  return cells;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

const MATCHES = arg('matches', 200);
const PER_CELL = arg('grid', 25);

console.log(`Persona card game — balance simulation`);
console.log(`Engine config: KO_TARGET ${CONFIG.KO_TARGET}, FIELD_CAP ${CONFIG.FIELD_CAP}, ` +
  `MAX_ONE_MORE_PER_TURN ${CONFIG.MAX_ONE_MORE_PER_TURN}, FARM_GAP ${CONFIG.COMEBACK_FARM_GAP}`);

const started = process.hrtime.bigint();
const results = headlinePass(MATCHES);
const decisive = results.filter((r) => !r.stuck);

heading(`Headline — ${MATCHES} Brutal vs Brutal matches (seeds 1000..${1000 + MATCHES - 1})`);
console.log(`  Decisive finishes      ${decisive.length}/${results.length} (${pct(decisive.length, results.length)})`);
console.log(`  Blowouts (8-0 / 8-1)   ${pct(decisive.filter((r) => r.blowout).length, decisive.length)}   target < 15%`);
console.log(`  Average final KO gap   ${fixed(mean(decisive.map((r) => r.koGap)))}`);
// Match length is reported but no longer treated as a target — it was dropped
// deliberately, so a long match is information rather than a problem.
console.log(`  Average match length   ${fixed(mean(decisive.map((r) => r.turns)), 1)} turns   (no target)`);
console.log(`  Median match length    ${fixed(median(decisive.map((r) => r.turns)), 1)} turns`);
console.log(`  Length range           ${Math.min(...decisive.map((r) => r.turns))}–${Math.max(...decisive.map((r) => r.turns))}`);
console.log(`  Seat 1 win rate        ${pct(decisive.filter((r) => r.winner === 0).length, decisive.length)}`);

flag(decisive.filter((r) => r.blowout).length / decisive.length >= 0.15, 'blowout rate is at or above the 15% target');

/* --- One Mores ----------------------------------------------------- */
heading('One Mores per turn');
const sides = decisive.flatMap((r) => r.stats.map((s, i) => ({ ...s, tricksterSide: r.fielded[i].includes('trickster') })));
const perTurn = (s) => (s.turnsTaken ? s.oneMores / s.turnsTaken : 0);
const withTrickster = sides.filter((s) => s.tricksterSide);
const without = sides.filter((s) => !s.tricksterSide);

console.log(`  All sides              ${fixed(mean(sides.map(perTurn)))} per turn`);
console.log(`  Fielded Trickster      ${fixed(mean(withTrickster.map(perTurn)))} per turn  (${withTrickster.length} sides)`);
console.log(`  Did not                ${fixed(mean(without.map(perTurn)))} per turn  (${without.length} sides)`);
console.log(`  Highest single side    ${fixed(Math.max(...sides.map(perTurn)))} per turn`);
flag(mean(withTrickster.map(perTurn)) > 1.5, 'Trickster sides average more than 1.5 One Mores per turn');
flag(mean(sides.map(perTurn)) > 1.5, 'all sides average more than 1.5 One Mores per turn');

/* --- Archetype grid ------------------------------------------------ */
heading(`Archetype win-rate grid — ${PER_CELL} matches per cell (${PER_CELL * 16} total)`);
const grid = gridPass(PER_CELL);
const pad = (s, n) => String(s).padEnd(n);

console.log(`  ${pad('row wins vs ->', 16)}${ARCHETYPE_IDS.map((a) => pad(a, 12)).join('')}overall`);
const overall = new Map();
for (const row of ARCHETYPE_IDS) {
  let wins = 0;
  let played = 0;
  const cells = ARCHETYPE_IDS.map((col) => {
    const record = grid.get(`${row}|${col}`);
    wins += record.wins;
    played += record.played;
    return pad(pct(record.wins, record.played), 12);
  });
  overall.set(row, played ? wins / played : 0);
  console.log(`  ${pad(row, 16)}${cells.join('')}${pct(wins, played)}`);
}
for (const [id, rate] of overall) flag(rate > 0.6, `${id} wins ${pct(rate * 100, 100)} overall — above the 60% flag`);

/* --- Passives ------------------------------------------------------ */
heading('Per-passive win rate — contested matches only');
console.log('  A match is contested for a passive when exactly ONE side fielded it. Comparing all');
console.log('  sides that had it against all that did not would mostly measure match length, since');
console.log('  a longer game puts more Personas on the board and so collects more passives.');
console.log('');
console.log(`  ${pad('passive', 20)}${pad('contested', 14)}${pad('holder won', 14)}delta vs 50%`);
for (const passive of PASSIVE_LIST) {
  let contested = 0;
  let holderWins = 0;
  let sidesFielding = 0;

  for (const result of decisive) {
    const had = [result.fielded[0].includes(passive.id), result.fielded[1].includes(passive.id)];
    sidesFielding += had.filter(Boolean).length;
    if (had[0] === had[1]) continue; // both or neither: tells us nothing
    contested += 1;
    const holder = had[0] ? 0 : 1;
    if (result.winner === holder) holderWins += 1;
  }

  const rate = contested ? holderWins / contested : null;
  const delta = rate === null ? null : (rate - 0.5) * 100;

  console.log(
    `  ${pad(passive.name, 20)}` +
      `${pad(String(contested), 14)}` +
      `${pad(pct(holderWins, contested), 14)}` +
      `${delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}pp`}` +
      (contested < 30 ? '   (low sample)' : '')
  );
  if (delta !== null && contested >= 30) {
    flag(Math.abs(delta) > 10, `${passive.name} swings the win rate by ${delta.toFixed(1)}pp — above the 10pp flag`);
  }
  flag(sidesFielding === 0, `${passive.name} was never fielded in ${decisive.length} matches — it is not reachable in practice`);
}

/* --- Passive ablation ----------------------------------------------- */
heading('Per-passive ablation — forced starter, same seeds, passive on vs removed');
console.log('  The observational numbers above are confounded: a side that fields MORE Personas');
console.log('  collects more passives, and a side fields more Personas because it is losing them.');
console.log('  This pass controls for that. Seat 1 is forced to start with the holder Persona, then');
console.log('  the same seed is replayed with the passive stripped the instant that Persona lands.');
console.log('  Identical seed, identical deck, identical starter — one difference.');
console.log('');
console.log(`  ${pad('passive', 20)}${pad('holder', 16)}${pad('seeds', 8)}${pad('with', 10)}${pad('without', 10)}${pad('delta', 10)}diverged`);

/** A deck-legal Persona that prints each passive, and the flavour it lives in. */
const ABLATION_HOLDERS = {
  trickster: ['pixie', 'p3'],
  stalwart: ['ara-mitama', 'p4'],
  analyst: ['orpheus', 'p3'],
  'soul-battery': ['apsaras', 'p3'],
  bloodlust: ['take-minakata', 'p3'],
  'sacrificial-lamb': ['hua-po', 'p3'],
  momentum: ['jack-frost', 'p3'],
  endure: ['kaiwan', 'p3'],
  // Counter has no deck-legal holder: Odin is fusion-only.
};

const ABLATION_SEEDS = 80;
for (const passive of PASSIVE_LIST) {
  const holder = ABLATION_HOLDERS[passive.id];
  if (!holder) {
    console.log(`  ${pad(passive.name, 20)}${pad('—', 16)}not measurable: no deck-legal Persona prints it`);
    flag(true, `${passive.name} is only on fusion-only Personas, and fusions happen in a minority of matches`);
    continue;
  }
  const [cardId, flavour] = holder;

  let paired = 0;
  let withWins = 0;
  let withoutWins = 0;
  let diverged = 0;

  for (let i = 0; i < ABLATION_SEEDS; i++) {
    const setup = {
      seed: 700000 + i,
      decks: [flavour, FLAVOURS[(i + 1) % FLAVOURS.length]],
      archetypes: [ARCHETYPE_IDS[i % 4], ARCHETYPE_IDS[(i + 2) % 4]],
      forceStarter: cardId,
    };
    const on = playMatch(setup);
    const off = playMatch({ ...setup, suppress: passive.id, suppressSeat: 0 });
    if (on.winner === null || off.winner === null) continue;

    paired += 1;
    if (on.winner === 0) withWins += 1;
    if (off.winner === 0) withoutWins += 1;
    if (on.turns !== off.turns || on.koCounts.join() !== off.koCounts.join()) diverged += 1;
  }

  const delta = paired ? ((withWins - withoutWins) / paired) * 100 : null;
  console.log(
    `  ${pad(passive.name, 20)}${pad(cardId, 16)}${pad(String(paired), 8)}` +
      `${pad(pct(withWins, paired), 10)}${pad(pct(withoutWins, paired), 10)}` +
      `${pad(delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}pp`, 10)}` +
      `${pct(diverged, paired)} of matches`
  );
  if (delta !== null && paired >= 20) {
    flag(Math.abs(delta) > 10, `${passive.name} moves the win rate by ${delta.toFixed(1)}pp when ablated — above the 10pp flag`);
    flag(diverged / paired < 0.1, `${passive.name} changed the course of only ${pct(diverged, paired)} of matches — it barely fires`);
  }
}

/* --- Fusion reach --------------------------------------------------- */
heading('Fusion reach');
const fusionsPerMatch = decisive.map((r) => r.stats[0].fusions + r.stats[1].fusions);
const readyPerSide = decisive.flatMap((r) => r.stats.map((s) => s.fusionReadyTurns));
console.log(`  Fusions per match      ${fixed(mean(fusionsPerMatch))}`);
console.log(`  Matches with none      ${pct(fusionsPerMatch.filter((n) => n === 0).length, fusionsPerMatch.length)}`);
console.log(`  Turns fusion was ready ${fixed(mean(readyPerSide), 1)} per side`);

/* --- New mechanics --------------------------------------------------- */
heading('New mechanics — how often do they actually happen?');
const perMatch = (key) => mean(decisive.map((r) => r.stats[0][key] + r.stats[1][key]));
const noneOf = (key) => pct(decisive.filter((r) => r.stats[0][key] + r.stats[1][key] === 0).length, decisive.length);

console.log(`  Technicals per match   ${fixed(perMatch('technicals'))}   (none in ${noneOf('technicals')} of matches)`);
console.log(`  Gallows per match      ${fixed(perMatch('gallows'))}   (none in ${noneOf('gallows')} of matches)`);
console.log(`  Showtimes per match    ${fixed(perMatch('showtimes'))}   (none in ${noneOf('showtimes')} of matches)`);
flag(perMatch('technicals') < 0.5, 'Technicals almost never land — the ailment follow-up may be unreachable in bot play');
flag(perMatch('gallows') < 0.3, 'the Gallows is barely used — the bot may be undervaluing it');

/* --- Draw-level scaling ---------------------------------------------- */
heading('Draw-level scaling — are late Persona draws clearing the floor?');
const lateDraws = decisive.flatMap((r) => r.stats);
const totalLate = lateDraws.reduce((sum, s) => sum + (s.personaDrawsLate ?? 0), 0);
const aboveFloor = lateDraws.reduce((sum, s) => sum + (s.personaDrawsLateAboveFloor ?? 0), 0);
console.log(`  Floor at turn 10 / 20 / 40   ${[10, 20, 40].map((t) => drawLevelFloor({ turn: t })).join(' / ')} (cap ${CONFIG.DRAW_SCALE_CAP})`);
console.log(`  Persona draws after turn 10  ${totalLate}`);
console.log(`  ...at or above the floor     ${pct(aboveFloor, totalLate)}`);
flag(totalLate > 0 && aboveFloor / totalLate < 0.5, 'most late Persona draws are still below the floor — the re-weighting is too gentle');

/* --- Whims of Fate ---------------------------------------------------- */
heading(`Whims of Fate — the comeback swing (observational, not an ablation)`);
console.log(`  Sides that fell ${CONFIG.WHIMS_DEFICIT}+ knockouts behind, split by whether they reached for the card`);
console.log('  at the point where it widens. This is what the bots chose to do, not a controlled');
console.log('  A/B, so read it as "does the card correlate with coming back" and nothing stronger.');
console.log('');
const behindSides = [];
for (const result of decisive) {
  for (const seat of [0, 1]) {
    if (result.maxDeficit[seat] < CONFIG.WHIMS_DEFICIT) continue;
    behindSides.push({ won: result.winner === seat, playedWhims: result.whimsWhileBehind[seat] });
  }
}
const withWhims = behindSides.filter((s) => s.playedWhims);
const withoutWhims = behindSides.filter((s) => !s.playedWhims);
console.log(`  ${pad('sides that fell behind', 26)}${behindSides.length}`);
console.log(`  ${pad('...played Whims of Fate', 26)}${pad(String(withWhims.length), 8)}won ${pct(withWhims.filter((s) => s.won).length, withWhims.length)}`);
console.log(`  ${pad('...did not', 26)}${pad(String(withoutWhims.length), 8)}won ${pct(withoutWhims.filter((s) => s.won).length, withoutWhims.length)}`);
if (withWhims.length >= 20 && withoutWhims.length >= 20) {
  const swing =
    (withWhims.filter((s) => s.won).length / withWhims.length -
      withoutWhims.filter((s) => s.won).length / withoutWhims.length) *
    100;
  console.log(`  ${pad('swing', 26)}${swing > 0 ? '+' : ''}${swing.toFixed(1)}pp`);
} else {
  console.log(`  ${pad('swing', 26)}— too few of one group to say`);
}
flag(withWhims.length < 20, 'Whims of Fate was rarely played from behind — too small a sample to read');

/* --- Resource pressure ---------------------------------------------- */
heading('Resource pressure — is anything actually scarce?');
const allSides = decisive.flatMap((r) => r.stats);
console.log(`  Weakness hits per side ${fixed(mean(allSides.map((s) => s.weaknessHits)), 1)} over the whole match`);
console.log(`  Knockdowns per side    ${fixed(mean(allSides.map((s) => s.knockdowns)), 1)}`);
console.log(`  One Mores per side     ${fixed(mean(allSides.map((s) => s.oneMores)), 1)}`);
console.log(`  Guards per side        ${fixed(mean(allSides.map((s) => s.guards)), 1)}`);

const rate = (key) => mean(allSides.map((s) => (s.turnsTaken ? s[key] / s.turnsTaken : 0))) * 100;
console.log(`  SP spent per side      ${fixed(mean(allSides.map((s) => s.spSpent)), 1)} over the match`);
console.log(`  Unspent SP per turn    ${fixed(mean(allSides.map((s) => (s.turnsTaken ? s.spUnspentAtTurnEnd / s.turnsTaken : 0))), 1)} left on the active at end of turn`);
console.log(`  Turns ended at full SP ${fixed(rate('turnsEndedFullSp'), 1)}% of turns`);
const totalDecisions = decisive.reduce((sum, r) => sum + r.decisions, 0);
const totalBlocked = decisive.reduce((sum, r) => sum + r.blocked, 0);
const pressure = totalDecisions ? (totalBlocked / totalDecisions) * 100 : 0;
console.log(`  Best skill unaffordable ${fixed(pressure, 1)}% of decisions   target 15–25%   (n=${totalDecisions})`);
flag(pressure < 15, 'SP pressure is below the 15% target — SP is still not really a constraint');
flag(pressure > 25, 'SP pressure is above the 25% target — Personas may be stuck on basic attacks');

/* --- Strategy spot-checks ------------------------------------------ */
heading('Strategy spot-checks — scripted archetype openings, 60 matches each');
const MATCHUPS = [
  ['turtle vs aggro', 'defensive', 'aggressive'],
  ['coverage vs turtle', 'tactical', 'defensive'],
  ['aggro vs control', 'aggressive', 'tactical'],
  ['swift vs turtle', 'swift', 'defensive'],
  ['swift vs aggro', 'swift', 'aggressive'],
  ['control vs turtle', 'tactical', 'defensive'],
];
for (const [label, left, right] of MATCHUPS) {
  let wins = 0;
  let played = 0;
  let turns = [];
  for (let i = 0; i < 60; i++) {
    const swap = i % 2 === 1;
    const result = playMatch({
      seed: 900000 + i + label.length * 1000,
      decks: [FLAVOURS[i % FLAVOURS.length], FLAVOURS[(i + 2) % FLAVOURS.length]],
      archetypes: swap ? [right, left] : [left, right],
    });
    if (result.winner === null) continue;
    played += 1;
    turns.push(result.turns);
    if (result.winner === (swap ? 1 : 0)) wins += 1;
  }
  const rate = wins / played;
  console.log(`  ${pad(label, 22)}${pad(pct(wins, played), 10)}(${played} matches, avg ${fixed(mean(turns), 1)} turns)`);
  flag(rate > 0.65 || rate < 0.35, `${label}: ${pct(wins, played)} is lopsided — one plan may dominate the other`);
}

const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
console.log(`\nDone in ${elapsed.toFixed(1)}s.`);
