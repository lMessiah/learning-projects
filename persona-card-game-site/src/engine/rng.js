/**
 * Seeded, purely functional RNG (mulberry32).
 *
 * The engine never calls Math.random(). Every random draw takes the RNG state
 * from the game state and returns a new one, so a match is fully reproducible
 * from its seed — which is what will let the same engine run authoritatively on
 * a server for the later online mode.
 */

export function createRng(seed) {
  const s = (Number(seed) >>> 0) || 0x9e3779b9;
  return { s };
}

/** @returns {[number, {s:number}]} float in [0, 1) and the next RNG state. */
export function nextFloat(rng) {
  const s = (rng.s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [value, { s }];
}

/** @returns {[number, {s:number}]} integer in [0, maxExclusive). */
export function nextInt(rng, maxExclusive) {
  const [value, next] = nextFloat(rng);
  return [Math.floor(value * maxExclusive), next];
}

/** @returns {[boolean, {s:number}]} true with probability p. */
export function rollChance(rng, p) {
  const [value, next] = nextFloat(rng);
  return [value < p, next];
}

/** Fisher-Yates. Returns a new array; never mutates the input. */
export function shuffle(rng, items) {
  const out = [...items];
  let state = rng;
  for (let i = out.length - 1; i > 0; i--) {
    const [j, next] = nextInt(state, i + 1);
    state = next;
    [out[i], out[j]] = [out[j], out[i]];
  }
  return [out, state];
}

/** Pick n distinct items. Returns [picked, nextRng]. */
export function sample(rng, items, n) {
  const [shuffled, next] = shuffle(rng, items);
  return [shuffled.slice(0, n), next];
}
