// AI opponent. Works only from a player view (no peeking at hidden ships).
//
// RECRUIT  — checkerboard hunting, pokes around hits, fires ultimates loosely.
// VETERAN  — probability density with some noise.
// ADMIRAL  — probability density, best-scoring ultimate placement.

import { getMap, isWater } from './maps.js';
import { getCommander, DIRS } from './commanders.js';
import { ultPattern, shipCells, idxOf, HIT, MISS } from './engine.js';

export const DIFFICULTIES = ['recruit', 'veteran', 'admiral'];

function knowledge(view) {
  const map = getMap(view.mapId);
  const shots = new Map(view.foeBoard.shots);
  const contacts = new Set(view.foeBoard.contacts);
  const clear = new Set(view.foeBoard.clear);
  const sunkCells = new Set();
  for (const s of view.foe.ships) {
    if (s.sunk) for (const c of shipCells(s)) sunkCells.add(idxOf(map, c.x, c.y));
  }
  const openHits = [];
  for (const [k, r] of shots) if (r === HIT && !sunkCells.has(k)) openHits.push(k);
  const remaining = view.foe.ships.filter((s) => !s.sunk).map((s) => s.len);
  return { map, shots, contacts, clear, sunkCells, openHits, remaining };
}

export function density(view) {
  const K = knowledge(view);
  const { map, shots, contacts, clear, sunkCells, openHits, remaining } = K;
  const open = new Set(openHits);
  const d = new Float64Array(map.w * map.h);
  for (const len of remaining) {
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        for (const dir of ['h', 'v']) {
          if (len === 1 && dir === 'v') continue;
          const cells = shipCells({ x, y, len, dir });
          let ok = true;
          let k = 0;
          for (const c of cells) {
            if (!isWater(map, c.x, c.y)) { ok = false; break; }
            const i = idxOf(map, c.x, c.y);
            const s = shots.get(i);
            if (s === MISS || clear.has(i) || sunkCells.has(i)) { ok = false; break; }
            if (open.has(i)) k++;
          }
          if (!ok) continue;
          const w = open.size ? (k ? Math.pow(30, k) : 1) : 1;
          for (const c of cells) {
            const i = idxOf(map, c.x, c.y);
            if (!shots.has(i)) d[i] += w;
          }
        }
      }
    }
  }
  for (const i of contacts) if (!shots.has(i)) d[i] += 1e9;
  return { d, K };
}

function argmax(map, d, shots, rng, noise = 0) {
  let best = -1;
  let bestV = -Infinity;
  for (let i = 0; i < d.length; i++) {
    if (map.cells[i] !== 1 || shots.has(i)) continue;
    const v = d[i] * (1 + noise * rng()) + rng() * 1e-6;
    if (v > bestV) { bestV = v; best = i; }
  }
  return best;
}

function cellOf(map, i) {
  return { x: i % map.w, y: (i / map.w) | 0 };
}

function recruitTarget(view, rng) {
  const { map, shots, contacts, openHits } = knowledge(view);
  const free = (x, y) => isWater(map, x, y) && !shots.has(idxOf(map, x, y));
  for (const i of contacts) if (!shots.has(i)) return cellOf(map, i);
  const around = [];
  for (const i of openHits) {
    const c = cellOf(map, i);
    for (const dd of DIRS) if (free(c.x + dd.dx, c.y + dd.dy)) around.push({ x: c.x + dd.dx, y: c.y + dd.dy });
  }
  if (around.length && rng() < 0.85) return around[Math.floor(rng() * around.length)];
  const pool = [];
  const parity = [];
  for (let y = 0; y < map.h; y++)
    for (let x = 0; x < map.w; x++)
      if (free(x, y)) {
        pool.push({ x, y });
        if ((x + y) % 2 === 0) parity.push({ x, y });
      }
  const src = parity.length && rng() < 0.7 ? parity : pool;
  return src[Math.floor(rng() * src.length)];
}

export function chooseFire(view, difficulty = 'veteran', rng = Math.random) {
  if (difficulty === 'recruit') return recruitTarget(view, rng);
  const { d, K } = density(view);
  const noise = difficulty === 'veteran' ? 0.6 : 0;
  const i = argmax(K.map, d, K.shots, rng, noise);
  return cellOf(K.map, i);
}

// Returns { x, y, dir } or null when the ultimate is not ready / not worth it.
export function chooseUlt(view, difficulty = 'veteran', rng = Math.random) {
  const commander = getCommander(view.me.commander);
  const u = commander.ult;
  if (view.ultUsed || view.me.charge < u.cost || view.turn !== view.you || view.phase !== 'battle') return null;
  const { d, K } = density(view);
  const { map, shots } = K;
  const water = [];
  for (let i = 0; i < map.cells.length; i++) if (map.cells[i] === 1) water.push(cellOf(map, i));
  const dirs = u.id === 'torpedo' ? [0, 1, 2, 3] : u.id === 'airstrike' ? [0, 1] : [0];

  if (difficulty === 'recruit') {
    const open = water.filter((c) => !shots.has(idxOf(map, c.x, c.y)));
    const c = open[Math.floor(rng() * open.length)];
    return { ...c, dir: dirs[Math.floor(rng() * dirs.length)] };
  }

  // Normalise density so scores are comparable across ability shapes.
  let total = 0;
  for (let i = 0; i < d.length; i++) if (!shots.has(i) && d[i] < 1e9) total += d[i];
  const p = (i) => (shots.has(i) ? 0 : Math.min(d[i], total || 1) / (total || 1));

  let best = null;
  let bestScore = -Infinity;
  for (const c of water) {
    for (const dir of dirs) {
      const cells = ultPattern(map, u.id, c.x, c.y, dir);
      let score = 0;
      if (u.id === 'torpedo') {
        let decay = 1;
        for (const q of cells) {
          score += p(idxOf(map, q.x, q.y)) * decay;
          decay *= 0.8;
        }
        score += cells.length * 0.002; // longer lanes reveal more
      } else if (u.id === 'homing') {
        const target = p(idxOf(map, c.x, c.y));
        let ring = 0;
        for (const q of cells) ring = Math.max(ring, p(idxOf(map, q.x, q.y)));
        score = target * 2 + ring;
      } else if (u.id === 'scan') {
        for (const q of cells) {
          const i = idxOf(map, q.x, q.y);
          if (!shots.has(i) && !K.contacts.has(i) && !K.clear.has(i)) score += p(i) + 0.001;
        }
      } else {
        for (const q of cells) score += p(idxOf(map, q.x, q.y));
      }
      if (difficulty === 'veteran') score *= 1 + rng() * 0.35;
      if (score > bestScore) {
        bestScore = score;
        best = { x: c.x, y: c.y, dir };
      }
    }
  }
  return best;
}
