# BATTLESHIT

The ultimate multiplayer browser Battleship. Irregular theatres with islands and dead water, five commanders with chargeable ultimates, a comeback-friendly charge economy, and a minimal DEFCON-style vector UI.

```
npm install
npm start            # http://localhost:8080
npm test             # rules engine + AI self-play on every map/commander
```

Requires Node 18+. The only runtime dependency is `ws`.

## How a match plays

1. **Briefing.** The host picks a theatre (Quick Match draws one at random), and each player picks a commander. Both ready up.
2. **Deployment.** Place the standard fleet (5/4/3/3/2) on open water only. Land and off-map cells are off limits. Use `R` or right-click to rotate, or hit RANDOM. The timer is 2:00, after which a random deployment is filled in.
3. **Battle.** Players alternate turns. On your turn you may **launch your ultimate** if it's charged, then you **must fire one shot**. Firing ends the turn. The turn timer is 0:45, and a timeout fires at a random cell. Sunk ships are revealed to the attacker.
4. First to destroy the enemy fleet wins. Rematch keeps you in the same room.

### Ultimate charge

| Source | Charge |
|---|---|
| Start of each of your turns (UBI) | +1 |
| Each hit you **take** | +1 |
| Each ship you **lose** | +1 more |
| Second player, once, at battle start | +1 |

Charge caps at your ultimate's cost, and you can launch one ultimate per turn. Taking damage brings your ultimate sooner, which works against snowballing. Every value lives in `shared/commanders.js` (`RULES`).

### Commanders

| Commander | Ultimate | Cost | Effect |
|---|---|---|---|
| **KESTREL**, Naval Aviation | AIRSTRIKE | 10 | 5-cell line, horizontal or vertical. Flies over islands. |
| **LEVIATHAN**, Submarine Command | TORPEDO RUN | 8 | Launch from any water cell in 4 directions. Clears every cell it passes and stops at the first intact hull, land or the edge. |
| **BASTION**, Coastal Artillery | BOMBARDMENT | 12 | 3x3 saturation. |
| **WRAITH**, Signals Intelligence | DEEP SCAN | 10 | Reveals every hull in a radius-2 diamond (13 cells). No damage. |
| **VECTOR**, Guided Munitions | HUNTER-KILLER | 6 | Strike a cell. On a miss it re-locks onto the nearest intact hull within 2 cells. |

Islands matter. Torpedoes stop at land, airstrikes don't, and the lagoon on ATOLL only fits small hulls.

### Theatres

| Theatre | Shape |
|---|---|
| OPEN WATER | Clipped octagon, no cover. |
| ATOLL | Ring reef with a sealed lagoon. |
| THE STRAIT | Two basins joined by a narrow channel. |
| ARCHIPELAGO | Scattered islands that block lines of fire. |
| FJORDS | Deep inlets carved into a mountain coast. |
| CRESCENT | A thin moon of water. |
| TWIN LAKES | Bodies of water that never touch. |

Maps are ASCII in `shared/maps.js`: `.` is water, `#` is land, a space is off-map. `node scripts/maps.mjs` prints every map with its water count and checks that the fleet fits.

## Balance

`node scripts/balance.mjs [gamesPerPair] [recruit|veteran|admiral]` plays AI-vs-AI across every commander pairing and map. At the current numbers (1,800 admiral games):

- Each commander's win rate is between 48.5% and 51%. Run-to-run noise is about ±3 points.
- First-player win rate is about 50%.
- Ultimates fire about 3–7 times per player per game, in roughly 26 turns each.

You can tune values without editing code:

```
RULES='{"CHARGE_PER_HIT_TAKEN":2}' COSTS='{"airstrike":10}' node scripts/balance.mjs 120
```

The comeback mechanic is honest but modest. In simulations of near-perfect play, adding charge-from-damage didn't measurably raise how often a player who fell two ships behind came back to win. At equal ultimate frequency it was about 16–17% either way. The extra charge also shortens games, which leaves less time to recover. Against humans, the underdog will usually have a full ultimate at the moment it matters. If you want a stronger rubber band, the levers are `CHARGE_PER_HIT_TAKEN`, `CHARGE_PER_SINK_TAKEN` and `CHARGE_CAP_MULT` (bank past one ultimate).

## Architecture

```
server/index.js    static file server + WebSocket endpoint (/ws)
server/lobby.js    rooms, quick-match queue, AI seats, timers, reconnects
shared/engine.js   authoritative rules (pure, no I/O); also used by the client for previews
shared/maps.js     theatres
shared/commanders.js  commanders + charge economy
shared/bot.js      AI: RECRUIT (parity hunt), VETERAN/ADMIRAL (probability density)
public/            vanilla JS client, canvas rendering, WebAudio synth sound
```

- The server is authoritative. Each client only receives its own fleet plus what it has legitimately learned about the enemy, and the AI plays from that same view.
- A refresh or dropped connection resumes the match through a session token. A seat that stays disconnected for 60 s forfeits.
- Private rooms use 4-letter codes, and `/?room=CODE` pre-fills the join field.

### Controls

`Q` arm ultimate · `R` / right-click rotate · `Esc` cancel · `M` mute. On touch screens, the first tap aims and a second tap on the same cell fires.

### Deploying

This is a single Node process holding all state in memory. Any host that runs Node and supports WebSockets will work, for example Fly.io, Railway, Render or a VPS. Set `PORT` if needed, and `/healthz` returns `ok`.
