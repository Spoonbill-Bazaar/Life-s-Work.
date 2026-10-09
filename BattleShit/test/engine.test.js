import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAP_DEFS, getMap } from '../shared/maps.js';
import { COMMANDERS, RULES } from '../shared/commanders.js';
import { Match, randomPlacements, validatePlacements, ultPattern } from '../shared/engine.js';
import { chooseFire, chooseUlt } from '../shared/bot.js';

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function fixedMatch(mapId = 'open-water', commanders = ['kestrel', 'leviathan'], first = 0) {
  const m = new Match({ mapId, commanders, first, rng: seeded(1) });
  return m;
}

test('every map fits its fleet', () => {
  for (const d of MAP_DEFS) {
    const map = getMap(d.id);
    const p = randomPlacements(map, seeded(7));
    assert.equal(validatePlacements(map, p), null, d.id);
  }
});

test('placement validation rejects land, overlap and missing ships', () => {
  const map = getMap('atoll');
  // (4,3) is reef
  const fleet = randomPlacements(map, seeded(3));
  const bad = fleet.map((p) => (p.id === 'destroyer' ? { ...p, x: 4, y: 3, dir: 'h' } : p));
  assert.match(validatePlacements(map, bad), /out of the water/);
  assert.match(validatePlacements(map, fleet.slice(1)), /Every ship/);
  const overlap = fleet.map((p) => (p.id === 'destroyer' ? { ...fleet[0], id: 'destroyer' } : p));
  assert.match(validatePlacements(map, overlap), /overlaps/);
});

test('turns alternate, UBI charges the active player, second player gets a bonus', () => {
  const m = fixedMatch();
  m.place(0, randomPlacements(m.map, seeded(1)));
  m.place(1, randomPlacements(m.map, seeded(2)));
  assert.equal(m.phase, 'battle');
  assert.equal(m.players[0].charge, RULES.UBI_PER_TURN);
  assert.equal(m.players[1].charge, RULES.SECOND_PLAYER_BONUS);
  const t = m.randomTarget(0);
  assert.ok(m.fire(0, t.x, t.y).ok);
  assert.equal(m.turn, 1);
  assert.ok(m.fire(0, 0, 0).error);
});

test('taking hits charges the defender (comeback mechanic)', () => {
  const m = fixedMatch();
  m.place(0, randomPlacements(m.map, seeded(1)));
  m.place(1, randomPlacements(m.map, seeded(2)));
  const ship = m.players[1].ships.find((s) => s.id === 'destroyer');
  const before = m.players[1].charge;
  m.fire(0, ship.x, ship.y);
  // defender: +1 for the hit, then +UBI as their turn starts
  assert.equal(m.players[1].charge, before + RULES.CHARGE_PER_HIT_TAKEN + RULES.UBI_PER_TURN);
  m.fire(1, ...Object.values(m.randomTarget(1)));
  const c2 = ship.dir === 'h' ? [ship.x + 1, ship.y] : [ship.x, ship.y + 1];
  const b2 = m.players[1].charge;
  const r = m.fire(0, ...c2);
  assert.equal(r.event.sunk.length, 1);
  const cap = m.players[1].commander.ult.cost;
  assert.equal(m.players[1].charge, Math.min(cap, b2 + RULES.CHARGE_PER_HIT_TAKEN + RULES.CHARGE_PER_SINK_TAKEN + RULES.UBI_PER_TURN));
});

test('ultimate requires full charge and can be used once per turn before firing', () => {
  const m = fixedMatch('open-water', ['bastion', 'wraith']);
  m.place(0, randomPlacements(m.map, seeded(1)));
  m.place(1, randomPlacements(m.map, seeded(2)));
  assert.match(m.ult(0, 5, 5).error, /not charged/);
  const full = m.players[0].commander.ult.cost;
  m.players[0].charge = full;
  const r = m.ult(0, 5, 5);
  assert.ok(r.ok);
  assert.equal(r.event.cells.length, 9);
  assert.equal(m.players[0].charge, 0);
  m.players[0].charge = full;
  assert.match(m.ult(0, 2, 5).error, /already used/);
  assert.equal(m.turn, 0, 'ult does not end the turn');
});

test('torpedo stops at the first hull and is blocked by land', () => {
  const map = getMap('atoll');
  // lane from inside the lagoon going east hits the reef immediately
  assert.equal(ultPattern(map, 'torpedo', 5, 5, 0).length, 3);
  const m = new Match({ mapId: 'open-water', commanders: ['leviathan', 'kestrel'], first: 0, rng: seeded(4) });
  const place = [
    { id: 'carrier', x: 3, y: 3, dir: 'h' },
    { id: 'battleship', x: 3, y: 5, dir: 'h' },
    { id: 'cruiser', x: 0, y: 7, dir: 'h' },
    { id: 'submarine', x: 6, y: 7, dir: 'h' },
    { id: 'destroyer', x: 9, y: 4, dir: 'v' },
  ];
  m.place(0, place);
  m.place(1, place);
  m.players[0].charge = m.players[0].commander.ult.cost;
  const r = m.ult(0, 0, 3, 0); // east along row 3 -> carrier at x=3
  assert.ok(r.ok);
  assert.deepEqual(r.event.cells.map((c) => c.r), ['miss', 'miss', 'miss', 'hit']);
});

test('deep scan reveals contacts without damage', () => {
  const m = fixedMatch('open-water', ['wraith', 'kestrel']);
  m.place(0, randomPlacements(m.map, seeded(1)));
  m.place(1, randomPlacements(m.map, seeded(2)));
  m.players[0].charge = m.players[0].commander.ult.cost;
  const r = m.ult(0, 5, 5);
  assert.ok(r.ok);
  assert.equal(m.boards[1].shots.size, 0);
  assert.equal(r.event.cells.length, 13);
  const v = m.view(0);
  assert.equal(v.foeBoard.contacts.length, r.event.cells.filter((c) => c.r === 'contact').length);
});

test('views never leak hidden enemy ships', () => {
  const m = fixedMatch();
  m.place(0, randomPlacements(m.map, seeded(1)));
  m.place(1, randomPlacements(m.map, seeded(2)));
  const v = m.view(0);
  for (const s of v.foe.ships) assert.equal(s.x, undefined);
  assert.ok(v.me.ships[0].x !== undefined);
});

test('bot vs bot completes on every map with every commander', () => {
  const rng = seeded(99);
  let games = 0;
  for (const d of MAP_DEFS) {
    for (let ci = 0; ci < COMMANDERS.length; ci++) {
      const cmd = [COMMANDERS[ci].id, COMMANDERS[(ci + 1) % COMMANDERS.length].id];
      const m = new Match({ mapId: d.id, commanders: cmd, rng });
      m.place(0, randomPlacements(m.map, rng));
      m.place(1, randomPlacements(m.map, rng));
      let guard = 0;
      while (m.phase === 'battle' && guard++ < 1000) {
        const i = m.turn;
        const diff = ['recruit', 'veteran', 'admiral'][(guard + ci) % 3];
        const u = chooseUlt(m.view(i), diff, rng);
        if (u) assert.ok(m.ult(i, u.x, u.y, u.dir).ok);
        if (m.phase !== 'battle') break;
        const f = chooseFire(m.view(i), diff, rng);
        const r = m.fire(i, f.x, f.y);
        assert.ok(r.ok, r.error);
      }
      assert.equal(m.phase, 'over', `${d.id} ${cmd}`);
      games++;
    }
  }
  assert.equal(games, MAP_DEFS.length * COMMANDERS.length);
});
