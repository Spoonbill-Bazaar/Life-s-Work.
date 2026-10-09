// Authoritative rules. Pure logic, no I/O. The server runs it; the client imports
// the geometry helpers for previews and placement validation.

import { getMap, isWater } from './maps.js';
import { getCommander, RULES, DIRS } from './commanders.js';

export const HIT = 'h';
export const MISS = 'm';

export function shipCells({ x, y, len, dir }) {
  const out = [];
  for (let i = 0; i < len; i++) {
    out.push(dir === 'v' ? { x, y: y + i } : { x: x + i, y });
  }
  return out;
}

export function idxOf(map, x, y) {
  return y * map.w + x;
}

// placements: [{ id, x, y, dir }] — one per ship in map.fleet
export function validatePlacements(map, placements) {
  if (!Array.isArray(placements)) return 'Placement must be a list.';
  if (placements.length !== map.fleet.length) return 'Every ship must be placed.';
  const taken = new Set();
  const seen = new Set();
  for (const p of placements) {
    const spec = map.fleet.find((s) => s.id === p?.id);
    if (!spec) return 'Unknown ship.';
    if (seen.has(spec.id)) return 'Duplicate ship.';
    seen.add(spec.id);
    if (p.dir !== 'h' && p.dir !== 'v') return 'Bad orientation.';
    if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) return 'Bad coordinates.';
    for (const c of shipCells({ ...p, len: spec.len })) {
      if (!isWater(map, c.x, c.y)) return `${spec.name} is out of the water.`;
      const k = idxOf(map, c.x, c.y);
      if (taken.has(k)) return `${spec.name} overlaps another ship.`;
      taken.add(k);
    }
  }
  return null;
}

export function canPlace(map, occupied, x, y, len, dir) {
  for (const c of shipCells({ x, y, len, dir })) {
    if (!isWater(map, c.x, c.y)) return false;
    if (occupied.has(idxOf(map, c.x, c.y))) return false;
  }
  return true;
}

export function randomPlacements(map, rng = Math.random, tries = 400) {
  // Several attempts; prefer layouts where ships do not touch (harder to chain).
  let best = null;
  let bestScore = Infinity;
  for (let attempt = 0; attempt < 24; attempt++) {
    const occupied = new Set();
    const out = [];
    let ok = true;
    const order = map.fleet.slice().sort((a, b) => b.len - a.len);
    for (const spec of order) {
      let placed = false;
      for (let t = 0; t < tries && !placed; t++) {
        const dir = rng() < 0.5 ? 'h' : 'v';
        const x = Math.floor(rng() * map.w);
        const y = Math.floor(rng() * map.h);
        if (canPlace(map, occupied, x, y, spec.len, dir)) {
          for (const c of shipCells({ x, y, len: spec.len, dir })) occupied.add(idxOf(map, c.x, c.y));
          out.push({ id: spec.id, x, y, dir });
          placed = true;
        }
      }
      if (!placed) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    let touches = 0;
    for (const k of occupied) {
      const x = k % map.w;
      const y = (k / map.w) | 0;
      for (const d of DIRS) {
        const nx = x + d.dx;
        const ny = y + d.dy;
        if (nx >= 0 && ny >= 0 && nx < map.w && ny < map.h && occupied.has(idxOf(map, nx, ny))) touches++;
      }
    }
    const score = touches + rng() * 2;
    if (score < bestScore) {
      best = out;
      bestScore = score;
    }
    if (touches === 0 && attempt > 4) break;
  }
  if (!best) throw new Error(`Fleet does not fit on ${map.id}`);
  // restore fleet order
  return map.fleet.map((s) => best.find((p) => p.id === s.id));
}

// Geometry of each ultimate. Returns in-theatre water cells only.
// For the torpedo this is the full lane; resolution stops at the first hull.
export function ultPattern(map, ultId, x, y, dir = 0) {
  const cells = [];
  const add = (cx, cy) => {
    if (isWater(map, cx, cy)) cells.push({ x: cx, y: cy });
  };
  switch (ultId) {
    case 'airstrike': {
      const d = DIRS[dir % 2];
      for (let i = -2; i <= 2; i++) add(x + d.dx * i, y + d.dy * i);
      break;
    }
    case 'bombard':
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) add(x + dx, y + dy);
      break;
    case 'scan':
    case 'homing':
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) if (Math.abs(dx) + Math.abs(dy) <= 2) add(x + dx, y + dy);
      break;
    case 'torpedo': {
      const d = DIRS[dir % 4];
      let cx = x;
      let cy = y;
      while (isWater(map, cx, cy)) {
        cells.push({ x: cx, y: cy });
        cx += d.dx;
        cy += d.dy;
      }
      break;
    }
  }
  return cells;
}

export class Match {
  constructor({ mapId, commanders, first, rng = Math.random }) {
    this.map = getMap(mapId);
    if (!this.map) throw new Error('Unknown map');
    this.rng = rng;
    this.phase = 'placement';
    this.first = first ?? (rng() < 0.5 ? 0 : 1);
    this.turn = this.first;
    this.turnNo = 0;
    this.ultUsed = false;
    this.winner = null;
    this.endReason = null;
    this.players = commanders.map((cid) => {
      const commander = getCommander(cid);
      if (!commander) throw new Error('Unknown commander');
      return {
        commander,
        ships: null,
        occ: null,
        charge: 0,
        ready: false,
        stats: { shots: 0, hits: 0, ults: 0, chargeFromDamage: 0 },
      };
    });
    // boards[i] = what the opponent knows about player i's waters
    this.boards = [0, 1].map(() => ({ shots: new Map(), contacts: new Set(), clear: new Set() }));
  }

  place(i, placements) {
    if (this.phase !== 'placement') return { error: 'Placement is over.' };
    const err = validatePlacements(this.map, placements);
    if (err) return { error: err };
    const p = this.players[i];
    p.occ = new Map();
    p.ships = this.map.fleet.map((spec, si) => {
      const pl = placements.find((q) => q.id === spec.id);
      const ship = { ...spec, x: pl.x, y: pl.y, dir: pl.dir, hits: new Array(spec.len).fill(false), sunk: false };
      shipCells(ship).forEach((c, ci) => p.occ.set(idxOf(this.map, c.x, c.y), { si, ci }));
      return ship;
    });
    p.ready = true;
    if (this.players.every((q) => q.ready)) this.start();
    return { ok: true };
  }

  unready(i) {
    if (this.phase !== 'placement') return;
    this.players[i].ready = false;
  }

  start() {
    this.phase = 'battle';
    this.turn = this.first;
    this.players[1 - this.first].charge += RULES.SECOND_PLAYER_BONUS;
    this.beginTurn();
  }

  beginTurn() {
    this.turnNo++;
    this.ultUsed = false;
    this.addCharge(this.turn, RULES.UBI_PER_TURN);
  }

  addCharge(i, n) {
    const p = this.players[i];
    p.charge = Math.min(chargeCap(p.commander), p.charge + n);
  }

  // Hit a cell on defender's board. Returns { r, sunk? }.
  strike(defender, x, y, events) {
    const board = this.boards[defender];
    const k = idxOf(this.map, x, y);
    if (board.shots.has(k)) return { r: 'none' };
    const d = this.players[defender];
    const at = d.occ.get(k);
    if (!at) {
      board.shots.set(k, MISS);
      board.contacts.delete(k);
      return { r: 'miss' };
    }
    board.shots.set(k, HIT);
    board.contacts.delete(k);
    board.clear.delete(k);
    const ship = d.ships[at.si];
    ship.hits[at.ci] = true;
    this.players[1 - defender].stats.hits++;
    let gained = RULES.CHARGE_PER_HIT_TAKEN;
    let sunk = null;
    if (ship.hits.every(Boolean)) {
      ship.sunk = true;
      gained += RULES.CHARGE_PER_SINK_TAKEN;
      sunk = publicShip(ship);
      events.sunk.push(sunk);
    }
    const before = d.charge;
    this.addCharge(defender, gained);
    d.stats.chargeFromDamage += d.charge - before;
    events.chargeGained += d.charge - before;
    return { r: 'hit', sunk };
  }

  checkTurn(i) {
    if (this.phase !== 'battle') return 'The battle is not on.';
    if (this.turn !== i) return 'Not your turn.';
    return null;
  }

  fire(i, x, y) {
    const err = this.checkTurn(i);
    if (err) return { error: err };
    if (!isWater(this.map, x, y)) return { error: 'Not a water cell.' };
    const def = 1 - i;
    if (this.boards[def].shots.has(idxOf(this.map, x, y))) return { error: 'Already targeted.' };
    const ev = newEvent('shot', i, x, y, this.turnNo);
    const res = this.strike(def, x, y, ev);
    ev.cells.push({ x, y, r: res.r });
    this.players[i].stats.shots++;
    this.afterAction(ev);
    if (this.phase === 'battle') {
      this.turn = def;
      this.beginTurn();
    }
    return { ok: true, event: ev };
  }

  ult(i, x, y, dir = 0) {
    const err = this.checkTurn(i);
    if (err) return { error: err };
    const p = this.players[i];
    const u = p.commander.ult;
    if (this.ultUsed) return { error: 'Ultimate already used this turn.' };
    if (p.charge < u.cost) return { error: 'Ultimate not charged.' };
    if (!isWater(this.map, x, y)) return { error: 'Not a water cell.' };
    const def = 1 - i;
    const board = this.boards[def];
    const ev = newEvent(u.id, i, x, y, this.turnNo);
    ev.dir = dir;
    const pattern = ultPattern(this.map, u.id, x, y, dir);
    const isShot = (c) => board.shots.has(idxOf(this.map, c.x, c.y));

    if (u.id === 'airstrike' || u.id === 'bombard') {
      for (const c of pattern) {
        if (isShot(c)) continue;
        const res = this.strike(def, c.x, c.y, ev);
        ev.cells.push({ ...c, r: res.r });
        if (this.phase !== 'battle') break;
      }
    } else if (u.id === 'torpedo') {
      for (const c of pattern) {
        ev.path.push(c);
        if (isShot(c)) continue;
        const res = this.strike(def, c.x, c.y, ev);
        ev.cells.push({ ...c, r: res.r });
        if (res.r === 'hit') break;
      }
    } else if (u.id === 'scan') {
      const d = this.players[def];
      for (const c of pattern) {
        if (isShot(c)) continue;
        const k = idxOf(this.map, c.x, c.y);
        if (d.occ.has(k)) {
          board.contacts.add(k);
          ev.cells.push({ ...c, r: 'contact' });
        } else {
          board.clear.add(k);
          ev.cells.push({ ...c, r: 'clear' });
        }
      }
    } else if (u.id === 'homing') {
      const d = this.players[def];
      const live = (c) => !isShot(c) && d.occ.has(idxOf(this.map, c.x, c.y));
      let lock = null;
      if (live({ x, y })) lock = { x, y };
      else {
        let best = Infinity;
        const candidates = pattern.filter(live);
        for (const c of candidates) {
          const dist = Math.abs(c.x - x) + Math.abs(c.y - y) + this.rng() * 0.5;
          if (dist < best) {
            best = dist;
            lock = c;
          }
        }
      }
      if (lock) {
        ev.lock = lock;
        const res = this.strike(def, lock.x, lock.y, ev);
        ev.cells.push({ ...lock, r: res.r });
      } else if (!isShot({ x, y })) {
        const res = this.strike(def, x, y, ev);
        ev.cells.push({ x, y, r: res.r });
      }
    }

    p.charge -= u.cost;
    p.stats.ults++;
    this.ultUsed = true;
    this.afterAction(ev);
    return { ok: true, event: ev };
  }

  afterAction(ev) {
    const def = 1 - ev.by;
    if (this.players[def].ships.every((s) => s.sunk)) this.end(ev.by, 'fleet destroyed');
  }

  end(winner, reason) {
    this.phase = 'over';
    this.winner = winner;
    this.endReason = reason;
  }

  forfeit(i, reason = 'forfeit') {
    if (this.phase === 'over') return;
    this.end(1 - i, reason);
  }

  // Any untargeted water cell on the enemy board. Used for turn timeouts.
  randomTarget(i) {
    const board = this.boards[1 - i];
    const open = [];
    for (let k = 0; k < this.map.cells.length; k++) {
      if (this.map.cells[k] === 1 && !board.shots.has(k)) open.push(k);
    }
    const k = open[Math.floor(this.rng() * open.length)];
    return { x: k % this.map.w, y: (k / this.map.w) | 0 };
  }

  view(i) {
    const me = this.players[i];
    const foe = this.players[1 - i];
    const reveal = this.phase === 'over';
    return {
      phase: this.phase,
      you: i,
      turn: this.turn,
      turnNo: this.turnNo,
      round: Math.ceil(this.turnNo / 2),
      first: this.first,
      ultUsed: this.ultUsed,
      winner: this.winner,
      endReason: this.endReason,
      mapId: this.map.id,
      me: {
        commander: me.commander.id,
        charge: me.charge,
        ready: me.ready,
        ships: me.ships ? me.ships.map((s) => ({ ...publicShip(s), hits: s.hits.slice() })) : null,
        stats: { ...me.stats },
      },
      foe: {
        commander: foe.commander.id,
        charge: foe.charge,
        ready: foe.ready,
        ships: foe.ships
          ? foe.ships.map((s) => (s.sunk || reveal ? { ...publicShip(s), hits: s.hits.slice() } : { id: s.id, name: s.name, len: s.len, sunk: false }))
          : this.map.fleet.map((s) => ({ id: s.id, name: s.name, len: s.len, sunk: false })),
        stats: { ...foe.stats },
      },
      myBoard: boardView(this.boards[i]),
      foeBoard: boardView(this.boards[1 - i]),
    };
  }
}

export function chargeCap(commander) {
  return Math.round(commander.ult.cost * RULES.CHARGE_CAP_MULT);
}

function newEvent(kind, by, x, y, turnNo) {
  return { kind, by, x, y, turnNo, cells: [], path: [], sunk: [], chargeGained: 0 };
}

function publicShip(s) {
  return { id: s.id, name: s.name, len: s.len, x: s.x, y: s.y, dir: s.dir, sunk: s.sunk };
}

function boardView(b) {
  return {
    shots: [...b.shots.entries()],
    contacts: [...b.contacts],
    clear: [...b.clear],
  };
}
