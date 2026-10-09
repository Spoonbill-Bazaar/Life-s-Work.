// Monte-Carlo balance check: bot vs bot for every commander pairing.
//   node scripts/balance.mjs [gamesPerPair=40] [difficulty=admiral]
import { MAP_DEFS } from '../shared/maps.js';
import { COMMANDERS, RULES } from '../shared/commanders.js';

// Overrides for tuning, e.g. RULES='{"CHARGE_PER_HIT_TAKEN":2}' COSTS='{"airstrike":10}'
Object.assign(RULES, JSON.parse(process.env.RULES || '{}'));
for (const [k, v] of Object.entries(JSON.parse(process.env.COSTS || '{}'))) COMMANDERS.find((c) => c.ult.id === k).ult.cost = v;
import { Match, randomPlacements } from '../shared/engine.js';
import { chooseFire, chooseUlt } from '../shared/bot.js';

const N = +(process.argv[2] || 40);
const diff = process.argv[3] || 'admiral';
let s = 12345;
const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);

const ids = COMMANDERS.map((c) => c.id);
const wins = Object.fromEntries(ids.map((id) => [id, { w: 0, g: 0, ults: 0 }]));
let turns = 0, games = 0, firstWins = 0, comebacks = 0, trailed = 0;

for (const a of ids) for (const b of ids) {
  if (a >= b && a !== b) continue;
  for (let n = 0; n < N; n++) {
    const map = MAP_DEFS[n % MAP_DEFS.length].id;
    const m = new Match({ mapId: map, commanders: [a, b], rng });
    m.place(0, randomPlacements(m.map, rng));
    m.place(1, randomPlacements(m.map, rng));
    let behind = [false, false];
    while (m.phase === 'battle') {
      const i = m.turn;
      const u = chooseUlt(m.view(i), diff, rng);
      if (u) m.ult(i, u.x, u.y, u.dir);
      if (m.phase !== 'battle') break;
      const f = chooseFire(m.view(i), diff, rng);
      m.fire(i, f.x, f.y);
      // "behind" = had at least 2 more ships sunk than the opponent at some point
      const sunk = [0, 1].map((p) => m.players[p].ships.filter((x) => x.sunk).length);
      if (sunk[0] - sunk[1] >= 2) behind[0] = true;
      if (sunk[1] - sunk[0] >= 2) behind[1] = true;
    }
    games++; turns += m.turnNo;
    if (m.winner === m.first) firstWins++;
    if (behind[0] || behind[1]) trailed++;
    if (behind[m.winner]) comebacks++;
    for (const p of [0, 1]) {
      const id = m.players[p].commander.id;
      wins[id].g++; wins[id].ults += m.players[p].stats.ults;
      if (m.winner === p) wins[id].w++;
    }
  }
}
console.log(`${games} games (${diff}), avg turns/game ${(turns / games).toFixed(1)}, first-player win ${(firstWins / games * 100).toFixed(1)}%, underdog wins after trailing by 2+ ships ${(comebacks / Math.max(1, trailed) * 100).toFixed(1)}% of ${trailed}`);
for (const id of ids) {
  const w = wins[id];
  console.log(`  ${id.padEnd(10)} win ${(w.w / w.g * 100).toFixed(1)}%  ults/game ${(w.ults / w.g).toFixed(2)}`);
}
