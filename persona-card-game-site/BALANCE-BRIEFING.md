# Velvet Duel — Balance & Design Briefing

> ## ⚠️ SNAPSHOT — SUPERSEDED. Do not treat any number here as current.
>
> This was generated for one design conversation, before the game was named
> **Velvet Duel** and before Waves 1–3 landed. It has NOT been maintained, and
> several of its headline numbers are now wrong — Ara Mitama's affinities, stat
> growth and flavour; the Alacrity rules; fusion's action cost; the whole buff
> system. Every line number in it is stale.
>
> **`SPEC.md` is the authoritative rules document.** `src/engine/config.js` is the
> authority on constants. Use this file only as a record of what was *asked* and
> *decided* in that conversation — §0 SCOPE is still the useful part — and verify
> anything else against the code before acting on it.

Generated from the working tree. Every extract is prefixed with its file path and
line range. Line numbers are accurate as of generation; treat them as anchors, not
permanent addresses.

**Reading conventions used here**
- `NOT PRESENT` means I searched and the thing does not exist in the codebase. It
  has not been reconstructed from any design doc.
- **DUPLICATE** flags a value or rule implemented in more than one place.

---

# 0. SCOPE — READ THIS FIRST

The designer has ruled on each of the gaps this document turned up. Treat this
section as binding: it is the difference between a useful proposal and a wasted one.

## 0.1 WANTED NOW — design these

| # | Thing | Current status |
|---|---|---|
| 1 | **Slime** — a new Persona | does not exist; roster is 38 |
| 2 | **Null** affinity — immunity to a damage type | no such affinity |
| 3 | **Reflect** affinity — bounce a damage type back | no such affinity; only the `counter` passive is adjacent |

These three are the active brief. Sections 0.4 and 0.5 give the implementation
surface for each, so a proposal can name real files and functions.

## 0.2 FUTURE UPDATE — acknowledge, do not design yet

**Buff stacking.** Buffs currently do not stack at all (B4): a second Tarukaja only
refreshes the timer, and an opposing debuff annihilates both. The designer intends to
change this in a *later* update. So:
- Do **not** fold buff stacking into a Null/Reflect/Slime proposal.
- Do flag it if a proposal would make future stacking harder to add.
- If you touch `applyBuff`, leave the door open — the shape that will need to change
  is `persona.buffs` becoming a multi-entry list per stat rather than `.find()`-one.

## 0.3 NEVER — do not propose these

**Crits and damage variance are permanently out of scope.** Damage is deterministic
by design and will stay that way. Do not suggest crit chance, damage ranges, dice
rolls, accuracy, evasion, or "add a little randomness for excitement". The only RNG
touching combat is the ailment proc, and that is where it stops.

This is a deliberate design pillar, not an oversight — `src/engine/damage.js:158-167`
records that Hama/Mudo were *once* an instant-kill dice roll and were deliberately
replaced with the deterministic `executeMultiplier`. `src/engine/config.js:112-113`
states it outright: *"No skill in the game has a random chance to knock a Persona
out."* Any proposal reintroducing outcome randomness is rejected on arrival.

## 0.4 Implementation surface — Null and Reflect

**The good news: there is one chokepoint.** Every affinity read in the codebase goes
through `affinitiesOf` — `src/engine/state.js:503-509`:

```js
export function affinitiesOf(persona) {
  const card = getPersona(persona.cardId);
  return {
    weaknesses: persona.weaknesses ?? card.weaknesses,
    resists: persona.resists ?? card.resists,
  };
}
```

Widening that return to `{ weaknesses, resists, nulls, reflects }` is the spine of the
change. **14 call sites read it**, and each has to decide what the two new categories
mean for it. Full checklist, all verified present:

| # | Site | What it does now | Decision needed |
|---|---|---|---|
| 1 | `damage.js:31-37` `affinityOf` | returns `'weak'｜'resist'｜'neutral'` | must gain `'null'｜'reflect'`. **This is the core edit.** |
| 2 | `damage.js:67` | maps affinity → multiplier | Null → ×0 . Reflect → ×0 to target *plus* a new return field |
| 3 | **`bot.js:86-88`** `perceivedAffinity` | **the DUPLICATE formula** — its own weak/resist branch | must mirror #1 or the AI will walk into Nulls forever |
| 4 | `bot.js:758-759` | scouting: counts unrevealed types | should Nulls count as worth scouting? (yes, probably) |
| 5 | `legal.js:52-53` | "does this Persona have any chart at all" | `weaknesses.length + resists.length > 0` → add the new lists |
| 6 | `legal.js:260-262` | Analyst-style "anything left to reveal" | same |
| 7 | `state.js:512-517` `affinitiesFullyRevealed` | builds `[...weaknesses, ...resists]` | Nulls/Reflects must be revealable too |
| 8 | `state.js:547-554` | redaction for online play | must not leak a hidden Null |
| 9 | `effects.js:445-451` | Analyst reveal-all | add the new lists |
| 10 | **`effects.js:480-510`** rewrite Specials | **preserves SHAPE — same count of weaknesses and resists** | ⚠ biggest gotcha, see below |
| 11 | `effects.js:535-560` + `:578-580` | Twist of Fate — swaps one weakness | must not be allowed to create a contradiction |
| 12 | `cards.js:186-195` `validateDatabase` | rejects a type that is both weak and resist | becomes a **4-way disjointness** check |
| 13 | `cardView.js:89-90, 114-115` | renders `WEAK` / `RESIST` rows | needs `NULL` / `REFLECT` rows + colours |
| 14 | `board.js:590-597` | the compact affinity strip | same |

### ⚠ The three design problems worth solving before writing code

1. **The rewrite Specials preserve "shape".** `rewriteAffinities`
   (`effects.js:480-510`) draws a new chart with *the same number* of weaknesses and
   resists, explicitly so a rewrite "never makes a Persona stronger or weaker on
   average, only different". A Null is strictly stronger than a resist and a Reflect
   stronger still — so shape-preservation breaks the moment those enter the pool.
   Either exclude Null/Reflect from rewrites, or define an equivalence (is one Null
   worth two resists?). **This needs an answer before anything else.**

2. **Reflect vs the knockdown/One More rule.** If a Reflect bounces a *weakness* hit
   back, does the attacker get knocked down and does the *defender* get a One More on
   the opponent's turn? The existing `counter` passive deliberately dodges this — its
   reflection goes through `applyDamage` directly (`effects.js:882-891`) so it "can
   never counter a counter and can never itself grant a One More". Reflect should
   almost certainly inherit that rule, but it must be stated.

3. **Null interacts with the whole knockdown economy.** A weakness is the only route
   to a One More outside a Shock Technical. A Null is not merely "0 damage" — it is
   also "cannot be knocked down by this type, ever". Combined with `attemptKnockdown`
   already rejecting `dealt <= 0` (`effects.js:686`), Null gets knockdown-immunity
   *for free* against that type. That is probably correct, but it means **Null is much
   stronger than ×0 damage suggests** and should be priced accordingly.

**Precedent to copy:** `almighty` is already a de-facto "cannot be resisted, cannot be
weak" type — `damage.js:32` returns `'neutral'` before any lookup. Whatever Null and
Reflect do, they must state their interaction with almighty. The natural rule is that
almighty pierces both, keeping it the reliable-but-no-One-More option.

## 0.5 Implementation surface — Slime

Adding a Persona is **data-only**: one object in `src/data/cards.json` under
`personas`. No engine change. The schema is D1 below; every field is mandatory except
`passive` and `fusionOnly`.

Constraints the new card must satisfy, all machine-checked:

- `arcana` must be one of the existing set. **This is the highest-leverage choice** —
  arcana determines which fusion recipes the card can feed, and the pools are already
  uneven (see D4 / the arcana demand map). `Strength` and `Empress` feed **no** recipe
  at all; `Chariot` feeds four.
- `level` ≤ `DECK_MAX_PERSONA_LEVEL` (25) to be deck-legal. Above that it must be
  `fusionOnly: true` and needs a recipe, or `validateDatabase` fails it
  (`cards.js:224-228`).
- `game`: `'common' | 'p3' | 'p4' | 'p5'`. `common` means every flavour can draw it.
- `affinity`: four integers **0–3**, one per archetype. Drives deck-generation weight.
- `weaknesses` / `resists` must be disjoint (`cards.js:195`) and must not contain
  `almighty` (`cards.js:189`).
- Must have **at least one skill at or below its printed level** (`cards.js:197-199`).
- `statGrowth` applies per level gained; see D1. Note the roster is near-uniform at
  **+2 combat stats per level** — deviating is a real balance lever.

**Slime is an obvious candidate to carry Null**, given it is being designed at the
same time — a low-level blob that nulls `phys` is both flavour-accurate and the
cleanest way to introduce the mechanic on a card cheap enough to test with. That is a
suggestion, not a decision.

**Validation is automatic.** `validateAll()` (`archetypes.js:570-572`) runs
`validateDatabase()` + `validateDecks()`, and `validateDecks` rebuilds all twelve
flavour × archetype decks across several seeds, asserting deck size, copy limits and
that every deck can still complete `MIN_COMPLETABLE_RECIPES` (2) fusions. A new card
that breaks deck generation will fail the test suite, not ship quietly.

## 0.6 How to verify any proposal

`npm run simulate -- --matches 200` runs whole matches with no UI on fixed seeds and
prints win rates, per-passive swing, fusion reach and flagged outliers. **It is exactly
reproducible** — the engine has no `Math.random()` (A4) — so a before/after on the same
seeds is a real measurement, not noise. `npx vitest run` currently passes 1,074 tests.

⚠ **Caveat that will bite a Null/Reflect change specifically:** the simulator is driven
by bots, and the bot has its *own copy* of the damage formula (`bot.js:96`, see B1). If
Null/Reflect are added to `damage.js` but not to `bot.js`, the bots will keep firing
nulled elements into a wall and the simulation will report nonsense. Fix #3 in the
0.4 table before trusting any simulator output.

---

# A. ORIENTATION

## A1. Source file tree

Tests (58 files, ~15,000 lines) are collapsed to one line — ask if you need them.

```
.
├── index.html
├── package.json
├── vite.config.js
├── README.md
│
├── src/
│   ├── main.js                    (c) UI — app entry / router
│   │
│   ├── data/                      ← (a) CARD DATA
│   │   ├── cards.json             (a) THE card database. 3,889 lines. All personas,
│   │   │                              skills, items, specials, fusion recipes, decks.
│   │   ├── cards.js               (a) loads + validates cards.json, builds lookups
│   │   └── archetypes.js          (a) deck GENERATION: 30-card decks from
│   │                                  flavour + archetype weighting
│   │
│   ├── engine/                    ← (b) COMBAT RESOLUTION + all rules
│   │   ├── config.js              (b) every tunable constant. START HERE.
│   │   ├── damage.js              (b) THE damage formula, affinity, execute, technical
│   │   ├── effects.js             (b) resolveAttack, applyDamage, knockdown, KO,
│   │   │                              buffs, ailments, turn boundaries, win check
│   │   ├── actions.js             (b) the reducer: every action handler, One More,
│   │   │                              action budget, fusion, Gallows
│   │   ├── legal.js               (b) getLegalActions — what is playable right now
│   │   ├── state.js               (b) state shape, persona instances, combo
│   │   │                              multiplier, Gallows tiering
│   │   ├── passives.js            (b) all 10 passives as pure hooks
│   │   ├── bot.js                 (b) AI scoring — CONTAINS A 2nd DAMAGE FORMULA
│   │   ├── rng.js                 (b) seeded mulberry32
│   │   ├── redact.js              (b) hidden-info redaction for online play
│   │   └── index.js               (b) public re-exports
│   │
│   ├── ui/                        ← (c) UI (no rules live here)
│   │   ├── game/
│   │   │   ├── board.js           (c) the match screen. 1,719 lines, largest UI file
│   │   │   ├── fusionPanel.js     (c) fusion modal
│   │   │   ├── controller.js      (c) holds current state, drives bot turns
│   │   │   ├── setup.js  botGame.js  hotseat.js  hotseatSave.js
│   │   │   ├── online.js  inspect.js  anim.js
│   │   ├── rules.js               (c) the in-game rules screen (943 lines of prose)
│   │   ├── cardView.js  gallery.js  matchStats.js  tips.js
│   │   ├── menu.js  profile.js  settings.js  settingsView.js
│   │   └── theme.js  arcana.js  archetypeRow.js  attribution.js
│   │
│   ├── net/                       ← (d) NETCODE
│   │   ├── webrtc.js              (d) peer-to-peer transport (the default)
│   │   ├── websocket.js           (d) relay transport
│   │   ├── transport.js           (d) transport interface
│   │   ├── onlineMatch.js         (d) host-authoritative match sync
│   │   └── shortcode.js           (d) 6-char room codes
│   │
│   └── styles/                    (c) base, board, cards, gallery, select, themes
│
├── server/                        ← (d) NETCODE (optional, Node)
│   ├── rendezvous.js              (d) hands out short codes; no game data passes through
│   └── relay.js                   (d) websocket relay
│
├── tools/
│   ├── simulate.js                balance simulator — runs whole matches, no UI
│   └── relay-smoke.js
│
├── tests/                         58 files, ~15,000 lines, 1,044 tests
└── deploy/                        nginx conf + systemd unit
```

**FIREBASE: NOT PRESENT.** There is no Firebase, Firestore, or any hosted
database anywhere in the project. Online play is peer-to-peer WebRTC, with an
optional self-hosted rendezvous server that only brokers connection details.
Local play has no backend at all.

## A2. Line count per source file, largest first (top 15)

Tests excluded.

| Lines | File | Kind |
|------:|------|------|
| 3,889 | `src/data/cards.json` | (a) card data |
| 2,726 | `src/styles/board.css` | (c) UI |
| 1,719 | `src/ui/game/board.js` | (c) UI |
| 1,433 | `src/engine/actions.js` | (b) combat/rules |
| 1,324 | `src/engine/effects.js` | (b) combat/rules |
| 1,006 | `src/engine/bot.js` | (b) AI |
| 943 | `src/ui/rules.js` | (c) UI |
| 822 | `src/engine/legal.js` | (b) combat/rules |
| 769 | `src/ui/game/online.js` | (d) netcode UI |
| 741 | `tools/simulate.js` | tooling |
| 714 | `src/engine/state.js` | (b) combat/rules |
| 605 | `tests/board.test.js` | test |
| 603 | `tests/engine.fieldPresence.test.js` | test |
| 599 | `tests/engine.specials.test.js` | test |
| 578 | `src/data/archetypes.js` | (a) deck generation |

The whole rules engine is ~6,000 lines across 11 files in `src/engine/`.

## A3. Where game state lives

One plain-JSON object, created by `createMatch` and threaded through the reducer.
There is no global, no store, no class instance. Field names and types:

```
state                       src/engine/state.js:164-183
  version        number
  config         object      snapshot of CONFIG at match creation
  rng            {s:number}  seeded RNG state — the ONLY source of randomness
  seed           number
  nextUid        number      monotonic id source for persona instances
  phase          'starterSelect' | 'playing' | 'gameOver'
  turn           number      PER PLAYER TURN, not per round
  activePlayer   0 | 1
  players        [Player, Player]
  turnState      TurnState | null
  starterOptions [string[], string[]]
  winner         0 | 1 | null
  endReason      string | null
  suddenDeath    { koAt:[number,number] } | null
  koTimeline     object[]
  log            object[]    capped; forgets the early game
  darkHour       { turnsLeft:number } | null      (added dynamically)

Player                      src/engine/state.js:63-90
  id, name       number, string
  deckId         'p3'|'p4'|'p5'      archetype  'aggressive'|'defensive'|'tactical'|'swift'|null
  controller     'human'|'bot'       difficulty string|null
  lastSkillId    string|null         pendingDraw  object|null
  deck           string[]            hand  [{uid,cardId}]        discard  string[]
  field          PersonaInstance[]   activeUid  string|null
  koCount        number     THIS player's own personas KO'd
  emptyFieldTurns, pendingBonusDraws, fatigue, reshuffles   number
  stats          object

PersonaInstance             src/engine/state.js:20-58
  uid, cardId, owner              string, string, 0|1
  level, strength, magic, endurance, maxHp, hp, maxSp, sp    number
  ko, knockedDown, guarding, warded, endured                 boolean
  buffs      [{stat:'atk'|'def', direction:'up'|'down', turnsLeft:number}]
  ailments   [{type:'burn'|'shock', turnsLeft:number}]
  charges    ('concentrate'|'charge')[]
  passive          string|null      inheritedSkills  string[]
  revealedTypes    string[]         weaknesses/resists  string[]|null (override)
  rewritten        boolean

TurnState                   src/engine/state.js:210-233
  actionsRemaining, personaChangesRemaining, oneMoresGranted   number
  oneMoreActive, oneMoreUsed, canTargetBench, momentumUsed     boolean
  itemsPlayed, specialsPlayed, fusionsPerformed                number
  gallowsUsed, gallowsJunkUsed, personasPlayed, comboStacks    number
  phantomStrike   boolean (added dynamically)
```

## A4. Is combat resolution deterministic and pure?

Yes at the boundary, mutation-based inside. `applyAction(state, action)` deep-clones
the incoming state (`cloneState`, `src/engine/state.js:560-564`, `structuredClone`
with a JSON fallback), mutates the *clone* freely, then returns it — so the caller's
state object is never touched and the function behaves as a pure reducer. Illegal
actions `throw`, which discards the whole draft, so a rule violated halfway through
a handler leaves no partial mutation behind. `src/engine/damage.js`'s `computeDamage`
is pure in the stricter sense: it reads two personas and returns a number, mutating
nothing.

The engine reads **no DOM and calls no `Math.random()`, `Date.now()`, or
`localStorage`** — I grepped `src/engine/` for all of them and the only matches are
comments asserting the rule. All randomness flows through a seeded mulberry32 whose
state (`{s}`) lives in `state.rng`, so a match replays identically from its seed, the
state is plain-JSON serialisable, and the same module runs on both peers in an online
match. Practical consequence for balance work: **`tools/simulate.js` results are
exactly reproducible**, and any change you make to `CONFIG` is measurable by rerunning
the same seeds.

---

# B. COMBAT MATH

## B1. The damage function, verbatim

### `src/engine/damage.js:45-124` — `computeDamage`, the whole pipeline

```js
export function computeDamage({
  attacker,
  defender,
  power,
  damageType,
  category,
  ignoreGuard = false,
  flat = false,
  passiveMult = 1,
  comboMult = 1,
  ignoreShockBonus = false,
}) {
  const cat = category || skillCategory(damageType);
  const atkStat = Math.max(1, attackStatOf(attacker, cat));
  const defStat = Math.max(0, defender.endurance);

  const affinity = affinityOf(defender, damageType);
  const affinityMult = affinity === 'weak' ? CONFIG.WEAK_MULT : affinity === 'resist' ? CONFIG.RESIST_MULT : 1;

  // FLAT damage: a card that prints "deal 60 damage" deals 60, full stop —
  // modified only by weakness, resist and guard.
  if (flat) {
    const guardOnly = defender.guarding && !ignoreGuard ? CONFIG.GUARD_MULT : 1;
    const flatRaw = power * affinityMult * guardOnly;
    return {
      amount: Math.max(0, Math.round(flatRaw)),
      affinity,
      weak: affinity === 'weak',
      resisted: affinity === 'resist',
      chargeUsed: null,
      flat: true,
      breakdown: { base: power, affinityMult, guardMult: guardOnly },
    };
  }

  const base = (power * atkStat) / (atkStat + defStat);

  const atkBuff = buffOf(attacker, 'atk');
  const attackMult = !atkBuff ? 1 : atkBuff.direction === 'up' ? CONFIG.BUFF_MULT : 1 / CONFIG.BUFF_MULT;

  const defBuff = buffOf(defender, 'def');
  const defenseMult = !defBuff ? 1 : defBuff.direction === 'up' ? 1 / CONFIG.BUFF_MULT : CONFIG.BUFF_MULT;

  const guardMult = defender.guarding && !ignoreGuard ? CONFIG.GUARD_MULT : 1;
  const shockMult = !ignoreShockBonus && hasAilment(defender, 'shock') ? CONFIG.SHOCK_TAKEN_MULT : 1;

  // Concentrate boosts magic, Charge boosts physical. Only one applies.
  const wantedCharge = cat === 'phys' ? 'charge' : 'concentrate';
  const chargeUsed = attacker.charges.includes(wantedCharge) ? wantedCharge : null;
  const chargeMult = chargeUsed ? CONFIG.CHARGE_MULT : 1;

  const raw =
    base * attackMult * defenseMult * comboMult * affinityMult * guardMult * shockMult * chargeMult * passiveMult;
  const amount = Math.max(0, Math.round(raw));

  return {
    amount, affinity,
    weak: affinity === 'weak',
    resisted: affinity === 'resist',
    chargeUsed, flat: false,
    breakdown: { base, affinityMult, attackMult, defenseMult, comboMult, guardMult, shockMult, chargeMult, passiveMult },
  };
}
```

**The formula in one line** (`src/engine/damage.js:89` + `:111-112`):

```
base   = power × atkStat / (atkStat + defenderEndurance)
amount = round( base × atk × def × combo × affinity × guard × shock × charge × passive )
```

Rounding happens **once, at the very end** — a deliberate change from the original
spec, which rounded before the multipliers (`src/engine/damage.js:10-12`).

### Helpers it calls

`src/engine/damage.js:23-25` — which stat attacks:
```js
export function attackStatOf(persona, category) {
  return category === 'phys' ? persona.strength : persona.magic;
}
```

`src/engine/damage.js:31-37` — affinity lookup:
```js
export function affinityOf(persona, damageType) {
  if (damageType === 'almighty') return 'neutral'; // almighty is never weak/resisted
  const { weaknesses, resists } = affinitiesOf(persona);
  if (weaknesses.includes(damageType)) return 'weak';
  if (resists.includes(damageType)) return 'resist';
  return 'neutral';
}
```

`src/engine/config.js:269-273` — which stat a damage type uses:
```js
export function skillCategory(type) {
  if (type === 'phys') return 'phys';
  if (MAGIC_TYPES.includes(type)) return 'magic';
  return 'support';
}
```
with `MAGIC_TYPES = ['fire','ice','elec','wind','light','dark','almighty']` (`config.js:266`).

`src/engine/state.js:459-461` — buff lookup (note: `.find`, so **at most one buff per stat**):
```js
export function buffOf(persona, stat) {
  return persona.buffs.find((b) => b.stat === stat) || null;
}
```

`src/engine/state.js:242-245` — the combo multiplier:
```js
export function comboMultiplier(state) {
  const stacks = state.turnState?.comboStacks ?? 0;
  return 1 + stacks * CONFIG.COMBO_DAMAGE_STEP;
}
```

`src/engine/damage.js:170-181` — the execute rider (replaced instant-kill):
```js
export function executeMultiplier(defender, execute) {
  if (!execute || !defender) return 1;
  if (execute.when === 'knockedDown') {
    return defender.knockedDown ? execute.mult ?? CONFIG.EXECUTE_MULT : 1;
  }
  if (execute.when === 'lowHp') {
    const threshold = execute.threshold ?? CONFIG.EXECUTE_HP_THRESHOLD;
    const ratio = defender.maxHp > 0 ? defender.hp / defender.maxHp : 0;
    return ratio < threshold ? execute.mult ?? CONFIG.EXECUTE_MULT : 1;
  }
  return 1;
}
```

`src/engine/damage.js:151-156` — Technical detection:
```js
export function technicalFor(defender, damageType) {
  if (!defender || defender.ko) return null;
  if (hasAilment(defender, 'burn') && (damageType === 'phys' || damageType === 'wind')) return 'burn';
  if (hasAilment(defender, 'shock') && damageType === 'phys') return 'shock';
  return null;
}
```

`src/engine/damage.js:135-139` — percentage-of-current-HP power (Life Drain):
```js
export function percentPowerAgainst(effect, defender) {
  const share = effect?.percentOfTargetHp;
  if (!share || !defender) return null;
  return Math.max(1, Math.round(defender.hp * share));
}
```

### What feeds `passiveMult` — `src/engine/effects.js:787-805`

```js
  const result = computeDamage({
    attacker, defender, power, damageType, category, flat,
    ignoreShockBonus: technical === 'shock',
    comboMult,
    passiveMult:
      passiveDamageMultiplier(state, attacker) *   // Bloodlust ×1.2
      darkHour *                                   // ×1.5 both sides
      execute *                                    // ×1.5
      (technical ? CONFIG.TECHNICAL_MULT : 1) *    // ×1.5
      (phantomHit ? CONFIG.PHANTOM_STRIKE_MULT : 1), // ×1.5
  });
```

> ### ⚠ **DUPLICATE — the damage formula is implemented TWICE**
>
> 1. `src/engine/damage.js:45-124` — `computeDamage`, the real one. Only two
>    callers, both in `effects.js:774` and `:787`.
> 2. `src/engine/bot.js:96-129` — `estimateDamage`, a **second, independent
>    re-implementation** used for every AI decision.
>
> They read the same `CONFIG` constants, so retuning a constant moves both. But the
> *structure* is duplicated, and the two already differ:
>
> | | `computeDamage` | `estimateDamage` |
> |---|---|---|
> | flat-damage path | yes | **no** |
> | Bloodlust / Dark Hour / Phantom Strike | via `passiveMult` | **absent** |
> | execute, technical, shock, charge, combo | yes | yes |
> | affinity source | true affinity | `perceivedAffinity` — gated by bot difficulty |
> | `ignoreGuard` | supported | **absent** |
>
> **Implication for balance work:** if you change the *shape* of the formula (not
> just a constant), the bot's evaluation silently diverges from reality, and
> `tools/simulate.js` — which drives bots — will report misleading numbers. Change
> both, or make the bot call `computeDamage`.

## B2. How STR / MAG / END enter the formula

**STR and MAG are interchangeable inputs to the same slot** — exactly one of them
is selected by the damage type, never both:

`src/engine/damage.js:23-25`
```js
return category === 'phys' ? persona.strength : persona.magic;
```
`phys` → STR. All of fire/ice/elec/wind/light/dark/almighty → MAG. There is no
skill that scales off both, and no hybrid coefficient.

**END is neither a divisor nor a subtraction — it is a term in the denominator of
a ratio.** The exact line, `src/engine/damage.js:89`:

```js
  const base = (power * atkStat) / (atkStat + defStat);
```

where `defStat = Math.max(0, defender.endurance)` (`damage.js:64`).

So the attack stat appears in **both** numerator and denominator. Consequences worth
holding onto for tuning:

- Damage can never reach zero from END alone, and never exceeds `power`.
- At `atkStat == END`, damage is exactly `power / 2`.
- The mitigation END buys is `atk/(atk+END)`, which has **diminishing returns in
  END** — going 10→20 END against a 20-STR attacker cuts damage from 0.50×power to
  0.40×power; going 20→30 cuts it only 0.40→0.33.
- It also means **END is worth less the higher the attacker's stat**, so END scales
  poorly into the late game. This is the single most important curve in the game.
- `Math.max(1, atkStat)` (`damage.js:63`) prevents division by zero.

Flat-damage cards **bypass the ratio entirely** (`damage.js:75-87`) — power is used
raw and END is ignored, modified only by weakness/resist/guard.

## B3. Weak / Resist / Null / Reflect multipliers

`src/engine/config.js:95-105`
```js
  WEAK_MULT: 2,
  RESIST_MULT: 0.5,
  GUARD_MULT: 0.5,
  BUFF_MULT: 1.4,          // debuffs divide by this
  CHARGE_MULT: 2.5,        // Concentrate / Charge
  SHOCK_TAKEN_MULT: 1.5,
  TECHNICAL_MULT: 1.5,
```

| Reaction | Multiplier | Notes |
|---|---|---|
| **Weak** | **×2** | also triggers knockdown → One More |
| **Resist** | **×0.5** | |
| Neutral | ×1 | |
| **Null** | **NOT PRESENT — 🎯 WANTED, see §0.4** | `affinityOf` returns only `'weak'｜'resist'｜'neutral'`. No immunity affinity exists. |
| **Reflect** | **NOT PRESENT as an affinity — 🎯 WANTED, see §0.4** | only the `counter` passive is adjacent; see below |

**On Null:** there is no null/immune affinity anywhere. The nearest thing is the
`warded` boolean (Moonless Gown), which blocks *all* damage but also prevents the
persona acting — `src/engine/effects.js:612-615`. It is a temporary status, not a
property of a persona.

**On Reflect:** there is no reflect affinity. There *is* a `counter` **passive** that
reflects a fraction of physical damage — `src/engine/passives.js:55-66`:
```js
  counter: {
    onDamageTaken: ({ damageType, dealt, wasStanding }) => {
      if (damageType !== 'phys' || !wasStanding || dealt <= 0) return null;
      const reflect = Math.round(dealt * CONFIG.COUNTER_REFLECT);
      return reflect > 0 ? { reflect } : null;
    },
  },
```
`COUNTER_REFLECT: 0.25` (`config.js:203`). It reflects 25% of *dealt* damage, only
against `phys`, only while standing. Reflected damage goes through `applyDamage`
directly, so it cannot counter a counter and cannot grant a One More
(`effects.js:882-891`).

**Almighty ignores the whole affinity system** — `damage.js:32` returns `'neutral'`
before any lookup. Almighty can never be resisted and can never trigger a weakness
knockdown, which makes it the "reliable but no One More" damage type.

## B4. Buff / debuff math

**One stack of Tarukaja multiplies outgoing damage by ×1.4. One stack of Rakukaja
divides incoming damage by ×1.4** (≈0.714×). `BUFF_MULT: 1.4`, `src/engine/config.js:99`.

Attacker side, `src/engine/damage.js:91-92`:
```js
  const atkBuff = buffOf(attacker, 'atk');
  const attackMult = !atkBuff ? 1 : atkBuff.direction === 'up' ? CONFIG.BUFF_MULT : 1 / CONFIG.BUFF_MULT;
```
Defender side, `src/engine/damage.js:94-95` (note the inversion):
```js
  const defBuff = buffOf(defender, 'def');
  const defenseMult = !defBuff ? 1 : defBuff.direction === 'up' ? 1 / CONFIG.BUFF_MULT : CONFIG.BUFF_MULT;
```

So there are exactly four states per stat: `up` (×1.4 or ÷1.4), `down` (the inverse),
or absent (×1).

### **STACK CAP: 1. Buffs do not stack at all.**

> 🔜 **FUTURE UPDATE — not the current brief.** The designer intends to add stacking
> in a later pass. Do not design it now; see §0.2. What follows is how it works today.

This is the answer to "current stack cap" and it is stricter than most card games —
`src/engine/effects.js:352-376`:

```js
export function applyBuff(state, persona, stat, direction, duration = CONFIG.BUFF_DURATION) {
  if (persona.ko) return 'noop';
  const existing = persona.buffs.find((b) => b.stat === stat);
  const label = `${stat === 'atk' ? 'attack' : 'defense'}`;

  if (!existing) {
    persona.buffs.push({ stat, direction, turnsLeft: duration });
    ...
    return 'applied';
  }

  if (existing.direction === direction) {
    existing.turnsLeft = duration;                       // ← REFRESH, not stack
    pushLog(state, `${nameOf(persona)}'s ${label} change was refreshed. (${duration} turns)`, 'buff');
    return 'refreshed';
  }

  persona.buffs = persona.buffs.filter((b) => b !== existing);   // ← MUTUAL ANNIHILATION
  pushLog(state, `${nameOf(persona)}'s ${label} change was cancelled out.`, 'buff');
  return 'cancelled';
}
```

Three behaviours to note for balance:
1. **Same direction → refreshes duration only.** Casting Tarukaja twice is never
   ×1.96; it is ×1.4 with the clock reset. The second cast is nearly a wasted action.
2. **Opposite direction → both are removed**, leaving neutral. Rakunda onto a
   Rakukaja'd target does not go to ×1.4 incoming; it goes to ×1.0. So a debuff spent
   on a buffed target is a *cleanse*, not a debuff.
3. There are only two buff stats, `atk` and `def`. No separate magic/physical
   attack buff, no accuracy/evasion axis.

**Duration: `BUFF_DURATION: 3`** (`config.js:121`), ticked at end of turn for the
owning player only — `src/engine/effects.js:1303-1306`:
```js
    persona.buffs = persona.buffs
      .map((b) => ({ ...b, turnsLeft: b.turnsLeft - 1 }))
      .filter((b) => b.turnsLeft > 0);
```

**Charge / Concentrate are a separate system** and DO multiply on top of buffs:
`CHARGE_MULT: 2.5`, consumed on use (`damage.js:103-105`, `effects.js:813-815`). Only
one applies — `charge` for phys, `concentrate` for magic.

## B5. Crit / variance / RNG in damage

**There is no crit and no damage variance. Damage is fully deterministic.**

> 🚫 **PERMANENTLY OUT OF SCOPE.** This is a design pillar, not a gap. Do not propose
> crits, damage ranges, accuracy, evasion, or any other outcome randomness. See §0.3.

I grepped `src/engine/` for `crit`, `variance`, `jitter`, `spread`, `randomRange` —
no damage-side hits. `computeDamage` takes no RNG parameter and reads none.
Identical inputs always produce an identical number.

⚠ **Stale doc:** `src/engine/damage.js:43` still advertises `critMultiplier:number`
in the JSDoc `@returns`. The function does **not** return that field. The comment is
a leftover; there is no crit implementation behind it.

RNG touches combat in exactly **one** place — the ailment proc rider,
`src/engine/effects.js:894-901`:
```js
  let ailment = null;
  if (!ko && effect.ailment && dealt > 0) {
    const [inflicted, rng] = rollChance(state.rng, effect.ailmentChance ?? 0);
    state.rng = rng;
    if (inflicted) {
      applyAilment(state, defender, effect.ailment);
      ailment = effect.ailment;
    }
  }
```
`ailmentChance` is printed per-skill in `cards.json`. Note the ailment cannot land on
a killing blow (`!ko`).

The design has deliberately removed randomness from outcomes: `src/engine/damage.js:158-167`
records that Hama/Mudo were once an instant-kill dice roll and are now the
deterministic `executeMultiplier` rider. `config.js:112-113` states outright: *"No
skill in the game has a random chance to knock a Persona out."*

Elsewhere RNG drives deck shuffling, draws, starter options, and bot tie-breaking —
never a damage number.

---

# C. TURN & BOARD RULES (as implemented)

## C1. Core numbers

All from `src/engine/config.js:5-53` unless noted.

| Rule | Constant | Value |
|---|---|---|
| Field cap (active + bench, living) | `FIELD_CAP` | **8** |
| Party / bench split | — | **NOT PRESENT** — there is no separate bench size. One flat field of 8; `activeUid` names which one is active. KO'd personas stay in `field` but don't count toward the cap. |
| Opening hand | `OPENING_HAND` | **5** |
| Hand limit (discard down at end of turn) | `HAND_LIMIT` | **7** |
| Deck size | `DECK_SIZE` (`src/data/archetypes.js:71-72`) | **30** — fixed `{persona:16, item:8, special:6}`, identical for every archetype |
| Max copies of a card | `MAX_COPIES` (`archetypes.js:73`) | **2** |
| Draw per turn | `DRAW_PER_TURN` | **1** |
| Extra draw on Pass | `PASS_DRAW` | **1** |
| **Actions per turn** | `ACTIONS_PER_TURN` | **1** |
| Persona changes per turn | `PERSONA_CHANGES_PER_TURN` | **1** |
| One Mores per turn | `MAX_ONE_MORE_PER_TURN` | **1** (Trickster lifts the cap) |
| Items per turn | `ITEMS_PER_TURN` | **1** |
| Specials per turn | `SPECIALS_PER_TURN` | **1** |
| Fusions per turn | `FUSIONS_PER_TURN` | **1** — **and costs the action** (`FUSION_USES_ACTION: true`) |
| Gallows paid / junk per turn | `GALLOWS_PER_TURN` / `GALLOWS_JUNK_PER_TURN` | **1 / 1**, counted separately |
| SP regen per turn | `SP_REGEN_PER_TURN` | **3**, **active slot only** — bench regains nothing |
| KO target (win condition) | `KO_TARGET` | **8** |

**The action economy is the tightest constraint in the game: one action per turn.**
Everything else (playing personas, items, specials, swapping) is free but rationed.

Level gating, `config.js:14-17` and `:64-76`:
- `PLAY_LEVEL_GAP: 10` — a persona card is playable only if its printed level ≤
  (highest level on your field + 10).
- `DECK_MAX_PERSONA_LEVEL: 25` — nothing above 25 appears in a prebuilt deck.
- `FUSION_LEVEL_GAP: 20` — deliberately wider than `PLAY_LEVEL_GAP`; the comment
  records that at parity (10) the simulator showed fusion in only 2.5% of matches.
- `FUSION_FIRST_TURN: 4` — no fusion before turn 4. **Note `state.turn` counts per
  *player turn*, not per round**, so player 1 waits two of their own turns and
  player 2 waits one. `config.js:60-63` says the asymmetry is deliberate.

## C2. Turn sequence, as ordered in code

`beginTurn` — `src/engine/actions.js:148-161`:

1. `state.activePlayer = playerId`
2. `state.turn += 1`
3. `state.turnState = createTurnState()` — **all per-turn counters reset here,
   including `comboStacks`**
4. Push the turn-banner log line
5. `runStartOfTurn(state, playerId)` — expands to steps 5a–5g below
6. `promoteActiveIfEmpty` — auto-promote a bench persona if the active slot is empty
7. Bump `turnsTaken`; bump `fusionReadyTurns` if a fusion is available
8. `evaluateGameEnd`

`runStartOfTurn` — `src/engine/effects.js:1079-1131`:

- **5a.** Stand up every knocked-down persona; clear `guarding`; clear `warded`
- **5b.** Fatigue damage, if decked out: `FATIGUE_DAMAGE (5) × fatigue stacks` to
  **all** the player's living personas
- **5c.** SP regen — **active persona only** (Soul Battery doubles it)
- **5d.** `tickEmptyFieldTimer` — *before the draw*, so an empty board filters the
  cards it is about to be dealt, and a 4th empty turn-start ends the match without
  dealing a hand nobody will play
- **5e.** If the match ended there, stop
- **5f.** `drawCards(..., drawCountFor(...))` — 1 normally, 2 while ≥3 KOs behind
- **5g.** Pay out any `pendingBonusDraws` banked by catching the opponent boardless
  (drawn *uniformly*, not quality-weighted)

**Main phase** — the player acts. There is no formal phase separation: any legal
action may be taken in any order until the action budget is spent and `END_TURN` is
issued. `getLegalActions` is the sole authority on what is playable.

`END_TURN` — `src/engine/actions.js:1386-1416`:

9. Validate the discard: you must discard **exactly** `hand.length - HAND_LIMIT`
   cards, no more, no fewer
10. Record end-of-turn stats (unspent SP, whether the best skill was affordable)
11. `runEndOfTurn(state, player)` — expands to 11a–11d
12. `evaluateGameEnd`; if there is a winner, stop
13. `beginTurn(state, opponentOf(player))` — go to 1

`runEndOfTurn` — `src/engine/effects.js:1281-1322`:

- **11a.** Tick Dark Hour (it ticks on *every* turn boundary, so it covers a full round)
- **11b.** Burn damage: `BURN_DAMAGE (5)` to each of this player's burning personas
- **11c.** Tick buff and ailment durations on this player's personas
- **11d.** `rewardEmptyOpponentField` — if the opponent has no living board, bank a
  bonus draw for your next turn

Note the asymmetry: **knockdowns clear at the START of your turn (5a), buffs tick at
the END (11c)**.

## C3. Swap rules

**Swapping does NOT cost an action.** It has its own budget,
`personaChangesRemaining`, and `CHANGE_ACTIVE` never calls `requireAction` or
`spendAction`. Verbatim — `src/engine/actions.js:899-917`:

```js
  CHANGE_ACTIVE(state, action) {
    requirePlaying(state, action);
    const player = state.players[action.player];
    if (state.turnState.personaChangesRemaining <= 0) fail('you have already changed Persona this turn');
    const target = requireOwnPersona(state, action.player, action.targetUid);
    if (target.uid === player.activeUid) fail(`${nameOf(target)} is already active`);
    if (target.knockedDown) fail(`${nameOf(target)} is knocked down and cannot step up`);

    const previous = getActive(state, action.player);
    player.activeUid = target.uid;
    state.turnState.personaChangesRemaining -= 1;
    if (previous) previous.guarding = false;
    pushLog(...);
    return state;
  },
```

- **Can you swap while knocked down?** You cannot swap *to* a knocked-down persona
  (`actions.js:905`). Swapping *away from* a knocked-down active is allowed — there
  is no check on `previous`. So a knockdown does not trap you; it costs you the slot.
- **Swapping drops your Guard** (`actions.js:910`).
- **Budget: 1 per turn**, +1 per One More (Baton Pass, `actions.js:184`), +1 per
  Alacrity knockdown (`actions.js:1001-1003`).
- A knocked-down active **cannot act at all** — `requireUsableActive`
  (`actions.js:94-99`) rejects knocked-down, warded, and shocked personas.

## C4. One More — the full code path

**Step 1 — the hit resolves.** `resolveAttack`, `src/engine/effects.js:817-828`.
The comment block is worth reading in full because it documents a bug that was fixed:

```js
  // ORDER OF RESOLUTION. The knockout is deliberately held back to the end.
  //
  // A blow lands, it is reported, and THEN the board is asked what the damage
  // did. Resolving the knockout first — which is what used to happen, because
  // applyDamage did it on the spot — put the log in reverse ("was knocked out"
  // before "took 40 damage — Weakness!") and, worse, meant a weakness hit that
  // killed its target scored no knockdown and so granted no One More. Hitting a
  // weakness hard enough to kill was strictly worse than hitting it softly.
  //
  // So: apply the damage, say what happened, put the body down, and only then
  // take it off the board.
  const { dealt, lethal } = applyDamage(state, defender, result.amount, attacker, { deferKo: true });
```

**Step 2 — knockdown is attempted while the body is still on the board.**
`src/engine/effects.js:871-880`:
```js
  const knockedDown = attemptKnockdown(state, attacker, defender, {
    qualifies: result.weak || technical === 'shock',
    dealt,
    lethal,
  });

  // The blow has been reported and the body has been put down. Now, and only
  // now, is it taken off the board.
  const ko = lethal;
  if (lethal) koPersona(state, defender, attacker);
```

Note `qualifies`: **a weakness hit OR a Shock Technical**. Almighty can never
qualify (it is always neutral).

**Step 3 — the knockdown gate.** `src/engine/effects.js:674-704`:
```js
function attemptKnockdown(state, attacker, defender, { qualifies, dealt, lethal = false }) {
  if (!qualifies) return false;

  const say = (message, kind) => { if (!lethal) pushLog(state, message, kind); };

  if (defender.warded || dealt <= 0) {
    say(`${nameOf(defender)} was never touched, and stays on its feet.`, 'knockdown');
    return false;
  }
  if (defender.guarding) {
    say(`${nameOf(defender)} guarded and stayed on its feet.`, 'attack');
    return false;
  }
  if (preventsKnockdown(defender)) {                       // ← Stalwart, see C5
    say(`${nameOf(defender)} shrugged it off and stayed standing. (Stalwart)`, 'knockdown');
    return false;
  }
  // Already down: there is no second knockdown to score off it.
  if (defender.knockedDown) return false;

  defender.knockedDown = true;
  bumpStat(state, attacker.owner, 'knockdowns');
  say(`${nameOf(defender)} is knocked down!`, 'knockdown');
  // ... combo stacking follows
```

Five things block a knockdown, and therefore block the One More: not qualifying,
being warded, zero damage, **guarding**, **Stalwart**, and already being down.

**Step 4 — combo stacking**, `src/engine/effects.js:709-714`:
```js
  if (state.turnState && attacker.owner === state.activePlayer) {
    state.turnState.comboStacks += 1;
```

**Step 5 — spend the action, then grant.** `src/engine/actions.js:217-220`:
```js
function consumeAction(state, result, attacker) {
  spendAction(state);
  if (result?.knockedDown && attacker) grantOneMore(state, attacker);
}
```
The One More keys off `result.knockedDown` — **never off the weakness hit itself**.

**Step 6 — the grant and the cap.** `src/engine/actions.js:172-193`:
```js
function grantOneMore(state, attacker) {
  const turn = state.turnState;
  const chains = chainsOneMore(attacker);
  if (!chains && turn.oneMoresGranted >= CONFIG.MAX_ONE_MORE_PER_TURN) {
    pushLog(state, 'One More already used this turn.', 'info');
    return false;
  }
  turn.oneMoresGranted += 1;
  turn.oneMoreUsed = true;
  bumpStat(state, attacker.owner, 'oneMores');
  turn.oneMoreActive = true;
  turn.actionsRemaining += 1;
  turn.personaChangesRemaining += 1;
  ...
  return true;
}
```

**Chain counter / cap:**
- `oneMoresGranted` is the counter; cap is `MAX_ONE_MORE_PER_TURN: 1`.
- The **Trickster** passive (`passives.js:40-45`, `oneMoreChain: () => true`) bypasses
  the cap entirely for its holder — unlimited chaining.
- The chain is still bounded in practice: each enemy persona can only be knocked
  down once while standing (`effects.js:699`), so the ceiling is the size of the
  enemy field.
- A One More grants **+1 action AND +1 Persona change (Baton Pass) AND opens the
  enemy bench as a legal target** (`oneMoreActive`).
- `spendAction` (`actions.js:199-202`) clears `oneMoreActive` immediately, so the
  bench closes the moment the extra action is used — on *any* action, including Guard.

**Net action cost of a weakness knockdown is zero** — `consumeAction` spends 1 then
grants 1 back. This matters when reading budget deltas: raw `actionsRemaining` diffs
under-report cost, and you must add `oneMoresGranted` back.

## C5. Stalwart — **the >50% test runs AFTER damage is applied**

The condition, verbatim — `src/engine/passives.js:47-53`:
```js
  stalwart: {
    id: 'stalwart',
    name: 'Stalwart',
    description: `Cannot be knocked down while above ${Math.round(CONFIG.STALWART_HP_RATIO * 100)}% HP.`,
    onKnockdownAttempt: ({ persona }) =>
      persona.hp > persona.maxHp * CONFIG.STALWART_HP_RATIO ? 'prevent' : null,
  },
```
`STALWART_HP_RATIO: 0.5` — `src/engine/config.js:202`.

Invoked through `preventsKnockdown` — `src/engine/passives.js:167`:
```js
export const preventsKnockdown = (persona) => runHook(persona, 'onKnockdownAttempt', {}) === 'prevent';
```

### **Ordering — this is the answer you asked for**

`persona.hp` is read at the moment the hook runs, and the hook runs from
`attemptKnockdown`, which `resolveAttack` calls at **line 871** — *after* `applyDamage`
at **line 828**. Sequence within one attack in `src/engine/effects.js`:

| Line | What happens |
|---|---|
| 828 | `applyDamage(...)` — **`defender.hp` is decremented here** |
| 842-846 | damage log line |
| 871 | `attemptKnockdown(...)` → `preventsKnockdown` → **Stalwart reads `persona.hp`** |
| 880 | `koPersona` if lethal |

**So Stalwart tests the POST-damage HP.**

I confirmed this empirically rather than by reading alone — a throwaway test firing
Zio at Ara Mitama (Stalwart, weak to elec) through the real reducer:

| Setup | Result | Knocked down? |
|---|---|---|
| **100/100 HP** — starts well above the 50% line | → 49/100 | **YES** |
| 400/400 HP — same hit, does not cross the line | → 349/400 | no |
| 6/400 HP — hit is lethal | → KO | n/a, **One More still granted** |

The first row is the proof: if Stalwart read *pre*-damage HP, a persona at full
health could never be knocked down by a single non-lethal hit. It was.

Practical consequences for balance:
- Stalwart only protects against hits that leave it **above half**. Any hit that
  crosses the 50% line goes through.
- **A lethal blow always beats Stalwart**, because HP is 0 by the time the hook runs.
  This is called out explicitly in the code comment at `src/engine/bot.js:262-263`:
  *"Stalwart is read at the target's CURRENT HP, which is why a lethal hit slips past
  it: at 0 HP there is nothing left for it to shrug off."*
- Guard, by contrast, is checked at `effects.js:690` *before* Stalwart and does not
  read HP at all — so **Guard is the strictly more reliable knockdown denial**.

If you want Stalwart to test pre-damage HP, the fix is to capture `defender.hp`
before line 828 and pass it into `attemptKnockdown` — the hook signature already
takes a ctx object.

## C6. Gallows — the Feast / Meal / Junk branch

The tiering function is the single source of truth. `src/engine/state.js:591-644`,
verbatim:

```js
export function gallowsMeal(eaterLevel, foodLevel, foodPassive = null, eaterMaxHp = 0) {
  // Sacrificial Lamb rides on top of whichever tier the levels put it in, so
  // the hierarchy holds: a Lamb feast still beats a Lamb meal, and a Lamb
  // always beats the same food without it.
  const lamb = foodPassive === 'sacrificial-lamb' ? CONFIG.GALLOWS_LAMB_BONUS : 0;

  if (foodLevel >= eaterLevel) {
    return {
      tier: 'feast',
      label: 'Feast',
      levels: CONFIG.GALLOWS_FEAST_LEVELS + lamb,
      heal: 0,
      usesAction: true,
      nourishing: true,
      canInherit: true,
      canInheritPassive: true,
      statBump: CONFIG.GALLOWS_STAT_BUMP,
    };
  }

  if (foodLevel >= eaterLevel - CONFIG.COMEBACK_FARM_GAP) {
    return {
      tier: 'meal',
      label: 'Meal',
      levels: CONFIG.GALLOWS_LEVELS + lamb,
      heal: 0,
      usesAction: true,
      nourishing: true,
      canInherit: true,
      canInheritPassive: false,
      statBump: 0,
    };
  }

  return {
    tier: 'junk',
    label: 'Junk',
    levels: 0,
    heal: Math.round(eaterMaxHp * CONFIG.GALLOWS_JUNK_HEAL),
    usesAction: false,
    ...
  };
}
```

| Tier | Condition | Payout | Costs action? | Inherit |
|---|---|---|---|---|
| **Feast** | `food ≥ eater` | +2 levels, +1 permanent stat | **yes** | skill **or passive** |
| **Meal** | `eater-5 ≤ food < eater` | +1 level | **yes** | skill only |
| **Junk** | `food < eater-5` | 20% max HP heal, no levels | **no** | none |

Constants: `GALLOWS_FEAST_LEVELS: 2`, `GALLOWS_LEVELS: 1`, `GALLOWS_LAMB_BONUS: 1`,
`GALLOWS_JUNK_HEAL: 0.2`, `GALLOWS_STAT_BUMP: 1`, `COMEBACK_FARM_GAP: 5` —
`src/engine/config.js:178-186` and `:255`.

⚠ **Note `COMEBACK_FARM_GAP` is doing double duty**: it is the Gallows Meal/Junk
boundary *and* the "victim too far below the killer to teach it anything" gap for
KO level-ups (`config.js:255`). Retuning it moves both systems. Not a duplicated
literal — one constant, two consumers — but easy to change by accident.

### Where the once-per-turn counters are tracked

Two **separate** counters on `turnState`, declared at `src/engine/state.js:224-225`:
```js
    gallowsUsed: 0,
    gallowsJunkUsed: 0,
```

Checked before anything is consumed — `src/engine/actions.js:1251-1258`:
```js
    if (meal.usesAction) {
      if (state.turnState.gallowsUsed >= CONFIG.GALLOWS_PER_TURN) {
        fail(`only ${CONFIG.GALLOWS_PER_TURN} nourishing Gallows sacrifice per turn`);
      }
    } else if ((state.turnState.gallowsJunkUsed ?? 0) >= CONFIG.GALLOWS_JUNK_PER_TURN) {
      fail(`only ${CONFIG.GALLOWS_JUNK_PER_TURN} junk Gallows disposal per turn`);
    }
    if (meal.usesAction) requireAction(state);
```

Incremented at `src/engine/actions.js:1359` and `:1362`:
```js
      state.turnState.gallowsUsed += 1;
      ...
      state.turnState.gallowsJunkUsed = (state.turnState.gallowsJunkUsed ?? 0) + 1;
```

Mirrored for the legal-action list at `src/engine/legal.js:600-601`. `config.js:172-177`
explains why they are separate: sharing one counter meant binning a dead card cost
you the feast you were about to eat.

## C7. Win / loss conditions

`evaluateGameEnd` — `src/engine/effects.js:1028-1064`. It runs after **every** action
(`applyAction`, `actions.js:1429`), so a simultaneous KO is judged on the whole batch.

```js
export function evaluateGameEnd(state) {
  if (state.winner !== null) return state;

  const down = [0, 1].map((id) => state.players[id].koCount >= CONFIG.KO_TARGET);

  if (state.suddenDeath) {
    const delta0 = state.players[0].koCount - state.suddenDeath.koAt[0];
    const delta1 = state.players[1].koCount - state.suddenDeath.koAt[1];
    if (delta0 !== delta1) {
      const winner = delta0 > delta1 ? 1 : 0;
      return endGame(state, winner, 'sudden-death');
    }
    return state;
  }

  if (down[0] && down[1]) {
    const hp0 = totalRemainingHp(state, 0);
    const hp1 = totalRemainingHp(state, 1);
    if (hp0 !== hp1) {
      const winner = hp0 > hp1 ? 0 : 1;
      ...
      return endGame(state, winner, 'simultaneous-ko-hp');
    }
    state.suddenDeath = { koAt: [state.players[0].koCount, state.players[1].koCount] };
    ...
    return state;
  }

  if (down[0]) return endGame(state, 1, 'ko-target');
  if (down[1]) return endGame(state, 0, 'ko-target');
  return state;
}
```

**Four ways a match ends:**

1. **`ko-target`** — a player has `koCount >= KO_TARGET (8)` of their **own** personas
   knocked out. `koCount` counts *your losses*, so reaching 8 means you lose.
2. **`simultaneous-ko-hp`** — both cross 8 at once → winner is whoever has more total
   HP across surviving personas. Tied → sudden death, next KO differential decides.
3. **`empty-field`** — `src/engine/effects.js:1224-1232`. Starting a
   `EMPTY_FIELD_LOSS_TURNS (3)` + 1'th consecutive turn with no living persona loses:
   ```js
   export function checkEmptyFieldLoss(state, playerId) {
     if (state.winner !== null) return state;
     const player = state.players[playerId];
     if ((player.emptyFieldTurns ?? 0) <= CONFIG.EMPTY_FIELD_LOSS_TURNS) return state;
     if (livingField(state, playerId).length > 0) return state;
     pushLog(state, `${player.name} has no Personas left to stand for them.`, 'danger');
     return endGame(state, opponentOf(playerId), 'empty-field');
   }
   ```
4. **`resign`** — `src/engine/actions.js:1377-1384`.

**Decking out does NOT end the match.** Running out of cards adds a `fatigue` stack;
each of that player's turns then deals `FATIGUE_DAMAGE (5) × stacks` to all their
personas (`effects.js:1094-1100`). Death by fatigue arrives via `ko-target` or
`empty-field`, not as its own condition.

---

# D. CARD DATA

## D1. Complete card object, verbatim — schema example

`src/data/cards.json:1360-1416` — Kaiwan, level 14, mid-range:

```json
    {
      "id": "kaiwan",
      "name": "Kaiwan",
      "type": "persona",
      "arcana": "Star",
      "level": 14,
      "game": "common",
      "flavor": "A star-reading spirit. It has already seen how this ends.",
      "strength": 9,
      "magic": 14,
      "endurance": 9,
      "hp": 54,
      "sp": 32,
      "weaknesses": [
        "light"
      ],
      "resists": [
        "dark",
        "elec"
      ],
      "statGrowth": {
        "strength": 0,
        "magic": 2,
        "endurance": 1,
        "hp": 4,
        "sp": 3
      },
      "skills": [
        { "skill": "eiha",     "unlockLevel": 1 },
        { "skill": "zio",      "unlockLevel": 1 },
        { "skill": "tarunda",  "unlockLevel": 8 },
        { "skill": "eiga",     "unlockLevel": 12 },
        { "skill": "zionga",   "unlockLevel": 16 }
      ],
      "affinity": {
        "aggressive": 0,
        "defensive": 0,
        "tactical": 2,
        "swift": 2
      },
      "passive": "endure"
    },
```
*(the `skills` array is reformatted to one line per entry for readability here; the
file has each key on its own line. Every other value is verbatim.)*

**Field notes:**
- `game`: `'common' | 'p3' | 'p4' | 'p5'` — which flavour pools may draw it.
- `affinity`: integers **0–3**, one per archetype, driving deck-generation weight.
  Validated in `src/data/cards.js:213-218`.
- `statGrowth`: applied **per level gained**, see below.
- `passive`: optional, at most one. `fusionOnly: true` appears on results that
  cannot be put in a deck.
- Skills reference `skillLibrary` by id; the persona entry only carries the id and
  an `unlockLevel`.

**How growth is applied** — `src/engine/effects.js:997-1017`:
```js
export function levelUp(state, persona, levels) {
  const card = getPersona(persona.cardId);
  const growth = card.statGrowth;
  const before = persona.level;
  for (let i = 0; i < levels; i++) {
    persona.level += 1;
    persona.strength += growth.strength || 0;
    persona.magic += growth.magic || 0;
    persona.endurance += growth.endurance || 0;
    persona.maxHp += growth.hp || 0;
    persona.hp += growth.hp || 0;     // ← healing on level-up
    persona.maxSp += growth.sp || 0;
    persona.sp += growth.sp || 0;
  }
  ...
  const unlocked = card.skills.filter((s) => s.unlockLevel > before && s.unlockLevel <= persona.level);
```
Note **levelling heals**: current HP rises with max HP, so a Gallows feast mid-combat
is also a small heal. Growth is linear and read from the *card*, so an instance that
changed passive via fusion still grows on its printed line.

## D2. Total personas defined

**38 total** in `src/data/cards.json`:
- **24 deck-legal** (`fusionOnly` absent) — these are all ≤ level 22
- **14 fusion-only** (`fusionOnly: true`) — levels 28–64, obtainable only by fusing

By pool: 6 `common`, 6 `p3`, 5 `p4`, 7 `p5`, + 14 fusion.

## D3. The three signatures

### Pixie — `src/data/cards.json:635-690` (verbatim)
```json
    {
      "id": "pixie",
      "name": "Pixie",
      "type": "persona",
      "arcana": "Lovers",
      "level": 3,
      "game": "common",
      "flavor": "A tiny fairy whose healing spells outshine her fists.",
      "passive": "trickster",
      "strength": 4,
      "magic": 8,
      "endurance": 4,
      "hp": 40,
      "sp": 24,
      "weaknesses": ["dark"],
      "resists": ["elec"],
      "statGrowth": { "strength": 0, "magic": 1, "endurance": 1, "hp": 3, "sp": 2 },
      "skills": [
        { "skill": "dia",      "unlockLevel": 1 },
        { "skill": "zio",      "unlockLevel": 1 },
        { "skill": "media",    "unlockLevel": 6 },
        { "skill": "rakukaja", "unlockLevel": 9 },
        { "skill": "zionga",   "unlockLevel": 14 }
      ],
      "affinity": { "aggressive": 3, "defensive": 2, "tactical": 2, "swift": 3 }
    },
```
**Balance note:** Pixie is a **level 3 card carrying Trickster**, the unlimited
One More chain passive — the strongest passive in the game — and it is in the
`common` pool, so every flavour can draw it. It is also the joint-highest `swift`
affinity. Worth a hard look.

### Slime — **NOT PRESENT — 🎯 WANTED, see §0.5**
There is no persona with id or name `slime` in `src/data/cards.json`. It is to be
designed; §0.5 has the schema constraints and the arcana-choice trap. Full roster of
38 ids for confirmation:
`angel, anzu, apsaras, ara-mitama, arsene, berith, black-frost, girimehkala, hua-po,
incubus, ippon-datara, izanagi, izanagi-no-okami, jack-frost, jack-o-lantern, kaiwan,
kikuri-hime, koppa-tengu, messiah, mithra, mothman, nekomata, odin, omoikane, orpheus,
pixie, rangda, sarasvati, satanael, silky, surt, take-minakata, thanatos, titania,
unicorn, vasuki, yaksini, yoshitsune`.

### Ara Mitama — `src/data/cards.json:969-1025` (verbatim)
```json
    {
      "id": "ara-mitama",
      "name": "Ara Mitama",
      "type": "persona",
      "arcana": "Chariot",
      "level": 4,
      "game": "p4",
      "flavor": "A rough soul. All courage, no subtlety.",
      "passive": "stalwart",
      "strength": 10,
      "magic": 4,
      "endurance": 7,
      "hp": 52,
      "sp": 18,
      "weaknesses": ["ice", "elec"],
      "resists": ["phys"],
      "statGrowth": { "strength": 1, "magic": 0, "endurance": 1, "hp": 4, "sp": 1 },
      "skills": [
        { "skill": "bash",         "unlockLevel": 1 },
        { "skill": "tarukaja",     "unlockLevel": 1 },
        { "skill": "rakunda",      "unlockLevel": 9 },
        { "skill": "assault-dive", "unlockLevel": 12 },
        { "skill": "heat-wave",    "unlockLevel": 20 }
      ],
      "affinity": { "aggressive": 3, "defensive": 3, "tactical": 1, "swift": 3 }
    },
```
**Balance note:** two weaknesses (ice + elec) against one resist. Given C5 — Stalwart
tests post-damage HP — a 52 HP body is knocked down by any hit over 26, so Stalwart
protects it only against fairly small hits. The simulator currently flags Stalwart at
**−17.7pp win-rate swing**, the largest of any passive.

## D4. Full persona table

*(Your message was cut off mid-sentence at "Table only, no skill" — I have read that
as "no skill lists" and omitted them. I have added Passive and Pool columns, which
you did not ask for; drop them if unwanted. Growth is per level gained.)*

Sorted deck-legal first by level, then fusion-only by level.

| Name | Lv | Arcana | HP | SP | STR | MAG | END | Growth /level | Weak | Resist | Passive | Pool |
|------|----|--------|----|----|-----|-----|-----|---------------|------|--------|---------|------|
| Pixie | 3 | Lovers | 40 | 24 | 4 | 8 | 4 | str+0 mag+1 en+1 hp+3 sp+2 | dark | elec | trickster | common |
| Orpheus | 4 | Fool | 48 | 24 | 7 | 8 | 6 | str+1 mag+1 en+0 hp+3 sp+2 | ice | fire | analyst | p3 |
| Izanagi | 4 | Fool | 50 | 22 | 9 | 7 | 6 | str+1 mag+0 en+1 hp+3 sp+2 | dark | elec | — | p4 |
| Arsene | 4 | Fool | 46 | 24 | 8 | 8 | 5 | str+1 mag+1 en+0 hp+3 sp+2 | light | dark | — | p5 |
| Ara Mitama | 4 | Chariot | 52 | 18 | 10 | 4 | 7 | str+1 mag+0 en+1 hp+4 sp+1 | ice/elec | phys | stalwart | p4 |
| Apsaras | 5 | Priestess | 42 | 28 | 4 | 8 | 5 | str+0 mag+1 en+1 hp+3 sp+3 | elec | ice | soul-battery | p3 |
| Jack Frost | 6 | Magician | 46 | 26 | 6 | 9 | 6 | str+0 mag+1 en+1 hp+3 sp+2 | fire | ice | momentum | common |
| Angel | 6 | Justice | 44 | 28 | 5 | 9 | 6 | str+0 mag+1 en+1 hp+3 sp+3 | dark | light | — | common |
| Koppa Tengu | 8 | Hermit | 46 | 24 | 8 | 7 | 6 | str+1 mag+1 en+1 hp+3 sp+2 | fire | wind | momentum | common |
| Jack-o'-Lantern | 9 | Magician | 50 | 28 | 7 | 11 | 7 | str+0 mag+1 en+1 hp+3 sp+2 | ice | fire | sacrificial-lamb | p5 |
| Hua Po | 10 | Hermit | 48 | 30 | 7 | 12 | 7 | str+0 mag+1 en+1 hp+3 sp+3 | ice | fire | sacrificial-lamb | common |
| Omoikane | 11 | Hierophant | 54 | 34 | 6 | 14 | 8 | str+0 mag+1 en+1 hp+3 sp+3 | dark | elec | — | p3 |
| Nekomata | 12 | Magician | 58 | 30 | 12 | 10 | 8 | str+1 mag+1 en+0 hp+3 sp+2 | ice | dark | endure | common |
| Incubus | 12 | Devil | 56 | 30 | 10 | 12 | 8 | str+0 mag+1 en+1 hp+3 sp+3 | light | dark | — | p5 |
| Silky | 13 | Priestess | 54 | 32 | 8 | 13 | 9 | str+0 mag+1 en+1 hp+3 sp+3 | fire | ice | — | p3 |
| Kaiwan | 14 | Star | 54 | 32 | 9 | 14 | 9 | str+0 mag+2 en+1 hp+4 sp+3 | light | dark/elec | endure | common |
| Ippon-Datara | 14 | Hermit | 66 | 20 | 16 | 5 | 12 | str+1 mag+0 en+1 hp+4 sp+1 | elec | phys | — | p4 |
| Yaksini | 15 | Empress | 62 | 26 | 14 | 10 | 10 | str+1 mag+0 en+1 hp+4 sp+2 | light | fire | — | p4 |
| Berith | 16 | Hierophant | 64 | 26 | 15 | 12 | 11 | str+1 mag+1 en+0 hp+3 sp+2 | ice | fire | — | p5 |
| Take-Minakata | 17 | Chariot | 66 | 28 | 15 | 12 | 11 | str+1 mag+1 en+0 hp+3 sp+2 | wind | elec | bloodlust | p3 |
| Mothman | 17 | Moon | 60 | 32 | 12 | 15 | 10 | str+0 mag+1 en+1 hp+3 sp+3 | fire | elec/wind | — | p4 |
| Sarasvati | 19 | Priestess | 62 | 40 | 8 | 18 | 12 | str+0 mag+1 en+1 hp+3 sp+3 | elec | ice/wind | — | common |
| Unicorn | 21 | Strength | 70 | 32 | 16 | 14 | 14 | str+1 mag+0 en+1 hp+4 sp+2 | dark | light | — | p3 |
| Anzu | 22 | Star | 66 | 36 | 14 | 18 | 12 | str+0 mag+1 en+1 hp+3 sp+3 | elec | wind | — | p5 |
| **Mithra** | 28 | Justice | 78 | 42 | 18 | 22 | 16 | str+1 mag+1 en+0 hp+4 sp+3 | dark | light/fire | — | fusion |
| **Kikuri-Hime** | 30 | Priestess | 82 | 46 | 12 | 24 | 18 | str+0 mag+1 en+1 hp+4 sp+3 | elec | ice/light | — | fusion |
| **Titania** | 33 | Empress | 84 | 48 | 18 | 26 | 18 | str+0 mag+1 en+1 hp+4 sp+3 | dark | wind/light | — | fusion |
| **Rangda** | 34 | Empress | 86 | 46 | 22 | 26 | 18 | str+1 mag+1 en+0 hp+4 sp+3 | light | dark/elec | — | fusion |
| **Girimehkala** | 36 | Moon | 96 | 34 | 28 | 16 | 24 | str+1 mag+0 en+1 hp+5 sp+2 | light | phys/dark | — | fusion |
| **Black Frost** | 38 | Star | 88 | 50 | 22 | 28 | 20 | str+0 mag+1 en+1 hp+4 sp+3 | light | fire/ice | trickster | fusion |
| **Vasuki** | 40 | Hanged Man | 94 | 44 | 26 | 24 | 22 | str+1 mag+1 en+0 hp+4 sp+3 | fire | ice/phys | — | fusion |
| **Surt** | 46 | Magician | 100 | 52 | 30 | 32 | 24 | str+1 mag+1 en+0 hp+4 sp+3 | ice | fire | — | fusion |
| **Thanatos** | 50 | Death | 106 | 50 | 34 | 30 | 26 | str+1 mag+1 en+0 hp+5 sp+3 | light | dark/phys | bloodlust | fusion |
| **Odin** | 54 | Emperor | 108 | 56 | 32 | 36 | 26 | str+1 mag+1 en+0 hp+5 sp+3 | ice | elec/phys | counter | fusion |
| **Yoshitsune** | 58 | Tower | 112 | 44 | 40 | 24 | 28 | str+1 mag+0 en+1 hp+5 sp+2 | dark | phys/fire | — | fusion |
| **Messiah** | 60 | Judgement | 118 | 60 | 32 | 38 | 30 | str+1 mag+1 en+0 hp+5 sp+4 | dark | light/phys | — | fusion |
| **Satanael** | 62 | Fool | 120 | 60 | 36 | 40 | 30 | str+1 mag+1 en+0 hp+5 sp+4 | light | dark/phys | — | fusion |
| **Izanagi-no-Okami** | 64 | Fool | 122 | 62 | 38 | 38 | 32 | str+1 mag+1 en+0 hp+5 sp+4 | **—** | elec/phys | — | fusion |

**Observations that fall straight out of the table:**
- **Every persona has exactly one weakness, except two.** Ara Mitama has two
  (ice + elec); **Izanagi-no-Okami has none at all**. Since a weakness hit is the
  only route to a knockdown outside a Shock Technical, Izanagi-no-Okami is
  structurally immune to One More.
- Growth lines are near-uniform: almost every card gains **+2 combat stats per
  level** (either str+1/en+1, mag+1/en+1, or str+1/mag+1). Kaiwan is the only
  outlier with **mag+2 en+1 = +3**.
- END never exceeds ~half of STR+MAG at any level. Combined with the B2 ratio, this
  means the offensive side of the curve outruns the defensive side as levels climb.
- The deck-legal roster tops out at level 22, and `DECK_MAX_PERSONA_LEVEL` is 25 —
  so the level gap between the best card you can draw (22) and the cheapest fusion
  result (28) is what `FUSION_LEVEL_GAP: 20` exists to bridge.

---

# E. THINGS I FLAGGED ALONG THE WAY

Not requested, but they bear on balance work and I would rather you heard them now.

1. **The damage formula is implemented twice** — `damage.js:45` (real) and
   `bot.js:96` (bot). They already diverge on flat damage, Bloodlust, Dark Hour and
   Phantom Strike. Any structural change to the formula must be made in both, or the
   simulator will lie to you. Full comparison table in B1.
2. **Stalwart tests post-damage HP** (C5), so a lethal hit always beats it and any
   hit crossing 50% beats it. The simulator currently flags Stalwart at **−17.7pp**,
   the biggest swing of any passive.
3. **Buffs do not stack** (B4) — same-direction reapplication only refreshes the
   timer, and opposite directions annihilate. A debuff on a buffed target is a
   cleanse, not a debuff. 🔜 *Designer intends to change this in a future update —
   not the current brief.*
4. **No crit, no damage variance** (B5). The only combat RNG is the ailment proc.
   🚫 *Permanently out of scope — a design pillar, do not propose changing it.*
5. `critMultiplier` is advertised in the `computeDamage` JSDoc (`damage.js:43`) but
   is never returned — stale doc, no implementation behind it.
6. **`COMEBACK_FARM_GAP: 5` drives two unrelated systems** — the Gallows Meal/Junk
   boundary and the KO level-up gap (C6).
7. **`Pixie` (level 3, `common` pool) carries Trickster**, the uncapped One More
   chain. Cheapest card in the game, strongest passive, available to every flavour.
8. Simulator warnings from the last 200-match run, unaddressed:
   Counter *"was never fielded in 200 matches"*; Soul Battery **−10.7pp**;
   Sacrificial Lamb **−10.5pp**; Endure **+12.5pp**; Analyst *"fires in only 6.3%
   of matches"*; *"Technicals almost never land"*; *"SP pressure is below the 15%
   target — SP is still not really a constraint."*

**To reproduce any number here:** `npm run simulate -- --matches 200`. It runs whole
matches with no UI on fixed seeds, so results are exactly reproducible across runs.

---

# F. THE ASK, IN ONE PARAGRAPH

Design **Slime** (a new Persona), **Null** (immunity to a damage type) and **Reflect**
(bounce a damage type back). §0.4 lists the 14 call sites a Null/Reflect change must
satisfy and the three design problems to settle first — rewrite-Special shape
preservation, whether a Reflect can grant a One More, and the fact that Null carries
free knockdown-immunity and so is worth more than ×0 damage suggests. §0.5 has Slime's
schema and the arcana trap. Buff stacking is a later update: acknowledge it, don't
design it. Crits and damage variance are never coming — don't propose them. Verify
anything you propose with `npm run simulate -- --matches 200`, but fix the bot's
duplicate damage formula (`bot.js:96`) first or the numbers will lie to you.
