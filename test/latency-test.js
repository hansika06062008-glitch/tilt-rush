/**
 * Latency + reliability test for Tilt Rush.
 * Start the server first (npm start), then:  npm test
 * Options: node test/latency-test.js [serverUrl] [phones] [seconds]
 *
 * Simulates a game screen and several phones streaming sensor input at
 * 60 Hz, and measures phone -> game -> phone round-trip time.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';   // allow the self-signed cert from "npm run lan"
const { io } = require('socket.io-client');

const URL = process.argv[2] || 'http://localhost:3000';
const PHONES = Number(process.argv[3]) || 4;
const SECONDS = Number(process.argv[4]) || 5;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const call = (s, ev, data) => new Promise(r => s.emit(ev, data, r));
const connect = () => new Promise((res, rej) => {
  const s = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false, rejectUnauthorized: false });
  s.once('connect', () => res(s));
  s.once('connect_error', rej);
});
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };

(async () => {
  console.log(`Testing ${URL}: ${PHONES} phones streaming for ${SECONDS}s\n`);

  // Game screen creates a room
  let game = await connect();
  const created = await call(game, 'game:create', {});
  const code = created.code;
  check('Game screen creates a room code', /^[A-Z0-9]{4}$/.test(code), code);

  // Bad code is rejected
  const stranger = await connect();
  const bad = await call(stranger, 'ctrl:join', { code: 'ZZZZ', name: 'Nobody' });
  check('Wrong room code is rejected', !!bad.error);
  stranger.close();

  // Phones pair with the room code
  const phones = [];
  for (let i = 0; i < PHONES; i++) {
    const s = await connect();
    const r = await call(s, 'ctrl:join', { code, name: 'Phone ' + (i + 1) });
    if (r.error) throw new Error(r.error);
    s.pid = r.pid; s.token = r.token; s.sent = new Map(); s.rtts = [];
    s.on('ack', seq => { const t = s.sent.get(seq); if (t) s.rtts.push(performance.now() - t); });
    phones.push(s);
  }
  check(`${PHONES} phones paired`, phones.length === PHONES);

  if (PHONES >= 4) {
    const extra = await connect();
    const full = await call(extra, 'ctrl:join', { code, name: 'Fifth' });
    check('5th phone is turned away (max 4)', !!full.error);
    extra.close();
  }

  // Game side: ack every packet so we can measure round trips, and check ordering
  let received = 0, outOfOrder = 0;
  const lastSeq = {};
  game.on('i', d => {
    received++;
    if (lastSeq[d[0]] !== undefined && d[1] <= lastSeq[d[0]]) outOfOrder++;
    lastSeq[d[0]] = d[1];
    game.volatile.emit('ack', [d[0], d[1]]);
  });

  // Stream 60 Hz input from every phone, like the real controller
  let sentTotal = 0;
  const timers = phones.map(s => {
    let seq = 0;
    return setInterval(() => {
      seq++;
      s.sent.set(seq, performance.now());
      s.volatile.emit('i', [seq, Math.round(Math.sin(seq / 20) * 100), Math.floor(seq / 120), seq % 90 < 20 ? 1 : 0, 0]);
      sentTotal++;
    }, 16);
  });
  await sleep(SECONDS * 1000);
  timers.forEach(clearInterval);
  await sleep(300);

  const rtts = phones.flatMap(s => s.rtts);
  const oneWay = rtts.map(r => r / 2);
  check('Input reaches the game in order', outOfOrder === 0, `${received}/${sentTotal} packets, ${outOfOrder} out of order`);
  check('Phone -> game latency p95 under 50 ms', pct(oneWay, 0.95) < 50,
    `${rtts.length} samples, one-way p50 ${pct(oneWay, 0.5).toFixed(1)} ms, p95 ${pct(oneWay, 0.95).toFixed(1)} ms, round trip p95 ${pct(rtts, 0.95).toFixed(1)} ms`);
  check('Input rate per phone ~60 Hz', received / PHONES / SECONDS > 50, `${(received / PHONES / SECONDS).toFixed(0)} Hz`);

  // Vibration feedback reaches the right phone
  const gotBuzz = new Promise(r => { phones[0].once('buzz', r); setTimeout(() => r(null), 1000); });
  game.emit('buzz', { pid: phones[0].pid, pattern: [100] });
  check('Vibration event reaches the phone', JSON.stringify(await gotBuzz) === '[100]');

  // Phone reconnects and keeps its seat
  const statusSeen = new Promise(r => { game.once('player:status', r); setTimeout(() => r(null), 1500); });
  phones[1].close();
  const st = await statusSeen;
  check('Game sees a phone disconnect', !!st && st.online === false);
  const back = await connect();
  const rj = await call(back, 'ctrl:join', { code, name: 'Phone 2', pid: phones[1].pid, token: phones[1].token });
  check('Phone reconnects into the same seat', rj.ok && rj.pid === phones[1].pid);

  // Game screen reloads and reclaims the room
  const hostDown = new Promise(r => { phones[0].once('host:status', r); setTimeout(() => r(null), 1500); });
  game.close();
  const hd = await hostDown;
  game = await connect();
  const hostUp = new Promise(r => { phones[0].once('host:status', r); setTimeout(() => r(null), 1500); });
  const re = await call(game, 'game:create', { code, token: created.token });
  const hu = await hostUp;
  check('Game screen reconnects to the same room', re.code === code && re.players.length === PHONES && hd && !hd.online && hu && hu.online);

  // QR code endpoint
  const qr = await fetch(`${URL}/qr.svg?text=${encodeURIComponent(URL + '/play?room=' + code)}`).then(r => r.text()).catch(() => '');
  check('QR code is generated', qr.includes('<svg'));

  [game, back, ...phones].forEach(s => s.close());
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch(err => { console.error('Test crashed:', err.message, '\nIs the server running? Start it with: npm start'); process.exit(1); });
