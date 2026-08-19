/**
 * The five How to Play lessons.
 *
 * Each is a scripted board plus a list of coaching steps. The board is authored
 * (see scenario.js) so the lesson always finds the position it describes; the
 * PLAY is not, so you can ignore the coach entirely and the lesson still works.
 *
 * A step is one of:
 *   { title, say }                        a paragraph, dismissed with Next
 *   { title, do, until, hint?, point? }   an objective, finished by playing
 *
 * `until(state, atStepStart)` gets the live board and the board as it was when
 * the step opened, so objectives can be relative ("they have taken more
 * damage") rather than absolute. `point` is a CSS selector for the control the
 * step is about — the action bar carries `data-act`, skill buttons carry
 * `data-skill-id`, and hand cards carry `data-card-id`.
 *
 * ── Rules that keep these honest ──────────────────────────────────────────
 *
 * Everything asserted in the text has to be true of the shipped card database,
 * not of what the database said when the lesson was written. `tests/
 * tutorial.test.js` builds every scenario and checks the specific claims: that
 * Jack Frost really is weak to fire, that Pixie really knows Zio at the level
 * the board hands it over at, that the fusion the lesson asks for really is
 * reachable from the board it sets up. If a balance pass moves one of those,
 * a test fails rather than a player being lied to.
 */
import { getActive, livingField, personaSkills, buffOf } from '../../engine/index.js';

/* ------------------------------------------------------------------ *
 * Predicate helpers — small, so the lesson data stays readable
 * ------------------------------------------------------------------ */

const foe = (state) => getActive(state, 1);
const fieldOf = (state, p) => state.players[p].field;
const findCard = (state, p, cardId) => fieldOf(state, p).find((x) => x.cardId === cardId);

/** They have lost HP since this step opened. */
const damagedThem = (state, at) => {
  const before = fieldOf(at, 1).reduce((sum, p) => sum + p.hp, 0);
  const now = fieldOf(state, 1).reduce((sum, p) => sum + p.hp, 0);
  return now < before;
};

/** A full turn has gone by. */
const turnPassed = (state, at) => state.turn > at.turn;

/** You have put another body down. */
const playedABody = (state, at) => livingField(state, 0).length > livingField(at, 0).length;

const knowsSkill = (state, persona, skillId) =>
  Boolean(persona) && personaSkills(state, persona).some((s) => s.id === skillId);

/* ------------------------------------------------------------------ *
 * 1 — First Blood
 * ------------------------------------------------------------------ */

const BASICS = {
  id: 'basics',
  number: 1,
  icon: '⚔️',
  title: 'First Blood',
  summary: 'How you win, how you attack, and what a weakness buys you.',
  minutes: 4,
  scenario: {
    seed: 101,
    turn: 1,
    players: [
      { name: 'You', deckId: 'p3', archetype: 'aggressive', starter: 'orpheus', controller: 'human' },
      { name: 'Tutorial', deckId: 'p4', archetype: 'defensive', starter: 'jack-frost', controller: 'bot', difficulty: 'easy' },
    ],
    field: [
      [{ cardId: 'orpheus', level: 4, active: true }],
      [{ cardId: 'jack-frost', level: 6, active: true }],
    ],
    hand: [['pixie', 'medicine', 'muscle-drink'], ['medicine']],
  },
  outro:
    'That is the whole loop: **put bodies down, find the weakness, spend the extra action**. Everything else in this game is a way of doing one of those three things better.',
  steps: [
    {
      title: 'What winning looks like',
      say:
        'You win by knocking out **8 of your opponent\'s Personas**. Not by reducing them to zero cards, not by surviving longest — eight knockouts, and the match is over.\n\nThat cuts both ways. Your own Personas are the resource you spend to get there, so the question every turn is not "can I attack?" but "what am I trading?"',
    },
    {
      title: 'Bodies first',
      do:
        'You have **Orpheus** out and one Persona standing. That is thin. Playing a Persona from your hand is **free** — it does not cost your action — so there is almost never a reason not to.',
      hint: 'Click **Pixie** in your hand.',
      point: '.hand-tile[data-card-id="pixie"]',
      until: playedABody,
    },
    {
      title: 'One action a turn',
      say:
        'You may play as many Personas as you like, one Item, one Special, and change your active Persona once — all free.\n\nThen you get **one action**: attack, use a skill, Guard, fuse, feed the Gallows, or pass. One. That single choice is the whole game.',
    },
    {
      title: 'Find the weakness',
      do:
        'Their **Jack Frost** is weak to **fire**, and Orpheus knows **Agi**. A weakness hit deals **double damage** — and if it knocks a standing Persona down, you get a **One More**.',
      hint: 'Use **Agi** on Jack Frost.',
      point: '.skill-btn[data-skill-id="agi"]',
      until: damagedThem,
    },
    {
      title: 'One More',
      say:
        'Knocking a standing Persona down with a weakness hands you a **One More**: one extra action, one extra Persona change, and — for that action only — you may hit **any** enemy Persona, including their bench.\n\nThis is the engine of the whole game. Chaining weaknesses is how a turn becomes three turns.',
    },
    {
      title: 'Spend it',
      do: 'You have an extra action. Use it — attack again, or set something up.',
      hint: 'Take another action, or **End turn** if you would rather bank the position.',
      until: (state, at) => damagedThem(state, at) || turnPassed(state, at),
    },
    {
      title: 'Guard and Pass',
      say:
        '**Guard** halves incoming damage and stops you being knocked down at all — it denies them the One More, which is often worth more than the HP.\n\n**Pass** gives up your action and draws you an extra card. Doing nothing is sometimes the strongest thing available.',
    },
    {
      title: 'Close it out',
      do:
        'End your turn. At the end of it, you discard down to **7 cards**, Burn ticks, and buff timers count down.',
      hint: 'Click **End turn**.',
      point: '[data-act="endturn"]',
      until: turnPassed,
    },
    {
      title: 'The SP tap',
      say:
        'One last thing, and it decides more matches than it looks like it should: **only your active Persona regains SP**, +3 at the start of your turn. The bench regains nothing.\n\nSo rotating a spent Persona out is not free healing — it is parking. A Persona you drained stays drained until you stand it back up and fight with it.',
    },
  ],
};

/* ------------------------------------------------------------------ *
 * 2 — The Velvet Room
 * ------------------------------------------------------------------ */

const VELVET = {
  id: 'velvet',
  number: 2,
  icon: '🌀',
  title: 'The Velvet Room',
  summary: 'The Gallows, fusion, and the level ceiling that gates them both.',
  minutes: 6,
  scenario: {
    seed: 202,
    turn: 4,
    players: [
      { name: 'You', deckId: 'p3', archetype: 'tactical', starter: 'pixie', controller: 'human' },
      { name: 'Tutorial', deckId: 'p5', archetype: 'defensive', starter: 'arsene', controller: 'bot', difficulty: 'easy' },
    ],
    field: [
      [
        // L10 exactly, and not a point higher: the Gallows only counts food as
        // a MEAL — a level plus an inheritance — while it is within
        // COMEBACK_FARM_GAP (5) of the eater. At L12 the level-6 Jack Frost
        // this lesson hands over would be junk: free, but no level and nothing
        // to inherit, which is not the lesson. 10 + Kaiwan's 14 also clears
        // Titania's combined-level bar of 24 exactly, and the meal pushes it to
        // 25 before the fusion step asks for it.
        { cardId: 'pixie', level: 10, active: true },
        { cardId: 'kaiwan', level: 14 },
      ],
      [{ cardId: 'arsene', level: 6, active: true }],
    ],
    hand: [['jack-frost', 'apsaras'], []],
  },
  outro:
    'Fusion and the Gallows are the same idea at two prices. **The Gallows spends a body for a level**; **fusion spends two bodies for a better one**. Both cost your action, which is exactly why they are worth learning to time.',
  steps: [
    {
      title: 'The level ceiling',
      say:
        'You cannot drop a level 20 Persona on turn one. A Persona is playable only if its level is within **10** of the highest-level Persona you already have out.\n\nSo your board has to **earn** its way up. That is what this lesson is about: the two ways to climb.',
    },
    {
      title: 'The Gallows',
      say:
        'Feed one of your Personas to another. The eater gains a **level**, and may **inherit a skill** from what it ate.\n\nThe food can come from your hand or off your field, and the price depends on what you feed: something near the eater\'s level is a **meal** and costs your action. Something the board has long outgrown is **junk** — no level, but it is free and it heals.',
    },
    {
      title: 'Feed it',
      do:
        'You are holding **Jack Frost**. Feed it to **Pixie** — Pixie gains a level, and Jack Frost\'s **Bufu** is on the table as an inheritance.\n\nThat matters more than the level: Pixie is a magic Persona with no ice, and ice is a weakness a lot of things carry.',
      hint: 'Click **⚰️ Gallows**, choose Pixie as the eater and Jack Frost as the food. Leave Kaiwan alone — you need it in two steps\' time.',
      point: '[data-act="gallows"]',
      // "Pixie leveled up" alone is not enough, and the reason is a trap the
      // player can genuinely fall into: feeding Pixie the KAIWAN also levels it,
      // and eats the Star half of the fusion this lesson is walking toward. So
      // the objective is "you got the level AND you still have your material" —
      // if they eat Kaiwan the step stays up rather than waving them on into a
      // fusion that can no longer happen.
      until: (state, at) => {
        const now = findCard(state, 0, 'pixie');
        const before = findCard(at, 0, 'pixie');
        if (!now || !before) return false;
        return now.level > before.level && Boolean(findCard(state, 0, 'kaiwan'));
      },
    },
    {
      title: 'That cost your action',
      do:
        'A Gallows meal spends your action, so your turn is done. End it — the opponent will take theirs, and we will fuse on the way back.',
      hint: 'Click **End turn**, then wait for your turn to come round.',
      point: '[data-act="endturn"]',
      until: (state, at) => state.turn > at.turn && state.activePlayer === 0,
    },
    {
      title: 'Fusion',
      say:
        'Fusion takes **two Personas of the right Arcana** and turns them into one much stronger one. Each recipe names its two Arcana and a **combined level** the pair has to clear.\n\nYou have **Pixie** (Lovers) and **Kaiwan** (Star). That is the recipe for **Titania** — and your two are now comfortably over the bar.',
    },
    {
      title: 'Fuse them',
      do:
        'Open the fusion panel and make Titania. You will be asked which skills to carry over: the result keeps its own printed kit plus what you choose to inherit.',
      hint: 'Click **🌀 Fusion** and pick the Titania recipe.',
      point: '[data-act="fusion"]',
      until: (state) => Boolean(findCard(state, 0, 'titania')),
    },
    {
      title: 'What you just paid',
      say:
        'Two bodies became one. Your board got **stronger** and **narrower** at the same time — and a narrow board is how you lose to the empty-field clock.\n\nFusion also costs your action and is limited to **one a turn**, and it does not open at all until **turn 4**. It is a mid-game play, not an opening.',
    },
    {
      title: 'Which one, when',
      say:
        'Rule of thumb: **the Gallows is for cards you were never going to play** — a Persona too low-level to matter is worth more as a level than as a body. **Fusion is for cards you were**.\n\nAnd feeding from your **hand** is nearly free, because a card in hand was never on the board holding a position.',
    },
  ],
};

/* ------------------------------------------------------------------ *
 * 3 — Reading the board
 * ------------------------------------------------------------------ */

const READING = {
  id: 'reading',
  number: 3,
  icon: '🔍',
  title: 'Reading the Board',
  summary: 'Affinities, hidden information, ailments, and buffs that cover your whole field.',
  minutes: 6,
  scenario: {
    seed: 303,
    turn: 3,
    players: [
      { name: 'You', deckId: 'p3', archetype: 'tactical', starter: 'pixie', controller: 'human' },
      { name: 'Tutorial', deckId: 'p5', archetype: 'defensive', starter: 'ara-mitama', controller: 'bot', difficulty: 'easy' },
    ],
    field: [
      [
        { cardId: 'pixie', level: 9, active: true },
        { cardId: 'orpheus', level: 9 },
      ],
      [
        { cardId: 'ara-mitama', level: 9, active: true },
        { cardId: 'jack-frost', level: 8 },
      ],
    ],
    hand: [['lesser-theurgy', 'medicine'], []],
  },
  outro:
    'Damage in this game is **deterministic** — no crits, no variance, no misses. Everything you can see, you can calculate. Which means every loss is a read you got wrong, and that is a much better game than a dice roll.',
  steps: [
    {
      title: 'Three reactions, and only three',
      say:
        'A Persona reacts to a damage type in exactly three ways: **weak** (×2), **resist** (×0.5), or **neutral**.\n\nThere is no Null and no Reflect. Nothing ever bounces back at you, and nothing is ever completely immune — so there is always a line, even if it is a slow one.',
    },
    {
      title: 'You only know what you have seen',
      say:
        'Look at their Personas: some affinities show as **?**. You have not discovered them yet.\n\nYou learn a weakness by **hitting it**, or by playing something that reveals it. Their Ara Mitama is weak to **ice** and **dark**, and resists **fire** — you know that because this lesson told you. In a real match, you would have to find out.',
    },
    {
      title: 'Buffs cover your whole field',
      do:
        'Pixie knows **Rakukaja**. Cast it.\n\nThis is the part most people get wrong: a buff is not attached to the Persona that cast it. It lands on **every Persona you have out**, bench included.',
      hint: 'Use **Rakukaja**.',
      point: '.skill-btn[data-skill-id="rakukaja"]',
      until: (state) => fieldOf(state, 0).every((p) => buffOf(p, 'def')?.direction === 'up'),
    },
    {
      title: 'Look at your bench',
      say:
        'Orpheus is sitting on the bench and it has the defence buff too. It will still have it when it steps up.\n\nThat changes how you sequence a turn: **play your bodies first, then buff**, because a Persona that arrives after the cast does not get it. Same card, two very different turns.',
    },
    {
      title: 'Casting it again extends it',
      say:
        'Recasting a buff you already hold does not stack the number — it **adds turns**. Two turns left plus a fresh Rakukaja is **five**, and the log will say "extended to 5 turns".\n\nThe ceiling is **6 turns**, so you can bank one cast ahead and no further. And casting the **opposite** direction on top — a Rakunda into your Rakukaja — cancels both and leaves the stat neutral. Dekaja and Dekunda strip a whole field at once.',
    },
    {
      title: 'Ailments and Technicals',
      say:
        '**Burn** ticks 5 damage at the end of each of its owner\'s turns. **Shock** stops a Persona acting for a turn and raises the damage it takes by 50%.\n\nHit an ailing target with the right follow-up and you land a **Technical** for another ×1.5. Shock plus a **physical** hit is the big one — it knocks the target down in its own right, so it pays a One More **without needing a weakness at all**.',
    },
    {
      title: 'Set one up',
      do:
        'You are holding **Lesser Theurgy**: it inflicts Burn or Shock with no roll at all. Play it on their Ara Mitama.\n\nAra Mitama has no elec weakness for you to exploit — but Shock does not care.',
      hint: 'Play **Lesser Theurgy** from your hand.',
      point: '.hand-tile[data-card-id="lesser-theurgy"]',
      until: (state) => Boolean(foe(state)) && foe(state).ailments.length > 0,
    },
    {
      title: 'Walls read differently',
      say:
        'One more thing about Ara Mitama specifically: its **Stalwart** passive refuses to be knocked down while it is above **half HP**. You can hit its ice weakness for double damage and still get no One More out of it.\n\nSo against a wall, the read is not "where is the weakness" — it is "**how do I get it under half first**".',
    },
  ],
};

/* ------------------------------------------------------------------ *
 * 4 — The triad
 * ------------------------------------------------------------------ */

const TRIAD = {
  id: 'triad',
  number: 4,
  icon: '🔺',
  title: 'Pixie, Slime, Ara Mitama',
  summary: 'The three signature Personas, why each beats one of the others, and how tempo works.',
  minutes: 6,
  scenario: {
    seed: 404,
    turn: 5,
    players: [
      { name: 'You', deckId: 'p4', archetype: 'aggressive', starter: 'slime', controller: 'human' },
      { name: 'Tutorial', deckId: 'p5', archetype: 'defensive', starter: 'ara-mitama', controller: 'bot', difficulty: 'easy' },
    ],
    field: [
      [
        { cardId: 'slime', level: 10, active: true },
        { cardId: 'pixie', level: 10 },
      ],
      [
        { cardId: 'ara-mitama', level: 10, active: true },
        { cardId: 'slime', level: 9 },
      ],
    ],
    hand: [['baton-pass'], []],
  },
  outro:
    'The cycle is a **starting point**, not a law — it holds at some level bands and not others, and a real deck is thirty cards deep. But it is the fastest way to learn the one thing that matters: **a Persona is not strong or weak, it is strong or weak against something**.',
  steps: [
    {
      title: 'Three cards, one circle',
      say:
        'Every flavour is guaranteed one signature Persona in its opening three: **Pixie** (P3), **Slime** (P4), **Ara Mitama** (P5).\n\nThey beat each other in a cycle.\n**Slime** beats **Ara Mitama**. **Pixie** beats **Slime**. **Ara Mitama** beats **Pixie**.',
    },
    {
      title: 'Slime answers the wall',
      do:
        'You are Slime. They are Ara Mitama — high Endurance, a heal, and a passive that refuses knockdowns. Normally a nightmare to chew through.\n\nHit it with a physical skill and watch the number.',
      hint: 'Attack Ara Mitama, or use **Bash**.',
      point: '.skill-btn[data-skill-id="bash"]',
      until: damagedThem,
    },
    {
      title: 'Why that hurt so much',
      say:
        'Slime\'s **Corrosive** passive treats the defender\'s Endurance as **70% lower** on physical damage.\n\nEndurance is the *only* thing making Ara Mitama a wall. Corrosive does not out-muscle the wall — it reaches inside the damage formula and deletes the reason it was a wall at all. That is why Slime is the answer to it and a fairly ordinary attacker against everything else.',
    },
    {
      title: 'And what answers Slime',
      say:
        'Slime is weak to **elec**, and it has almost no Magic to hide behind.\n\n**Pixie** knows **Zio** from level 1. Double damage, a knockdown, a One More — the fat Strength stat never gets a turn to matter. Look at their bench: there is a Slime sitting on it.',
    },
    {
      title: 'Rotate',
      do:
        'Change your active Persona to **Pixie**. Changing is **free** — one a turn, and a One More hands you another.',
      hint: 'Click Pixie on your bench, then **Switch Pixie in**.',
      until: (state, at) => state.players[0].activeUid !== at.players[0].activeUid,
    },
    {
      title: 'And what answers Pixie',
      say:
        'Ara Mitama closes the circle, but **not by killing Pixie** — its Strength does not grow at all as it levels.\n\nIt closes the circle by **not dying**. +2 Endurance per level, a heal, and Stalwart. Pixie spends turn after turn failing to remove it, and every one of those turns is a turn the Ara Mitama player spends building something you will not enjoy meeting.\n\nRead the matchup in **turns bought**, not knockouts.',
    },
    {
      title: 'Tempo: One More and Baton Pass',
      say:
        'A knockdown gives you a **One More** — an extra action *and* an extra Persona change. Spending that change is a **Baton Pass**: the next Persona picks up a **damage bonus that grows with each knockdown in the chain**.\n\nSo the ideal turn is not one big hit. It is: hit a weakness, knock down, pass the baton, hit another weakness with the Persona that arrived. That is where matches are actually won.',
    },
    {
      title: 'Keep a board',
      say:
        'Last warning, and it is a real one. An **empty field is a legal position** — nothing forces a card out of your hand — but you get **3 full turns** of it, and beginning a fourth **loses the match outright**. No knockouts required.\n\nHolding Personas back as fusion material is strategy. Holding all of them back is a countdown.',
    },
  ],
};

/* ------------------------------------------------------------------ *
 * 5 — Thinking two turns ahead
 * ------------------------------------------------------------------ */

const DEPTH = {
  id: 'depth',
  number: 5,
  icon: '♟️',
  title: 'Two Turns Ahead',
  summary: 'A real decision, worked through: the greedy line, the patient line, and why one wins.',
  minutes: 8,
  scenario: {
    seed: 505,
    turn: 7,
    players: [
      { name: 'You', deckId: 'p3', archetype: 'tactical', starter: 'pixie', controller: 'human' },
      { name: 'Tutorial', deckId: 'p5', archetype: 'aggressive', starter: 'arsene', controller: 'bot', difficulty: 'easy' },
    ],
    field: [
      [
        // L10 for the same reason as lesson 2: the Angel this lesson feeds it
        // is level 6, and above L11 that stops being a meal and becomes junk —
        // no level, no Hama, no lesson.
        { cardId: 'pixie', level: 10, active: true },
        { cardId: 'ara-mitama', level: 12 },
      ],
      [
        { cardId: 'arsene', level: 12, active: true, hp: 60 },
        { cardId: 'jack-frost', level: 10, hp: 18 },
        { cardId: 'apsaras', level: 9, hp: 14 },
      ],
    ],
    hand: [['ambush', 'angel'], []],
  },
  outro:
    'That is the shape of every real decision in this game: **the greedy line takes what is in front of you; the patient line asks what the same card is worth one turn later**.\n\nThe cards do not get better. Your position does.',
  steps: [
    {
      title: 'The position',
      say:
        'Look at the board properly before you touch anything.\n\nYou have **Pixie** out — it has **Trickster**, which lifts the cap on how many One Mores you can chain in a turn. On your bench is a tough **Ara Mitama**. In hand: **Ambush** and an **Angel**.\n\nThey have a healthy **Arsene** in front, and two badly hurt Personas on the bench that you cannot normally touch.',
    },
    {
      title: 'The greedy line',
      say:
        '**Ambush** lets your attacks hit *any* enemy Persona this turn, bench included. Play it now and you can start swinging at those two hurt bodies.\n\nWith Trickster chaining One Mores, that is a real three-hit turn. It feels great. Count what it actually banks: two knockouts, maybe, out of the **eight** you need — and **Ambush is gone**.',
    },
    {
      title: 'The patient line',
      say:
        'Now the other one.\n\nArsene resists **dark** and Pixie is your only real attacker. Instead of cashing Ambush into a mediocre board, you **feed the Angel to Pixie** at the Gallows.\n\nThat buys three things at once: Pixie gains a **level** (and Magic with it), it can **inherit Hama** — a light skill it had no access to — and **Ambush stays in your hand**.',
    },
    {
      title: 'Play it',
      do:
        'Feed **Angel** to **Pixie**. It is a card from your hand, so it costs you no board presence at all — only your action.',
      hint: 'Click **⚰️ Gallows**, eater Pixie, food Angel.',
      point: '[data-act="gallows"]',
      until: (state, at) => {
        const now = findCard(state, 0, 'pixie');
        const before = findCard(at, 0, 'pixie');
        if (!now || !before) return false;
        return now.level > before.level || knowsSkill(state, now, 'hama');
      },
    },
    {
      title: 'What that bought',
      say:
        'Compare the two futures.\n\n**Greedy:** two hurt Personas removed, Ambush spent, Pixie unchanged.\n**Patient:** Pixie is a level higher with a new damage type, Ambush is still in hand, and those two hurt Personas are *still* hurt — they do not heal on the bench.\n\nNext turn you play Ambush into a **better** Pixie with **more** ways to hit. The same card, worth more, because you waited.',
    },
    {
      title: 'Hand it over',
      do:
        'End your turn. They get one — that is the price of patience, and it is a real price. Watch what they do with it.',
      hint: 'Click **End turn**.',
      point: '[data-act="endturn"]',
      until: (state, at) => state.turn > at.turn && state.activePlayer === 0,
    },
    {
      title: 'Now cash it',
      say:
        'Your turn again, and the position is better than the one you gave up.\n\nThis is the general shape: **your action is the scarce resource, and cards do not expire.** A Special held one more turn is not a wasted turn if the turn made it bigger.',
    },
    {
      title: 'The counter-question',
      say:
        'Be fair to the greedy line, though, because it is not always wrong.\n\nPatience loses when **the window closes**: if they were about to heal that bench, if you were about to lose Pixie, if you are behind on the knockout race and need points *now*. The right question is never "greedy or patient" — it is "**is this window still open next turn?**"',
    },
    {
      title: 'Everything at once',
      say:
        'That is the game. Affinities tell you *what* to hit, One More tells you *how often*, fusion and the Gallows tell you *what you will be hitting with in five turns*, and your one action a turn is the budget for all of it.\n\nGo and lose a few. It is much faster.',
    },
  ],
};

export const LESSONS = Object.freeze([BASICS, VELVET, READING, TRIAD, DEPTH]);

export const getLesson = (id) => LESSONS.find((l) => l.id === id) ?? null;
