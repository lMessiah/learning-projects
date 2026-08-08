/**
 * Lightweight feedback animations.
 *
 * The board re-renders from scratch on every action, so instead of animating
 * transitions we diff the previous state against the new one, work out what
 * just happened, and play it on the freshly rendered nodes. Pure CSS classes
 * and one floating element per hit — no animation library.
 *
 * Everything is scaled by `--anim-scale` on the board element, so the Phase 6
 * animation-speed setting can slow it down or turn it off by setting the scale.
 */

const BASE_DURATION = 900; // ms; the longest effect (floating number) at 1x

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const personaIndex = (state) => {
  const map = new Map();
  for (const player of state.players) for (const p of player.field) map.set(p.uid, p);
  return map;
};

/**
 * Diff two states into a list of things worth showing.
 * @returns {{hits:Array, heals:Array, knockdowns:Array, kos:Array, buffs:Array,
 *            oneMore:boolean, weakness:boolean, acting:string|null}}
 */
export function diffStates(prev, next) {
  const effects = {
    hits: [],
    heals: [],
    knockdowns: [],
    kos: [],
    buffs: [],
    oneMore: false,
    weakness: false,
    acting: null,
  };
  if (!prev || prev === next) return effects;

  const before = personaIndex(prev);
  const after = personaIndex(next);

  for (const [uid, now] of after) {
    const was = before.get(uid);
    if (!was) continue;

    if (now.hp < was.hp) effects.hits.push({ uid, amount: was.hp - now.hp });
    if (now.hp > was.hp) effects.heals.push({ uid, amount: now.hp - was.hp });
    if (!was.knockedDown && now.knockedDown) effects.knockdowns.push(uid);
    if (!was.ko && now.ko) effects.kos.push(uid);

    const buffKey = (p) => p.buffs.map((b) => `${b.stat}${b.direction}`).sort().join(',');
    const ailKey = (p) => p.ailments.map((a) => a.type).sort().join(',');
    if (buffKey(was) !== buffKey(now) || ailKey(was) !== ailKey(now)) effects.buffs.push(uid);
  }

  // New log lines tell us about the things state alone doesn't show.
  const lastId = prev.log[prev.log.length - 1]?.id ?? 0;
  for (const entry of next.log) {
    if (entry.id <= lastId) continue;
    if (entry.kind === 'onemore') effects.oneMore = true;
    if (entry.kind === 'attack' && entry.text.includes('Weakness!')) effects.weakness = true;
  }

  // Whoever was acting when the action resolved gets the spotlight.
  const actorId = prev.activePlayer;
  effects.acting = prev.players[actorId]?.activeUid ?? null;

  return effects;
}

/** Briefly add a class, then take it off again. */
function pulse(node, className, ms) {
  if (!node) return;
  node.classList.add(className);
  setTimeout(() => node.classList.remove(className), ms);
}

function floatText(host, anchor, text, className, ms) {
  if (!anchor || !host) return;
  const hostRect = host.getBoundingClientRect();
  const rect = anchor.getBoundingClientRect();
  const node = el('span', `float-num ${className}`, text);
  node.style.left = `${rect.left - hostRect.left + rect.width / 2}px`;
  node.style.top = `${rect.top - hostRect.top + rect.height / 3}px`;
  host.appendChild(node);
  setTimeout(() => node.remove(), ms);
}

/**
 * Play the diffed effects against the freshly rendered board.
 * @param host   the board screen element (also the positioning context)
 * @param scale  animation speed multiplier; <= 0 disables everything
 */
export function playEffects(host, effects, scale = 1) {
  if (!host || scale <= 0) return;
  const ms = (fraction) => Math.max(1, Math.round(BASE_DURATION * fraction) / scale);
  const find = (uid) => host.querySelector(`[data-uid="${uid}"]`);

  if (effects.acting) pulse(find(effects.acting), 'is-acting', ms(0.7));

  for (const { uid, amount } of effects.hits) {
    const node = find(uid);
    pulse(node, 'is-hit', ms(0.45));
    floatText(host, node, `-${amount}`, 'float-num--damage', ms(1));
  }

  for (const { uid, amount } of effects.heals) {
    const node = find(uid);
    pulse(node, 'is-healed', ms(0.5));
    floatText(host, node, `+${amount}`, 'float-num--heal', ms(1));
  }

  for (const uid of effects.knockdowns) pulse(find(uid), 'is-going-down', ms(0.6));
  for (const uid of effects.kos) pulse(find(uid), 'is-ko', ms(0.7));
  for (const uid of effects.buffs) pulse(find(uid), 'is-status-changed', ms(0.8));

  if (effects.weakness) {
    const banner = el('div', 'splash splash--weak', 'WEAK!');
    host.appendChild(banner);
    setTimeout(() => banner.remove(), ms(1));
  }

  if (effects.oneMore) {
    const splash = el('div', 'splash splash--onemore', 'ONE MORE!');
    host.appendChild(splash);
    setTimeout(() => splash.remove(), ms(1.4));
  }
}
