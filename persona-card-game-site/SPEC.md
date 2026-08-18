# Velvet Duel — Authoritative Rules Specification

*A Persona card game. Unofficial fan project — not affiliated with or endorsed by
ATLUS or SEGA. All card art is placeholder CSS.*

**Status: authoritative.** Where this document and any other text disagree, this one
wins. It was derived from the engine, not from prior design notes — the implementation
is the source of truth, and the in-game rules screen (`src/ui/rules.js`) has been
corrected to match it, not the other way round.

**Scope:** the rules as implemented at Patch 3 / Wave 1. Constants are named rather
than inlined wherever the engine names them, so retuning `src/engine/config.js` keeps
this document true.

---

## 1. The shape of a match

Two players. Each brings a **30-card deck**, fixed at 16 Personas / 8 Items /
6 Specials, maximum 2 copies of any card.

A deck is not hand-built: it is a **flavour** (`p3` / `p4` / `p5`, deciding the card
pool) plus an **archetype** (`aggressive` / `defensive` / `tactical` / `swift`,
deciding how that pool is weighted). Twelve combinations, generated from the match
seed.

Both players draw an **opening hand of 5** and choose a starting Persona from three
offered options. Then turns alternate.

### 1.1 Winning

A match ends in exactly four ways.

| Reason | Condition |
|---|---|
| `ko-target` | A player has **8** of their own Personas knocked out. They lose. |
| `simultaneous-ko-hp` | Both cross 8 on the same action → the player with more total HP across surviving Personas wins. |
| `empty-field` | A player *begins* a 4th consecutive turn with no living Persona. See §7. |
| `resign` | A player resigns. |

If both cross 8 **and** total HP is tied, the match enters **sudden death**: the next
difference in knockouts decides it.

**Running out of cards does not end the match.** It adds a Fatigue stack; see §7.3.

---

## 2. The turn

`state.turn` counts **player turns, not rounds** — turn 1 is the first player's, turn
2 is the second player's. This matters for the fusion gate (§5.1).

### 2.1 Start of turn, in order

1. Every knocked-down Persona you own **stands up**. Guard drops. Moonless Gown drops.
2. **Fatigue** damage, if you have stacks: `5 × stacks` to every living Persona you own.
3. **SP regen: `+3`, to the active Persona only.** The bench regains nothing.
4. **Empty-field timer** ticks — *before* the draw, so a boardless player's draw is
   filtered and a 4th empty turn ends the match without dealing a hand nobody will play.
5. **Draw 1** (or 2 while 3+ knockouts behind — see §8).
6. Any banked bonus draw is paid out.

### 2.2 Main phase

There are no sub-phases. Any legal action may be taken in any order. What constrains
you is the budget:

| Resource | Per turn | Notes |
|---|---|---|
| **Action** | **1** | The scarce one. See §2.3. |
| Persona change | 1 | +1 per One More, +1 per Ambush-style grant |
| Persona cards played | unlimited | subject to field cap and level ceiling |
| Item cards | 1 | |
| Special cards | 1 | |
| Fusion | 1 | **also costs the action** |
| Gallows, paid tiers | 1 | **costs the action** |
| Gallows, junk tier | 1 | **free**, counted separately |

### 2.3 What costs your action

**Costs the action:** Attack · Use Skill · Guard · Pass · **Fusion** · Gallows
feast/meal · any Item or Special whose card prints `usesAction: true`.

**Free:** playing a Persona from hand · changing your active Persona · Gallows junk
disposal · any Item or Special printing `usesAction: false`.

Every action carries its own price on the legal-action object as `usesAction`. The UI
reads that flag and never re-derives the rule.

### 2.4 End of turn

1. Discard down to the **hand limit of 7** — you must discard *exactly* the overflow.
2. **Burn** ticks: 5 damage to each of your burning Personas.
3. Buff and ailment durations tick down **on your Personas only**.
4. If the opponent's board is empty, you bank a bonus card for your next draw.
5. Turn passes.

> **Asymmetry worth knowing:** knockdowns clear at the **start** of your turn; buffs
> and ailments tick at the **end** of it.

---

## 3. Combat

### 3.1 The damage formula

```
base   = power × attackStat / (attackStat + defenderEndurance)
amount = round( base × atk × def × combo × affinity × guard × shock × charge × passive )
```

- **attackStat** is Strength for `phys`, Magic for every magic type. Never both.
- **Endurance is a term in the denominator**, not a divisor or a subtraction. It can
  never reduce damage to zero, and it has diminishing returns: at `attack == endurance`
  damage is exactly half of `power`.
- Rounding happens **once, at the very end**.

**Flat damage** — a card that prints "deal 60 damage" — bypasses the ratio entirely.
Endurance is ignored; only weakness, resist and Guard apply.

**Damage is fully deterministic. There is no crit and no variance.** The only random
roll anywhere in combat is the ailment proc (§3.6).

### 3.2 Multipliers

| Source | Value |
|---|---|
| Weakness | ×2 |
| Resist | ×0.5 |
| Guard | ×0.5 |
| Attack buff / debuff | ×1.4 / ÷1.4 |
| Defence buff / debuff | ÷1.4 / ×1.4 |
| Charge / Concentrate | ×2.5, consumed on use |
| Shock, damage taken | ×1.5 |
| Technical | ×1.5 |
| Execute rider | ×1.5 |
| Knockdown combo | +0.1 per stack |

`almighty` is **never weak and never resisted** — it is checked before any affinity
lookup. It therefore can never trigger a knockdown either, which makes it the reliable
damage type that buys no tempo.

There is **no Null and no Reflect affinity.** A Persona reacts to a damage type in
exactly three ways: weak, resist, neutral.

### 3.3 Knockdown

A blow knocks a Persona down if **all** of these hold:

1. It hit a **weakness**, *or* it was a **Shock Technical** (physical into Shock).
2. Damage actually landed (`dealt > 0`) and the target was not warded.
3. The target was **not guarding**.
4. No passive prevented it (Stalwart — §6).
5. The target was **standing**. A Persona already down cannot be knocked down again.

### 3.4 Order of resolution — normative

Within a single attack, in this exact order:

1. Damage is applied. **HP changes here.**
2. The hit is reported.
3. Knockdown is evaluated — **while the body is still on the board**, even if the blow
   was fatal.
4. If the blow was lethal, the Persona is knocked out.
5. Counter reflection, if any.
6. Ailment rider, if any — **never on a killing blow**.

> This ordering is load-bearing. Because step 3 precedes step 4, **a weakness hit that
> kills still scores its knockdown and still grants a One More.**
>
> Step 1 destroys the HP the target had when the blow arrived, so any rule that asks
> about it must be handed the value rather than reading the instance. Stalwart is the
> one such rule — see §6.

### 3.5 One More

Knocking a **standing** enemy Persona down grants the attacker a **One More**:

- **+1 action**
- **+1 Persona change** (the Baton Pass)
- **the opponent's bench becomes targetable** — see §3.5.1

Baseline is **1 per turn**. The **Trickster** passive lifts the cap entirely for its
holder, so knockdowns scored during a One More keep the chain alive. The chain is still
bounded: each enemy Persona can only be knocked down once while standing.

A One More is granted from the **knockdown**, never from the weakness hit itself. So:

- A **killing** weakness hit **does** grant one.
- A **guarded** hit grants nothing.
- A hit on a Persona **already down** grants nothing.
- A hit that **Stalwart** shrugs off grants nothing.

Net action cost of a weakness knockdown is **zero** — the action is spent and
immediately handed back.

#### 3.5.1 Reaching the bench — normative

Attacks and offensive skills target the opponent's **active** Persona only. Exactly
three things change that:

| Route | Duration |
|---|---|
| **One More** | the granted action **only** — closes the instant any action is spent |
| **Ambush** (Special) | the **rest of the turn** |
| **Armageddon** (Special) | hits every enemy Persona at once |

The One More route is the narrow one, and the distinction is deliberate: spending the
extra action on a Guard closes the bench just as surely as spending it on an attack.

### 3.5.2 Alacrity — normative

A skill printing the **Alacrity** keyword refunds **one Persona change** every time it
is used. It is unconditional: no knockdown is required, no weakness is required, and it
pays out in full against a target that resists it or survives it.

Its only price is the **action** it costs, and there is one action per turn — so
Alacrity fires once a turn, twice if a One More grants a second action.

The refund is a **change**, not an action: it lets you move, not attack again. Its
purpose is the exit — spend your action attacking, take the change back, and rotate the
attacker to the bench before the reply lands.

It **stacks with Baton Pass**. Knocking a Persona down with an Alacrity skill grants
both refunds — the One More's change and Alacrity's own.

Alacrity is the **Swift** archetype keyword, and is printed on cheap, low-power skills
only.

> Alacrity was once gated on scoring a knockdown. That was redundant: a knockdown
> requires a weakness hit, a weakness hit grants a One More, and a One More already
> refunds a Persona change — so the keyword only ever paid on turns that had already
> paid, and did nothing on the turns a fragile Persona most needed to get out.

### 3.6 Status ailments

| Ailment | Effect | Duration |
|---|---|---|
| **Burn** | 5 damage at the end of the owner's turn | 3 turns |
| **Shock** | the Persona **cannot act at all** | 1 turn |

Ailments **refresh, never stack**. An ailment is never applied by a killing blow. The
ailment proc is the only RNG in combat; the chance is printed per skill.

**Technical** — hitting an ailing target with the matching follow-up, ×1.5:

- Burn + `phys` or `wind`
- Shock + `phys` — **and this also knocks the target down**, so it pays a One More

A Shock Technical replaces the plain Shock ×1.5 rather than stacking with it.

### 3.7 Buffs

Two stats only: **atk** and **def**. Duration 3 turns.

**Buffs do not stack.** Reapplying the same direction only refreshes the timer.
Applying the opposite direction **cancels both**, leaving the stat neutral — so a
debuff aimed at a buffed target is a cleanse, not a debuff.

### 3.8 Guard

Halves incoming damage and **prevents knockdown outright** — including from a weakness
hit, and therefore denying the One More. It lasts until the start of your next turn,
and drops if you change your active Persona.

Guard is checked **before** any knockdown-preventing passive and does not read HP, which
makes it strictly more reliable than Stalwart.

---

## 4. Personas

### 4.1 The field

One flat field, capacity **8 living Personas**. One of them is **active**; the rest are
the bench. Knocked-out Personas remain on the field but do not count against the cap.

Only the active Persona can attack, use skills, or be targeted (§3.5.1). Only the
active Persona regenerates SP.

### 4.2 Playing a Persona

Free — it does not cost your action. Gated by the **play-level ceiling**: a Persona
card is playable only if its printed level is at most
`(highest level among your living field Personas) + 10`. An empty field has no ceiling
to clear, so the first Persona is always playable.

### 4.3 Levelling

A Persona levels by scoring knockouts, by eating at the Gallows, or by being a fusion
result with Sacrificial Lamb material.

| Victim relative to killer | Levels earned |
|---|---|
| 5 or more levels **below** | **0** — fight upward |
| within 4 levels either way | 1 |
| 3 or more levels **above** | 2 |

Each level gained adds the card's printed `statGrowth` — **and current HP rises with
max HP**, so levelling mid-combat is a partial heal. Skills unlock at their printed
level.

### 4.3.1 The skill cap — normative

A Persona may know at most **8 skills**, counting **printed and inherited together**.

Nothing in the card data approaches this: the fattest card prints 6, and the most any
Persona has *unlocked* at its printed level is 4. The cap exists because **inherited
skills accumulate** — a fusion hands down two, and every Gallows meal, Skill Card and
Evolve adds another with no natural stop.

How the cap is enforced depends on whether the player is choosing:

| Route | At the cap |
|---|---|
| **Skill Card**, **Evolve**, **Gallows** inheritance | The action must name a skill to forget. The engine refuses it otherwise. |
| A printed skill **unlocking on level-up** | Declined and logged. Nothing is asked. |

The asymmetry is deliberate. A level-up fires from a knockout, a Gallows meal or a
fusion bonus — there is no point at which the player can be prompted — so the Persona
simply has no room and is told so. Everywhere the player *did* choose to learn
something, the choice of what to give up is theirs.

- **Any skill may be forgotten**, printed or inherited. A printed skill lives on the
  card, so giving one up is recorded on the instance and survives re-levelling.
- The legal action arrives with a **sensible default already filled in** — the weakest
  skill it knows, lowest power first — with every alternative attached as metadata. A
  one-click player and the bot both work; the player may overrule it.
- A drop offered when the Persona is **not** full is refused, so the UI cannot ask a
  question that does not exist.
- Forgetting is not permanent in principle: a skill given up can be taught again later.
- **A fusion result cannot exceed the cap at creation** — worst case is 4 unlocked
  printed skills plus the 2 it inherits.

### 4.4 SP

Every Persona **enters play at full SP** — starters, cards from hand, fusion results
and revivals alike. SP regenerates **only in the active slot**, `+3` per turn. The
bench neither gains nor loses.

The one exception is a Persona pulled back by **Traesto**: it keeps the SP it left
with, because it is not a purchase arriving, it is your own body walking back on.

### 4.5 Death, revival and retreat

- A **knockout** increments the owner's `koCount` permanently. Reviving does not undo it.
- **Revival Bead** returns a knocked-out Persona at 50% HP and full SP. It **keeps its
  level, stats, inherited skills and passive** — the instance is restored, not rebuilt.
- **Traesto** returns a Persona to your hand, healed to full, keeping its level, stats,
  inherited skills, passive **and SP**. Replaying it ignores the play-level ceiling.
- **A retreated Persona held in hand is destroyed if that card is discarded.** The
  instance is not preserved through the discard pile. This is intended: discarding the
  card is the player choosing to let it go.

---

## 5. Fusion and the Gallows

### 5.1 Fusion — normative

**Fusion costs your action.** You fuse or you attack, not both. It is *additionally*
rationed at **1 per turn**, and that ration is not redundant: a One More refunds the
action, so without the cap a weakness chain could fuse repeatedly in one turn.

Four gates, all checked before anything is sacrificed:

1. **Turn gate** — no fusion before **turn 4**. Because turns are counted per player,
   the first player waits two of their own turns and the second waits one. The
   asymmetry is deliberate: the first player is the one who could otherwise fuse first.
2. **Action** — you must have your action.
3. **Ration** — one fusion per turn.
4. **Result-level ceiling** — the result's printed level may be at most
   `(highest level on your field) + 20`. Wider than the play ceiling because fusion has
   already paid twice.

Then the recipe itself: two Personas from your **field, your hand, or one of each**,
matching the recipe's two Arcana, with **combined level** at or above the recipe's bar.

The result enters at its printed level and **inherits one thing from each parent** — a
skill, or that parent's passive. At most one passive can survive a fusion; overwriting
the result's own printed passive requires explicit confirmation. Sacrifices are **not**
knockouts and do not touch either KO tally.

Every recipe is tagged **offence** or **defence**, which is what deck generation uses to
decide which material an archetype is dealt.

### 5.2 The Gallows

Feed one Persona to another. The tier is decided by the food's level relative to the
eater's:

| Tier | Condition | Payout | Action? | Inherits |
|---|---|---|---|---|
| **Feast** | food ≥ eater | +2 levels, +1 permanent stat | **yes** | a skill **or** the passive |
| **Meal** | within 5 levels below | +1 level | **yes** | a skill |
| **Junk** | more than 5 levels below | 20% max HP, no levels | **no** | nothing |

**Sacrificial Lamb** adds +1 level on top of whichever tier it lands in.

The paid tiers and the junk tier are rationed **separately** — one each per turn — so
binning a dead card never costs you the feast you were saving your action for.

---

## 6. Passives

A Persona prints **at most one**, and most print none. Passives are never activated
choices: they are always-on or auto-triggered, never appear in the legal action list,
and never cost an action. Fusion and a Gallows feast can move a passive onto another
Persona.

| Passive | Effect |
|---|---|
| **Trickster** | One Mores chain — lifts the per-turn cap entirely |
| **Stalwart** | Cannot be knocked down while above 50% HP — **see below** |
| **Counter** | Reflects 25% of physical damage taken while standing |
| **Analyst** | Damaging an enemy reveals its whole affinity chart |
| **Bloodlust** | ×1.2 damage while behind on the KO tally |
| **Soul Battery** | ×2 SP regen |
| **Momentum** | Drawing a card after a skill costing ≤6 SP, once per turn |
| **Endure** | Survives one otherwise-fatal blow at 1 HP, once per match, against any damage source |
| **Sacrificial Lamb** | Fusion result enters at +2 levels |

> ### Stalwart reads HP **as it was when the blow landed** — normative
>
> Stalwart tests the Persona's HP **before** the incoming damage is subtracted, not
> what is left afterwards. Damage is still applied first in the resolution order
> (§3.4); the pre-hit value is captured and handed to the passive.
>
> Consequences, all intended:
> - A hit that **carries** the Persona past the halfway line is still refused. It was
>   healthy when it was struck, and that is what the rule asks about.
> - **A lethal blow does not defeat Stalwart.** A healthy Stalwart Persona killed
>   outright **dies standing**: no knockdown, and therefore **no One More** for the
>   attacker.
> - To knock a Stalwart Persona down you must get it to **half HP or below first**, and
>   then hit its weakness. The check is strictly greater-than, so exactly 50% is not
>   protected.
> - Guard is still checked first and still reads no HP, so it remains the more
>   unconditional denial.

---

## 7. Board pressure

### 7.1 The empty-field clock

An empty field is a **legal tactical state**, not a loss condition on its own — holding
Personas back as fusion fodder is intended play. But it is on a clock: you get **3 full
turns** starting with an empty field, and beginning a 4th loses the match.

While the clock runs, every draw is **hard-filtered to Persona cards** for as long as
your deck holds one. That filter is the timer's only side effect, and it exists so a
timer death is never draw luck. Playing any Persona resets the clock.

### 7.2 Board-control reward

End your turn with nothing living opposite you and your **next** draw phase deals one
extra card. Banked rather than paid immediately, and drawn uniformly — this is payment
for board control, not a comeback lever.

### 7.3 Fatigue

Running out of deck does not lose the match. The deck reshuffles from the discard and
the player takes a **Fatigue** stack; every subsequent turn of theirs deals
`5 × stacks` to all their living Personas. Death arrives via §1.1, not as its own
condition.

---

## 8. Comeback mechanics

All keyed to the **KO deficit** — how many more of your own Personas have been knocked
out than the opponent's. At zero or negative these are entirely inert, so a player who
is ahead never benefits.

The thresholds are **staggered on purpose**, so no single exchange switches the whole
stack on:

| Deficit | Effect |
|---|---|
| **2+** | Draws become quality-weighted |
| **3+** | Draw **2** cards per turn instead of 1 |
| **4+** | Whims of Fate reads **hidden** weaknesses, not only uncovered ones |

**Bloodlust** is the exception and fires at any deficit — it is a printed passive a
player chose to run, not a system handout.

---

## 9. Hidden information

A player knows: their own hand, their own discard, the public board.

A player does **not** know: the opponent's hand, either deck's order, or the RNG state.

An enemy Persona's weaknesses and resists are hidden until **uncovered** — you learn a
type by striking with it, or all at once via Analyst. A rewrite Special replaces a
Persona's chart and wipes everything either player had learned about it, which is the
counter to a memorised card database.

---

## 10. Online play — normative

**Peer-to-peer and host-authoritative.** There is no game server and no database.

- The **host** owns the one real state and is the only side that ever calls
  `applyAction`.
- The **guest** holds nothing but a redacted view and sends action *requests*. The host
  validates each one and either applies it or rejects it.
- Every view sent to a client passes through redaction first, so a client is never sent
  the opponent's hand, the deck order, or the RNG seed. Redaction lives in the engine,
  not the network layer, because it is a rule about what a player may know.

Transport is **WebRTC** browser-to-browser by default. The connection code is the
WebRTC handshake itself, which is why it is long. Pointing Settings at the optional
bundled **rendezvous server** shortens it to a 6-character code; that server brokers
connection details for ten minutes and **no game data passes through it**.

Because the host is also a player, this is protection appropriate to a friendly game
rather than tournament security.

**There is no save for an online match** — closing a tab ends it. Local hot-seat
matches *are* saved and resume behind the pass-the-device gate.

---

## 11. Determinism

The engine is a pure state machine, completely separate from the UI:

```
newState = applyAction(state, action)
legal    = getLegalActions(state, player)
```

It contains **no DOM access and no `Math.random()`**. Every random draw comes from a
seeded RNG carried inside the game state. Consequences that the rest of this document
depends on:

- A match replays **identically** from its seed. Balance simulations are exactly
  reproducible.
- The state is plain JSON — which is what makes hot-seat saves and the online protocol
  possible at all.
- `applyAction` deep-clones before mutating and **throws** on an illegal action, so a
  rule violated halfway through leaves no partial state behind.

---

## Appendix A — Tunable constants

Every number in this document comes from `src/engine/config.js`. Retuning it there
keeps this document true; nothing else hard-codes these.

| Constant | Value |
|---|---|
| `FIELD_CAP` | 8 |
| `KO_TARGET` | 8 |
| `OPENING_HAND` / `HAND_LIMIT` | 5 / 7 |
| `DRAW_PER_TURN` / `PASS_DRAW` | 1 / 1 |
| `ACTIONS_PER_TURN` | 1 |
| `PERSONA_CHANGES_PER_TURN` | 1 |
| `MAX_ONE_MORE_PER_TURN` | 1 |
| `ITEMS_PER_TURN` / `SPECIALS_PER_TURN` | 1 / 1 |
| `FUSION_USES_ACTION` | **true** |
| `FUSIONS_PER_TURN` | 1 |
| `FUSION_FIRST_TURN` | 4 |
| `FUSION_LEVEL_GAP` / `PLAY_LEVEL_GAP` | 20 / 10 |
| `DECK_MAX_PERSONA_LEVEL` | 25 |
| `SP_REGEN_PER_TURN` | 3 |
| `WEAK_MULT` / `RESIST_MULT` / `GUARD_MULT` | 2 / 0.5 / 0.5 |
| `BUFF_MULT` / `CHARGE_MULT` | 1.4 / 2.5 |
| `SHOCK_TAKEN_MULT` / `TECHNICAL_MULT` / `EXECUTE_MULT` | 1.5 / 1.5 / 1.5 |
| `COMBO_DAMAGE_STEP` | 0.1 |
| `BASIC_ATTACK_POWER` | 30 |
| `BURN_DAMAGE` / `BURN_DURATION` | 5 / 3 |
| `SHOCK_DURATION` / `BUFF_DURATION` | 1 / 3 |
| `MAX_SKILLS_PER_PERSONA` | 8 |
| `STALWART_HP_RATIO` | 0.5 |
| `ALACRITY_REFUND` | 1 |
| `COUNTER_REFLECT` | 0.25 |
| `EMPTY_FIELD_LOSS_TURNS` | 3 |
| `GALLOWS_PER_TURN` / `GALLOWS_JUNK_PER_TURN` | 1 / 1 |
| `COMEBACK_FARM_GAP` | 5 |
| `FATIGUE_DAMAGE` | 5 |

> `COMEBACK_FARM_GAP` drives **two** systems: the Gallows Meal/Junk boundary (§5.2) and
> the "too far below to teach anything" gap for KO levelling (§4.3). Retuning it moves
> both.

---

## Appendix B — Known inconsistencies resolved by this spec

Corrected in `src/ui/rules.js` while writing this document, per "the rules match the
game":

1. **"Fusion is free; the Gallows is not"** (section heading) — stale from the era when
   fusion cost no action. Now *"Fusion and the Gallows both cost your action"*.
2. **"No action left … (Fusion is free, so it is still available.)"** — same staleness,
   and actively misleading. Now lists fusion among the things that spend the action.
3. **Bench targeting contradicted itself.** One FAQ called One More *"the one exception
   to active-only targeting"*; another said the exceptions were Ambush and Armageddon.
   Both now state all three routes and the One More duration limit.

## Appendix C — Deliberately NOT in this game

- **Crits, damage variance, accuracy, evasion.** Damage is deterministic. Hama and Mudo
  were once an instant-kill dice roll and were deliberately replaced with a readable
  execute multiplier.
- **Null and Reflect affinities.** Three reactions only: weak, resist, neutral.
- **Buff stacking.** Buffs refresh; they never accumulate.
- **A separate bench size.** One field of 8; "bench" just means "not active".
- **A game server or account system.** Local profile is a name in `localStorage`. No
  signup, no login.
