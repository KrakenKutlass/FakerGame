import { createServer } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { Game, cleanName, loadWords } from './game.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const WORDS_FILE = process.env.WORDS_FILE || resolve(root, 'words.txt');
const PROMPTS_DIR = process.env.PROMPTS_DIR || resolve(root, 'prompts');
const PROMPT_FILES = { handsup: 'hands-up.txt', facecard: 'face-card.txt', numbertaker: 'numbertaker.txt' };
// After the host taps Ready: 3-2-1 countdown, then time to act, then the statement is revealed.
const ACT_REVEAL_MS = 8000;
const DIST_DIR = resolve(root, 'dist');
// How long a player can be disconnected (e.g. phone screen locked) before they're dropped.
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 10 * 60 * 1000;

// Fail fast on a broken words file rather than at the first round.
console.log(`Loaded ${loadWords(WORDS_FILE).length} words from ${WORDS_FILE}`);
for (const file of Object.values(PROMPT_FILES)) loadWords(resolve(PROMPTS_DIR, file));

// Re-read a list whenever its file changes so it can be edited without restarting the container.
function watchedList(path) {
  let cached = null;
  let cachedMtime = 0;
  return () => {
    try {
      const { mtimeMs } = statSync(path);
      if (!cached || mtimeMs !== cachedMtime) {
        cached = loadWords(path);
        cachedMtime = mtimeMs;
      }
    } catch (err) {
      console.error(`Could not reload ${path}, using previous list:`, err.message);
    }
    return cached ?? [];
  };
}

const promptLists = Object.fromEntries(
  Object.entries(PROMPT_FILES).map(([kind, file]) => [kind, watchedList(resolve(PROMPTS_DIR, file))]),
);
for (const [kind, file] of Object.entries(PROMPT_FILES)) {
  console.log(`Loaded ${promptLists[kind]().length} ${kind} statements from ${file}`);
}

const game = new Game({
  getWords: watchedList(WORDS_FILE),
  getPrompts: (kind) => promptLists[kind]?.() ?? [],
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

  // Drop our reference if the host closed the room out from under this connection.
  function current() {
    if (room?.closed) {
      room = null;
      playerId = null;
    }
    return room;
  }

  function attach(targetRoom, id) {
    current();
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
    if (!current()) return;
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

  // Host's "Start game" from the lobby, or the impostor's "They got me" mid-round: deal a
  // fresh word and impostor (or go back to the lobby if too many people have left).
  socket.on('newRound', (_payload, ack) => {
    if (!current()) return fail(ack, 'Not in a room');
    const hostStarting = room.hostId === playerId && !room.round;
    const isImpostor = room.round?.impostorId === playerId;
    if (!hostStarting && !isImpostor) return fail(ack, 'Only the impostor can do that');
    try {
      game.nextRound(room);
    } catch (err) {
      return fail(ack, err.message);
    }
    broadcast(room);
    ack?.({ ok: true });
  });

  // Anyone in the round can vote to skip the word; a majority deals a new word, same impostor.
  socket.on('voteSkip', (_payload, ack) => {
    if (!current()) return fail(ack, 'Not in a room');
    try {
      game.voteSkip(room, playerId);
    } catch (err) {
      return fail(ack, err.message);
    }
    broadcast(room);
    ack?.({ ok: true });
  });

  // Host's "End game": everyone back to the lobby.
  socket.on('endGame', (_payload, ack) => {
    if (!current()) return fail(ack, 'Not in a room');
    if (room.hostId !== playerId) return fail(ack, 'Only the host can end the game');
    game.endRound(room);
    broadcast(room);
    ack?.({ ok: true });
  });

  // Host's "Close room": everyone is sent back to the home screen and the code stops working.
  socket.on('closeRoom', (_payload, ack) => {
    if (!current()) return fail(ack, 'Not in a room');
    if (room.hostId !== playerId) return fail(ack, 'Only the host can close the room');
    const closing = room;
    for (const id of closing.players.keys()) {
      const channel = `player:${closing.code}:${id}`;
      io.to(channel).emit('closed');
      io.in(channel).socketsLeave(channel);
      cancelRemoval(closing, id);
    }
    game.closeRoom(closing);
    current();
    ack?.({ ok: true });
  });

  // Host's lobby settings for the act modes.
  socket.on('setMode', ({ mode } = {}, ack) => {
    if (!current()) return fail(ack, 'Not in a room');
    if (room.hostId !== playerId) return fail(ack, 'Only the host can pick the mode');
    if (room.round) return fail(ack, 'End the game to change the mode');
    game.setMode(room, mode);
    broadcast(room);
    ack?.({ ok: true });
  });

  socket.on('setAdult', ({ adult } = {}, ack) => {
    if (!current()) return fail(ack, 'Not in a room');
    if (room.hostId !== playerId) return fail(ack, 'Only the host can change that');
    if (room.round) return fail(ack, 'End the game to change that');
    game.setAdult(room, adult);
    broadcast(room);
    ack?.({ ok: true });
  });

  // Host's Ready in the act modes: everyone acts, then the statement is revealed to all.
  socket.on('ready', (_payload, ack) => {
    if (!current()) return fail(ack, 'Not in a room');
    if (room.hostId !== playerId) return fail(ack, 'Only the host can do that');
    let round;
    try {
      round = game.ready(room);
    } catch (err) {
      return fail(ack, err.message);
    }
    broadcast(room);
    const r = room;
    setTimeout(() => {
      if (!r.closed && game.reveal(r, round)) broadcast(r);
    }, ACT_REVEAL_MS);
    ack?.({ ok: true });
  });

  // Host's Next in the act modes: same impostor survives into the next round, or impostor won.
  socket.on('next', (_payload, ack) => {
    if (!current()) return fail(ack, 'Not in a room');
    if (room.hostId !== playerId) return fail(ack, 'Only the host can do that');
    try {
      game.advance(room);
    } catch (err) {
      return fail(ack, err.message);
    }
    broadcast(room);
    ack?.({ ok: true });
  });

  // Host picks the category in the lobby (null = random). Locked while a game is running.
  socket.on('setCategory', ({ category } = {}, ack) => {
    if (!current()) return fail(ack, 'Not in a room');
    if (room.hostId !== playerId) return fail(ack, 'Only the host can pick the category');
    if (room.round) return fail(ack, 'End the game to change the category');
    game.setCategory(room, category ?? null);
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
