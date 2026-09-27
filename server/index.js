import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { Game, cleanName, loadWords } from './game.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const WORDS_FILE = process.env.WORDS_FILE || resolve(root, 'words.txt');
const DIST_DIR = resolve(root, 'dist');
// How long a player can be disconnected (e.g. phone screen locked) before they're dropped.
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 10 * 60 * 1000;

// Fail fast on a broken words file rather than at the first round.
console.log(`Loaded ${loadWords(WORDS_FILE).length} words from ${WORDS_FILE}`);

let cachedWords = null;
const game = new Game({
  // Re-read each round so the file can be edited without restarting the container.
  getWords: () => {
    try {
      cachedWords = loadWords(WORDS_FILE);
    } catch (err) {
      console.error(`Could not reload ${WORDS_FILE}, using previous list:`, err.message);
    }
    return cachedWords;
  },
});

const app = express();
app.get('/healthz', (_req, res) => res.send('ok'));
if (existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.get('*', (_req, res) => res.sendFile(resolve(DIST_DIR, 'index.html')));
}

const httpServer = createServer(app);
const io = new Server(httpServer);

// "CODE:playerId" -> pending removal timer, so a reconnect can cancel it.
const removalTimers = new Map();
const timerKey = (room, playerId) => `${room.code}:${playerId}`;

function cancelRemoval(room, playerId) {
  clearTimeout(removalTimers.get(timerKey(room, playerId)));
  removalTimers.delete(timerKey(room, playerId));
}

function broadcast(room) {
  for (const player of room.players.values()) {
    io.to(`player:${room.code}:${player.id}`).emit('state', game.viewFor(room, player.id));
  }
}

function dropPlayer(room, playerId) {
  cancelRemoval(room, playerId);
  game.removePlayer(room, playerId);
  if (game.rooms.has(room.code)) broadcast(room);
}

io.on('connection', (socket) => {
  let room = null;
  let playerId = null;

  const fail = (ack, message) => typeof ack === 'function' && ack({ error: message });

  function attach(targetRoom, id) {
    // Moving to a different room counts as leaving the old one.
    if (room && (room !== targetRoom || playerId !== id)) detach(room !== targetRoom);
    room = targetRoom;
    playerId = id;
    socket.join(`player:${room.code}:${playerId}`);
    cancelRemoval(room, playerId);
    room.players.get(playerId).connected = true;
    broadcast(room);
  }

  function detach(leaving) {
    if (!room) return;
    const r = room;
    const id = playerId;
    socket.leave(`player:${r.code}:${id}`);
    room = null;
    playerId = null;
    const player = r.players.get(id);
    if (!player) return;
    if (leaving) {
      dropPlayer(r, id);
      return;
    }
    // Only mark offline if no other tab/socket for this player is still connected.
    const stillHere = io.sockets.adapter.rooms.get(`player:${r.code}:${id}`)?.size > 0;
    if (stillHere) return;
    player.connected = false;
    broadcast(r);
    removalTimers.set(timerKey(r, id), setTimeout(() => dropPlayer(r, id), DISCONNECT_GRACE_MS));
  }

  socket.on('create', ({ playerId: id, name } = {}, ack) => {
    const clean = cleanName(name);
    if (!id || !clean) return fail(ack, 'Enter your name first');
    const newRoom = game.createRoom(String(id), clean);
    attach(newRoom, String(id));
    ack?.({ code: newRoom.code });
  });

  socket.on('join', ({ playerId: id, name, code } = {}, ack) => {
    const target = game.getRoom(code);
    if (!target) return fail(ack, 'Room not found — check the code');
    if (!id) return fail(ack, 'Missing player id');
    const clean = cleanName(name);
    if (!target.players.has(String(id)) && !clean) return fail(ack, 'Enter your name first');
    game.addPlayer(target, String(id), clean);
    attach(target, String(id));
    ack?.({ code: target.code });
  });

  // Host starts the first round, the impostor's "They got me", and the host's "End game"
  // all do the same thing: deal a fresh word and impostor (or go back to the lobby if
  // too many people have left to play another round).
  socket.on('newRound', (_payload, ack) => {
    if (!room) return fail(ack, 'Not in a room');
    const isHost = room.hostId === playerId;
    const isImpostor = room.round?.impostorId === playerId;
    if (!isHost && !isImpostor) return fail(ack, 'Only the host or the impostor can do that');
    try {
      game.nextRound(room);
    } catch (err) {
      return fail(ack, err.message);
    }
    broadcast(room);
    ack?.({ ok: true });
  });

  socket.on('leave', (_payload, ack) => {
    detach(true);
    ack?.({ ok: true });
  });

  socket.on('disconnect', () => detach(false));
});

httpServer.listen(PORT, () => {
  console.log(`FakerGame listening on http://0.0.0.0:${PORT}`);
});
