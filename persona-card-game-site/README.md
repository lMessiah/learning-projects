# Persona Card Game (Unofficial, Patch 3)

A browser card game inspired by the **mechanics** of ATLUS's Persona series, played as a TCG.
Fan project — not affiliated with or endorsed by ATLUS or SEGA. **All card art is placeholder
CSS** (coloured frames + arcana symbols + text). No game artwork, sprites or logos are used.

Runs entirely client-side: no backend, no accounts, no database. (Online play is
peer-to-peer; a tiny optional server exists only to shorten invite codes.)

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # engine, bot and UI suites
npm run build    # static bundle in dist/ (relative asset paths)
npm run simulate # headless balance report (200 bot-vs-bot matches, ~100s)
npm run relay    # match-link relay for online play (port 8788)
npm run relay:smoke         # 11 checks against it, no browser needed
node server/rendezvous.js   # optional: six-character WebRTC codes (legacy path)

# The build uses base: './', so dist/ serves from anywhere:
cd dist && python3 -m http.server
```

## Settings

Themes are pure CSS-variable overrides on a root class (`theme-p3` / `theme-p4` /
`theme-p5` in `src/styles/themes.css`) — a fourth theme is a copy-paste block, no
logic changes. The theme follows the deck you picked unless Settings locks one in;
hot-seat uses one theme for the whole match. Animation speed, auto-end turn,
auto-skip single-target choices, the display name and the theme override all
persist in localStorage and apply immediately.

## Architecture

| Path | Purpose |
| --- | --- |
| `src/data/cards.json` | The entire card database — Personas, Items, Specials, fusion recipes, deck flavours. Adding cards never touches code. |
| `src/data/cards.js` | Pure loader: resolves skill references, freezes data, validates integrity. |
| `src/data/archetypes.js` | Deck **generation**: a flavour picks the card pool, an archetype weights it, the match seed rolls the 30 cards. Twelve decks, no twelve lists. |
| `src/engine/passives.js` | The passive system, as a table of hooks. One printed passive per card at most; adding one is an entry here plus a field in cards.json. |
| `src/ui/tips.js` | Post-loss tips (from the per-player counters the engine keeps), the six strategy tips, and the rotating connection-screen tip. |
| `src/ui/matchStats.js` | The post-match scoreboard: damage ledger, knockout timeline, biggest hit, MVP per side. Reads the engine's own counters, never the log. |
| `src/ui/attribution.js` | The site-attribution link, rendered into the Settings credits section. |
| `tools/simulate.js` | Headless balance simulator. Not part of the app bundle. |
| `src/engine/` | Pure deterministic state machine — `applyAction(state, action)` / `getLegalActions(state, player)`. No DOM, no `Math.random()`; all randomness comes from a seeded RNG stored in state, so the same engine can later run on a server for online play. |
| `src/engine/bot.js` | The four bot difficulties. Also pure: `chooseBotAction(state, player, difficulty, rng)` returns an action plus the advanced RNG, and only ever picks from `getLegalActions`. |
| `src/ui/` | Rendering and event handling only. Never contains game rules. |
| `server/relay.js` | The match relay: seats two players in a room and forwards their messages verbatim. Never imports the engine. Required for shareable match links. |
| `server/rendezvous.js` | Optional, zero-dependency short-code server for the WebRTC path. Not needed to play. |
| `deploy/` | systemd unit, nginx site and a step-by-step guide for putting both on a server. |
| `src/net/` | Online play: `transport.js` (a 4-method interface + an in-memory pair for tests), `websocket.js` (relay transport, used by match links), `webrtc.js` (peer-to-peer data channel, copy-paste signalling), `onlineMatch.js` (host-authoritative protocol, same controller shape the board already consumes). |
| `src/ui/game/` | The match screen: `controller.js` (owns the state, paces the bot), `board.js` (renders + input), `inspect.js` (hover tooltip / tap detail), `anim.js` (state-diff feedback), `setup.js` (vs-bot picker), `hotseat.js` (local multiplayer + privacy gate). |
| `src/styles/select.css` | The one selection & highlight system: hoverable / selected / valid-target / invalid, for every screen that lets you pick something. Loaded last so it wins; rings are `box-shadow`, never a border width, so a highlight can never move the layout. |
| `tests/` | Vitest suites. The four `botMatch.*.test.js` files play whole matches through the real UI and are one difficulty per file — see the note in `tests/support/fullMatch.js` before merging any of them. |

### The board never reflows

Everything that appears and disappears mid-turn lives **outside the board's
layout**: the battle log is its own fixed-width scrolling column, the One More
announcement is a chip in a fixed-height strip plus a transform-only splash, and
the Full Analysis hand reveal floats over the board rather than being inserted
into it. `anim.js` animates only `transform`, `opacity`, `filter` and the width
of a bar fill inside a fixed-height track — so a hit, a heal, a Technical or the
fusion sequence can never move a single tile. `tests/anim.test.js` asserts that
contract against the stylesheet itself.

Every base duration lives in one table, `DURATIONS` in `anim.js`. `board.js`
stamps it onto the board element as `--dur-*` custom properties and the
stylesheet only ever divides those by `--anim-scale`, so the JS and the CSS
cannot drift apart and the speed setting is a single multiplier. The two long
ceremonies (fusion, Gallows) are skippable: the overlay itself stays
`pointer-events: none` so it can never swallow a click meant for the board, and
a one-shot capture-phase listener clears it on the way past.

### Resigning and the post-match screen

`RESIGN` is legal in `getLegalActions` on your own turn, and the handler accepts
it at any time — the legal list is what the bot and the auto-end-turn logic read,
and neither should ever consider conceding, but a player who wants out should not
have to wait for their opponent's turn. It is reachable from the pause menu and
from a small button beside the log, always behind a confirmation, and online it
travels as an ordinary action for the host to apply.

Every match — win, loss or resignation — ends on a scoreboard: damage dealt and
taken, One Mores, Technicals, fusions, Gallows, cards drawn and
played, SP spent, the biggest single hit with the skill that threw it, the full
knockout timeline, and an MVP Persona per side.

The result overlay blurs the board behind it, which used to take the battle log
away at exactly the moment it is worth reading, so it carries a **Battle log**
tab of its own holding the *complete* feed rather than the sidebar's recent
tail. The log only ever clears when a new match starts, because a new match is a
new state with a new log.

## A turn, at a glance

All of these are config constants in `src/engine/config.js`.

| Allowance | Per turn |
| --- | --- |
| Draw | 1 (plus 1 more if you pass) |
| SP regen | 3, **to the active Persona only** — the bench regains nothing |
| Action | 1 — attack, skill, guard, a Feast/Meal at the Gallows, or pass |
| **Fusions** | **1** — free, like an Item or a Special |
| **Item cards** | **1** |
| **Special cards** | **1** (counted separately from Items) |
| Persona change | 1, plus 1 extra on a One More (Baton Pass) |
| Personas played to the field | unlimited up to `FIELD_CAP` (8) |
| Gallows sacrifices | 1 — costs your action unless it was junk food |
| Hand limit | 7, discard down at end of turn |

Win by knocking out `KO_TARGET` (8) of the opponent's Personas.

### One More

Knocking a **standing** enemy Persona down with a weakness hit earns a One More:
one extra action, one extra Persona change (Baton Pass), and — the single
exception to active-only targeting — that action may hit **any** enemy Persona,
bench included. Hitting something already down pays nothing, a guarded hit pays
nothing, and a killing blow pays a level-up instead. Baseline is one per turn;
the **Trickster** passive lifts the cap so knockdowns scored during a One More
keep the chain alive.

### Technicals

Hitting a Persona that already has an ailment with the right follow-up lands a
**Technical** for ×1.5 damage. Burn combos with physical and wind; Shock combos
with physical, and also knocks the target down — which pays a One More by the
ordinary rule. Both halves are visible on the board before you commit, and a
Shock Technical *replaces* the plain +50% Shock damage rather than stacking with
it.

Ailments come from two places: every Fire skill can inflict Burn and every
Electric skill can inflict Shock, each printing its own percentage (40% at the
light and medium tiers, 50% heavy, 70% severe) — and **Lesser Theurgy**, which
inflicts Burn *or* Shock with no roll at all and costs no action, so you can
play it and cash it in on the same turn. Shock expires at the end of its
victim's next turn, so a Shock Technical has to be taken immediately; Burn lasts
three and can wait.

### Rewriting what a Persona is

Each deck holds one Special that **rewrites** a Persona's weaknesses and
resists: **Turn of the Moon** (P3, your active), **Jester's Trickery** (P4, any
one of yours) and **Change of Heart** (P5, both actives at once). The new chart
is drawn from the seeded RNG, keeps the same *number* of weaknesses and resists,
and is disjoint — so it changes what a Persona is without making it stronger or
weaker. Everything either player had uncovered is wiped.

It exists for two reasons. The card database is finite, so a dedicated player
eventually stops reading the board and starts reciting it. And the **Brutal**
bot reads that same database outright from turn one — its one sanctioned cheat.
A rewritten Persona is no longer described by its card, so Brutal's cheat buys
it nothing and it has to probe like everyone else. That is implemented as one
branch in `perceivedAffinity` and one flag (`rewritten`) on the instance.

Every reader of a Persona's chart — the damage formula, the bot, the card face,
the board strip, Whims of Fate, Third Eye — goes through `state.affinitiesOf`,
so none of them can disagree about what a Persona currently is.

### Twist of Fate

A rewrite scrambles a chart and hands you a new puzzle. **Twist of Fate** — one
per deck, no flavour exclusive — makes a single precise edit instead: you *name
an element*, and it replaces one of the enemy active's weaknesses with it. It is
the answer to the worst position in the game, which is holding a hand full of
fire against something that is weak to nothing you own.

Two rules keep it a trade rather than a free win:

- You **cannot** name something the target **resists**. A resist beats a
  weakness, so it would be a dead card — the resist is not stripped, the option
  is simply never offered. `twistableElements()` is what both the picker and the
  handler read, so the UI cannot offer a choice the engine would refuse.
- **The defender** chooses which weakness they give up. There is no way to pause
  an action and ask them, and a coin flip would not be "the opponent chooses" in
  any meaningful sense, so `twistSacrifice()` makes their best move for them:
  they shed a weakness you had already *uncovered* before one you had not, since
  the uncovered one is the one actually costing them. Fully deterministic — it
  spends no RNG at all, which also means it can never desync an online match.

The new weakness is revealed to both players immediately, so Whims of Fate can
fetch an answer for it on the spot.

### No random knockouts

Nothing in the game has a chance to remove a Persona outright. The Hama and Mudo
lines are ordinary Light and Dark damage skills with a deterministic **execute**
rider (`CONFIG.EXECUTE_MULT`): Hama hits +50% harder against a target that is
already knocked down, Mudo against one below 40% HP. Ailment riders are the only
randomness a skill carries, and every one of them prints its percentage on the
card.

### The Gallows

Once a turn, feed one Persona from your field or hand to another Persona on your
field. What you get back — and what it costs — depends entirely on how the food
compares with the eater. `gallowsMeal()` in `state.js` is the only place that
comparison is made; the legal-action list, the handler, the bot and the panel's
before-you-confirm preview all read it, so the tier the UI shows you is by
construction the tier you get.

| Tier | Food level | Gain | Cost |
| --- | --- | --- | --- |
| **Feast** | at or above the eater | **+2 levels** | your action |
| **Meal** | within `COMEBACK_FARM_GAP` (5) below | **+1 level** | your action |
| **Junk** | further below than that | no levels, **20% HP** | **nothing** |

Sacrificial Lamb adds +1 on top of whichever tier it lands in, so a Lamb is
always the best version of the meal it would otherwise have been. Junk disposal
is free because clearing a card your board outgrew ten turns ago is housekeeping
rather than a play, and charging a whole turn for it meant nobody ever did it —
but all three tiers share the one-per-turn cap, so it stays tempo and never
becomes an engine. Like fusion material, a fed Persona is **not** a knockout.

Alongside it, Persona draws gain a slowly rising **level floor**: from turn
`DRAW_SCALE_START` (8) the minimum printed level a draw aims for climbs by 1
every 2 turns up to `DRAW_SCALE_CAP` (20). It is a re-weighting rather than a
filter, so a deck of nothing but openers still draws normally — it just stops
turn 27 feeling like turn 3. Explicit draw manipulation always overrides it.

### Draw manipulation

Four Specials reserve or reshape what you draw, all deterministic through the
seeded RNG and all overriding the Momentum weighting and the level floor for the
draw they claim:

- **Fortune's Draw** — name an Arcana; your next draw is the first Persona of it.
- **Arcana Reading** — name an Arcana; your next draw is the *highest-level* one.
- **Whims of Fate** — your next draw becomes a Persona that answers the enemy
  active's weaknesses. It matches only weaknesses you have uncovered until you
  are `WHIMS_DEFICIT` (2) knockouts behind, at which point it matches all of
  them — without revealing anything. Redaction strips the resolved type list
  from every view, so the card hands you the answer and not the question.
- **Providence** — look at the top 5 and discard any of them.

### The SP economy

Every Persona **enters play at full SP** — starters, cards played from hand,
fusion results and revivals alike. Scarcity comes from spending, not from
arriving broke: SP regenerates **in the active slot only**, so a Persona on the
bench neither gains nor loses it and rotating a spent one out is a real cost
rather than a free refill.
Costs are tuned against that tap: ~6 is a light probe, 8 a workhorse, 14+
something you save for, spend an item on, or move with SP Transfer. SP-restore
items are capped at **two per deck between them** (`deckGroup`).

### Passives

A Persona card may print at most one passive, and most print none. Passives are
always-on or auto-triggered — never an activated choice, never a legal action.
They are declared as hooks in `src/engine/passives.js`: `onKnockdownAttempt`,
`onDamageTaken`, `onFatalDamage`, `onDamageDealt`, `onSkillUsed`, `onTurnStart`,
`onFusionMaterial`, plus damage-multiplier and One-More-chain hooks.

**Any** passive can be moved onto another Persona — there is no approved list.
What limits it is that there are exactly two channels, and both are expensive:
a **fusion** takes one skill *or* that parent's passive from each parent, and
the **Gallows on its feast tier only** (food grown to the eater's own level) can
hand over the food's passive instead of one of its skills. A meal or a junk
disposal never moves one. A Persona carries at most one passive, so inheriting
over an existing one **replaces** it, and both channels demand an explicit
confirmation before that happens.

### Field presence

An empty field is a **legal tactical state**, not evidence of losing. Holding
Personas back as fusion or Gallows fodder, or waiting for the play ceiling to
reach the card you actually want, is intended play — nothing forces a Persona
out of your hand, and being boardless never pays a comeback benefit.

The one consequence is a clock. You get `EMPTY_FIELD_LOSS_TURNS` (3) **full
turns**, each with its own draw phase, starting with an empty field; beginning a
fourth loses the match outright. Playing any Persona, by any route, resets it.

While the clock runs, every draw is **hard-filtered to Persona cards** for as
long as the deck holds one. That filter is the timer's only side effect: it
changes *what* you draw, never *how many*. Draw quantity is Underdog Draw's
business and draw quality is Momentum's, and both read the KO tally alone.

The mirror of the rule: end your turn with your **opponent's** field empty and
your next draw phase deals you one extra card, drawn uniformly. Banked rather
than paid on the spot, because a card handed over at the end of your own turn
arrives when there is nothing left to do with it.

### Comeback mechanics

All keyed off the KO deficit, and all inert at parity or ahead:

- **Momentum Draw** — draws are weighted toward higher-quality cards, scaling
  with the deficit, through the seeded RNG so online stays reproducible.
- **Underdog Draw** — behind by `COMEBACK_UNDERDOG_DEFICIT` (3), draw 2 a turn.
- **Level catch-up** — a knockout teaches nothing when the victim was
  `COMEBACK_FARM_GAP` (5) or more levels below the killer.

### Keywords

**Alacrity** on a skill refunds a Persona change when the skill knocks the
target down — hit, rotate, hit again. It is the Swift keyword, and it is printed
next to the skill name on the card.

### Skill Cards and drains

A **Skill Card** is an Item that permanently teaches its printed skill to one of
your field Personas for the rest of the match — the way you patch a hole in your
board's element coverage without waiting for a level. It can only ever name an
entry in `skillLibrary`, so it can never teach a passive, and
`deckGroup: "skill-card"` caps them at two per deck between them.

**Traesto** is the tactical retreat: one per deck, rare, and it uses your
action. It pulls one of your field Personas back into your hand as the *same
body* — level, learned and inherited skills, passive and SP all survive, held on
the hand entry as a `persona` blob. What it sheds is the fight: ailments, buffs
and debuffs go, and HP comes back in full. Putting it down again ignores the
play-level ceiling, because the ceiling exists to stop you dropping a card you
have not earned and this one was on your field a moment ago. If the retreating
Persona was your active, one of your bench steps up for free. It is never a
knockout, and retreating your last Persona is legal — you simply start the
empty-field clock.

**Drain skills** are skills, not affinities — there is no drain or repel
reaction anywhere in the game. **Life Drain** takes **20% of the target's
current HP** and gives the user exactly that much back: it scales against a big
healthy wall, and because it takes a share of what is *left* it can never itself
land a knockout. **Spirit Drain** deals no damage at all and moves up to 6 SP
from the enemy active to yours for a 1 SP cast. Both are Almighty, so neither
has any weakness, resist or Technical interaction.

### Flavour exclusives

Each flavour holds three or four cards no other deck can run, plus a
`flavourLean` archetype axis the deck builder weights on top of the play style
you chose:

| Flavour | Lean | Exclusives |
| --- | --- | --- |
| **P3** — haymaker | Aggressive | Theurgy · Dark Hour · Moonless Gown · Chewing Soul · **Turn of the Moon** |
| **P4** — midrange grind | Defensive | Shuffle Time · Persona Evolution · Steak Skewer · Full Analysis · **Jester's Trickery** |
| **P5** — scout then strike | Tactical | Phantom Strike · Smoke Bomb · Third Eye · **Change of Heart** |

### Decks are generated

You pick a **flavour** (P3/P4/P5, which decides the card pool) and an
**archetype** (Aggressive / Defensive / Tactical / Swift, which decides how that
pool is weighted). The 30 cards are then rolled from the match seed, so twelve
decks exist without twelve lists to maintain — add a card with an `affinity`
block in cards.json and it enters circulation. `validateDecks()` checks that
every flavour x archetype pair still builds a legal 30-card deck — and that it
contains the material for at least two completable fusion recipes, repairing the
most redundant slots if the weighting left it unable to fuse.

### The power curve

A Persona card can only be **played to the field** if its printed level is at most
`highest level among your field Personas + PLAY_LEVEL_GAP` (10). Stronger cards wait
in hand until your board grows into them. Prebuilt decks additionally contain nothing
above `DECK_MAX_PERSONA_LEVEL` (25) — every Persona beyond that is fusion-only, and
each one is the result of exactly one recipe (both enforced by `validateDatabase()`).

Fusion answers to a gap of its own, `FUSION_LEVEL_GAP` (20) — wider than the hand-play
gap because fusion has already paid twice, in two sacrificed Personas and a combined-level
requirement. The two gates ask different questions: combined level asks whether the
*materials* are big enough, the gap asks whether your *board* has earned a Persona that
size, and only the second stops a small board jumping straight to the top. The ceiling is
read before the parents are sacrificed, so the Persona you feed in is the one that admits
the result — which is what makes the recipes a ladder (mid tier 28–40, then high tier
46–64) climbed a rung at a time rather than a menu.

Fusion is also shut for the opening turns (`FUSION_FIRST_TURN`, turn 4). The first turns
are for putting a board down; a fusion landing before either player has committed anything
skips that entirely.

## What's in Patch 3

Everything below is built, wired to the UI and covered by tests.

| | |
| --- | --- |
| **Modes** | Vs Bot (Easy / Medium / Brutal / Chaos), local hot-seat with a pass-the-device gate, and peer-to-peer online play with no server or account |
| **Combat** | Weakness → knockdown → One More, Technicals off Burn and Shock, Guard, buffs and debuffs, Charge and Concentrate, execute riders, no random knockouts anywhere |
| **The board** | Fusion (free, 1/turn), the three-tier Gallows with skill and passive inheritance, 9 fully transferable passives, Baton Pass, bench targeting, the empty-field clock |
| **Cards** | Generated decks from 3 flavours × 4 archetypes, flavour exclusives, Skill Cards, drains, draw manipulation, affinity rewrites, Twist of Fate, Traesto |
| **Around the match** | Battle log sidebar and a full post-match log tab, resignation, post-match scoreboard with a knockout timeline and MVP, contextual post-loss tips, a full Rules and FAQ screen |
| **Presentation** | Three themes, one selection-highlight system across every picker, a full battle animation pass, a skippable Velvet-Room fusion sequence, a skippable victory/defeat outro, animation-speed and play-assist settings |
| **Not in it** | No shop, no deck building, no between-match progression, no audio, no saved games |

## Online multiplayer

There are two ways in, and the game picks between them by itself.

### Match links (relay)

With `server/relay.js` running, hosting produces a link like
`https://yoursite/#/join/ABC234`. Sending it is the entire handshake — the guest
opens it and the match starts. The relay seats two players in a room and
forwards their messages verbatim; it never imports the rules engine, parses a
game message, or stores anything. See `deploy/README.md` to run it on a server.

```bash
npm run relay        # port 8788, loopback only
npm run relay:smoke  # prove it works, no browser required
```

The relay address is empty by default, which means *the same host the page came
from, at `/ws`* — a deployed site behind the bundled nginx config needs no
configuration. Set Settings → Match links only when the relay lives elsewhere.

### Peer to peer (no server)

Without a relay the game falls back to WebRTC: two browsers talk directly over a
data channel and there is no backend at all. The peers connect by pasting their
connection details to each other. That code is long because it *is* the connection detail — a WebRTC
handshake carries a 32-byte DTLS fingerprint, ICE credentials and candidate
addresses, so ~90 characters of it are irreducible.

### Short codes (optional)

For six-character codes like `ABC234`, run the bundled rendezvous server and
point Settings → Online match codes at it:

```bash
node server/rendezvous.js      # port 8787, zero dependencies, in memory
```

It stores the two connection blobs under a short key for ten minutes and does
nothing else — it never sees game state, never runs the engine, and the peers
still connect directly to each other. It is the only server in the project and
it is entirely optional; with the field empty the serverless handshake is used.

The host runs the only real state and is the only side that calls `applyAction`.
Every view sent to a player first goes through `redactStateFor(state, seat)` in
the engine, which hides the opponent's hand, **both** deck orders and the RNG —
so neither side can read the other's cards or predict a roll. The guest validates
locally for instant feedback, but the host re-validates authoritatively and a
tampered client gets its move rejected.

Since the host is also a player, this is protection for a friendly game, not
tournament security. Making it airtight means a neutral authoritative server —
which is a transport swap away, because `createHostSession` is already written
against the transport interface rather than WebRTC.
