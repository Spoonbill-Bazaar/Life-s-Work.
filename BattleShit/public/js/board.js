// Canvas renderer for a theatre: coastlines, ships, shots and effects.

import { WATER, LAND, cellAt } from '/shared/maps.js';
import { shipCells } from '/shared/engine.js';

export const C = {
  grid: 'rgba(72,214,232,0.10)',
  water: 'rgba(72,214,232,0.022)',
  coast: '#48d6e8',
  coastDim: 'rgba(72,214,232,0.35)',
  land: '#04161b',
  hatch: 'rgba(72,214,232,0.07)',
  label: 'rgba(120,180,190,0.45)',
  me: '#6dfcb0',
  foe: '#ff4d4d',
  miss: 'rgba(150,215,225,0.55)',
  amber: '#ffb347',
  white: '#e6fbff',
};

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const coord = (x, y) => `${LETTERS[x]}${y + 1}`;

const ease = (t) => 1 - Math.pow(1 - t, 3);
const clamp01 = (t) => Math.max(0, Math.min(1, t));

export class Board {
  constructor(canvas, side) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.side = side; // 'me' | 'foe' | 'deploy'
    this.map = null;
    this.ships = [];
    this.shots = new Map();
    this.contacts = new Set();
    this.clear = new Set();
    this.masks = new Map();
    this.shipMasks = new Map();
    this.preview = null;
    this.hover = null;
    this.aim = null;
    this.interactive = false;
    this.fx = [];
    this.cs = 20;
    this.ox = 0;
    this.oy = 0;
    this.dpr = 1;
    this.sweep = side === 'me' || side === 'deploy';
    this.shake = 0;
    this.handlers = {};
    this.bind();
  }

  on(name, fn) {
    this.handlers[name] = fn;
  }

  emit(name, ...args) {
    this.handlers[name]?.(...args);
  }

  bind() {
    const c = this.canvas;
    c.addEventListener('pointermove', (e) => {
      const cell = this.cellFromEvent(e);
      if (e.pointerType === 'mouse') this.setHover(cell);
    });
    c.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') this.setHover(null);
    });
    c.addEventListener('pointerup', (e) => {
      if (e.button === 2) return;
      const cell = this.cellFromEvent(e);
      if (!cell) return;
      if (e.pointerType !== 'mouse') {
        // touch: first tap aims, second tap on the same cell commits
        if (!this.hover || this.hover.x !== cell.x || this.hover.y !== cell.y) {
          this.setHover(cell);
          if (this.side !== 'deploy') return;
        }
      }
      this.emit('click', cell);
    });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.emit('rotate');
    });
  }

  setHover(cell) {
    const same = cell && this.hover && cell.x === this.hover.x && cell.y === this.hover.y;
    if (same || (!cell && !this.hover)) return;
    this.hover = cell;
    this.emit('hover', cell);
  }

  setMap(map) {
    this.map = map;
    // lets narrow layouts size the board host to the theatre's shape
    this.canvas.parentElement.style.setProperty('--ar', `${map.w + 1.4} / ${map.h + 1.6}`);
    this.resize();
  }

  resize() {
    if (!this.map) return;
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(50, r.width);
    const H = Math.max(50, r.height);
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.dpr = dpr;
    const pad = 22;
    const cs = Math.floor(Math.min((W - pad - 8) / this.map.w, (H - pad - 8) / this.map.h));
    this.cs = Math.max(8, cs);
    const bw = this.cs * this.map.w;
    const bh = this.cs * this.map.h;
    this.ox = Math.round(pad + (W - pad - bw) / 2);
    this.oy = Math.round(pad + (H - pad - bh) / 2) - 4;
    this.W = W;
    this.H = H;
  }

  cellFromEvent(e) {
    if (!this.map) return null;
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left - this.ox) / this.cs);
    const y = Math.floor((e.clientY - r.top - this.oy) / this.cs);
    if (cellAt(this.map, x, y) !== WATER) return null;
    return { x, y };
  }

  idx(x, y) {
    return y * this.map.w + x;
  }

  center(x, y) {
    return { px: this.ox + (x + 0.5) * this.cs, py: this.oy + (y + 0.5) * this.cs };
  }

  // ---- state ---------------------------------------------------------------

  setKnowledge(board) {
    this.shots = new Map(board.shots);
    this.contacts = new Set(board.contacts);
    this.clear = new Set(board.clear);
  }

  masked(k, now) {
    const t = this.masks.get(k);
    if (t === undefined) return false;
    if (now >= t) {
      this.masks.delete(k);
      return false;
    }
    return true;
  }

  // ---- effects -------------------------------------------------------------

  // Schedule the animation for one match event. Returns its duration in ms.
  play(ev, now, hooks = {}) {
    const m = this.map;
    const color = this.side === 'foe' ? C.me : C.foe;
    const origin = this.side === 'foe' ? { px: this.W * 0.5, py: this.H + 30 } : { px: this.W * 0.5, py: -30 };
    let end = 0;
    const impactAt = (c, t) => {
      const k = this.idx(c.x, c.y);
      this.masks.set(k, now + t);
      this.fx.push({ type: 'impact', x: c.x, y: c.y, r: c.r, t0: now + t, dur: c.r === 'hit' ? 900 : 600 });
      if (c.r === 'hit' && this.side === 'me') {
        this.fx.push({ type: 'text', x: c.x, y: c.y, text: '+CHG', color: C.amber, t0: now + t + 200, dur: 1100 });
      }
      hooks.impact?.(c.r, t);
      end = Math.max(end, t + 600);
    };
    const sinkAt = (t) => {
      for (const s of ev.sunk) {
        this.shipMasks.set(s.id, now + t);
        this.fx.push({ type: 'sunk', ship: s, t0: now + t, dur: 1400 });
        hooks.sunk?.(t);
        end = Math.max(end, t + 1400);
      }
    };

    switch (ev.kind) {
      case 'shot': {
        const c = ev.cells[0];
        this.fx.push({ type: 'arc', from: origin, x: c.x, y: c.y, t0: now, dur: 520, color });
        hooks.launch?.(0);
        impactAt(c, 520);
        sinkAt(560);
        break;
      }
      case 'bombard': {
        hooks.launch?.(0);
        ev.cells.forEach((c, i) => {
          const d = i * 70 + Math.random() * 60;
          this.fx.push({ type: 'arc', from: origin, x: c.x, y: c.y, t0: now + d, dur: 560, color, thin: true });
          impactAt(c, d + 560);
        });
        sinkAt(560 + ev.cells.length * 70 + 120);
        break;
      }
      case 'airstrike': {
        hooks.launch?.(0);
        const dir = ev.dir % 2;
        const a = dir === 0 ? { x: ev.x - 2.5, y: ev.y } : { x: ev.x, y: ev.y - 2.5 };
        const b = dir === 0 ? { x: ev.x + 2.5, y: ev.y } : { x: ev.x, y: ev.y + 2.5 };
        this.fx.push({ type: 'strafe', a, b, t0: now, dur: 650, color });
        ev.cells.forEach((c) => {
          const along = dir === 0 ? c.x - a.x : c.y - a.y;
          impactAt(c, 120 + (along / 5) * 600);
        });
        sinkAt(800);
        break;
      }
      case 'torpedo': {
        hooks.launch?.(0);
        const per = 70;
        this.fx.push({ type: 'torp', path: ev.path, t0: now, per, color });
        for (const c of ev.cells) {
          const i = ev.path.findIndex((p) => p.x === c.x && p.y === c.y);
          impactAt(c, (i + 0.5) * per);
        }
        sinkAt(ev.path.length * per + 80);
        end = Math.max(end, ev.path.length * per + 400);
        break;
      }
      case 'scan': {
        hooks.scan?.(0);
        this.fx.push({ type: 'scan', x: ev.x, y: ev.y, t0: now, dur: 1100, color: C.amber });
        for (const c of ev.cells) {
          const d = Math.abs(c.x - ev.x) + Math.abs(c.y - ev.y);
          this.masks.set(this.idx(c.x, c.y), now + 250 + d * 160);
        }
        end = 1200;
        break;
      }
      case 'homing': {
        hooks.launch?.(0);
        this.fx.push({ type: 'arc', from: origin, x: ev.x, y: ev.y, t0: now, dur: 480, color });
        let t = 480;
        if (ev.lock && (ev.lock.x !== ev.x || ev.lock.y !== ev.y)) {
          this.fx.push({ type: 'seek', a: { x: ev.x, y: ev.y }, b: ev.lock, t0: now + 480, dur: 280, color: C.amber });
          t += 280;
        } else if (!ev.lock) {
          this.fx.push({ type: 'scan', x: ev.x, y: ev.y, t0: now + 480, dur: 600, color: 'rgba(255,179,71,0.6)', small: true });
        }
        for (const c of ev.cells) impactAt(c, t);
        sinkAt(t + 40);
        end = Math.max(end, t + 300);
        break;
      }
    }
    if (ev.cells.some((c) => c.r === 'hit')) {
      setTimeout(() => (this.shake = this.side === 'me' ? 7 : 3), Math.min(end, 600));
    }
    return end;
  }

  // ---- drawing -------------------------------------------------------------

  draw(now) {
    const { ctx, map } = this;
    if (!map) return;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    if (this.shake > 0.1) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
      this.shake *= 0.86;
    }
    const cs = this.cs;
    const { ox, oy } = this;

    // water + grid
    ctx.lineWidth = 1;
    ctx.strokeStyle = C.grid;
    ctx.fillStyle = C.water;
    ctx.beginPath();
    for (let y = 0; y < map.h; y++)
      for (let x = 0; x < map.w; x++)
        if (cellAt(map, x, y) === WATER) {
          ctx.rect(ox + x * cs + 0.5, oy + y * cs + 0.5, cs, cs);
        }
    ctx.fill();
    ctx.stroke();

    // land with hatching
    ctx.save();
    ctx.beginPath();
    for (let y = 0; y < map.h; y++)
      for (let x = 0; x < map.w; x++) if (cellAt(map, x, y) === LAND) ctx.rect(ox + x * cs, oy + y * cs, cs, cs);
    ctx.fillStyle = C.land;
    ctx.fill();
    ctx.clip();
    ctx.strokeStyle = C.hatch;
    ctx.beginPath();
    for (let d = -this.H; d < this.W + this.H; d += 6) {
      ctx.moveTo(d, 0);
      ctx.lineTo(d - this.H, this.H);
    }
    ctx.stroke();
    ctx.restore();

    // radar sweep (home waters)
    if (this.sweep) this.drawSweep(now);

    // coastline: every water edge that borders non-water; land edges to void
    ctx.save();
    ctx.strokeStyle = C.coast;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = C.coast;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    const edge = (x1, y1, x2, y2) => {
      ctx.moveTo(ox + x1 * cs, oy + y1 * cs);
      ctx.lineTo(ox + x2 * cs, oy + y2 * cs);
    };
    for (let y = 0; y < map.h; y++)
      for (let x = 0; x < map.w; x++) {
        if (cellAt(map, x, y) !== WATER) continue;
        if (cellAt(map, x, y - 1) !== WATER) edge(x, y, x + 1, y);
        if (cellAt(map, x, y + 1) !== WATER) edge(x, y + 1, x + 1, y + 1);
        if (cellAt(map, x - 1, y) !== WATER) edge(x, y, x, y + 1);
        if (cellAt(map, x + 1, y) !== WATER) edge(x + 1, y, x + 1, y + 1);
      }
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = C.coastDim;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = 0; y < map.h; y++)
      for (let x = 0; x < map.w; x++) {
        if (cellAt(map, x, y) !== LAND) continue;
        if (cellAt(map, x, y - 1) === 0) edge(x, y, x + 1, y);
        if (cellAt(map, x, y + 1) === 0) edge(x, y + 1, x + 1, y + 1);
        if (cellAt(map, x - 1, y) === 0) edge(x, y, x, y + 1);
        if (cellAt(map, x + 1, y) === 0) edge(x + 1, y, x + 1, y + 1);
      }
    ctx.stroke();
    ctx.restore();

    // labels
    ctx.fillStyle = C.label;
    ctx.font = `${Math.max(9, Math.min(12, cs * 0.42))}px 'Share Tech Mono', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let x = 0; x < map.w; x++) ctx.fillText(LETTERS[x], ox + (x + 0.5) * cs, oy - 11);
    ctx.textAlign = 'right';
    for (let y = 0; y < map.h; y++) ctx.fillText(String(y + 1), ox - 6, oy + (y + 0.5) * cs);

    // scan knowledge
    for (const k of this.clear) {
      if (this.shots.has(k) || this.masked(k, now)) continue;
      const { px, py } = this.center(k % map.w, (k / map.w) | 0);
      ctx.fillStyle = 'rgba(255,179,71,0.35)';
      ctx.fillRect(px - 1, py - 1, 2, 2);
    }
    for (const k of this.contacts) {
      if (this.shots.has(k) || this.masked(k, now)) continue;
      const { px, py } = this.center(k % map.w, (k / map.w) | 0);
      const s = cs * 0.28 * (1 + 0.08 * Math.sin(now / 200));
      ctx.save();
      ctx.strokeStyle = C.amber;
      ctx.shadowColor = C.amber;
      ctx.shadowBlur = 8;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, py - s);
      ctx.lineTo(px + s, py);
      ctx.lineTo(px, py + s);
      ctx.lineTo(px - s, py);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }

    // ships
    for (const s of this.ships) {
      if (s.x === undefined) continue;
      const mt = this.shipMasks.get(s.id);
      if (mt !== undefined && now < mt) continue;
      this.drawShip(s, this.side === 'foe' ? C.foe : C.me, s.sunk);
    }

    // shots
    for (const [k, r] of this.shots) {
      if (this.masked(k, now)) continue;
      const x = k % map.w;
      const y = (k / map.w) | 0;
      const { px, py } = this.center(x, y);
      if (r === 'm') {
        ctx.strokeStyle = C.miss;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(px, py, Math.max(2, cs * 0.12), 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(255,77,77,0.14)';
        ctx.fillRect(ox + x * cs + 1, oy + y * cs + 1, cs - 1, cs - 1);
        ctx.save();
        ctx.strokeStyle = C.foe;
        ctx.shadowColor = C.foe;
        ctx.shadowBlur = 10;
        ctx.lineWidth = 2;
        const s = cs * 0.24;
        ctx.beginPath();
        ctx.moveTo(px - s, py - s);
        ctx.lineTo(px + s, py + s);
        ctx.moveTo(px + s, py - s);
        ctx.lineTo(px - s, py + s);
        ctx.stroke();
        ctx.restore();
      }
    }

    // preview (placement / ultimate footprint)
    if (this.preview) {
      const p = this.preview;
      const col = p.ok ? p.color || C.amber : C.foe;
      ctx.save();
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.16;
      for (const c of p.cells) ctx.fillRect(ox + c.x * cs + 1, oy + c.y * cs + 1, cs - 1, cs - 1);
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      for (const c of p.cells) ctx.strokeRect(ox + c.x * cs + 3.5, oy + c.y * cs + 3.5, cs - 6, cs - 6);
      if (p.ship) {
        ctx.globalAlpha = 0.85;
        this.drawShip(p.ship, col, false, true);
      }
      if (p.arrow) this.drawArrow(p.arrow, col);
      ctx.restore();
    }

    // crosshair
    const h = this.hover;
    if (h && this.interactive) {
      const { px, py } = this.center(h.x, h.y);
      ctx.save();
      ctx.strokeStyle = 'rgba(230,251,255,0.12)';
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(ox, py + 0.5);
      ctx.lineTo(ox + map.w * cs, py + 0.5);
      ctx.moveTo(px + 0.5, oy);
      ctx.lineTo(px + 0.5, oy + map.h * cs);
      ctx.stroke();
      ctx.setLineDash([]);
      const col = this.side === 'foe' ? C.white : C.me;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      const x0 = ox + h.x * cs + 2;
      const y0 = oy + h.y * cs + 2;
      const L = cs * 0.3;
      const S = cs - 4;
      ctx.beginPath();
      ctx.moveTo(x0, y0 + L); ctx.lineTo(x0, y0); ctx.lineTo(x0 + L, y0);
      ctx.moveTo(x0 + S - L, y0); ctx.lineTo(x0 + S, y0); ctx.lineTo(x0 + S, y0 + L);
      ctx.moveTo(x0 + S, y0 + S - L); ctx.lineTo(x0 + S, y0 + S); ctx.lineTo(x0 + S - L, y0 + S);
      ctx.moveTo(x0 + L, y0 + S); ctx.lineTo(x0, y0 + S); ctx.lineTo(x0, y0 + S - L);
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.textAlign = 'left';
      ctx.font = `11px 'Share Tech Mono', monospace`;
      ctx.fillText(coord(h.x, h.y), ox + map.w * cs + 4 > this.W - 30 ? ox + 2 : ox + map.w * cs + 6, oy + map.h * cs - 6);
      ctx.restore();
    }

    this.drawFx(now);
  }

  drawShip(s, color, sunk, ghost = false) {
    const { ctx, cs, ox, oy } = this;
    const cells = shipCells(s);
    const a = cells[0];
    const b = cells[cells.length - 1];
    const inset = cs * 0.2;
    const x = ox + a.x * cs + inset;
    const y = oy + a.y * cs + inset;
    const w = (b.x - a.x + 1) * cs - inset * 2;
    const hgt = (b.y - a.y + 1) * cs - inset * 2;
    const r = Math.min(w, hgt) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, w, hgt, r) : ctx.rect(x, y, w, hgt);
    ctx.fillStyle = color;
    ctx.globalAlpha = ghost ? 0.15 : sunk ? 0.06 : 0.12;
    ctx.fill();
    ctx.globalAlpha = ghost ? 0.9 : sunk ? 0.55 : 0.95;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    if (sunk) ctx.setLineDash([4, 3]);
    if (!sunk && !ghost) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 6;
    }
    ctx.stroke();
    // centreline detail
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    ctx.globalAlpha *= 0.5;
    ctx.beginPath();
    if (s.dir === 'h') {
      ctx.moveTo(x + r, y + hgt / 2);
      ctx.lineTo(x + w - r, y + hgt / 2);
    } else {
      ctx.moveTo(x + w / 2, y + r);
      ctx.lineTo(x + w / 2, y + hgt - r);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawArrow({ x, y, dx, dy }, color) {
    const { ctx, cs } = this;
    const { px, py } = this.center(x, y);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const tx = px + dx * cs * 0.38;
    const ty = py + dy * cs * 0.38;
    ctx.moveTo(px - dx * cs * 0.3, py - dy * cs * 0.3);
    ctx.lineTo(tx, ty);
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - dx * cs * 0.2 - dy * cs * 0.16, ty - dy * cs * 0.2 - dx * cs * 0.16);
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - dx * cs * 0.2 + dy * cs * 0.16, ty - dy * cs * 0.2 + dx * cs * 0.16);
    ctx.stroke();
  }

  drawSweep(now) {
    const { ctx, map, cs, ox, oy } = this;
    const cx = ox + (map.w * cs) / 2;
    const cy = oy + (map.h * cs) / 2;
    const R = Math.hypot(map.w * cs, map.h * cs) / 2;
    const a = (now / 3200) * Math.PI * 2;
    ctx.save();
    ctx.beginPath();
    for (let y = 0; y < map.h; y++)
      for (let x = 0; x < map.w; x++) if (cellAt(map, x, y) === WATER) ctx.rect(ox + x * cs, oy + y * cs, cs, cs);
    ctx.clip();
    if (ctx.createConicGradient) {
      const g = ctx.createConicGradient(a, cx, cy);
      const col = this.side === 'foe' ? '255,77,77' : '109,252,176';
      g.addColorStop(0, `rgba(${col},0.10)`);
      g.addColorStop(0.08, `rgba(${col},0.0)`);
      g.addColorStop(1, `rgba(${col},0.0)`);
      ctx.fillStyle = g;
      ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    }
    ctx.restore();
  }

  drawFx(now) {
    const { ctx, cs } = this;
    this.fx = this.fx.filter((f) => now < f.t0 + (f.dur || 0) + (f.type === 'torp' ? f.path.length * f.per + 400 : 0));
    for (const f of this.fx) {
      const t = (now - f.t0) / (f.dur || 1);
      if (t < 0) continue;
      ctx.save();
      switch (f.type) {
        case 'arc': {
          const to = this.center(f.x, f.y);
          const mx = (f.from.px + to.px) / 2;
          const my = Math.min(f.from.py, to.py) - Math.abs(f.from.py - to.py) * 0.35 - 40;
          const p = ease(clamp01(t));
          const pt = (u) => ({
            x: (1 - u) * (1 - u) * f.from.px + 2 * (1 - u) * u * mx + u * u * to.px,
            y: (1 - u) * (1 - u) * f.from.py + 2 * (1 - u) * u * my + u * u * to.py,
          });
          ctx.strokeStyle = f.color;
          ctx.globalAlpha = 0.55 * (1 - Math.max(0, t - 0.8) * 5);
          ctx.lineWidth = f.thin ? 1 : 1.25;
          ctx.setLineDash([3, 5]);
          ctx.beginPath();
          const start = Math.max(0, p - 0.45);
          for (let u = start; u <= p; u += 0.02) {
            const q = pt(u);
            u === start ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y);
          }
          ctx.stroke();
          if (t < 1) {
            const q = pt(p);
            ctx.globalAlpha = 1;
            ctx.fillStyle = C.white;
            ctx.shadowColor = f.color;
            ctx.shadowBlur = 10;
            ctx.beginPath();
            ctx.arc(q.x, q.y, 2.2, 0, Math.PI * 2);
            ctx.fill();
          }
          break;
        }
        case 'impact': {
          const { px, py } = this.center(f.x, f.y);
          const hit = f.r === 'hit';
          const col = hit ? C.foe : C.coast;
          const e = ease(clamp01(t));
          ctx.strokeStyle = col;
          ctx.globalAlpha = 1 - e;
          ctx.lineWidth = hit ? 2 : 1;
          ctx.shadowColor = col;
          ctx.shadowBlur = hit ? 14 : 4;
          ctx.beginPath();
          ctx.arc(px, py, cs * (0.15 + e * (hit ? 1.4 : 0.7)), 0, Math.PI * 2);
          ctx.stroke();
          if (hit && t < 0.25) {
            ctx.globalAlpha = 1 - t * 4;
            ctx.fillStyle = '#fff';
            ctx.fillRect(px - cs / 2, py - cs / 2, cs, cs);
          }
          if (!hit) {
            ctx.globalAlpha = (1 - e) * 0.6;
            ctx.beginPath();
            ctx.arc(px, py, cs * (0.1 + e * 0.35), 0, Math.PI * 2);
            ctx.stroke();
          }
          break;
        }
        case 'sunk': {
          ctx.globalAlpha = 1 - clamp01(t);
          this.drawShip(f.ship, C.foe, false);
          const cells = shipCells(f.ship);
          const a = this.center(cells[0].x, cells[0].y);
          const b = this.center(cells[cells.length - 1].x, cells[cells.length - 1].y);
          ctx.fillStyle = C.foe;
          ctx.font = `12px 'Share Tech Mono', monospace`;
          ctx.textAlign = 'center';
          ctx.globalAlpha = Math.min(1, (1 - t) * 2);
          ctx.fillText(`${f.ship.name} DOWN`, (a.px + b.px) / 2, Math.min(a.py, b.py) - cs * 0.7);
          break;
        }
        case 'strafe': {
          const a = { px: this.ox + (f.a.x + 0.5) * cs, py: this.oy + (f.a.y + 0.5) * cs };
          const b = { px: this.ox + (f.b.x + 0.5) * cs, py: this.oy + (f.b.y + 0.5) * cs };
          const p = clamp01(t);
          const hx = a.px + (b.px - a.px) * p;
          const hy = a.py + (b.py - a.py) * p;
          ctx.strokeStyle = f.color;
          ctx.shadowColor = f.color;
          ctx.shadowBlur = 10;
          ctx.lineWidth = 2;
          ctx.globalAlpha = 1 - Math.max(0, t - 0.7) * 3;
          ctx.beginPath();
          ctx.moveTo(a.px, a.py);
          ctx.lineTo(hx, hy);
          ctx.stroke();
          // chevron "aircraft"
          const ang = Math.atan2(b.py - a.py, b.px - a.px);
          ctx.translate(hx, hy);
          ctx.rotate(ang);
          ctx.beginPath();
          ctx.moveTo(6, 0);
          ctx.lineTo(-5, -6);
          ctx.lineTo(-2, 0);
          ctx.lineTo(-5, 6);
          ctx.closePath();
          ctx.fillStyle = C.white;
          ctx.fill();
          break;
        }
        case 'torp': {
          const el = now - f.t0;
          const n = f.path.length;
          const pos = Math.min(n - 0.5, el / f.per);
          const fade = clamp01((el - n * f.per) / 400);
          const p0 = this.center(f.path[0].x, f.path[0].y);
          const i = Math.min(n - 1, Math.floor(pos));
          const frac = pos - i;
          const c1 = this.center(f.path[i].x, f.path[i].y);
          const c2 = f.path[i + 1] ? this.center(f.path[i + 1].x, f.path[i + 1].y) : c1;
          const hx = c1.px + (c2.px - c1.px) * frac;
          const hy = c1.py + (c2.py - c1.py) * frac;
          ctx.strokeStyle = f.color;
          ctx.globalAlpha = 0.7 * (1 - fade);
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 3]);
          ctx.beginPath();
          ctx.moveTo(p0.px, p0.py);
          ctx.lineTo(hx, hy);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1 - fade;
          ctx.fillStyle = C.white;
          ctx.shadowColor = f.color;
          ctx.shadowBlur = 10;
          ctx.beginPath();
          ctx.arc(hx, hy, 2.5, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'scan': {
          const { px, py } = this.center(f.x, f.y);
          const e = ease(clamp01(t));
          const R = cs * (f.small ? 2.5 : 2.6) * e + cs * 0.3;
          ctx.strokeStyle = f.color;
          ctx.shadowColor = C.amber;
          ctx.shadowBlur = 8;
          ctx.lineWidth = 1.5;
          for (const k of [1, 0.6]) {
            ctx.globalAlpha = (1 - e) * k;
            ctx.beginPath();
            ctx.moveTo(px, py - R * k);
            ctx.lineTo(px + R * k, py);
            ctx.lineTo(px, py + R * k);
            ctx.lineTo(px - R * k, py);
            ctx.closePath();
            ctx.stroke();
          }
          break;
        }
        case 'seek': {
          const a = this.center(f.a.x, f.a.y);
          const b = this.center(f.b.x, f.b.y);
          const p = ease(clamp01(t));
          ctx.strokeStyle = f.color;
          ctx.shadowColor = f.color;
          ctx.shadowBlur = 8;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(a.px, a.py);
          ctx.lineTo(a.px + (b.px - a.px) * p, a.py + (b.py - a.py) * p);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(b.px, b.py, cs * 0.45, 0, Math.PI * 2);
          ctx.globalAlpha = 0.6;
          ctx.stroke();
          break;
        }
        case 'text': {
          const { px, py } = this.center(f.x, f.y);
          ctx.fillStyle = f.color;
          ctx.globalAlpha = 1 - clamp01(t);
          ctx.font = `11px 'Share Tech Mono', monospace`;
          ctx.textAlign = 'center';
          ctx.fillText(f.text, px, py - cs * 0.6 - t * cs * 0.6);
          break;
        }
      }
      ctx.restore();
    }
  }
}

// Small static thumbnail of a theatre: coastline only.
export function drawThumb(canvas, map, color = C.coast) {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.max(40, r.width);
  const H = Math.max(30, r.height);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cs = Math.min((W - 8) / map.w, (H - 8) / map.h);
  const ox = (W - cs * map.w) / 2;
  const oy = (H - cs * map.h) / 2;
  ctx.fillStyle = 'rgba(72,214,232,0.05)';
  for (let y = 0; y < map.h; y++)
    for (let x = 0; x < map.w; x++) {
      const t = cellAt(map, x, y);
      if (t === WATER) ctx.fillRect(ox + x * cs, oy + y * cs, cs, cs);
    }
  ctx.fillStyle = 'rgba(72,214,232,0.18)';
  for (let y = 0; y < map.h; y++)
    for (let x = 0; x < map.w; x++) if (cellAt(map, x, y) === LAND) ctx.fillRect(ox + x * cs, oy + y * cs, cs, cs);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let y = 0; y < map.h; y++)
    for (let x = 0; x < map.w; x++) {
      if (cellAt(map, x, y) !== WATER) continue;
      const e = (x1, y1, x2, y2) => {
        ctx.moveTo(ox + x1 * cs, oy + y1 * cs);
        ctx.lineTo(ox + x2 * cs, oy + y2 * cs);
      };
      if (cellAt(map, x, y - 1) !== WATER) e(x, y, x + 1, y);
      if (cellAt(map, x, y + 1) !== WATER) e(x, y + 1, x + 1, y + 1);
      if (cellAt(map, x - 1, y) !== WATER) e(x, y, x, y + 1);
      if (cellAt(map, x + 1, y) !== WATER) e(x + 1, y, x + 1, y + 1);
    }
  ctx.stroke();
}

// Vector emblem per commander.
export function drawEmblem(canvas, id, color) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const S = canvas.clientWidth || 44;
  canvas.width = S * dpr;
  canvas.height = S * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, S, S);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.5;
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;
  const c = S / 2;
  ctx.strokeRect(1.5, 1.5, S - 3, S - 3);
  ctx.beginPath();
  switch (id) {
    case 'kestrel':
      ctx.moveTo(c - 14, c + 4); ctx.lineTo(c, c - 8); ctx.lineTo(c + 14, c + 4);
      ctx.moveTo(c - 8, c + 10); ctx.lineTo(c, c + 2); ctx.lineTo(c + 8, c + 10);
      break;
    case 'leviathan':
      ctx.ellipse(c, c + 3, 14, 5, 0, 0, Math.PI * 2);
      ctx.moveTo(c - 3, c - 2); ctx.lineTo(c - 3, c - 9); ctx.lineTo(c + 3, c - 9); ctx.lineTo(c + 3, c - 2);
      break;
    case 'bastion':
      for (const dx of [-7, 0, 7]) for (const dy of [-7, 0, 7]) ctx.rect(c + dx - 2.5, c + dy - 2.5, 5, 5);
      break;
    case 'wraith':
      ctx.arc(c, c + 8, 4, Math.PI, 0);
      ctx.moveTo(c - 10, c + 8); ctx.arc(c, c + 8, 10, Math.PI, 0);
      ctx.moveTo(c - 16, c + 8); ctx.arc(c, c + 8, 16, Math.PI, 0);
      break;
    case 'vector':
      ctx.arc(c, c, 12, 0, Math.PI * 2);
      ctx.moveTo(c - 10, c + 10); ctx.lineTo(c + 6, c - 6);
      ctx.moveTo(c + 6, c - 6); ctx.lineTo(c - 1, c - 6);
      ctx.moveTo(c + 6, c - 6); ctx.lineTo(c + 6, c + 1);
      break;
  }
  ctx.stroke();
}
