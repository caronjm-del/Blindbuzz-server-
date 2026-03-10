const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ─────────────────────────────────────────────
// In-memory room store
// rooms[code] = {
//   code, players[], round, gameStarted,
//   buzzOrder[], buzzLocked, createdAt
// }
// ─────────────────────────────────────────────
const rooms = {};

// Clean up empty/old rooms every 30min
setInterval(() => {
  const now = Date.now();
  for (const code in rooms) {
    const room = rooms[code];
    const age = now - room.createdAt;
    const empty = room.players.filter(p => p.connected).length === 0;
    if (empty && age > 5 * 60 * 1000) {
      console.log(`[CLEANUP] Removing empty room ${code}`);
      delete rooms[code];
    }
    // Also remove rooms older than 12h
    if (age > 12 * 60 * 60 * 1000) {
      console.log(`[CLEANUP] Removing old room ${code}`);
      delete rooms[code];
    }
  }
}, 30 * 60 * 1000);

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function broadcastRoom(code, event, data) {
  io.to(code).emit(event, data);
}

function getRoomState(code) {
  const room = rooms[code];
  if (!room) return null;
  return {
    code: room.code,
    players: room.players,
    round: room.round,
    gameStarted: room.gameStarted,
    buzzOrder: room.buzzOrder,
    buzzLocked: room.buzzLocked,
  };
}

// ─────────────────────────────────────────────
// REST: Health check
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    rooms: Object.keys(rooms).length,
    uptime: Math.floor(process.uptime()) + 's',
  });
});

app.get('/room/:code', (req, res) => {
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(getRoomState(req.params.code.toUpperCase()));
});

// ─────────────────────────────────────────────
// Socket.io events
// ─────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);

  // ── CREATE ROOM ──────────────────────────
  socket.on('create_room', ({ playerName }, callback) => {
    const code = genCode();
    const playerId = socket.id;

    const player = {
      id: playerId,
      name: playerName,
      color: '#ff3e6c',
      emoji: '🦊',
      score: 0,
      isAdmin: true,
      connected: true,
    };

    rooms[code] = {
      code,
      players: [player],
      round: 1,
      gameStarted: false,
      buzzOrder: [],
      buzzLocked: false,
      createdAt: Date.now(),
    };

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = playerId;

    console.log(`[CREATE] Room ${code} by ${playerName}`);
    callback({ ok: true, roomCode: code, playerId, state: getRoomState(code) });
  });

  // ── JOIN ROOM ────────────────────────────
  socket.on('join_room', ({ roomCode, playerName }, callback) => {
    const code = roomCode.toUpperCase();
    const room = rooms[code];

    if (!room) {
      return callback({ ok: false, error: 'Salle introuvable. Vérifie le code.' });
    }

    // Check duplicate name
    const duplicate = room.players.find(
      p => p.name.toLowerCase() === playerName.toLowerCase() && p.connected
    );
    if (duplicate) {
      return callback({ ok: false, error: 'Ce pseudo est déjà utilisé dans cette salle.' });
    }

    const COLORS = ['#ff3e6c','#ff8c42','#4ecdc4','#45b7d1','#96ceb4','#ffd700','#dda0dd','#98d8c8','#ff9ff3','#54a0ff'];
    const EMOJIS = ['🦊','🐺','🦁','🐯','🦋','🐸','🐙','🦄','🐲','🦅'];
    const idx = room.players.length;

    // Check if player is reconnecting
    const existing = room.players.find(p => p.name.toLowerCase() === playerName.toLowerCase());
    let playerId;

    if (existing) {
      // Reconnect
      existing.id = socket.id;
      existing.connected = true;
      playerId = socket.id;
    } else {
      playerId = socket.id;
      const player = {
        id: playerId,
        name: playerName,
        color: COLORS[idx % COLORS.length],
        emoji: EMOJIS[idx % EMOJIS.length],
        score: 0,
        isAdmin: false,
        connected: true,
      };
      room.players.push(player);
    }

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = playerId;

    console.log(`[JOIN] ${playerName} joined room ${code}`);

    // Notify all players in the room
    broadcastRoom(code, 'room_update', getRoomState(code));

    callback({ ok: true, playerId, state: getRoomState(code) });
  });

  // ── START GAME ───────────────────────────
  socket.on('start_game', (_, callback) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return callback?.({ ok: false, error: 'Room not found' });

    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isAdmin) return callback?.({ ok: false, error: 'Not admin' });

    if (room.players.filter(p => p.connected).length < 2) {
      return callback?.({ ok: false, error: 'Il faut au moins 2 joueurs !' });
    }

    room.gameStarted = true;
    room.round = 1;
    room.buzzOrder = [];
    room.buzzLocked = false;

    console.log(`[START] Room ${code}`);
    broadcastRoom(code, 'game_started', getRoomState(code));
    callback?.({ ok: true });
  });

  // ── BUZZ ─────────────────────────────────
  socket.on('buzz', (_, callback) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || !room.gameStarted) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    // Already buzzed?
    if (room.buzzOrder.find(b => b.id === socket.id)) return;

    // Add to buzz order
    const entry = {
      id: socket.id,
      name: player.name,
      time: Date.now(),
    };
    room.buzzOrder.push(entry);
    room.buzzOrder.sort((a, b) => a.time - b.time);

    // First buzz → +1 point
    if (room.buzzOrder.length === 1) {
      room.buzzLocked = true;
      player.score += 1;
      console.log(`[BUZZ] ${player.name} first in room ${code} (round ${room.round})`);
    }

    broadcastRoom(code, 'room_update', getRoomState(code));
    callback?.({ ok: true, position: room.buzzOrder.findIndex(b => b.id === socket.id) + 1 });
  });

  // ── NEXT ROUND ───────────────────────────
  socket.on('next_round', (_, callback) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isAdmin) return callback?.({ ok: false, error: 'Not admin' });

    room.round += 1;
    room.buzzOrder = [];
    room.buzzLocked = false;

    console.log(`[ROUND] Room ${code} → round ${room.round}`);
    broadcastRoom(code, 'room_update', getRoomState(code));
    callback?.({ ok: true });
  });

  // ── END GAME ─────────────────────────────
  socket.on('end_game', (_, callback) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isAdmin) return callback?.({ ok: false, error: 'Not admin' });

    console.log(`[END] Room ${code}`);
    broadcastRoom(code, 'game_ended', getRoomState(code));
    callback?.({ ok: true });
  });

  // ── RESET GAME ───────────────────────────
  socket.on('reset_game', (_, callback) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isAdmin) return callback?.({ ok: false, error: 'Not admin' });

    room.players.forEach(p => { p.score = 0; });
    room.round = 1;
    room.gameStarted = false;
    room.buzzOrder = [];
    room.buzzLocked = false;

    console.log(`[RESET] Room ${code}`);
    broadcastRoom(code, 'room_update', getRoomState(code));
    callback?.({ ok: true });
  });

  // ── DISCONNECT ───────────────────────────
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.connected = false;
      console.log(`[DISCONNECT] ${player.name} left room ${code}`);
      broadcastRoom(code, 'room_update', getRoomState(code));
    }
  });
});

// ─────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎵 BlindBuzz Server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/\n`);
});
