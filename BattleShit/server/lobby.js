import crypto from 'node:crypto';
import { MAP_DEFS, getMap } from '../shared/maps.js';
import { COMMANDERS, RULES, getCommander } from '../shared/commanders.js';
import { Match, randomPlacements } from '../shared/engine.js';
import { chooseFire, chooseUlt, DIFFICULTIES } from '../shared/bot.js';

const RECONNECT_GRACE_MS = 60_000;
const BOT_NAMES = { recruit: 'CADET-7', veteran: 'SENTINEL', admiral: 'OVERLORD' };

const send = (ws, type, data) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, ...data }));
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const cleanName = (s) =>
  String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 _\-.]/g, '')
    .trim()
    .slice(0, 16) || 'ANON';

function newCode(taken) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)];
    if (!taken.has(c)) return c;
  }
}

class Room {
  constructor(lobby, code, mode) {
    this.lobby = lobby;
    this.code = code;
    this.mode = mode; // 'private' | 'quick' | 'bot'
    this.seats = [null, null];
    this.phase = 'lobby';
    this.mapId = mode === 'private' ? 'open-water' : pick(MAP_DEFS).id;
    this.match = null;
    this.deadline = null;
    this.timer = null;
    this.botTimer = null;
    this.lastEvent = null;
    this.history = [];
  }

  seatOf(client) {
    return this.seats.findIndex((s) => s && s.client === client);
  }

  add(client, extra = {}) {
    const i = this.seats.indexOf(null);
    if (i < 0) return -1;
    this.seats[i] = {
      client,
      name: client.name,
      token: crypto.randomBytes(12).toString('hex'),
      commander: null,
      ready: false,
      rematch: false,
      connected: true,
      graceTimer: null,
      ...extra,
    };
    client.room = this;
    send(client.ws, 'joined', { code: this.code, token: this.seats[i].token, seat: i });
    return i;
  }

  addBot(difficulty) {
    const i = this.seats.indexOf(null);
    this.seats[i] = {
      client: null,
      bot: difficulty,
      name: BOT_NAMES[difficulty],
      commander: pick(COMMANDERS).id,
      ready: true,
      rematch: true,
      connected: true,
    };
  }

  get full() {
    return this.seats.every(Boolean);
  }

  humans() {
    return this.seats.filter((s) => s && !s.bot);
  }

  // ---- lobby -------------------------------------------------------------

  select(i, { commander, mapId }) {
    if (this.phase !== 'lobby') return;
    const seat = this.seats[i];
    if (commander && getCommander(commander)) seat.commander = commander;
    if (mapId && i === 0 && this.mode !== 'quick' && getMap(mapId)) {
      this.mapId = mapId;
      for (const s of this.seats) if (s && !s.bot) s.ready = false;
    }
    if (commander) seat.ready = false;
    this.sync();
  }

  setReady(i, ready) {
    if (this.phase !== 'lobby') return;
    const seat = this.seats[i];
    if (!seat.commander) return this.error(i, 'Choose a commander first.');
    seat.ready = !!ready;
    if (this.full && this.seats.every((s) => s.ready)) this.startPlacement();
    else this.sync();
  }

  startPlacement() {
    this.phase = 'placement';
    this.history = [];
    this.lastEvent = null;
    this.match = new Match({ mapId: this.mapId, commanders: this.seats.map((s) => s.commander) });
    this.seats.forEach((s, i) => {
      s.rematch = !!s.bot;
      if (s.bot) this.match.place(i, randomPlacements(this.match.map));
    });
    this.setDeadline(RULES.PLACEMENT_SECONDS, () => {
      this.seats.forEach((s, i) => {
        if (!this.match.players[i].ready) this.match.place(i, randomPlacements(this.match.map));
      });
      this.afterMatchChange();
    });
    this.sync();
  }

  // ---- battle ------------------------------------------------------------

  place(i, placements) {
    if (this.phase !== 'placement') return;
    const r = this.match.place(i, placements);
    if (r.error) return this.error(i, r.error);
    this.afterMatchChange();
  }

  unplace(i) {
    if (this.phase !== 'placement') return;
    this.match.unready(i);
    this.sync();
  }

  fire(i, x, y) {
    if (this.phase !== 'battle') return;
    const r = this.match.fire(i, x | 0, y | 0);
    if (r.error) return this.error(i, r.error);
    this.broadcastEvent(r.event);
    this.afterMatchChange();
  }

  ult(i, x, y, dir) {
    if (this.phase !== 'battle') return;
    const r = this.match.ult(i, x | 0, y | 0, (dir | 0) & 3);
    if (r.error) return this.error(i, r.error);
    this.broadcastEvent(r.event);
    this.afterMatchChange(true);
  }

  broadcastEvent(ev) {
    this.lastEvent = ev;
    this.history.push(ev);
    this.seats.forEach((s) => s && !s.bot && send(s.client?.ws, 'fx', { event: ev }));
  }

  afterMatchChange(sameTurn = false) {
    const m = this.match;
    if (this.phase === 'placement' && m.phase === 'battle') {
      this.phase = 'battle';
      this.startTurnClock();
    } else if (m.phase === 'over') {
      this.phase = 'over';
      this.clearDeadline();
      clearTimeout(this.botTimer);
    } else if (this.phase === 'battle' && !sameTurn) {
      this.startTurnClock();
    }
    this.sync();
  }

  startTurnClock() {
    const i = this.match.turn;
    const seat = this.seats[i];
    clearTimeout(this.botTimer);
    if (seat.bot) {
      this.clearDeadline();
      this.botTimer = setTimeout(() => this.botAct(i), 1100 + Math.random() * 700);
      return;
    }
    this.setDeadline(RULES.TURN_SECONDS, () => {
      if (this.phase !== 'battle' || this.match.turn !== i) return;
      const t = this.match.randomTarget(i);
      this.fire(i, t.x, t.y);
    });
  }

  botAct(i) {
    if (this.phase !== 'battle' || this.match.turn !== i) return;
    const diff = this.seats[i].bot;
    const u = chooseUlt(this.match.view(i), diff);
    if (u) {
      this.ult(i, u.x, u.y, u.dir);
      if (this.phase !== 'battle') return;
      this.botTimer = setTimeout(() => this.botFire(i), 1700);
    } else this.botFire(i);
  }

  botFire(i) {
    if (this.phase !== 'battle' || this.match.turn !== i) return;
    const f = chooseFire(this.match.view(i), this.seats[i].bot);
    this.fire(i, f.x, f.y);
  }

  rematch(i) {
    if (this.phase !== 'over' || !this.full) return;
    this.seats[i].rematch = true;
    if (this.seats.every((s) => s.rematch)) {
      this.phase = 'lobby';
      this.match = null;
      this.seats.forEach((s) => {
        s.ready = !!s.bot;
        if (s.bot) s.commander = pick(COMMANDERS).id;
      });
      if (this.mode !== 'private') this.mapId = pick(MAP_DEFS).id;
    }
    this.sync();
  }

  // ---- connection lifecycle -----------------------------------------------

  disconnect(client) {
    const i = this.seatOf(client);
    if (i < 0) return;
    const seat = this.seats[i];
    if (this.phase === 'lobby' || this.phase === 'over') {
      this.remove(i);
      return;
    }
    seat.connected = false;
    seat.client = null;
    seat.graceTimer = setTimeout(() => {
      if (seat.connected) return;
      this.match.forfeit(i, 'disconnected');
      this.afterMatchChange();
      this.remove(i);
    }, RECONNECT_GRACE_MS);
    this.sync();
  }

  resume(client, token) {
    const i = this.seats.findIndex((s) => s && !s.bot && s.token === token);
    if (i < 0) return false;
    const seat = this.seats[i];
    if (seat.client && seat.client !== client) seat.client.ws.close();
    clearTimeout(seat.graceTimer);
    seat.client = client;
    seat.connected = true;
    client.room = this;
    client.name = seat.name;
    send(client.ws, 'joined', { code: this.code, token: seat.token, seat: i });
    this.sync();
    return true;
  }

  leave(client) {
    const i = this.seatOf(client);
    if (i < 0) return;
    if (this.phase === 'placement' || this.phase === 'battle') {
      this.match.forfeit(i, 'surrendered');
      this.afterMatchChange();
    }
    this.remove(i);
  }

  remove(i) {
    const seat = this.seats[i];
    if (!seat) return;
    clearTimeout(seat.graceTimer);
    if (seat.client) seat.client.room = null;
    this.seats[i] = null;
    if (this.phase === 'lobby') {
      // keep the remaining human in seat 0 so they act as host
      if (!this.seats[0] && this.seats[1] && !this.seats[1].bot) {
        this.seats[0] = this.seats[1];
        this.seats[1] = null;
        if (this.seats[0].client) send(this.seats[0].client.ws, 'joined', { code: this.code, token: this.seats[0].token, seat: 0 });
      }
      this.seats.forEach((s) => s && !s.bot && (s.ready = false));
    }
    if (this.phase === 'over') {
      this.seats.forEach((s) => s && (s.rematch = false));
    }
    if (!this.humans().length) return this.destroy();
    if (this.mode === 'quick' && this.phase === 'lobby') this.mode = 'private';
    this.sync();
  }

  destroy() {
    this.clearDeadline();
    clearTimeout(this.botTimer);
    this.lobby.rooms.delete(this.code);
  }

  // ---- timers & sync --------------------------------------------------------

  setDeadline(seconds, fn) {
    this.clearDeadline();
    this.deadline = Date.now() + seconds * 1000;
    this.timer = setTimeout(() => {
      this.deadline = null;
      fn();
    }, seconds * 1000);
  }

  clearDeadline() {
    clearTimeout(this.timer);
    this.deadline = null;
  }

  error(i, msg) {
    send(this.seats[i]?.client?.ws, 'error', { msg });
  }

  sync() {
    this.seats.forEach((s, i) => {
      if (!s || s.bot || !s.client) return;
      send(s.client.ws, 'sync', {
        room: {
          code: this.code,
          mode: this.mode,
          phase: this.phase,
          mapId: this.mapId,
          you: i,
          deadline: this.deadline,
          now: Date.now(),
          seats: this.seats.map((q) =>
            q
              ? { name: q.name, commander: q.commander, ready: q.ready, connected: q.connected, bot: q.bot || null, rematch: q.rematch }
              : null,
          ),
        },
        match: this.match ? this.match.view(i) : null,
        history: this.match ? this.history : [],
      });
    });
  }
}

export class Lobby {
  constructor() {
    this.rooms = new Map();
    this.queue = [];
  }

  connect(ws) {
    const client = { ws, name: 'ANON', room: null };
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;
      try {
        this.handle(client, msg);
      } catch (e) {
        console.error(e);
        send(ws, 'error', { msg: 'Server fault.' });
      }
    });
    ws.on('close', () => {
      this.queue = this.queue.filter((c) => c !== client);
      client.room?.disconnect(client);
    });
    send(ws, 'hello', { online: this.online() + 1 });
  }

  online() {
    let n = this.queue.length;
    for (const r of this.rooms.values()) n += r.humans().filter((s) => s.connected).length;
    return n;
  }

  createRoom(mode) {
    const code = newCode(this.rooms);
    const room = new Room(this, code, mode);
    this.rooms.set(code, room);
    return room;
  }

  handle(client, msg) {
    const room = client.room;
    const seat = room ? room.seatOf(client) : -1;
    switch (msg.type) {
      case 'name':
        client.name = cleanName(msg.name);
        return;
      case 'resume': {
        const r = this.rooms.get(String(msg.code || '').toUpperCase());
        if (!r || !r.resume(client, String(msg.token || ''))) send(client.ws, 'resumeFailed', {});
        return;
      }
      case 'create': {
        this.leaveAll(client);
        const r = this.createRoom('private');
        r.add(client);
        r.sync();
        return;
      }
      case 'join': {
        const code = String(msg.code || '').toUpperCase().trim();
        const r = this.rooms.get(code);
        if (!r || r.mode === 'bot') return send(client.ws, 'error', { msg: `No room ${code || '????'}.` });
        if (r.full || r.phase !== 'lobby') return send(client.ws, 'error', { msg: `Room ${code} is full.` });
        this.leaveAll(client);
        r.add(client);
        r.sync();
        return;
      }
      case 'quick': {
        this.leaveAll(client);
        this.queue.push(client);
        send(client.ws, 'queued', {});
        if (this.queue.length >= 2) {
          const [a, b] = this.queue.splice(0, 2);
          const r = this.createRoom('quick');
          r.add(a);
          r.add(b);
          r.sync();
        }
        return;
      }
      case 'cancelQuick':
        this.queue = this.queue.filter((c) => c !== client);
        return;
      case 'bot': {
        this.leaveAll(client);
        const diff = DIFFICULTIES.includes(msg.difficulty) ? msg.difficulty : 'veteran';
        const r = this.createRoom('bot');
        r.add(client);
        r.addBot(diff);
        r.sync();
        return;
      }
      case 'leave':
        this.leaveAll(client);
        send(client.ws, 'left', {});
        return;
    }
    if (!room || seat < 0) return;
    switch (msg.type) {
      case 'select':
        return room.select(seat, { commander: msg.commander, mapId: msg.mapId });
      case 'ready':
        return room.setReady(seat, msg.ready);
      case 'place':
        return room.place(seat, msg.placements);
      case 'unplace':
        return room.unplace(seat);
      case 'fire':
        return room.fire(seat, msg.x, msg.y);
      case 'ult':
        return room.ult(seat, msg.x, msg.y, msg.dir);
      case 'rematch':
        return room.rematch(seat);
    }
  }

  leaveAll(client) {
    this.queue = this.queue.filter((c) => c !== client);
    client.room?.leave(client);
    client.room = null;
  }
}
