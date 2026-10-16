(() => {
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = d => ((d + 540) % 360) - 180;              // keep angles in -180..180
const SENS = { chill: 40, normal: 28, spicy: 18 };     // degrees of tilt for full lock
const DEADZONE = 2.5;                                  // degrees

const S = {
  joined: false, hostOnline: false, pid: null, color: '#FF7A1A',
  mode: 'sensor', sens: localStorage.getItem('tr:sens') || 'normal', haptics: localStorage.getItem('tr:haptics') !== 'off',
  steer: 0, touchSteer: 0, jumpCount: 0, boost: false, seq: 0, rtt: 0, energy: 100, lastStatus: null,
};
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); }

/* =========================================================
   SENSORS
   Gyroscope + accelerometer fused with a complementary filter.
   - Accelerometer: gravity direction in the screen plane gives the
     steering angle (stable but noisy).
   - Gyroscope: rotation rate around the screen axis gives fast,
     smooth changes (but drifts on its own).
   - Fused = mostly gyro, gently pulled toward the accelerometer.
   - Shake (spike in linear acceleration) = jump.
   ========================================================= */
const sen = { fused: null, neutral: null, gyroSign: 0, corr: 0, lastAcc: null, lastT: 0, flat: false, events: 0, hz: 0,
  raw: { gx: 0, gy: 0, gz: 0, ra: 0, rb: 0, rg: 0, lin: 0 }, calSamples: null, lastShake: 0 };

function onMotion(e) {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null) return;
  const t = performance.now();
  const dt = sen.lastT ? Math.min(0.1, (t - sen.lastT) / 1000) : 1 / 60;
  sen.lastT = t;
  sen.events++;
  const gx = g.x, gy = g.y, gz = g.z;
  sen.flat = Math.hypot(gx, gy) < 3.5;            // screen facing the sky: no steering info from gravity
  const accAngle = Math.atan2(gx, gy) * 180 / Math.PI;
  const r = e.rotationRate || {};
  const rate = r.alpha || 0;                       // deg/s around the axis through the screen

  // Learn whether this device's gyro sign matches the accelerometer (differs between phones/browsers)
  if (sen.lastAcc !== null && !sen.flat && Math.abs(rate) > 15) {
    const dAcc = wrap(accAngle - sen.lastAcc) / dt;
    sen.corr += Math.sign(dAcc * rate) * Math.min(1, Math.abs(dAcc) / 40);
    if (!sen.gyroSign && Math.abs(sen.corr) > 20) sen.gyroSign = Math.sign(sen.corr);
  }
  sen.lastAcc = accAngle;

  if (sen.fused === null) sen.fused = accAngle;
  if (sen.gyroSign) sen.fused = wrap(sen.fused + sen.gyroSign * rate * dt);
  const k = sen.flat ? 0 : sen.gyroSign ? 0.06 : 0.3;
  sen.fused = wrap(sen.fused + k * wrap(accAngle - sen.fused));
  if (sen.neutral === null) sen.neutral = sen.fused;
  if (sen.calSamples) sen.calSamples.push(sen.fused);

  const deg = -wrap(sen.fused - sen.neutral);      // + = turned right
  const max = SENS[S.sens] || 28;
  const mag = Math.max(0, Math.abs(deg) - DEADZONE) / (max - DEADZONE);
  if (S.mode === 'sensor') S.steer = clamp(Math.sign(deg) * mag, -1, 1);

  // Shake to jump (linear acceleration spike)
  const a = e.acceleration;
  const lin = a && a.x != null ? Math.hypot(a.x, a.y, a.z) : Math.abs(Math.hypot(gx, gy, gz) - 9.81);
  if (lin > 13 && t - sen.lastShake > 650) { sen.lastShake = t; jump(); }

  sen.raw = { gx, gy, gz, ra: r.alpha || 0, rb: r.beta || 0, rg: r.gamma || 0, lin };
}
setInterval(() => { sen.hz = sen.events; sen.events = 0; }, 1000);

async function enableSensors() {
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const res = await DeviceMotionEvent.requestPermission();      // iPhone asks the user
      if (res !== 'granted') { setMode('touch'); toast('Motion access was blocked. Using touch steering.'); return; }
    }
  } catch { /* not supported */ }
  window.addEventListener('devicemotion', onMotion);
  setTimeout(() => {
    if (!sen.lastT && S.mode === 'sensor') {
      setMode('touch');
      toast(window.isSecureContext ? 'No motion sensors found. Drag the wheel to steer.' : 'Motion sensors need an https link. Using touch steering.');
    }
  }, 1800);
}

function calibrate() {
  if (S.mode !== 'sensor' || sen.fused === null) { $('#calib').hidden = true; return toast('Calibration needs motion sensors.'); }
  sen.calSamples = [];
  $('#calGo').disabled = true;
  $('#calGo').textContent = 'Hold still…';
  setTimeout(() => {
    const s = sen.calSamples; sen.calSamples = null;
    if (s.length) {   // circular mean, safe across the ±180° boundary
      const x = s.reduce((a, d) => a + Math.cos(d * Math.PI / 180), 0), y = s.reduce((a, d) => a + Math.sin(d * Math.PI / 180), 0);
      sen.neutral = Math.atan2(y, x) * 180 / Math.PI;
    }
    $('#calGo').disabled = false;
    $('#calGo').textContent = 'Set straight position';
    $('#calib').hidden = true;
    toast('Calibrated! Straight is set ✓');
    buzz([40, 40, 40]);
    socket.emit('ctrl:action', { type: 'calibrated' });
  }, 500);
}
$('#calBtn').onclick = () => { $('#calib').hidden = false; };
$('#calGo').onclick = calibrate;
$('#calSkip').onclick = () => { $('#calib').hidden = true; if (sen.fused !== null) sen.neutral = sen.fused; };

/* ---------- touch steering fallback ---------- */
function setMode(m) {
  S.mode = m;
  $('#modeBtn').textContent = m === 'touch' ? '🌀 Tilt steer' : '✋ Touch steer';
  if (m === 'touch') S.steer = 0;
}
$('#modeBtn').onclick = () => {
  if (S.mode === 'touch') { setMode('sensor'); if (!sen.lastT) enableSensors(); toast('Tilt steering on'); }
  else { setMode('touch'); toast('Drag the wheel left and right to steer'); }
};
let dragX = null;
const area = $('#wheelArea');
area.addEventListener('pointerdown', e => { if (S.mode !== 'touch') return; dragX = e.clientX; area.setPointerCapture(e.pointerId); });
area.addEventListener('pointermove', e => { if (dragX === null) return; S.steer = clamp((e.clientX - dragX) / 90, -1, 1); });
const endDrag = () => { dragX = null; if (S.mode === 'touch') S.steer = 0; };
area.addEventListener('pointerup', endDrag);
area.addEventListener('pointercancel', endDrag);

/* ---------- buttons ---------- */
function jump() {
  S.jumpCount++;
  const b = $('#jumpBtn');
  b.classList.add('on'); setTimeout(() => b.classList.remove('on'), 120);
}
$('#jumpBtn').addEventListener('pointerdown', e => { e.preventDefault(); jump(); });
const boostBtn = $('#boostBtn');
const boostOn = e => { e.preventDefault(); S.boost = true; boostBtn.classList.add('on'); boostBtn.setPointerCapture?.(e.pointerId); };
const boostOff = () => { S.boost = false; boostBtn.classList.remove('on'); };
boostBtn.addEventListener('pointerdown', boostOn);
['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => boostBtn.addEventListener(ev, boostOff));
document.addEventListener('contextmenu', e => e.preventDefault());

function buzz(p) { if (S.haptics && navigator.vibrate) navigator.vibrate(p); }
$('#hapticBtn').onclick = () => {
  S.haptics = !S.haptics;
  localStorage.setItem('tr:haptics', S.haptics ? 'on' : 'off');
  $('#hapticBtn').setAttribute('aria-pressed', String(S.haptics));
  $('#hapticBtn').textContent = S.haptics ? '📳 Buzz on' : '📴 Buzz off';
  if (S.haptics) buzz([40]);
};
$('#hapticBtn').setAttribute('aria-pressed', String(S.haptics));
$('#hapticBtn').textContent = S.haptics ? '📳 Buzz on' : '📴 Buzz off';
$$('.seg button').forEach(b => {
  b.setAttribute('aria-pressed', String(b.dataset.sens === S.sens));
  b.onclick = () => {
    S.sens = b.dataset.sens; localStorage.setItem('tr:sens', S.sens);
    $$('.seg button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  };
});
$('#telBtn').onclick = () => {
  const on = $('#telemetry').hidden;
  $('#telemetry').hidden = !on;
  $('#telBtn').setAttribute('aria-pressed', String(on));
};

/* =========================================================
   NETWORK
   ========================================================= */
const socket = io({ transports: ['websocket'], reconnectionDelay: 300, reconnectionDelayMax: 2000 });
const sentAt = new Map();

function setStatus() {
  let kind = 'off', text = 'Reconnecting…';
  if (socket.connected && S.joined) { kind = S.hostOnline ? 'on' : 'off'; text = S.hostOnline ? 'Connected' : 'Game screen offline'; }
  else if (socket.connected) { kind = ''; text = 'Joining…'; }
  $('#dot').className = 'dot ' + kind;
  $('#statusText').textContent = text;
  if (kind !== S.lastStatus) { if (S.lastStatus === 'on' && kind === 'off') buzz([80, 60, 80]); S.lastStatus = kind; }
}
socket.on('connect', () => { setStatus(); if (S.joined) rejoin(); });
socket.on('disconnect', setStatus);
socket.on('host:status', ({ online }) => { S.hostOnline = online; setStatus(); });
socket.on('ack', seq => {
  const t = sentAt.get(seq);
  if (t === undefined) return;
  const r = performance.now() - t;
  S.rtt = S.rtt ? S.rtt * 0.8 + r * 0.2 : r;
});
socket.on('buzz', pattern => buzz(pattern));
socket.on('state', onState);
socket.on('ctrl:replaced', () => leave('You joined from another tab or device.'));
socket.on('ctrl:kicked', () => { sessionStorage.removeItem('tr:ctrl'); leave('The game screen removed you.'); });

// Stream input at 60 Hz. Volatile: stale packets are dropped, never queued.
setInterval(() => {
  if (!S.joined || !socket.connected) return;
  const seq = ++S.seq;
  sentAt.set(seq, performance.now());
  if (sentAt.size > 120) sentAt.delete(sentAt.keys().next().value);
  socket.volatile.emit('i', [seq, Math.round(S.steer * 100), S.jumpCount, S.boost ? 1 : 0, Math.round(S.rtt)]);
}, 16);

/* ---------- join ---------- */
const params = new URLSearchParams(location.search);
const saved = JSON.parse(sessionStorage.getItem('tr:ctrl') || 'null');
$('#code').value = (params.get('room') || (saved && saved.code) || '').toUpperCase();
$('#name').value = localStorage.getItem('tr:name') || '';
if (saved && (!params.get('room') || params.get('room').toUpperCase() === saved.code)) $('#joinBtn').textContent = `Rejoin as ${saved.name} 🏁`;
$('#code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

$('#joinForm').addEventListener('submit', e => {
  e.preventDefault();
  // These must start inside the tap (browsers require a user gesture)
  const sensorsReady = enableSensors();
  goFullscreen();
  const code = $('#code').value.trim().toUpperCase(), name = $('#name').value.trim();
  localStorage.setItem('tr:name', name);
  const prev = JSON.parse(sessionStorage.getItem('tr:ctrl') || 'null');
  const same = prev && prev.code === code;
  $('#joinBtn').disabled = true;
  $('#joinError').textContent = '';
  const send = () => socket.timeout(5000).emit('ctrl:join', { code, name, pid: same ? prev.pid : null, token: same ? prev.token : null }, async (err, res) => {
    $('#joinBtn').disabled = false;
    if (err) return ($('#joinError').textContent = 'Could not reach the game. Check your Wi-Fi.');
    if (res.error) return ($('#joinError').textContent = res.error);
    joined(res);
    await sensorsReady;
    $('#calib').hidden = S.mode !== 'sensor';
  });
  socket.connected ? send() : socket.once('connect', send);
});

function joined(res) {
  S.joined = true; S.pid = res.pid; S.hostOnline = res.hostOnline; S.color = res.color;
  sessionStorage.setItem('tr:ctrl', JSON.stringify({ code: res.code, pid: res.pid, token: res.token, name: res.name }));
  document.documentElement.style.setProperty('--me', res.color);
  $('#me').textContent = res.name;
  $('#join').hidden = true;
  $('#pad').hidden = false;
  history.replaceState(null, '', '/play?room=' + res.code);
  keepAwake();
  setStatus();
  buzz([60]);
}
function rejoin() {
  const s = JSON.parse(sessionStorage.getItem('tr:ctrl') || 'null');
  if (!s) return;
  socket.emit('ctrl:join', { code: s.code, name: s.name, pid: s.pid, token: s.token }, res => {
    if (res.error) return leave(res.error);
    S.hostOnline = res.hostOnline;
    setStatus();
    toast('Reconnected! 🔌');
  });
}
function leave(msg) {
  S.joined = false;
  $('#pad').hidden = true;
  $('#join').hidden = false;
  $('#joinError').textContent = msg || '';
  $('#joinBtn').textContent = "Let's ride! 🏁";
}

/* ---------- game state from the laptop ---------- */
function onState(s) {
  if (!S.joined) return;
  const me = s.players && s.players[S.pid];
  const banner = $('#banner'), btn = $('#bannerBtn');
  let title = '', text = '', action = null;
  if (s.status === 'lobby') { title = "You're in! 🎉"; text = 'Hold tight. The race starts when someone taps Start.'; action = ['Start race', 'start']; }
  else if (s.status === 'countdown') { title = 'Get ready…'; text = 'Hands on the wheel!'; }
  else if (s.status === 'waiting') { title = 'Paused ⏸'; text = 'Waiting for a player to reconnect.'; }
  else if (s.status === 'over') {
    title = me && me.rank === 1 && me.of > 1 ? 'You won! 🏆' : 'Race over!';
    text = me && me.inRace ? `You scored ${me.score} points${me.of > 1 ? ` and finished #${me.rank} of ${me.of}` : ''}.` : 'Join the next one!';
    action = ['Race again', 'restart'];
  } else if (s.status === 'playing' && me && !me.inRace) { title = 'Race in progress'; text = "You'll be in the next one!"; }
  else if (s.status === 'playing' && me && me.out) { title = 'Wipeout! 💥'; text = `You scored ${me.score}. Cheer on the others!`; }
  banner.hidden = !title || !$('#calib').hidden;
  $('#bannerTitle').textContent = title;
  $('#bannerText').textContent = text;
  btn.hidden = !action;
  if (action) { btn.textContent = action[0]; btn.onclick = () => socket.emit('ctrl:action', { type: action[1] }); }
  if (me && me.inRace && s.status !== 'lobby') {
    $('#scoreLine').textContent = `${me.score} pts  ${me.out ? '' : '❤️'.repeat(Math.max(0, me.lives))}`;
    S.energy = me.energy;
  } else $('#scoreLine').textContent = '';
}

/* ---------- screen helpers ---------- */
function goFullscreen() {
  const el = document.documentElement;
  const p = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : null;
  if (p) p.then(() => screen.orientation?.lock?.('landscape').catch(() => {})).catch(() => {});
}
let wakeLock = null;
async function keepAwake() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {} }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.joined) keepAwake(); });

/* ---------- visuals ---------- */
function frame() {
  if (S.joined) {
    $('#wheel').style.transform = `rotate(${S.steer * 90}deg)`;
    const m = $('#steerMark');
    m.style.width = Math.abs(S.steer) * 50 + '%';
    m.style.left = S.steer < 0 ? 50 - Math.abs(S.steer) * 50 + '%' : '50%';
    $('#boostFill').style.transform = `scaleY(${S.energy / 100})`;
    const hint = $('#hint');
    if (S.mode === 'touch') { hint.textContent = 'Drag the wheel left and right to steer.'; hint.className = 'hint'; }
    else if (sen.flat) { hint.textContent = 'Lift your phone up, like a steering wheel!'; hint.className = 'hint warn'; }
    else { hint.textContent = 'Tilt to steer. Shake to jump!'; hint.className = 'hint'; }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
setInterval(() => {
  const lat = $('#lat');
  const ms = S.rtt ? Math.round(S.rtt / 2) : null;
  lat.textContent = ms === null ? '-- ms' : `${ms} ms`;
  lat.className = 'lat ' + (ms === null ? '' : ms < 40 ? 'good' : ms < 90 ? 'ok' : 'bad');
  if (!$('#telemetry').hidden) {
    const r = sen.raw, f = v => (v >= 0 ? ' ' : '') + v.toFixed(1);
    $('#telemetry').textContent =
      `gyro  α${f(r.ra)} β${f(r.rb)} γ${f(r.rg)} °/s\n` +
      `accel x${f(r.gx)} y${f(r.gy)} z${f(r.gz)} m/s²\n` +
      `shake ${r.lin.toFixed(1)} m/s²   rate ${sen.hz} Hz\n` +
      `steer ${S.steer.toFixed(2)}   gyro fusion ${sen.gyroSign ? 'on' : 'learning'}\n` +
      `round trip ${Math.round(S.rtt)} ms   sent #${S.seq}`;
  }
}, 200);
})();
