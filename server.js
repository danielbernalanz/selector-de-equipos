const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const wss = new WebSocketServer({ server });

const rooms = new Map();

function generateCode(len = 5) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < len; i++) code += chars[crypto.randomInt(chars.length)];
  } while (rooms.has(code));
  return code;
}

function token() {
  return crypto.randomBytes(16).toString('hex');
}

function createRoom({ teacherName, className, numTeams, defaultCapacity }) {
  const cap = Math.max(1, Math.min(20, Number(defaultCapacity) || 3));
  const n = Math.max(1, Math.min(30, Number(numTeams) || 4));
  const teams = [];
  for (let i = 1; i <= n; i++) {
    teams.push({ id: i, name: `Equipo ${i}`, capacity: cap, members: [] });
  }
  const room = {
    code: generateCode(),
    teacherName: (teacherName || '').trim().slice(0, 40),
    className: (className || '').trim().slice(0, 60),
    teacherToken: token(),
    teams,
    createdAt: Date.now(),
    clients: new Map(),
  };
  rooms.set(room.code, room);
  return room;
}

function publicRoomState(room) {
  return {
    code: room.code,
    teacherName: room.teacherName,
    className: room.className,
    teams: room.teams.map((t) => ({
      id: t.id,
      name: t.name,
      capacity: t.capacity,
      members: t.members.map((m) => ({ id: m.id, name: m.name })),
    })),
  };
}

function broadcast(room, message) {
  const data = JSON.stringify(message);
  for (const socket of room.clients.keys()) {
    if (socket.readyState === socket.OPEN) socket.send(data);
  }
}

function broadcastRoom(room) {
  broadcast(room, { type: 'room', room: publicRoomState(room) });
}

wss.on('connection', (socket) => {
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  let room = null;
  let role = null;

  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    switch (msg.type) {
      case 'create': {
        if (room || role) return;
        room = createRoom(msg);
        role = 'teacher';
        room.clients.set(socket, { role });
        socket.send(JSON.stringify({
          type: 'ready',
          role: 'teacher',
          code: room.code,
          token: room.teacherToken,
          room: publicRoomState(room),
        }));
        broadcastRoom(room);
        break;
      }

      case 'teacherReconnect': {
        if (room || role) return;
        const r = rooms.get(String(msg.code || '').toUpperCase());
        if (!r || r.teacherToken !== msg.token) {
          socket.send(JSON.stringify({ type: 'error', message: 'Sesión de profesor inválida.' }));
          return;
        }
        room = r;
        role = 'teacher';
        room.clients.set(socket, { role });
        socket.send(JSON.stringify({ type: 'ready', role: 'teacher', code: r.code, token: r.teacherToken, room: publicRoomState(r) }));
        break;
      }

      case 'join': {
        if (room || role) return;
        const r = rooms.get(String(msg.code || '').toUpperCase());
        if (!r) {
          socket.send(JSON.stringify({ type: 'error', message: 'Sala no encontrada. Revisa el código.' }));
          return;
        }
        room = r;
        role = 'student';
        const studentId = String(msg.studentId || token());
        const name = String(msg.name || '').trim().slice(0, 40) || 'Alumno';
        room.clients.set(socket, { role, studentId, name });
        socket.send(JSON.stringify({
          type: 'ready',
          role: 'student',
          studentId,
          room: publicRoomState(r),
        }));
        broadcastRoom(r);
        break;
      }

      case 'joinTeam': {
        if (!room || role !== 'student') return;
        const entry = room.clients.get(socket);
        if (!entry) return;
        const studentId = entry.studentId;
        const team = room.teams.find((t) => t.id === Number(msg.teamId));
        if (!team) return;
        if (team.members.some((m) => m.id === studentId)) return;
        if (team.members.length >= team.capacity) return;
        for (const t of room.teams) {
          t.members = t.members.filter((m) => m.id !== studentId);
        }
        team.members.push({ id: studentId, name: entry.name });
        broadcastRoom(room);
        break;
      }

      case 'leaveTeam': {
        if (!room || role !== 'student') return;
        const entry = room.clients.get(socket);
        if (!entry) return;
        for (const t of room.teams) {
          t.members = t.members.filter((m) => m.id !== entry.studentId);
        }
        broadcastRoom(room);
        break;
      }

      case 'setTeam': {
        if (!room || role !== 'teacher') return;
        const team = room.teams.find((t) => t.id === Number(msg.teamId));
        if (!team) return;
        if (typeof msg.name === 'string' && msg.name.trim().length > 0) {
          team.name = msg.name.trim().slice(0, 40);
        }
        if (typeof msg.capacity === 'number' && Number.isFinite(msg.capacity)) {
          const cap = Math.max(1, Math.min(20, Math.floor(msg.capacity)));
          team.capacity = cap;
          while (team.members.length > team.capacity) {
            team.members.shift();
          }
        }
        broadcastRoom(room);
        break;
      }

      case 'removeMember': {
        if (!room || role !== 'teacher') return;
        for (const t of room.teams) {
          t.members = t.members.filter((m) => m.id !== String(msg.studentId));
        }
        broadcastRoom(room);
        break;
      }

      case 'close': {
        if (!room || role !== 'teacher') return;
        broadcast(room, { type: 'closed' });
        for (const s of room.clients.keys()) s.close();
        rooms.delete(room.code);
        room = null;
        role = null;
        break;
      }
    }
  });

  socket.on('close', () => {
    if (room) {
      room.clients.delete(socket);
      broadcastRoom(room);
      room = null;
      role = null;
    }
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    for (const socket of room.clients.keys()) {
      if (!socket.isAlive) {
        socket.terminate();
        room.clients.delete(socket);
      } else {
        socket.isAlive = false;
        socket.ping();
      }
    }
  }
}, 30000);

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.clients.size === 0 && now - room.createdAt > 6 * 3600 * 1000) {
      rooms.delete(code);
    }
  }
}, 3600 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});