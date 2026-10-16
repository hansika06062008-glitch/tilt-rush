'use strict';
/**
 * Tilt Rush server
 * - Serves the game screen (laptop) and the controller app (phone)
 * - Pairs phones to a game with a 4-letter room code / QR code
 * - Relays sensor input phone -> game over WebSockets with volatile
 *   (drop-if-stale) messages so input never queues up and lags
 */
const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const USE_HTTPS = process.argv.includes('--https') || process.env.HTTPS === '1';
const PORT = Number(process.env.PORT) || (USE_HTTPS ? 3443 : 3000);
const MAX_PLAYERS = 4;
const PLAYER_GRACE_MS = 90 * 1000;     // a disconnected phone keeps its seat this long
const ROOM_TTL_MS = 15 * 60 * 1000;    // room survives this long without a game screen
const COLORS = ['#FF7A1A', '#2EE6A6', '#FF4D8D', '#4DA3FF'];

const rooms = new Map();
const uid = () => crypto.randomBytes(6).toString('hex');
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, n);

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) return n.address;
  }
  return null;
}
function makeCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c;
  do c = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join('');
  while (rooms.has(c));
  return c;
}
const publicPlayer = p => ({ id: p.id, name: p.name, color: p.color, online: p.online });
const playerList = room => [...room.players.values()].map(publicPlayer);

/* ---------------- HTTP ---------------- */
const app = express();
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/api/info', (_req, res) => {
  const ip = lanIp();
  res.json({ lanOrigin: ip ? `${USE_HTTPS ? 'https' : 'http'}://${ip}:${PORT}` : null, https: USE_HTTPS });
});
app.get('/qr.svg', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 300);
  if (!/^https?:\/\//.test(text)) return res.status(400).send('Bad link');
  const svg = await QRCode.toString(text, { type: 'svg', margin: 1, color: { dark: '#14143D', light: '#FFFFFF' } });
  res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
});
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

let server;
if (USE_HTTPS) {
  // Phones only allow motion sensors on secure (https) pages, so for Wi-Fi
  // testing we create a self-signed certificate on the fly.
  const selfsigned = require('selfsigned');
  const ip = lanIp();
  const pems = selfsigned.generate([{ name: 'commonName', value: 'tilt-rush.local' }], {
    days: 365, keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...(ip ? [{ type: 7, ip }] : [])] }],
  });
  server = https.createServer({ key: pems.private, cert: pems.cert }, app);
} else {
  server = http.createServer(app);
}

const io = new Server(server, { pingInterval: 4000, pingTimeout: 6000, perMessageDeflate: false, cors: { origin: '*' } });

/* ---------------- Socket events ---------------- */
io.on('connection', socket => {
  const reply = cb => (typeof cb === 'function' ? cb : () => {});

  /* ---- game screen (laptop) ---- */
  socket.on('game:create', (data, cb) => {
    cb = reply(cb);
    const { code, token } = data || {};
    let room = code && rooms.get(String(code).toUpperCase());
    if (room && room.hostToken === token) {
      if (room.hostSocket && room.hostSocket !== socket.id) io.to(room.hostSocket).emit('game:replaced');
    } else {
      room = { code: makeCode(), hostToken: uid() + uid(), hostSocket: null, hostOnline: false, players: new Map(), ttl: null };
      rooms.set(room.code, room);
    }
    clearTimeout(room.ttl);
    room.hostSocket = socket.id;
    room.hostSock = socket;
    room.hostOnline = true;
    socket.data = { role: 'host', code: room.code };
    io.to('c:' + room.code).emit('host:status', { online: true });
    cb({ ok: true, code: room.code, token: room.hostToken, players: playerList(room) });
  });

  /* ---- controller (phone) ---- */
  socket.on('ctrl:join', (data, cb) => {
    cb = reply(cb);
    const { code, name, pid, token } = data || {};
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room) return cb({ error: 'No game with that code. Check the code on the laptop screen.' });
    let p = pid && room.players.get(pid);
    if (p && p.token === token) {
      clearTimeout(p.grace);
      if (p.online && p.socketId !== socket.id) io.to(p.socketId).emit('ctrl:replaced');
    } else {
      if (room.players.size >= MAX_PLAYERS) return cb({ error: `This game already has ${MAX_PLAYERS} players.` });
      const used = new Set([...room.players.values()].map(x => x.color));
      p = { id: uid(), token: uid() + uid(), color: COLORS.find(c => !used.has(c)) || COLORS[0] };
      room.players.set(p.id, p);
    }
    p.name = clean(name, 14) || p.name || `Player ${room.players.size}`;
    p.online = true;
    p.socketId = socket.id;
    socket.data = { role: 'ctrl', code: room.code, pid: p.id, room };
    socket.join('c:' + room.code);
    if (room.hostOnline) io.to(room.hostSocket).emit('player:join', publicPlayer(p));
    cb({ ok: true, code: room.code, pid: p.id, token: p.token, name: p.name, color: p.color, hostOnline: room.hostOnline });
  });

  // HOT PATH: sensor input, ~60 messages/second per phone.
  // Payload: [seq, steer*100, jumpCount, boost, rttMs].
  // Phones send these as volatile (dropped, not queued, if their Wi-Fi is busy).
  // Here we allow a tiny queue to the game screen but drop packets if it grows,
  // so old input can never pile up and cause lag. The next packet is 16 ms away.
  socket.on('i', d => {
    const room = socket.data.room;
    if (!room || !room.hostOnline || !Array.isArray(d) || d.length !== 5) return;
    const host = room.hostSock;
    if (host && host.connected && host.conn.writeBuffer.length < 8) {
      host.emit('i', [socket.data.pid, d[0], d[1], d[2], d[3], d[4]]);
    }
  });

  socket.on('ctrl:action', (data) => {
    const room = socket.data.room;
    const type = data && data.type;
    if (room && room.hostOnline && ['start', 'restart', 'calibrated'].includes(type)) {
      io.to(room.hostSocket).emit('ctrl:action', { pid: socket.data.pid, type });
    }
  });

  socket.on('ctrl:leave', () => leavePlayer(socket, true));

  /* ---- game -> phone ---- */
  const hostRoom = () => (socket.data.role === 'host' ? rooms.get(socket.data.code) : null);
  socket.on('ack', d => {                       // [pid, seq] lets the phone measure round-trip latency
    const room = hostRoom();
    const p = room && Array.isArray(d) && room.players.get(d[0]);
    if (p && p.online) io.to(p.socketId).volatile.emit('ack', d[1]);
  });
  socket.on('buzz', d => {                      // vibration feedback for one phone
    const room = hostRoom();
    const p = room && d && room.players.get(d.pid);
    if (p && p.online && Array.isArray(d.pattern)) io.to(p.socketId).emit('buzz', d.pattern.slice(0, 10));
  });
  socket.on('state', s => {                     // scores / lives / race status for all phones
    const room = hostRoom();
    if (room && s && typeof s === 'object') socket.to('c:' + room.code).emit('state', s);
  });
  socket.on('game:kick', d => {
    const room = hostRoom();
    const p = room && d && room.players.get(d.pid);
    if (!p) return;
    if (p.online) io.to(p.socketId).emit('ctrl:kicked');
    clearTimeout(p.grace);
    room.players.delete(p.id);
    io.to(room.hostSocket).emit('player:leave', { id: p.id });
  });

  socket.on('disconnect', () => {
    if (socket.data.role === 'host') {
      const room = rooms.get(socket.data.code);
      if (!room || room.hostSocket !== socket.id) return;
      room.hostOnline = false;
      io.to('c:' + room.code).emit('host:status', { online: false });
      room.ttl = setTimeout(() => {
        room.players.forEach(p => clearTimeout(p.grace));
        rooms.delete(room.code);
      }, ROOM_TTL_MS);
    } else if (socket.data.role === 'ctrl') {
      leavePlayer(socket, false);
    }
  });
});

function leavePlayer(socket, explicit) {
  const room = socket.data.room;
  const p = room && room.players.get(socket.data.pid);
  if (!p || p.socketId !== socket.id) return;
  socket.leave('c:' + room.code);
  socket.data = {};
  p.online = false;
  clearTimeout(p.grace);
  const remove = () => {
    room.players.delete(p.id);
    if (room.hostOnline) io.to(room.hostSocket).emit('player:leave', { id: p.id });
  };
  if (explicit) return remove();
  if (room.hostOnline) io.to(room.hostSocket).emit('player:status', { id: p.id, online: false });
  p.grace = setTimeout(remove, PLAYER_GRACE_MS);
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = lanIp(), proto = USE_HTTPS ? 'https' : 'http';
  console.log(`\n🏁 Tilt Rush is running!`);
  console.log(`   Game screen (laptop):  ${proto}://localhost:${PORT}`);
  if (ip) console.log(`   Phones on your Wi-Fi:  ${proto}://${ip}:${PORT}/play`);
  if (!USE_HTTPS) console.log(`   Tip: phones need https for motion sensors. Use "npm run lan" for Wi-Fi testing.`);
  console.log('');
});
