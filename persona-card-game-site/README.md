# Persona Card Game (Unofficial Alpha)

A browser card game inspired by the **mechanics** of ATLUS's Persona series, played as a TCG.
Fan project — not affiliated with or endorsed by ATLUS or SEGA. **All card art is placeholder
CSS** (coloured frames + arcana symbols + text). No game artwork, sprites or logos are used.

Runs entirely client-side: no backend, no accounts, no database.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # engine, bot and UI suites
npm run build    # static bundle in dist/ (relative asset paths)
node server/rendezvous.js   # optional: six-character online match codes

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
| `src/data/cards.json` | The entire card database — Personas, Items, Specials, fusion recipes, decks. Adding cards never touches code. |
| `src/data/cards.js` | Pure loader: resolves skill references, freezes data, validates integrity. |
| `src/engine/` | Pure deterministic state machine — `applyAction(state, action)` / `getLegalActions(state, player)`. No DOM, no `Math.random()`; all randomness comes from a seeded RNG stored in state, so the same engine can later run on a server for online play. |
| `src/engine/bot.js` | The four bot difficulties. Also pure: `chooseBotAction(state, player, difficulty, rng)` returns an action plus the advanced RNG, and only ever picks from `getLegalActions`. |
| `src/ui/` | Rendering and event handling only. Never contains game rules. |
| `server/rendezvous.js` | Optional, zero-dependency short-code server. Not needed to play. |
| `src/net/` | Online play: `transport.js` (a 4-method interface + an in-memory pair for tests), `webrtc.js` (peer-to-peer data channel, copy-paste signalling), `onlineMatch.js` (host-authoritative protocol, same controller shape the board already consumes). |
| `src/ui/game/` | The match screen: `controller.js` (owns the state, paces the bot), `board.js` (renders + input), `inspect.js` (hover tooltip / tap detail), `anim.js` (state-diff feedback), `setup.js` (vs-bot picker), `hotseat.js` (local multiplayer + privacy gate). |
| `tests/` | Vitest suites. |

## A turn, at a glance

All of these are config constants in `src/engine/config.js`.

| Allowance | Per turn |
| --- | --- |
| Draw | 1 (plus 1 more if you pass) |
| Action | 1 — attack, skill, guard, fuse or pass |
| **Item cards** | **1** |
| **Special cards** | **1** (counted separately from Items) |
| Persona change | 1, plus 1 extra on a One More (Baton Pass) |
| Personas played to the field | unlimited up to `FIELD_CAP` (8) |
| Hand limit | 7, discard down at end of turn |

Win by knocking out `KO_TARGET` (8) of the opponent's Personas.

### The power curve

A Persona card can only be **played to the field** if its printed level is at most
`highest level among your field Personas + PLAY_LEVEL_GAP` (10). Stronger cards wait
in hand until your board grows into them. Prebuilt decks additionally contain nothing
above `DECK_MAX_PERSONA_LEVEL` (25) — every Persona beyond that is fusion-only, and
each one is the result of exactly one recipe (both enforced by `validateDatabase()`).

Fusion is exempt from the gap: it is already paid for with two sacrificed Personas
and a combined-level requirement, and the recipes form a ladder — mid tier (28–40)
then high tier (46–64).

## Phase status

- [x] **Phase 1** — Card database + card renderer + gallery
- [x] **Phase 2** — Game engine + unit tests
- [x] **Phase 3** — Vs Bot mode (Easy / Medium / Brutal / Chaos)
- [x] **Phase 4** — Local multiplayer (hot-seat, pass-the-device screen)
- [x] **Phase 5** — Fusion + Special cards fully wired in
- [x] **Phase 6** — Settings + polish (themes, play assists, animation speed, reset)
- [x] **Online multiplayer** — peer-to-peer, host-authoritative, no server

## Online multiplayer

Two browsers talk directly over a WebRTC data channel. By default there is no
backend at all: the peers connect by pasting their connection details to each
other. That code is long because it *is* the connection detail — a WebRTC
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
