/**
 * Battle feedback animations.
 *
 * The board re-renders from scratch on every action, so rather than animating
 * transitions we diff the previous state against the new one, work out what
 * just happened, and play it on the freshly rendered nodes.
 *
 * TWO HARD RULES, and everything here follows from them:
 *
 *  1. **Nothing may cause layout.** Only `transform`, `opacity` and the `width`
 *     of a bar that already has a fixed track are animated. Floating numbers,
 *     splashes and the fusion sequence are all absolutely positioned inside the
 *     board screen, so they cannot push a single tile.
 *  2. **Everything scales with the animation-speed setting.** Durations here are
 *     divided by `scale`, and the CSS divides by `--anim-scale`; at 0 the whole
 *     module returns immediately and nothing is built at all.
 */

/**
 * Every base duration in the battle-feedback layer, in milliseconds at Normal
 * speed. THIS TABLE IS THE SOURCE OF TRUTH: `cssDurationVars()` publishes it to
 * the board element as `--dur-*` custom properties, and board.css divides those
 * by `--anim-scale` rather than hard-coding seconds of its own. The stylesheet
 * still carries a fallback for each so it reads correctly on its own, and a
 * test asserts the fallbacks match these numbers.
 *
 * The four the player actually complained about were `barFill`, `countUp`,
 * `knockdown`/`standUp` and `fusion` — they used to run at 400 / 315 / 550 /
 * 2000. Everything moved to a value you can follow with your eyes; the
 * knockdown flip went the other way because at 550ms it was reading as a stall
 * rather than a hit landing.
 */
export const DURATIONS = Object.freeze({
  acting: 600,
  hit: 420,
  heal: 500,
  knockdown: 400,
  standUp: 400,
  ko: 700,
  statusPop: 500,
  statusFade: 800,
  endure: 900,
  shake: 150,
  barFill: 600, // the ghost-bar drain itself
  barGhost: 900, // ...and how long the ghost segment lingers behind it
  floatNum: 900, // how long a damage/heal number stays on screen
  countUp: 500, // how long it takes to count up to its value (JS only)
  splashWeak: 900,
  splashTechnical: 1100,
  splashShowtime: 1400,
  splashOneMore: 1300,
  fusion: 2750,
  gallows: 1200,
});

/** `countUp` drives no CSS — the number is counted in JS, not animated. */
const JS_ONLY = new Set(['countUp']);

const kebab = (key) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * The table as CSS custom properties, for board.js to stamp on the screen.
 * Undivided: the stylesheet applies `--anim-scale` itself, so a speed change
 * needs one variable updated rather than twenty.
 */
export function cssDurationVars() {
  const out = {};
  for (const [key, ms] of Object.entries(DURATIONS)) {
    if (JS_ONLY.has(key)) continue;
    out[`--dur-${kebab(key)}`] = `${ms}ms`;
  }
  return out;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * The status pips a Persona is currently showing, as `{ key, cls, text }`.
 *
 * Lives here rather than in board.js because the expiry animation has to
 * re-create the row as it was a moment ago — with the departed pips still in
 * their old positions — and two implementations of "what pips does this
 * Persona have" would drift apart the first time one of them changed.
 */
export function statusTokens(persona) {
  const tokens = [];
  for (const buff of persona.buffs ?? []) {
    tokens.push({
      key: `buff:${buff.stat}:${buff.direction}`,
      cls: `dot dot--${buff.direction === 'up' ? 'buff' : 'debuff'}`,
      text: `${buff.direction === 'up' ? '▲' : '▼'}${buff.stat === 'atk' ? 'A' : 'D'}${buff.turnsLeft}`,
    });
  }
  for (const ailment of persona.ailments ?? []) {
    tokens.push({
      key: `ailment:${ailment.type}`,
      cls: `dot dot--${ailment.type}`,
      text: ailment.type === 'burn' ? `🔥${ailment.turnsLeft}` : '⚡',
    });
  }
  for (const charge of persona.charges ?? []) {
    tokens.push({
      key: `charge:${charge}`,
      cls: 'dot dot--charge',
      text: charge === 'charge' ? '💥' : '🌀',
    });
  }
  if (persona.guarding) tokens.push({ key: 'guard', cls: 'dot dot--guard', text: '🛡️' });
  return tokens;
}

const personaIndex = (state) => {
  const map = new Map();
  for (const player of state.players) for (const p of player.field) map.set(p.uid, p);
  return map;
};

/**
 * Diff two states into a list of things worth showing.
 *
 * Bars carry their BEFORE and AFTER ratios, because the board has already
 * rendered at the new value by the time this plays — the drain has to be
 * re-created from the old number rather than observed.
 */
export function diffStates(prev, next) {
  const effects = {
    hits: [],
    heals: [],
    bars: [],
    knockdowns: [],
    standUps: [],
    kos: [],
    statusAdded: [],
    statusExpired: [],
    endures: [],
    oneMore: false,
    weakness: false,
    technical: false,
    showtime: null,
    fusion: null,
    gallows: null,
    acting: null,
  };
  if (!prev || prev === next) return effects;

  const before = personaIndex(prev);
  const after = personaIndex(next);

  const ratio = (value, max) => (max > 0 ? Math.max(0, Math.min(1, value / max)) : 0);

  for (const [uid, now] of after) {
    const was = before.get(uid);
    if (!was) continue;

    if (now.hp < was.hp) effects.hits.push({ uid, amount: was.hp - now.hp });
    if (now.hp > was.hp) effects.heals.push({ uid, amount: now.hp - was.hp });
    if (!was.knockedDown && now.knockedDown) effects.knockdowns.push(uid);
    if (was.knockedDown && !now.knockedDown && !now.ko) effects.standUps.push(uid);
    if (!was.ko && now.ko) effects.kos.push(uid);
    if (!was.endured && now.endured) effects.endures.push(uid);

    // Ghost-bar drain, for HP and SP alike. Recorded whenever either moved.
    if (now.hp !== was.hp) {
      effects.bars.push({ uid, kind: 'hp', from: ratio(was.hp, was.maxHp), to: ratio(now.hp, now.maxHp) });
    }
    if (now.sp !== was.sp) {
      effects.bars.push({ uid, kind: 'sp', from: ratio(was.sp, was.maxSp), to: ratio(now.sp, now.maxSp) });
    }

    // Status pips: what arrived pops in, what left fades out where it stood.
    const previous = statusTokens(was);
    const current = statusTokens(now);
    const had = new Set(previous.map((t) => t.key));
    const has = new Set(current.map((t) => t.key));
    if (current.some((t) => !had.has(t.key))) effects.statusAdded.push(uid);
    const lost = previous.filter((t) => !has.has(t.key)).map((t) => t.key);
    if (lost.length) effects.statusExpired.push({ uid, before: previous, lost });
  }

  // New log lines tell us about the things state alone doesn't show.
  const lastId = prev.log[prev.log.length - 1]?.id ?? 0;
  for (const entry of next.log) {
    if (entry.id <= lastId) continue;
    if (entry.kind === 'onemore') effects.oneMore = true;
    if (entry.kind === 'technical') effects.technical = true;
    if (entry.kind === 'showtime') effects.showtime = entry.text;
    if (entry.kind === 'fusion' && entry.data) effects.fusion = entry.data;
    if (entry.kind === 'gallows' && entry.data) effects.gallows = entry.data;
    if (entry.kind === 'attack' && entry.text.includes('Weakness!')) effects.weakness = true;
  }

  // Whoever was acting when the action resolved gets the spotlight.
  const actorId = prev.activePlayer;
  effects.acting = prev.players[actorId]?.activeUid ?? null;

  return effects;
}

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

/** Briefly add a class, then take it off again. */
function pulse(node, className, ms) {
  if (!node) return;
  node.classList.add(className);
  setTimeout(() => node.classList.remove(className), ms);
}

function place(host, anchor, node, { yFraction = 1 / 3 } = {}) {
  const hostRect = host.getBoundingClientRect();
  const rect = anchor.getBoundingClientRect();
  node.style.left = `${rect.left - hostRect.left + rect.width / 2}px`;
  node.style.top = `${rect.top - hostRect.top + rect.height * yFraction}px`;
  host.appendChild(node);
}

/**
 * A damage or heal number that counts up to its value rather than appearing
 * whole. Purely a text swap on an already-positioned absolute element, so it
 * costs no layout.
 */
function countingNumber(host, anchor, amount, className, ms, prefix, countMs) {
  if (!anchor || !host) return;
  const node = el('span', `float-num ${className}`, `${prefix}0`);
  place(host, anchor, node);

  // The count has to finish before the number floats away, whatever the speed.
  const steps = Math.min(12, Math.max(4, Math.round(amount / 4)));
  let step = 0;
  const timer = setInterval(() => {
    step += 1;
    const shown = Math.round((amount * step) / steps);
    node.textContent = `${prefix}${shown}`;
    if (step >= steps) clearInterval(timer);
  }, Math.max(16, Math.min(countMs, ms * 0.85) / steps));

  setTimeout(() => {
    clearInterval(timer);
    node.remove();
  }, ms);
}

/**
 * The fighting-game bar drain: the fill snaps back to where it was and slides
 * to the new value, with a "ghost" segment left behind over the chunk that was
 * lost, fading a beat later.
 *
 * Width-only on an element inside a fixed-size track, so the track — and every
 * tile around it — stays exactly where it was.
 */
function drainBar(tile, { kind, from, to }, ms) {
  const bar = tile?.querySelector(`.tile__bar--${kind}`);
  const fill = bar?.querySelector('.tile__fill');
  if (!bar || !fill) return;

  const pct = (value) => `${value * 100}%`;

  // A loss leaves a white ghost over the chunk that went; a gain lights the
  // chunk that arrived in green. Same element, same rules, opposite direction.
  const losing = to < from;
  const ghost = el('div', `tile__ghost${losing ? '' : ' tile__ghost--gain'}`);
  ghost.style.left = pct(Math.min(from, to));
  ghost.style.width = pct(Math.abs(from - to));
  bar.appendChild(ghost);
  setTimeout(() => ghost.remove(), ms);

  // Start from the old value, then let the transition carry it to the rendered
  // one on the next frame.
  fill.style.transition = 'none';
  fill.style.width = pct(from);
  const run = () => {
    fill.style.transition = '';
    fill.style.width = pct(to);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else run();
}

/**
 * Fade out the pips that just expired, in the places they were standing.
 *
 * The live row has already re-rendered without them, so this lays a copy of the
 * row as it was over the top: the survivors are invisible spacers holding the
 * positions, and only the departed pips are drawn, fading. The overlay is
 * absolutely positioned inside the row, so it adds no layout of its own.
 */
function fadeExpired(tile, { before, lost }, ms) {
  const row = tile?.querySelector('.tile__status');
  if (!row) return;

  const ghost = el('div', 'tile__status tile__status--ghost');
  for (const token of before) {
    const dot = el('span', token.cls, token.text);
    if (lost.includes(token.key)) dot.classList.add('dot--expiring');
    else dot.style.visibility = 'hidden';
    ghost.appendChild(dot);
  }
  row.appendChild(ghost);
  setTimeout(() => ghost.remove(), ms);
}

function splash(host, className, text, ms) {
  const node = el('div', `splash ${className}`, text);
  host.appendChild(node);
  setTimeout(() => node.remove(), ms);
}

/** A short, small screen shake. Transform only, on the board container. */
function shake(host, ms) {
  host.classList.add('is-shaking');
  setTimeout(() => host.classList.remove('is-shaking'), ms);
}

/* ------------------------------------------------------------------ *
 * The Velvet Room: fusion and Gallows
 * ------------------------------------------------------------------ */

const PARTICLE_COUNT = 12;

function particles(className) {
  const wrap = el('div', 'velvet__particles');
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const dot = el('span', `velvet__particle ${className}`);
    // Deterministic fan, not random: every fusion looks like the same ritual.
    dot.style.setProperty('--angle', `${(360 / PARTICLE_COUNT) * i}deg`);
    dot.style.setProperty('--delay', `${i * 0.03}s`);
    wrap.appendChild(dot);
  }
  return wrap;
}

/**
 * The fusion sequence, ~2s: both sacrifices slide in from the sides, tilt
 * toward each other, dissolve into light, and the result scales up out of the
 * glow — after which its inherited passive and skills flash once.
 *
 * The palette is Velvet Room blue whatever theme is active, because this is the
 * one moment that belongs to the Velvet Room rather than to your deck.
 */
function playFusion(host, data, ms) {
  const stage = el('div', 'velvet velvet--fusion');
  const inner = el('div', 'velvet__stage');

  const [first, second] = data.parents ?? [];
  inner.appendChild(el('div', 'velvet__parent velvet__parent--a', first ?? '?'));
  inner.appendChild(el('div', 'velvet__parent velvet__parent--b', second ?? '?'));
  inner.appendChild(el('div', 'velvet__glow'));
  inner.appendChild(particles('velvet__particle--fusion'));

  const result = el('div', 'velvet__result');
  result.appendChild(el('span', 'velvet__result-name', data.result ?? ''));
  result.appendChild(el('span', 'velvet__result-level', `Lv ${data.level ?? '?'}`));

  const gains = el('div', 'velvet__gains');
  if (data.passive) gains.appendChild(el('span', 'velvet__gain velvet__gain--passive', data.passive));
  for (const skill of data.skills ?? []) gains.appendChild(el('span', 'velvet__gain', skill));
  if (gains.childElementCount) result.appendChild(gains);

  inner.appendChild(result);
  stage.appendChild(inner);
  host.appendChild(stage);
  setTimeout(() => stage.remove(), ms);
  return stage;
}

/**
 * The Gallows, ~1s: the same ritual at half length and one card short. The food
 * dissolves into the eater, which flashes, and the levels it gained float off.
 */
function playGallows(host, data, ms) {
  const stage = el('div', 'velvet velvet--gallows');
  const inner = el('div', 'velvet__stage');

  inner.appendChild(el('div', 'velvet__parent velvet__parent--food', data.food ?? '?'));
  inner.appendChild(el('div', 'velvet__glow'));
  inner.appendChild(particles('velvet__particle--gallows'));

  const eater = el('div', 'velvet__result');
  eater.appendChild(el('span', 'velvet__result-name', data.eater ?? ''));
  eater.appendChild(
    el('span', 'velvet__result-level', data.levels > 0 ? `+${data.levels} LEVEL` : 'FED')
  );
  inner.appendChild(eater);

  stage.appendChild(inner);
  host.appendChild(stage);
  setTimeout(() => stage.remove(), ms);
  return stage;
}

/**
 * Let the player cut a ceremony short.
 *
 * The stage itself stays `pointer-events: none`, so it can never swallow a
 * click meant for the board — that is a hard rule, and a 2.75s overlay that ate
 * input would be far worse than one that outstays its welcome. Instead this
 * listens once, on the capture phase, for any pointer or key press anywhere:
 * the input does whatever it was always going to do, and the ceremony gets out
 * of the way on its way past.
 */
const SKIP_EVENTS = ['pointerdown', 'mousedown', 'keydown'];

function makeSkippable(stage, ms) {
  if (!stage || typeof document === 'undefined') return stage;

  const detach = () => {
    for (const event of SKIP_EVENTS) document.removeEventListener(event, dismiss, true);
  };
  const dismiss = () => {
    stage.remove();
    detach();
  };
  for (const event of SKIP_EVENTS) document.addEventListener(event, dismiss, true);

  // A ceremony nobody interrupts still has to let go of these. Without this the
  // listeners outlive every sequence that simply ran its course, and a long
  // match accumulates one closure per fusion for as long as the page is open.
  setTimeout(detach, ms);
  return stage;
}

/* ------------------------------------------------------------------ *
 * Playback
 * ------------------------------------------------------------------ */

/**
 * Play the diffed effects against the freshly rendered board.
 * @param host   the board screen element (also the positioning context)
 * @param scale  animation speed multiplier; <= 0 disables everything
 */
export function playEffects(host, effects, scale = 1) {
  if (!host || scale <= 0) return;
  const ms = (key) => Math.max(1, Math.round(DURATIONS[key] / scale));
  const find = (uid) => host.querySelector(`[data-uid="${uid}"]`);

  if (effects.acting) pulse(find(effects.acting), 'is-acting', ms('acting'));

  for (const bar of effects.bars) drainBar(find(bar.uid), bar, ms('barGhost'));

  for (const { uid, amount } of effects.hits) {
    const node = find(uid);
    pulse(node, 'is-hit', ms('hit'));
    countingNumber(host, node, amount, 'float-num--damage', ms('floatNum'), '-', ms('countUp'));
  }

  for (const { uid, amount } of effects.heals) {
    const node = find(uid);
    pulse(node, 'is-healed', ms('heal'));
    countingNumber(host, node, amount, 'float-num--heal', ms('floatNum'), '+', ms('countUp'));
  }

  for (const uid of effects.knockdowns) pulse(find(uid), 'is-going-down', ms('knockdown'));
  for (const uid of effects.standUps) pulse(find(uid), 'is-standing-up', ms('standUp'));
  for (const uid of effects.kos) pulse(find(uid), 'is-ko', ms('ko'));
  for (const uid of effects.statusAdded) pulse(find(uid), 'is-status-changed', ms('statusPop'));
  for (const expired of effects.statusExpired) fadeExpired(find(expired.uid), expired, ms('statusFade'));
  for (const uid of effects.endures) pulse(find(uid), 'is-enduring', ms('endure'));

  // A weakness or a Technical is a hit worth feeling, so the board itself
  // twitches — 3px, transform only.
  if (effects.weakness || effects.technical) shake(host, ms('shake'));

  if (effects.weakness) splash(host, 'splash--weak', 'WEAK!', ms('splashWeak'));
  if (effects.technical) splash(host, 'splash--technical', 'TECHNICAL!', ms('splashTechnical'));
  if (effects.showtime) splash(host, 'splash--showtime', 'SHOWTIME!', ms('splashShowtime'));
  if (effects.oneMore) splash(host, 'splash--onemore', 'ONE MORE!', ms('splashOneMore'));

  // The two long ceremonies. Both are skippable — see makeSkippable.
  if (effects.fusion) makeSkippable(playFusion(host, effects.fusion, ms('fusion')), ms('fusion'));
  else if (effects.gallows) makeSkippable(playGallows(host, effects.gallows, ms('gallows')), ms('gallows'));
}
