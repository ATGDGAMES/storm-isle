// Storm Isle LAN server. No installs needed: just run  node server.js
// Then open http://localhost:3000 on this computer. Friends on your Wi-Fi open http://<your-ip>:3000
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const PORT = +process.env.PORT || 3000, GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const clients = new Map();
let nextId = 1;
const newWorld = r => { r.seed = Math.floor(Math.random() * 1e9); r.map = Math.floor(Math.random() * 4); };
const ROOMS = { ffa: { target: 15, max: 8 }, '1v1': { target: 5, max: 2 } };
Object.values(ROOMS).forEach(newWorld);

const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, 'storm-isle-lan.html'), (err, data) => {
    if (err) { res.writeHead(500); res.end('storm-isle-lan.html must be in the same folder as server.js'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(data);
  });
});

function frame(obj) {
  const p = Buffer.from(JSON.stringify(obj));
  const h = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
  return Buffer.concat([h, p]);
}
function send(c, obj) { if (c && !c.sock.destroyed) c.sock.write(frame(obj)); }
function inRoom(room) { return [...clients.values()].filter(o => o.room === room); }
function broadcast(room, obj, except) { const f = frame(obj); for (const c of inRoom(room)) if (c !== except && !c.sock.destroyed) c.sock.write(f); }

function readFrame(c) {
  const b = c.buf; if (b.length < 2) return null;
  const op = b[0] & 15; let len = b[1] & 127, off = 2;
  if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
  const masked = b[1] & 128;
  if (b.length < off + (masked ? 4 : 0) + len) return null;
  let mask; if (masked) { mask = b.slice(off, off + 4); off += 4; }
  const p = Buffer.from(b.slice(off, off + len));
  if (masked) for (let i = 0; i < len; i++) p[i] ^= mask[i & 3];
  c.buf = b.slice(off + len);
  return { op, text: p.toString() };
}

function onMsg(c, text) {
  let m; try { m = JSON.parse(text); } catch (e) { return; }
  if (m.t === 'join') {
    const name = ROOMS[m.room] ? m.room : 'ffa', R = ROOMS[name];
    if (inRoom(name).length >= R.max) { send(c, { t: 'full' }); return; }
    c.room = name; c.skin = String(m.skin || 'rookie').slice(0, 20); c.kills = 0;
    send(c, { t: 'welcome', id: c.id, seed: R.seed, map: R.map, target: R.target,
      players: inRoom(name).filter(o => o !== c).map(o => ({ id: o.id, skin: o.skin })) });
    broadcast(name, { t: 'join', id: c.id, skin: c.skin }, c);
    return;
  }
  if (!c.room) return;
  if (m.t === 's') broadcast(c.room, { t: 's', id: c.id, x: m.x, y: m.y, z: m.z, yaw: m.yaw, mv: m.mv, sl: m.sl }, c);
  else if (m.t === 'tr') broadcast(c.room, { t: 'tr', a: m.a, b: m.b }, c);
  else if (m.t === 'hit') { const to = clients.get(m.to); if (to && to.room === c.room) send(to, { t: 'hit', dmg: Math.max(0, Math.min(200, +m.dmg || 0)), by: c.id }); }
  else if (m.t === 'die') {
    const k = clients.get(m.by), R = ROOMS[c.room];
    if (k && k !== c && k.room === c.room) {
      k.kills++;
      broadcast(c.room, { t: 'kill', by: k.id, victim: c.id, kills: k.kills });
      if (k.kills >= R.target) {
        broadcast(c.room, { t: 'round', winner: k.id, target: R.target });
        inRoom(c.room).forEach(o => o.kills = 0);
        newWorld(R);
      }
    } else broadcast(c.room, { t: 'kill', by: 0, victim: c.id, kills: 0 });
  }
}
function drop(c) { if (clients.delete(c.id) && c.room) broadcast(c.room, { t: 'leave', id: c.id }); }

server.on('upgrade', (req, sock) => {
  if (req.url !== '/ws') { sock.destroy(); return; }
  const acc = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  const c = { id: nextId++, sock, room: null, skin: 'rookie', kills: 0, buf: Buffer.alloc(0) };
  clients.set(c.id, c);
  sock.on('data', d => { c.buf = Buffer.concat([c.buf, d]); let f; while ((f = readFrame(c)) !== null) { if (f.op === 8) { sock.end(); return; } if (f.op === 1) onMsg(c, f.text); } });
  sock.on('close', () => drop(c)); sock.on('error', () => drop(c));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Storm Isle LAN server running.');
  console.log('  You:      http://localhost:' + PORT);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list) if (i.family === 'IPv4' && !i.internal) console.log('  Friends:  http://' + i.address + ':' + PORT);
  console.log('In the lobby choose LAN Arena or LAN 1v1 and press Play. Ctrl+C stops the server.');
});
