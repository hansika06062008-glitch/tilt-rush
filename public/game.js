(() => {
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const COLORS = ['#FF7A1A', '#2EE6A6', '#FF4D8D', '#4DA3FF'];

/* ============ tuning ============ */
const BASE_SPEED = 320;        // px per second
const MAX_SPEED = 900;
const SPEED_UP = 9;            // px/s gained every second
const STEER_RATE = 1.05;       // road-widths per second at full tilt
const JUMP_TIME = 0.75;        // seconds in the air
const LIVES = 3;
const LANES = 5;
const SIZE = { car: [0.075, 0.14], cone: [0.05, 0.055], barrier: [0.16, 0.045], oil: [0.1, 0.07], truck: [0.12, 0.3], coin: [0.045, 0.045] };
const JUMPABLE = new Set(['cone', 'barrier', 'oil']);

/* ============ canvas ============ */
const canvas = $('#road'), ctx = canvas.getContext('2d');
let W = 0, H = 0;
function resize() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  W = innerWidth; H = innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize);
resize();
const road = () => { const rw = Math.min(W * 0.62, H * 0.95, 760); return { rw, left: (W - rw) / 2 }; };

/* ============ state ============ */
const G = {
  code: null, state: 'lobby', players: new Map(), obstacles: [], particles: [], texts: [],
  speed: BASE_SPEED, dist: 0, spawnIn: 1, shake: 0, scroll: 0,
};
const racers = () => [...G.players.values()].filter(p => p.inRace);

/* ============ networking ============ */
const socket = io({ transports: ['websocket'], reconnectionDelayMax: 2000 });
function net(kind, text) { $('#net .dot').className = 'dot ' + kind; $('#netText').textContent = text; }

socket.on('connect', () => {
  net('on', 'Online');
  const saved = JSON.parse(sessionStorage.getItem('tr:host') || 'null');
  socket.emit('game:create', saved || {}, res => {
    if (G.code && G.code !== res.code) G.players.forEach((p, id) => { if (!p.kb) G.players.delete(id); });
    G.code = res.code;
    sessionStorage.setItem('tr:host', JSON.stringify({ code: res.code, token: res.token }));
    const ids = new Set(res.players.map(p => p.id));
    G.players.forEach((p, id) => { if (!p.kb && !ids.has(id)) G.players.delete(id); });
    res.players.forEach(addPlayer);
    showJoinInfo();
    renderLobby();
  });
});
socket.on('disconnect', () => net('off', 'Reconnecting…'));
socket.on('game:replaced', () => { net('off', 'Opened in another tab'); socket.disconnect(); });

function addPlayer(info) {
  let p = G.players.get(info.id);
  if (!p) {
    p = { id: info.id, steer: 0, x: 0.5, vx: 0, jumpT: 0, boost: false, energy: 1, score: 0, lives: LIVES, inv: 0, out: false,
      inRace: false, rtt: null, lastSeq: -1, jumpCount: null, spinT: 0, yOff: 0, kb: false, lastInput: 0 };
    G.players.set(p.id, p);
  }
  Object.assign(p, { name: info.name, color: info.color, online: info.online });
  p.lastSeq = -1;
  p.jumpCount = null;
  return p;
}
socket.on('player:join', info => {
  const isNew = !G.players.has(info.id);
  const p = addPlayer(info);
  floatText(W / 2, 120, isNew ? `${p.name} joined! 🎉` : `${p.name} is back!`, p.color);
  renderLobby();
});
socket.on('player:status', ({ id, online }) => { const p = G.players.get(id); if (p) { p.online = online; renderLobby(); } });
socket.on('player:leave', ({ id }) => {
  const p = G.players.get(id);
  if (!p) return;
  if (p.inRace && !p.out) { p.out = true; p.lives = 0; }
  G.players.delete(id);
  renderLobby();
});

// Sensor input from phones: [pid, seq, steer*100, jumpCount, boost, rttMs]
socket.on('i', d => {
  const p = G.players.get(d[0]);
  if (!p) return;
  if (d[1] <= p.lastSeq) return;                  // drop late / out-of-order packets
  p.lastSeq = d[1];
  p.steer = Math.max(-1, Math.min(1, d[2] / 100));
  if (p.jumpCount === null) p.jumpCount = d[3];
  else if (d[3] > p.jumpCount) { p.jumpCount = d[3]; tryJump(p); }
  p.boost = !!d[4];
  if (d[5] > 0) p.rtt = d[5];
  p.lastInput = performance.now();
  p.online = true;
  if (d[1] % 6 === 0) socket.volatile.emit('ack', [p.id, d[1]]);  // ~10 acks/s for latency display
});
socket.on('ctrl:action', ({ pid, type }) => {
  const p = G.players.get(pid);
  if ((type === 'start' || type === 'restart') && (G.state === 'lobby' || G.state === 'over')) startRace();
  if (type === 'calibrated' && p) floatText(W / 2, 150, `${p.name} calibrated ✓`, p.color);
});
function buzz(p, pattern) { if (p && !p.kb && p.online) socket.emit('buzz', { pid: p.id, pattern }); }

/* ============ lobby ============ */
async function showJoinInfo() {
  let origin = location.origin;
  if (['localhost', '127.0.0.1'].includes(location.hostname)) {
    try { const info = await fetch('/api/info').then(r => r.json()); if (info.lanOrigin) origin = info.lanOrigin; } catch {}
  }
  const url = `${origin}/play?room=${G.code}`;
  $('#roomCode').textContent = G.code;
  $('#joinUrl').textContent = `${origin.replace(/^https?:\/\//, '')}/play`;
  $('#qr').src = '/qr.svg?text=' + encodeURIComponent(url);
  const note = $('#httpsNote');
  if (origin.startsWith('http:')) {
    note.hidden = false;
    note.textContent = 'Phones only share motion sensors on https. Run "npm run lan" or use the deployed link.';
  } else if (/^https:\/\/\d+\.\d+\.\d+\.\d+/.test(origin)) {
    note.hidden = false;
    note.textContent = 'First time on a phone? Tap "Advanced" then "Proceed" on the security warning.';
  } else note.hidden = true;
}
function renderLobby() {
  const list = [...G.players.values()];
  $('#slots').innerHTML = Array.from({ length: 4 }, (_, i) => {
    const p = list[i];
    if (!p) return `<li class="slot">Player ${i + 1}<br><small>scan to join</small></li>`;
    return `<li class="slot filled" style="--c:${esc(p.color)}">
      <span class="sname">${esc(p.name)}</span>
      <span class="sstat">${p.kb ? 'Arrows + Space + Shift' : p.online ? (p.rtt ? `Ready! ${Math.round(p.rtt / 2)} ms` : 'Ready!') : 'Phone offline…'}</span>
      <button class="kick" data-kick="${esc(p.id)}">remove</button></li>`;
  }).join('');
  const ready = list.filter(p => p.online).length;
  const btn = $('#startBtn');
  btn.disabled = ready === 0;
  btn.textContent = ready ? `Start race! (${ready} ${ready === 1 ? 'player' : 'players'})` : 'Waiting for players…';
  $('#kbBtn').hidden = list.some(p => p.kb) || list.length >= 4;
}
$('#slots').addEventListener('click', e => {
  const b = e.target.closest('[data-kick]');
  if (!b) return;
  const p = G.players.get(b.dataset.kick);
  if (p && p.kb) G.players.delete(p.id); else socket.emit('game:kick', { pid: b.dataset.kick });
  renderLobby();
});
$('#startBtn').onclick = () => startRace();
$('#againBtn').onclick = () => startRace();
$('#kbBtn').onclick = () => {
  const used = new Set([...G.players.values()].map(p => p.color));
  const p = addPlayer({ id: 'kb', name: 'Keyboard', color: COLORS.find(c => !used.has(c)) || COLORS[3], online: true });
  p.kb = true;
  renderLobby();
};
setInterval(() => { if (G.state === 'lobby') renderLobby(); }, 1000);

/* keyboard test player + shortcuts */
const keys = {};
addEventListener('keydown', e => {
  keys[e.key] = true;
  const kb = G.players.get('kb');
  if (e.key === ' ' && kb) { e.preventDefault(); tryJump(kb); }
  if (e.key === 'Enter' && (G.state === 'lobby' || G.state === 'over')) startRace();
});
addEventListener('keyup', e => { keys[e.key] = false; });

/* ============ race flow ============ */
function startRace() {
  const list = [...G.players.values()].filter(p => p.online);
  if (!list.length || G.state === 'countdown' || G.state === 'playing') return;
  G.players.forEach(p => { p.inRace = false; });
  list.forEach((p, i) => Object.assign(p, {
    inRace: true, x: (i + 0.5) / list.length * 0.8 + 0.1, vx: 0, lives: LIVES, score: 0, energy: 1,
    out: false, inv: 0, jumpT: 0, yOff: 0, spinT: 0,
  }));
  G.obstacles = []; G.particles = []; G.texts = [];
  G.speed = BASE_SPEED; G.dist = 0; G.spawnIn = 1.2;
  $('#lobby').hidden = true; $('#results').hidden = true; $('#waiting').hidden = true;
  $('#speedo').hidden = false;
  countdown(() => setState('playing'));
}
function setState(s) { G.state = s; sendState(); }
let cdTimer;
function countdown(done) {
  setState('countdown');
  const steps = ['3', '2', '1', 'GO!'];
  const el = $('#countdown');
  let i = 0;
  clearTimeout(cdTimer);
  const step = () => {
    if (i === steps.length) { el.hidden = true; return done(); }
    el.hidden = false;
    el.textContent = steps[i];
    el.classList.remove('tick'); void el.offsetWidth; el.classList.add('tick');
    racers().forEach(p => buzz(p, i === 3 ? [180] : [40]));
    i++;
    cdTimer = setTimeout(step, i === steps.length ? 550 : 750);
  };
  step();
}
function tryJump(p) {
  if (G.state !== 'playing' || !p.inRace || p.out || p.jumpT > 0) return;
  p.jumpT = JUMP_TIME;
  buzz(p, [30]);
}
function gameOver() {
  setState('over');
  const list = racers().sort((a, b) => b.score - a.score);
  $('#winner').textContent = list.length > 1 ? `🏆 ${list[0].name} wins!` : `${Math.round(list[0].score)} points!`;
  $('#board').innerHTML = list.map((p, i) => `<li style="--c:${esc(p.color)}"><span>${i + 1}. ${esc(p.name)}</span><span>${Math.round(p.score)}</span></li>`).join('');
  $('#results').hidden = false;
  $('#speedo').hidden = true;
  if (list[0]) buzz(list[0], [100, 60, 100, 60, 300]);
}
$('#skipWait').onclick = () => {
  racers().forEach(p => { if (!p.out && !p.online && !p.kb) { p.out = true; p.lives = 0; } });
  $('#waiting').hidden = true;
  if (racers().every(p => p.out)) return gameOver();
  countdown(() => setState('playing'));
};

/* ============ game update ============ */
function spawnRow() {
  const lanes = [0, 1, 2, 3, 4].sort(() => Math.random() - 0.5);
  const n = Math.random() < Math.min(0.6, 0.15 + G.speed / 1600) ? 2 : 1;   // always leaves 3 lanes open
  for (let k = 0; k < n; k++) {
    const r = Math.random(), truckP = 0.25 + G.speed / 3000;
    const type = r < truckP ? 'truck' : r < truckP + 0.3 ? 'cone' : r < truckP + 0.5 ? 'barrier' : 'oil';
    G.obstacles.push({ type, x: (lanes[k] + 0.5) / LANES, y: -SIZE[type][1] * road().rw, hit: new Set(), done: new Set() });
  }
  if (Math.random() < 0.6) {
    const x = (lanes[n] + 0.5) / LANES;
    for (let j = 0; j < 5; j++) G.obstacles.push({ type: 'coin', x, y: -60 - j * 52, taken: false });
  }
}
function floatText(x, y, text, color = '#FFE14A') { G.texts.push({ x, y, text, color, t: 1.2 }); }
function burst(x, y, color, n = 14) {
  if (REDUCED) return;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = 80 + Math.random() * 260;
    G.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, t: 0.6 + Math.random() * 0.4, color, size: 3 + Math.random() * 5 });
  }
}

function update(dt) {
  const { rw, left } = road();
  const now = performance.now();
  G.scroll += (G.state === 'playing' ? G.speed : 140) * dt;
  G.shake = Math.max(0, G.shake - dt * 2.5);
  G.particles = G.particles.filter(q => (q.t -= dt) > 0 && ((q.x += q.vx * dt), (q.y += q.vy * dt), (q.vy += 400 * dt), true));
  G.texts = G.texts.filter(t => (t.t -= dt) > 0 && ((t.y -= 50 * dt), true));

  // keyboard player and stale-input safety (phone locked/backgrounded => straighten wheel)
  G.players.forEach(p => {
    if (p.kb) { p.steer = (keys.ArrowRight ? 1 : 0) - (keys.ArrowLeft ? 1 : 0); p.boost = !!keys.Shift; p.online = true; }
    else if (now - p.lastInput > 500) { p.steer *= 0.8; p.boost = false; }
  });

  // pause if a racer's phone disconnects, resume when it returns
  if (G.state === 'playing' || G.state === 'waiting') {
    const missing = racers().filter(p => !p.out && !p.online && !p.kb);
    if (missing.length && G.state === 'playing') {
      setState('waiting');
      $('#waitingText').textContent = `Waiting for ${missing.map(p => p.name).join(' and ')} to reconnect…`;
      $('#waiting').hidden = false;
    } else if (!missing.length && G.state === 'waiting') {
      $('#waiting').hidden = true;
      countdown(() => setState('playing'));
    }
  }
  if (G.state !== 'playing') return;

  G.speed = Math.min(MAX_SPEED, G.speed + SPEED_UP * dt);
  G.dist += G.speed * dt;
  G.spawnIn -= dt;
  if (G.spawnIn <= 0) { spawnRow(); G.spawnIn = Math.max(250, 470 - G.speed * 0.18) / G.speed; }

  const [cw, ch] = SIZE.car.map(v => v * rw);
  const baseY = H - rw * 0.2;
  for (const p of racers()) {
    if (p.out) continue;
    const control = p.spinT > 0 ? -p.steer * 0.5 + Math.sin(now / 60) * 0.6 : p.steer;
    p.vx += (control * STEER_RATE - p.vx) * Math.min(1, dt * 14);
    p.x += p.vx * dt;
    if (p.x < 0.05 || p.x > 0.95) { p.x = Math.max(0.05, Math.min(0.95, p.x)); if (Math.random() < 0.15) buzz(p, [15]); }
    p.jumpT = Math.max(0, p.jumpT - dt);
    p.spinT = Math.max(0, p.spinT - dt);
    p.inv = Math.max(0, p.inv - dt);
    const boosting = p.boost && p.energy > 0.02;
    p.energy = Math.max(0, Math.min(1, p.energy + (boosting ? -0.42 : 0.035) * dt));
    p.yOff += ((boosting ? -rw * 0.4 : 0) - p.yOff) * Math.min(1, dt * 4);
    p.score += G.speed * dt * 0.02 * (boosting ? 2 : 1);
    p.boosting = boosting;
  }

  for (const o of G.obstacles) {
    o.y += G.speed * dt;
    const [ow, oh] = SIZE[o.type].map(v => v * rw);
    for (const p of racers()) {
      if (p.out) continue;
      const px = left + p.x * rw, py = baseY + p.yOff, ox = left + o.x * rw;
      const overlapX = Math.abs(ox - px) < (ow + cw) / 2 * 0.82;
      const overlapY = Math.abs(o.y - py) < (oh + ch) / 2 * 0.82;
      if (o.type === 'coin') {
        if (!o.taken && overlapX && overlapY) {
          o.taken = true; p.score += 50; p.energy = Math.min(1, p.energy + 0.2);
          burst(ox, o.y, '#FFE14A', 8); floatText(ox, o.y, '+50'); buzz(p, [20]);
        }
        continue;
      }
      if (overlapX && overlapY && !o.hit.has(p.id)) {
        if (JUMPABLE.has(o.type) && p.jumpT > 0) {
          if (!o.done.has(p.id)) { o.done.add(p.id); p.score += 25; floatText(px, py - ch, 'NICE JUMP! +25', p.color); }
        } else if (o.type === 'oil') {
          o.hit.add(p.id); p.spinT = 0.9; buzz(p, [60, 40, 60]); floatText(px, py - ch, 'SLIPPY!', '#4DA3FF');
        } else if (p.inv <= 0) {
          o.hit.add(p.id); crash(p, px, py);
        }
      }
      // close call: a truck passes right next to you
      if (o.type === 'truck' && !o.hit.has(p.id) && !o.done.has(p.id) && o.y - oh / 2 > py + ch / 2) {
        o.done.add(p.id);
        const gap = Math.abs(ox - px) - (ow + cw) / 2;
        if (gap < cw * 0.6) { p.score += 30; floatText(px, py - ch, 'CLOSE CALL! +30', '#2EE6A6'); buzz(p, [25, 30, 25]); }
      }
    }
  }
  G.obstacles = G.obstacles.filter(o => o.y < H + 400 && !(o.type === 'coin' && o.taken));

  if (racers().length && racers().every(p => p.out)) gameOver();
}
function crash(p, px, py) {
  p.lives--;
  p.inv = 2;
  G.shake = 1;
  burst(px, py, p.color, 22);
  if (p.lives <= 0) {
    p.out = true;
    floatText(px, py - 40, 'WIPEOUT!', '#FF4D8D');
    buzz(p, [400, 100, 400]);
  } else {
    floatText(px, py - 40, 'OUCH!', '#FF4D8D');
    buzz(p, [220, 80, 220]);
  }
}

/* ============ drawing ============ */
function rr(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function drawCar(p, x, y, w, h) {
  const air = p.jumpT > 0 ? Math.sin(Math.PI * (1 - p.jumpT / JUMP_TIME)) : 0;
  const s = 1 + air * 0.35;
  if (p.inv > 0 && Math.floor(p.inv * 10) % 2 === 0) ctx.globalAlpha = 0.35;
  if (p.out) ctx.globalAlpha = 0.25;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(x + air * 18, y + h * 0.1 + air * 24, w * 0.6, h * 0.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.rotate(p.vx * 0.25 + (p.spinT > 0 ? Math.sin(performance.now() / 50) * 0.5 : 0));
  if (p.boosting && !REDUCED) {
    const f = 0.7 + Math.random() * 0.5;
    ctx.fillStyle = '#FF7A1A';
    ctx.beginPath(); ctx.moveTo(-w * 0.3, h / 2); ctx.lineTo(0, h / 2 + h * 0.6 * f); ctx.lineTo(w * 0.3, h / 2); ctx.fill();
    ctx.fillStyle = '#FFE14A';
    ctx.beginPath(); ctx.moveTo(-w * 0.15, h / 2); ctx.lineTo(0, h / 2 + h * 0.35 * f); ctx.lineTo(w * 0.15, h / 2); ctx.fill();
  }
  ctx.fillStyle = '#0E0E2A';
  for (const [sx, sy] of [[-1, -0.3], [1, -0.3], [-1, 0.3], [1, 0.3]]) {
    rr(sx < 0 ? -w / 2 - w * 0.06 : w / 2 - w * 0.1, sy * h - h * 0.1, w * 0.16, h * 0.2, 3);
    ctx.fill();
  }
  ctx.fillStyle = p.color; rr(-w / 2, -h / 2, w, h, w * 0.3); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.85)'; rr(-w * 0.32, -h * 0.28, w * 0.64, h * 0.2, 4); ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.18)'; rr(-w * 0.32, -h * 0.02, w * 0.64, h * 0.3, 5); ctx.fill();
  ctx.fillStyle = '#FFE14A'; ctx.fillRect(-w * 0.38, -h / 2 + 2, w * 0.18, 4); ctx.fillRect(w * 0.2, -h / 2 + 2, w * 0.18, 4);
  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.font = '700 13px Rubik, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = p.color;
  ctx.fillText(p.name, x, y + h * 0.5 * s + 18);
}
function drawObstacle(o, x, w, h) {
  const y = o.y;
  switch (o.type) {
    case 'cone':
      ctx.fillStyle = '#FF7A1A';
      ctx.beginPath(); ctx.moveTo(x, y - h / 2); ctx.lineTo(x + w / 2, y + h / 2); ctx.lineTo(x - w / 2, y + h / 2); ctx.fill();
      ctx.fillStyle = '#FFFBF2'; ctx.fillRect(x - w * 0.22, y, w * 0.44, h * 0.15);
      break;
    case 'barrier': {
      ctx.fillStyle = '#FFE14A'; rr(x - w / 2, y - h / 2, w, h, 4); ctx.fill();
      ctx.save(); rr(x - w / 2, y - h / 2, w, h, 4); ctx.clip();
      ctx.fillStyle = '#14143D';
      for (let i = -w; i < w; i += 18) { ctx.beginPath(); ctx.moveTo(x - w / 2 + i, y + h / 2); ctx.lineTo(x - w / 2 + i + 9, y + h / 2); ctx.lineTo(x - w / 2 + i + 9 + h, y - h / 2); ctx.lineTo(x - w / 2 + i + h, y - h / 2); ctx.fill(); }
      ctx.restore();
      break;
    }
    case 'oil':
      ctx.fillStyle = '#0B0B22';
      ctx.beginPath(); ctx.ellipse(x, y, w / 2, h / 2, 0.3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(77,163,255,0.5)';
      ctx.beginPath(); ctx.ellipse(x - w * 0.12, y - h * 0.12, w * 0.15, h * 0.1, 0.3, 0, Math.PI * 2); ctx.fill();
      break;
    case 'truck':
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; rr(x - w / 2 + 6, y - h / 2 + 8, w, h, 8); ctx.fill();
      ctx.fillStyle = '#4DA3FF'; rr(x - w / 2, y - h / 2, w, h * 0.2, 8); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fillRect(x - w * 0.35, y - h / 2 + h * 0.03, w * 0.7, h * 0.05);
      ctx.fillStyle = '#FFFBF2'; rr(x - w / 2, y - h / 2 + h * 0.22, w, h * 0.78, 8); ctx.fill();
      ctx.fillStyle = '#FF4D8D'; ctx.fillRect(x - w / 2, y + h * 0.12, w, h * 0.06);
      break;
    case 'coin': {
      const sx = Math.abs(Math.sin(performance.now() / 180 + o.y / 90));
      ctx.fillStyle = '#FF7A1A';
      ctx.beginPath(); ctx.ellipse(x, y, (w / 2) * Math.max(0.25, sx), w / 2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#FFE14A';
      ctx.beginPath(); ctx.ellipse(x, y, (w / 2.8) * Math.max(0.2, sx), w / 2.8, 0, 0, Math.PI * 2); ctx.fill();
      break;
    }
  }
}
function draw() {
  const { rw, left } = road();
  const sc = G.scroll;
  ctx.save();
  if (G.shake > 0 && !REDUCED) ctx.translate((Math.random() - 0.5) * G.shake * 16, (Math.random() - 0.5) * G.shake * 16);
  ctx.fillStyle = '#14143D'; ctx.fillRect(-30, -30, W + 60, H + 60);
  ctx.fillStyle = '#1F1F55';
  for (let y = (sc * 0.6 % 90) - 90; y < H; y += 90) {
    ctx.fillRect(left - 90, y, 40, 46); ctx.fillRect(left + rw + 50, y + 30, 40, 46);
  }
  ctx.fillStyle = '#2C2C6E'; ctx.fillRect(left, -30, rw, H + 60);
  const rs = 20;
  for (let y = (sc % (rs * 2)) - rs * 2; y < H; y += rs * 2) {
    ctx.fillStyle = '#FF7A1A'; ctx.fillRect(left - 12, y, 12, rs); ctx.fillRect(left + rw, y, 12, rs);
    ctx.fillStyle = '#FFFBF2'; ctx.fillRect(left - 12, y + rs, 12, rs); ctx.fillRect(left + rw, y + rs, 12, rs);
  }
  ctx.fillStyle = 'rgba(255,225,74,0.5)';
  for (let l = 1; l < LANES; l++) {
    const x = left + (rw * l) / LANES - 3;
    for (let y = (sc % 72) - 72; y < H; y += 72) ctx.fillRect(x, y, 6, 36);
  }
  for (const o of G.obstacles) {
    const [w, h] = SIZE[o.type].map(v => v * rw);
    drawObstacle(o, left + o.x * rw, w, h);
  }
  const [cw, ch] = SIZE.car.map(v => v * rw);
  const baseY = H - rw * 0.2;
  const showCars = G.state === 'lobby' ? [] : racers();
  showCars.filter(p => p.out).concat(showCars.filter(p => !p.out)).forEach(p => drawCar(p, left + p.x * rw, baseY + p.yOff, cw, ch));
  G.particles.forEach(q => { ctx.globalAlpha = Math.min(1, q.t * 2); ctx.fillStyle = q.color; ctx.fillRect(q.x, q.y, q.size, q.size); });
  ctx.globalAlpha = 1;
  ctx.textAlign = 'center';
  G.texts.forEach(t => {
    ctx.globalAlpha = Math.min(1, t.t * 2);
    ctx.font = '28px "Lilita One", sans-serif';
    ctx.lineWidth = 6; ctx.strokeStyle = '#14143D'; ctx.strokeText(t.text, t.x, t.y);
    ctx.fillStyle = t.color; ctx.fillText(t.text, t.x, t.y);
  });
  ctx.globalAlpha = 1;
  ctx.restore();
}

/* ============ HUD + phone state ============ */
function renderHud() {
  const list = G.state === 'lobby' ? [] : racers();
  $('#hudPlayers').innerHTML = list.map(p => `
    <li class="pcard ${p.out ? 'out' : ''}" style="--c:${esc(p.color)}">
      <span class="car-chip"></span>
      <span class="pname">${esc(p.name)}</span>
      <span class="pscore">${Math.round(p.score)}</span>
      <span class="pmeta"><span>${p.out ? 'Out' : '❤️'.repeat(Math.max(0, p.lives))}</span>
        <span>${p.kb ? 'keyboard' : !p.online ? 'offline' : p.rtt ? Math.round(p.rtt / 2) + ' ms' : '…'}</span></span>
      <span class="energy" title="Boost"><i style="width:${Math.round(p.energy * 100)}%"></i></span>
    </li>`).join('');
  $('#speedo').textContent = Math.round(G.speed / 4) + ' km/h';
}
function sendState() {
  const sorted = racers().sort((a, b) => b.score - a.score);
  const players = {};
  G.players.forEach(p => {
    players[p.id] = { score: Math.round(p.score), lives: p.lives, out: p.out, inRace: p.inRace, energy: Math.round(p.energy * 100), rank: sorted.indexOf(p) + 1, of: sorted.length };
  });
  socket.emit('state', { status: G.state, players });
}
setInterval(() => { renderHud(); sendState(); }, 200);

/* ============ main loop ============ */
let last = performance.now();
function frame(t) {
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;
  update(dt);
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
renderLobby();
})();
