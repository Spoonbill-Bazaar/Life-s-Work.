import { MAP_DEFS, getMap } from '/shared/maps.js';
import { COMMANDERS, getCommander, DIRS, RULES } from '/shared/commanders.js';
import { ultPattern, shipCells, canPlace, randomPlacements, idxOf } from '/shared/engine.js';
import { Board, C, coord, drawThumb, drawEmblem } from './board.js';
import { sfx, isMuted, setMuted } from './audio.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
const store = {
  get(k, d = null) {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
  sget(k) {
    try {
      return JSON.parse(sessionStorage.getItem(k));
    } catch {
      return null;
    }
  },
  sset(k, v) {
    try {
      v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

// ---------------------------------------------------------------------------
// state

const S = {
  ws: null,
  connected: false,
  room: null,
  match: null,
  history: [],
  skew: 0,
  queued: false,
  difficulty: store.get('bs-diff', 'veteran'),
  name: store.get('bs-name', null) || `OPERATOR-${Math.floor(100 + Math.random() * 900)}`,
  deploy: null,
  ultArmed: false,
  ultDir: 0,
  logged: 0,
  matchKey: null,
  holdUntil: 0,
  hudTimer: null,
  reviewing: false,
  lastTurnSeen: null,
  lastCharge: 0,
};

const boards = {
  deploy: new Board($('#deploy-board'), 'deploy'),
  me: new Board($('#me-board'), 'me'),
  foe: new Board($('#foe-board'), 'foe'),
};

// ---------------------------------------------------------------------------
// network

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => {
    S.connected = true;
    $('#conn').textContent = 'LINK: SECURE';
    send('name', { name: S.name });
    const sess = store.sget('bs-session');
    if (sess) send('resume', sess);
  };
  ws.onclose = () => {
    S.connected = false;
    S.queued = false;
    $('#conn').textContent = 'LINK: LOST — RETRYING';
    renderQueue();
    setTimeout(connect, 1500);
  };
  ws.onmessage = (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    onMessage(m);
  };
}

function send(type, data = {}) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ type, ...data }));
}

function onMessage(m) {
  switch (m.type) {
    case 'hello':
      $('#online').textContent = `${m.online} OPERATOR${m.online === 1 ? '' : 'S'} ONLINE`;
      break;
    case 'joined':
      store.sset('bs-session', { code: m.code, token: m.token });
      S.queued = false;
      renderQueue();
      break;
    case 'resumeFailed':
      store.sset('bs-session', null);
      break;
    case 'left':
      store.sset('bs-session', null);
      S.room = null;
      S.match = null;
      render();
      break;
    case 'queued':
      S.queued = true;
      renderQueue();
      break;
    case 'error':
      toast(m.msg);
      sfx.bad();
      break;
    case 'fx':
      onFx(m.event);
      break;
    case 'sync':
      onSync(m);
      break;
  }
}

function onSync(m) {
  S.room = m.room;
  S.skew = Date.now() - m.room.now;
  const prevPhase = S.match?.phase;
  S.match = m.match;
  S.history = m.history || [];
  const key = m.match ? `${m.room.code}:${m.match.first}:${m.match.mapId}:${m.room.phase === 'lobby' ? 'l' : 'm'}` : null;
  if (m.room.phase === 'placement' && (!S.deploy || S.matchKey !== key)) {
    S.deploy = { placements: {}, sel: null, dir: 'h' };
    S.reviewing = false;
    S.logged = 0;
    $('#log').innerHTML = '';
    logQueue.length = 0;
  }
  S.matchKey = key;
  if (S.match && S.match.phase === 'over' && prevPhase && prevPhase !== 'over') {
    setTimeout(() => (S.match?.winner === S.match?.you ? sfx.win() : sfx.lose()), Math.max(0, S.holdUntil - performance.now()) + 200);
  }
  // write any events we did not see animated (reconnect, late join)
  while (S.logged < S.history.length) logEvent(S.history[S.logged++], 0);
  render();
}

function onFx(ev) {
  if (!S.match) return;
  const mine = ev.by === S.match.you;
  const board = mine ? boards.foe : boards.me;
  const now = performance.now();
  const dur = board.play(ev, now, {
    launch: (t) => sfx.launch(t / 1000),
    impact: (r, t) => (r === 'hit' ? sfx.hit(t / 1000) : sfx.miss(t / 1000)),
    sunk: (t) => sfx.sunk(t / 1000),
    scan: () => sfx.ping(0),
  });
  if (ev.kind === 'scan') ev.cells.filter((c) => c.r === 'contact').forEach((c, i) => sfx.contact(0.5 + i * 0.08));
  S.holdUntil = Math.max(S.holdUntil, now + dur);
  S.logged++;
  logEvent(ev, dur);
}

// ---------------------------------------------------------------------------
// rendering

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
  requestAnimationFrame(() => Object.values(boards).forEach((b) => b.resize()));
}

function render() {
  const r = S.room;
  renderTop();
  if (!r) {
    show('scr-title');
    return;
  }
  if (r.phase === 'lobby') {
    show('scr-brief');
    renderBrief();
  } else if (r.phase === 'placement') {
    show('scr-deploy');
    renderDeploy();
  } else {
    if ($('#scr-battle').classList.contains('hidden')) {
      show('scr-battle');
    }
    renderBattle();
  }
}

function renderTop() {
  const r = S.room;
  const m = S.match;
  const parts = [];
  if (r) {
    parts.push(r.mode === 'bot' ? 'TRAINING' : `ROOM ${r.code}`);
    parts.push(getMap(r.mapId).name);
    if (m && m.phase !== 'placement') parts.push(`ROUND ${String(m.round).padStart(2, '0')}`);
  } else parts.push('STANDBY');
  $('#status').textContent = '// ' + parts.join(' · ');
  const d = $('#defcon');
  if (m && (m.phase === 'battle' || m.phase === 'over')) {
    const sunk = [m.me.ships, m.foe.ships].map((ss) => ss.filter((s) => s.sunk).length);
    const total = sunk[0] + sunk[1];
    const left = Math.min(...[m.me.ships, m.foe.ships].map((ss) => ss.filter((s) => !s.sunk).length));
    const level = left <= 1 ? 1 : total >= 5 ? 2 : total >= 3 ? 3 : total >= 1 ? 4 : 5;
    d.textContent = `DEFCON ${level}`;
    d.style.color = ['', C.foe, '#ff7a45', C.amber, C.coast, C.coast][level];
    d.classList.remove('hidden');
  } else d.classList.add('hidden');
}

// ---- title ------------------------------------------------------------------

function renderQueue() {
  $('#queue-state').textContent = S.queued ? 'SEARCHING… [CANCEL]' : '';
}

function initTitle() {
  const input = $('#callsign');
  input.value = S.name;
  input.addEventListener('change', () => {
    S.name = input.value.toUpperCase().replace(/[^A-Z0-9 _\-.]/g, '').slice(0, 16) || S.name;
    input.value = S.name;
    store.set('bs-name', S.name);
    send('name', { name: S.name });
  });
  for (const b of document.querySelectorAll('#difficulty button')) {
    b.classList.toggle('on', b.dataset.diff === S.difficulty);
    b.addEventListener('click', () => {
      S.difficulty = b.dataset.diff;
      store.set('bs-diff', S.difficulty);
      document.querySelectorAll('#difficulty button').forEach((q) => q.classList.toggle('on', q === b));
      sfx.click();
    });
  }
  $('#join-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') act('join');
  });
  for (const b of document.querySelectorAll('.menu [data-act]')) b.addEventListener('click', () => act(b.dataset.act));
  const params = new URLSearchParams(location.search);
  if (params.get('room')) $('#join-code').value = params.get('room').toUpperCase();
}

function act(a) {
  sfx.unlock();
  sfx.click();
  if (!S.connected && a !== 'howto') return toast('No uplink. Retrying…');
  switch (a) {
    case 'quick':
      if (S.queued) {
        send('cancelQuick');
        S.queued = false;
        renderQueue();
      } else send('quick');
      break;
    case 'create':
      send('create');
      break;
    case 'join': {
      const code = $('#join-code').value.trim().toUpperCase();
      if (code.length !== 4) return toast('Room codes are 4 letters.');
      send('join', { code });
      break;
    }
    case 'bot':
      send('bot', { difficulty: S.difficulty });
      break;
    case 'howto':
      $('#howto').classList.toggle('hidden');
      break;
  }
}

// decorative radar on the title screen
function titleRadar(now) {
  const c = $('#title-radar');
  if ($('#scr-title').classList.contains('hidden')) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  const W = c.clientWidth;
  const H = c.clientHeight;
  if (c.width !== W * dpr || c.height !== H * dpr) {
    c.width = W * dpr;
    c.height = H * dpr;
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.hypot(W, H) / 2;
  ctx.strokeStyle = 'rgba(72,214,232,0.07)';
  ctx.lineWidth = 1;
  for (let r = 80; r < R; r += 80) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(0, cy);
  ctx.lineTo(W, cy);
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, H);
  ctx.stroke();
  const a = (now / 4000) * Math.PI * 2;
  if (ctx.createConicGradient) {
    const g = ctx.createConicGradient(a, cx, cy);
    g.addColorStop(0, 'rgba(72,214,232,0.16)');
    g.addColorStop(0.1, 'rgba(72,214,232,0)');
    g.addColorStop(1, 'rgba(72,214,232,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  titleRadar.blips ||= Array.from({ length: 9 }, () => ({ a: Math.random() * Math.PI * 2, r: 120 + Math.random() * (R - 160), foe: Math.random() < 0.5 }));
  for (const b of titleRadar.blips) {
    let since = (a - b.a) % (Math.PI * 2);
    if (since < 0) since += Math.PI * 2;
    const alpha = Math.max(0, 1 - since / 3);
    if (alpha <= 0) continue;
    ctx.fillStyle = b.foe ? `rgba(255,77,77,${alpha})` : `rgba(109,252,176,${alpha})`;
    const x = cx + Math.cos(b.a) * b.r;
    const y = cy + Math.sin(b.a) * b.r;
    ctx.fillRect(x - 2, y - 2, 4, 4);
  }
}

// ---- briefing -----------------------------------------------------------------

let briefBuilt = false;
function buildBrief() {
  const ml = $('#map-list');
  for (const d of MAP_DEFS) {
    const b = el('button', 'map-card');
    b.dataset.id = d.id;
    b.append(el('canvas'), el('span', 'nm', d.name));
    b.addEventListener('click', () => {
      if (S.room?.you !== 0 || S.room.mode === 'quick') return;
      sfx.click();
      send('select', { mapId: d.id });
    });
    ml.append(b);
  }
  ml.after(el('div', 'map-blurb'));
  const cl = $('#cmd-list');
  for (const c of COMMANDERS) {
    const b = el('button', 'cmd');
    b.dataset.id = c.id;
    const cv = el('canvas');
    b.append(
      cv,
      el('span', 'nm', c.name),
      el('span', 'role', c.role),
      el('span', 'role', `ULT: <span style="color:${C.amber}">${c.ult.name}</span> · ${c.ult.cost} CHG`),
      el('span', 'ult', c.ult.desc),
      el('span', 'q', `"${c.quote}"`),
    );
    b.addEventListener('click', () => {
      sfx.click();
      send('select', { commander: c.id });
    });
    cl.append(b);
  }
  $('#btn-ready').addEventListener('click', () => {
    sfx.click();
    const me = S.room.seats[S.room.you];
    send('ready', { ready: !me.ready });
  });
  $('#btn-leave-brief').addEventListener('click', leave);
  briefBuilt = true;
}

function renderBrief() {
  if (!briefBuilt) buildBrief();
  const r = S.room;
  const me = r.seats[r.you];
  const foe = r.seats[1 - r.you];
  const canPickMap = r.you === 0 && r.mode !== 'quick';
  $('#map-note').textContent = r.mode === 'quick' ? 'RANDOM DRAW' : canPickMap ? 'HOST PICKS' : 'HOST PICKS';
  for (const b of document.querySelectorAll('.map-card')) {
    b.classList.toggle('on', b.dataset.id === r.mapId);
    b.classList.toggle('locked', !canPickMap);
    b.disabled = !canPickMap && b.dataset.id !== r.mapId;
  }
  const m = getMap(r.mapId);
  document.querySelector('.map-blurb').textContent = `${m.name} — ${m.blurb} ${m.water} open cells.`;
  requestAnimationFrame(() => {
    for (const b of document.querySelectorAll('.map-card')) {
      const on = b.dataset.id === r.mapId;
      drawThumb(b.querySelector('canvas'), getMap(b.dataset.id), on ? C.amber : C.coast);
    }
  });
  for (const b of document.querySelectorAll('.cmd')) {
    const c = getCommander(b.dataset.id);
    b.classList.toggle('on', me?.commander === c.id);
    b.classList.toggle('foepick', foe?.commander === c.id && r.mode !== 'bot');
    drawEmblem(b.querySelector('canvas'), c.id, me?.commander === c.id ? C.me : c.color);
  }
  $('#room-code').textContent = r.mode === 'bot' ? '' : r.code;
  $('#room-hint').textContent =
    r.mode === 'bot'
      ? `Training against ${foe?.name}. The AI picks its commander in secret.`
      : foe
        ? 'Both operators ready up to deploy.'
        : `Share code ${r.code} — or link: ${location.origin}/?room=${r.code}`;
  const sl = $('#seat-list');
  sl.innerHTML = '';
  r.seats.forEach((s, i) => {
    if (!s) {
      sl.append(el('div', 'seat empty', '<span>AWAITING OPERATOR…</span>'));
      return;
    }
    const d = el('div', `seat${s.ready ? ' ready' : ''}`);
    const cmd = s.commander && (i === r.you || r.mode !== 'bot') ? getCommander(s.commander).name : s.bot ? 'CLASSIFIED' : '—';
    d.append(
      el('div', 'nm', `<span style="color:${i === r.you ? C.me : C.foe}">${s.name}${i === r.you ? ' (YOU)' : ''}</span><span class="dim">${i === 0 ? 'HOST' : ''}${s.bot ? ` AI/${s.bot.toUpperCase()}` : ''}</span>`),
      el('div', 'st', `${cmd} · ${s.ready ? 'READY' : 'NOT READY'}${s.connected ? '' : ' · LINK LOST'}`),
    );
    sl.append(d);
  });
  const btn = $('#btn-ready');
  btn.textContent = me.ready ? 'STAND DOWN' : 'READY';
  btn.disabled = !me.commander;
}

function leave() {
  sfx.click();
  if (S.room && (S.room.phase === 'battle' || S.room.phase === 'placement') && S.match?.phase !== 'over') {
    if (!confirm('Surrender this engagement?')) return;
  }
  send('leave');
  store.sset('bs-session', null);
  S.room = null;
  S.match = null;
  $('#over').classList.add('hidden');
  render();
}

// ---- deployment ---------------------------------------------------------------

function deployMap() {
  return getMap(S.match.mapId);
}

function placedShips() {
  const map = deployMap();
  return map.fleet
    .filter((s) => S.deploy.placements[s.id])
    .map((s) => ({ ...s, ...S.deploy.placements[s.id] }));
}

function occupiedExcept(id) {
  const map = deployMap();
  const occ = new Set();
  for (const s of placedShips()) if (s.id !== id) for (const c of shipCells(s)) occ.add(idxOf(map, c.x, c.y));
  return occ;
}

function initDeploy() {
  const b = boards.deploy;
  b.interactive = true;
  b.on('hover', () => updateDeployPreview());
  b.on('rotate', () => rotateDeploy());
  b.on('click', (cell) => {
    const d = S.deploy;
    if (!d || S.match.me.ready) return;
    const map = deployMap();
    if (d.sel) {
      const spec = map.fleet.find((s) => s.id === d.sel);
      const p = anchor(cell, spec.len, d.dir);
      if (canPlace(map, occupiedExcept(spec.id), p.x, p.y, spec.len, d.dir)) {
        d.placements[spec.id] = { x: p.x, y: p.y, dir: d.dir };
        sfx.place();
        d.sel = map.fleet.find((s) => !d.placements[s.id])?.id || null;
      } else sfx.bad();
    } else {
      const hit = placedShips().find((s) => shipCells(s).some((c) => c.x === cell.x && c.y === cell.y));
      if (hit) {
        delete d.placements[hit.id];
        d.sel = hit.id;
        d.dir = hit.dir;
        sfx.click();
      }
    }
    renderDeploy();
  });
  $('#btn-rotate').addEventListener('click', rotateDeploy);
  $('#btn-random').addEventListener('click', () => {
    const map = deployMap();
    for (const p of randomPlacements(map)) S.deploy.placements[p.id] = { x: p.x, y: p.y, dir: p.dir };
    S.deploy.sel = null;
    sfx.place();
    renderDeploy();
  });
  $('#btn-clear').addEventListener('click', () => {
    S.deploy.placements = {};
    S.deploy.sel = deployMap().fleet[0].id;
    sfx.click();
    renderDeploy();
  });
  $('#btn-confirm').addEventListener('click', () => {
    sfx.click();
    if (S.match.me.ready) return send('unplace');
    const list = deployMap().fleet.map((s) => ({ id: s.id, ...S.deploy.placements[s.id] }));
    send('place', { placements: list });
  });
}

// Centre the hull on the cursor so long ships feel natural to place.
function anchor(cell, len, dir) {
  const back = Math.floor((len - 1) / 2);
  return dir === 'h' ? { x: cell.x - back, y: cell.y } : { x: cell.x, y: cell.y - back };
}

function rotateDeploy() {
  if (!S.deploy) return;
  S.deploy.dir = S.deploy.dir === 'h' ? 'v' : 'h';
  sfx.click();
  updateDeployPreview();
}

function updateDeployPreview() {
  const b = boards.deploy;
  const d = S.deploy;
  if (!d || !d.sel || !b.hover || S.match?.me.ready) {
    b.preview = null;
    return;
  }
  const map = deployMap();
  const spec = map.fleet.find((s) => s.id === d.sel);
  const p = anchor(b.hover, spec.len, d.dir);
  const ok = canPlace(map, occupiedExcept(spec.id), p.x, p.y, spec.len, d.dir);
  const ship = { ...spec, x: p.x, y: p.y, dir: d.dir };
  b.preview = { cells: [], ok, ship, color: C.me };
}

function renderDeploy() {
  const m = S.match;
  const map = deployMap();
  const d = S.deploy;
  if (boards.deploy.map !== map) boards.deploy.setMap(map);
  if (m.me.ready && m.me.ships) {
    for (const s of m.me.ships) d.placements[s.id] = { x: s.x, y: s.y, dir: s.dir };
  }
  if (!d.sel && !m.me.ready) d.sel = map.fleet.find((s) => !d.placements[s.id])?.id || null;
  boards.deploy.ships = placedShips();
  boards.deploy.interactive = !m.me.ready;
  updateDeployPreview();
  $('#deploy-map').textContent = `${map.name} · vs ${getCommander(m.foe.commander).name}`;
  const fl = $('#fleet-list');
  fl.innerHTML = '';
  for (const s of map.fleet) {
    const b = el('button', 'fleet-item');
    if (d.placements[s.id]) b.classList.add('placed');
    if (d.sel === s.id) b.classList.add('sel');
    const bar = el('span', 'bar', '<i></i>'.repeat(s.len));
    b.append(el('span', '', s.name), bar);
    b.disabled = m.me.ready;
    b.addEventListener('click', () => {
      sfx.click();
      if (d.placements[s.id]) {
        d.dir = d.placements[s.id].dir;
        delete d.placements[s.id];
      }
      d.sel = s.id;
      renderDeploy();
    });
    fl.append(b);
  }
  const all = map.fleet.every((s) => d.placements[s.id]);
  const btn = $('#btn-confirm');
  btn.textContent = m.me.ready ? 'EDIT DEPLOYMENT' : 'CONFIRM DEPLOYMENT';
  btn.disabled = !m.me.ready && !all;
  for (const id of ['#btn-rotate', '#btn-random', '#btn-clear']) $(id).disabled = m.me.ready;
  $('#deploy-wait').textContent = m.me.ready
    ? m.foe.ready
      ? 'Both fleets deployed.'
      : 'Fleet locked. Waiting for the enemy to deploy…'
    : m.foe.ready
      ? 'Enemy fleet is in position.'
      : '';
}

// ---- battle -------------------------------------------------------------------

function initBattle() {
  const f = boards.foe;
  f.on('hover', () => updateFoePreview());
  f.on('rotate', () => rotateUlt());
  f.on('click', (cell) => {
    const m = S.match;
    if (!m || m.phase !== 'battle' || m.turn !== m.you) return;
    if (S.ultArmed) {
      send('ult', { x: cell.x, y: cell.y, dir: S.ultDir });
      S.ultArmed = false;
      f.preview = null;
      renderBattle();
      return;
    }
    const k = idxOf(f.map, cell.x, cell.y);
    if (f.shots.has(k)) return sfx.bad();
    send('fire', { x: cell.x, y: cell.y });
  });
  $('#btn-rematch').addEventListener('click', () => {
    sfx.click();
    send('rematch');
  });
  $('#btn-exit').addEventListener('click', leave);
  $('#btn-review').addEventListener('click', () => {
    S.reviewing = true;
    $('#over').classList.add('hidden');
    renderBattle();
  });
}

function rotateUlt() {
  if (!S.ultArmed) return;
  const u = getCommander(S.match.me.commander).ult;
  S.ultDir = (S.ultDir + 1) % (u.directions || 2);
  sfx.click();
  updateFoePreview();
  renderUltBox();
}

function canUlt() {
  const m = S.match;
  if (!m || m.phase !== 'battle' || m.turn !== m.you || m.ultUsed) return false;
  return m.me.charge >= getCommander(m.me.commander).ult.cost;
}

function toggleUlt(force) {
  const want = force ?? !S.ultArmed;
  if (want && !canUlt()) return sfx.bad();
  S.ultArmed = want;
  sfx.click();
  updateFoePreview();
  renderUltBox();
}

function updateFoePreview() {
  const f = boards.foe;
  const m = S.match;
  if (!m || !f.map || !f.hover || !S.ultArmed) {
    f.preview = null;
    return;
  }
  const u = getCommander(m.me.commander).ult;
  const { x, y } = f.hover;
  const cells = ultPattern(f.map, u.id, x, y, S.ultDir);
  const p = { cells, ok: true, color: C.amber };
  if (u.id === 'torpedo') p.arrow = { x, y, dx: DIRS[S.ultDir].dx, dy: DIRS[S.ultDir].dy };
  if (u.id === 'homing') p.cells = cells;
  f.preview = p;
}

function fleetPips(ships) {
  return ships.map((s) => `<span class="${s.sunk ? 'sunk' : ''}" title="${s.name}">${'<i></i>'.repeat(s.len)}</span>`).join('');
}

function renderBattle() {
  const m = S.match;
  const r = S.room;
  if (!m) return;
  const map = getMap(m.mapId);
  if (boards.me.map !== map) boards.me.setMap(map);
  if (boards.foe.map !== map) boards.foe.setMap(map);
  boards.me.setKnowledge(m.myBoard);
  boards.me.ships = m.me.ships || [];
  boards.foe.setKnowledge(m.foeBoard);
  boards.foe.ships = m.foe.ships.filter((s) => s.x !== undefined);
  const myTurn = m.phase === 'battle' && m.turn === m.you;
  boards.foe.interactive = myTurn;
  if (!myTurn) S.ultArmed = false;
  updateFoePreview();

  // defer HUD numbers until the current animation lands
  const wait = S.holdUntil - performance.now();
  clearTimeout(S.hudTimer);
  if (wait > 0) {
    S.hudTimer = setTimeout(renderHud, wait);
  } else renderHud();
}

function renderHud() {
  const m = S.match;
  const r = S.room;
  if (!m || !r) return;
  renderTop();
  const meSeat = r.seats[m.you];
  const foeSeat = r.seats[1 - m.you];
  const mc = getCommander(m.me.commander);
  const fc = getCommander(m.foe.commander);
  const myTurn = m.phase === 'battle' && m.turn === m.you;
  $('#me-who').innerHTML = `<span class="nm">${meSeat?.name || 'YOU'}</span><span class="role">${mc.name} · ${mc.role}</span>${myTurn ? '<span class="turnflag" style="color:var(--me)">YOUR TURN</span>' : ''}`;
  $('#foe-who').innerHTML = `<span class="nm">${foeSeat?.name || 'ENEMY'}</span><span class="role">${fc.name} · ${fc.role}${foeSeat && !foeSeat.connected ? ' · <span class="hot">LINK LOST</span>' : ''}</span>${m.phase === 'battle' && !myTurn ? '<span class="turnflag" style="color:var(--foe)">ENGAGING</span>' : ''}`;
  $('#me-fleet').innerHTML = fleetPips(m.me.ships || []);
  $('#foe-fleet').innerHTML = fleetPips(m.foe.ships);
  renderUltBox();
  // foe ult box
  const fu = fc.ult;
  const fb = $('#foe-ult');
  fb.innerHTML = '';
  fb.append(
    el('span', 'uname', `<span class="dim">ENEMY ULT</span> ${fu.name}`),
    el('span', 'dim', `${m.foe.charge}/${fu.cost}`),
    meter(m.foe.charge, fu.cost),
    el('span', 'udesc', fu.desc),
  );
  fb.classList.toggle('full', m.foe.charge >= fu.cost);

  // turn line
  const tl = $('#turnline');
  tl.innerHTML = '';
  if (m.phase === 'battle') {
    tl.append(
      el('span', myTurn ? 'you' : 'them', myTurn ? (m.ultUsed ? '▶ ULTIMATE SPENT — FIRE TO END TURN' : '▶ YOUR TURN — FIRE ONE SHOT') : `◀ ${foeSeat?.name || 'ENEMY'} IS TARGETING YOU`),
      el('span', 'timer', ''),
    );
  } else if (m.phase === 'over') {
    tl.append(el('span', m.winner === m.you ? 'you' : 'them', m.winner === m.you ? 'ENGAGEMENT WON' : 'ENGAGEMENT LOST'));
  }
  const surrender = el('button', 'ghost', m.phase === 'over' ? 'EXIT' : 'SURRENDER');
  surrender.style.marginLeft = 'auto';
  surrender.style.padding = '0 6px';
  surrender.addEventListener('click', leave);
  if (m.phase === 'over' && S.reviewing) {
    const back = el('button', 'ghost', 'RESULTS');
    back.style.padding = '0 6px';
    back.addEventListener('click', () => {
      S.reviewing = false;
      renderHud();
    });
    tl.append(back);
  }
  tl.append(surrender);

  if (myTurn && S.lastTurnSeen !== m.turnNo) sfx.yourTurn();
  S.lastTurnSeen = myTurn ? m.turnNo : null;

  renderOver();
}

function meter(charge, cost) {
  const d = el('div', 'meter');
  for (let i = 0; i < cost; i++) d.append(el('i', i < charge ? 'on' : ''));
  return d;
}

function renderUltBox() {
  const m = S.match;
  if (!m) return;
  const u = getCommander(m.me.commander).ult;
  const box = $('#me-ult');
  box.innerHTML = '';
  const ready = m.me.charge >= u.cost;
  if (ready && S.lastCharge < u.cost) sfx.charged();
  S.lastCharge = m.me.charge;
  const ctl = el('div', 'uctl');
  const arm = el('button', S.ultArmed ? 'armed' : '', S.ultArmed ? 'CANCEL [Esc]' : `ARM [Q]`);
  arm.disabled = !canUlt() && !S.ultArmed;
  arm.addEventListener('click', () => toggleUlt());
  ctl.append(arm);
  if (S.ultArmed && u.rotatable) {
    const rot = el('button', '', `ROTATE [R] ${u.id === 'torpedo' ? '→↓←↑'[S.ultDir] : S.ultDir ? '↕' : '↔'}`);
    rot.addEventListener('click', rotateUlt);
    ctl.append(rot);
  }
  box.append(
    el('span', 'uname', `${u.name} <span class="dim">${m.me.charge}/${u.cost}</span>`),
    ctl,
    meter(m.me.charge, u.cost),
    el('span', 'udesc', `${u.desc} <span style="color:var(--amber)">+${RULES.UBI_PER_TURN}/turn · +${RULES.CHARGE_PER_HIT_TAKEN}/hit taken · +${RULES.CHARGE_PER_SINK_TAKEN} per ship lost</span>`),
  );
  box.classList.toggle('full', ready);
}

function renderOver() {
  const m = S.match;
  const r = S.room;
  const o = $('#over');
  if (!m || m.phase !== 'over' || S.reviewing) {
    o.classList.add('hidden');
    return;
  }
  o.classList.remove('hidden');
  const win = m.winner === m.you;
  const t = $('#over-title');
  t.textContent = win ? 'VICTORY' : 'DEFEAT';
  t.className = `over-title ${win ? 'win' : 'lose'}`;
  const reasons = {
    'fleet destroyed': win ? 'ENEMY FLEET DESTROYED' : 'YOUR FLEET WAS DESTROYED',
    disconnected: win ? 'ENEMY LOST UPLINK' : 'UPLINK LOST',
    surrendered: win ? 'ENEMY SURRENDERED' : 'YOU SURRENDERED',
  };
  $('#over-sub').textContent = `${reasons[m.endReason] || ''} · ROUND ${m.round}`;
  const st = $('#over-stats');
  const row = (label, a, b) => `<span>${label}</span><span style="color:var(--me)">${a}</span><span style="color:var(--foe)">${b}</span>`;
  const acc = (s) => (s.shots ? `${Math.round((s.hits / Math.max(1, s.shots + s.ults)) * 100)}%` : '—');
  st.innerHTML =
    `<span class="h"></span><span class="h">YOU</span><span class="h">ENEMY</span>` +
    row('SHOTS FIRED', m.me.stats.shots, m.foe.stats.shots) +
    row('HULL HITS', m.me.stats.hits, m.foe.stats.hits) +
    row('HITS PER ACTION', acc(m.me.stats), acc(m.foe.stats)) +
    row('ULTIMATES', m.me.stats.ults, m.foe.stats.ults) +
    row('CHARGE FROM DAMAGE', m.me.stats.chargeFromDamage, m.foe.stats.chargeFromDamage);
  const foeSeat = r.seats[1 - m.you];
  const meSeat = r.seats[m.you];
  const btn = $('#btn-rematch');
  btn.disabled = !foeSeat || meSeat?.rematch;
  btn.textContent = !foeSeat ? 'ENEMY LEFT' : meSeat?.rematch ? 'WAITING FOR ENEMY…' : foeSeat.rematch && !foeSeat.bot ? 'ACCEPT REMATCH' : 'REMATCH';
}

// ---- log ----------------------------------------------------------------------

const ULT_NAMES = Object.fromEntries(COMMANDERS.map((c) => [c.ult.id, c.ult.name]));

function logEvent(ev, delay) {
  const m = S.match;
  if (!m) return;
  const mine = ev.by === m.you;
  const who = mine ? 'YOU' : S.room?.seats[ev.by]?.name || 'ENEMY';
  const hits = ev.cells.filter((c) => c.r === 'hit').length;
  const misses = ev.cells.filter((c) => c.r === 'miss').length;
  let what = '';
  switch (ev.kind) {
    case 'shot':
      what = `SHOT ${coord(ev.x, ev.y)} — ${hits ? '<span class="hit">HIT</span>' : 'MISS'}`;
      break;
    case 'airstrike':
    case 'bombard':
      what = `<span class="amber">${ULT_NAMES[ev.kind]}</span> ${coord(ev.x, ev.y)}${ev.kind === 'airstrike' ? (ev.dir % 2 ? ' ↕' : ' ↔') : ''} — ${hits ? `<span class="hit">${hits} HIT</span> · ` : ''}${misses} MISS`;
      break;
    case 'torpedo': {
      const h = ev.cells.find((c) => c.r === 'hit');
      what = `<span class="amber">TORPEDO RUN</span> ${coord(ev.x, ev.y)} ${'→↓←↑'[ev.dir]} — ${h ? `<span class="hit">HIT ${coord(h.x, h.y)}</span>` : 'NO CONTACT'} · ${misses} CLEARED`;
      break;
    }
    case 'scan': {
      const n = ev.cells.filter((c) => c.r === 'contact').length;
      what = `<span class="amber">DEEP SCAN</span> ${coord(ev.x, ev.y)} — ${n} CONTACT${n === 1 ? '' : 'S'}`;
      break;
    }
    case 'homing': {
      const c = ev.cells[0];
      what = `<span class="amber">HUNTER-KILLER</span> ${coord(ev.x, ev.y)} — ${ev.lock ? `LOCK ${coord(ev.lock.x, ev.lock.y)} <span class="hit">HIT</span>` : c ? 'NO LOCK · MISS' : 'NO LOCK'}`;
      break;
    }
  }
  for (const s of ev.sunk) what += ` · <span class="hit">${mine ? 'ENEMY ' : ''}${s.name} DESTROYED</span>`;
  if (ev.chargeGained && !mine) what += ` · <span class="amber">+${ev.chargeGained} CHG</span>`;
  const line = el('div', '', `<span class="t">T${String(ev.turnNo ?? m.turnNo).padStart(2, '0')}</span><span class="${mine ? 'me' : 'foe'}">${who}</span> ▸ ${what}`);
  // queue keeps lines in order even when animations differ in length
  const at = Math.max(logQueue.at(-1)?.at ?? 0, performance.now() + Math.min(delay, 1500));
  logQueue.push({ line, at });
  flushLog(performance.now());
}

const logQueue = [];
function flushLog(now) {
  const log = $('#log');
  let wrote = false;
  while (logQueue.length && logQueue[0].at <= now) {
    log.append(logQueue.shift().line);
    wrote = true;
  }
  if (!wrote) return;
  while (log.children.length > 200) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

// ---- misc ---------------------------------------------------------------------

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function initGlobal() {
  const mute = $('#mute');
  const paint = () => (mute.textContent = isMuted() ? 'SND:OFF' : 'SND:ON');
  paint();
  mute.addEventListener('click', () => {
    setMuted(!isMuted());
    paint();
  });
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (k === 'm') {
      setMuted(!isMuted());
      paint();
    } else if (k === 'r') {
      if (S.room?.phase === 'placement') rotateDeploy();
      else rotateUlt();
    } else if (k === 'q' && S.room?.phase === 'battle') toggleUlt();
    else if (k === 'escape') {
      if (S.ultArmed) toggleUlt(false);
      if (S.deploy) S.deploy.sel = null, S.room?.phase === 'placement' && renderDeploy();
    }
  });
  window.addEventListener('pointerdown', () => sfx.unlock(), { once: true });
  const ro = new ResizeObserver(() => Object.values(boards).forEach((b) => b.resize()));
  for (const b of Object.values(boards)) ro.observe(b.canvas);
  window.addEventListener('resize', () => {
    if (S.room?.phase === 'lobby') renderBrief();
  });
}

function frame(now) {
  for (const b of Object.values(boards)) if (!b.canvas.closest('.screen').classList.contains('hidden')) b.draw(now);
  titleRadar(now);
  flushLog(now);
  // timers
  const r = S.room;
  if (r && r.deadline) {
    const left = Math.max(0, Math.ceil((r.deadline + S.skew - Date.now()) / 1000));
    const txt = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
    const t = r.phase === 'placement' ? $('#deploy-timer') : document.querySelector('#turnline .timer');
    if (t && t.textContent !== txt) {
      t.textContent = txt;
      t.style.color = left <= 10 ? C.foe : '';
    }
  } else {
    const t = document.querySelector('#turnline .timer');
    if (t) t.textContent = '';
    $('#deploy-timer').textContent = '';
  }
  requestAnimationFrame(frame);
}

if (location.search.includes('debug')) window.__bs = { S, boards };

initTitle();
initDeploy();
initBattle();
initGlobal();
render();
connect();
requestAnimationFrame(frame);
