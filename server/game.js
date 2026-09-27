import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const MIN_PLAYERS = 2;
export const MAX_NAME_LENGTH = 20;
// Letters only, without I/O/L so codes are easy to read aloud across a table.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * Parse the words file. Format: `[Category]` header lines, then one word per line.
 * Lines starting with `#` and blank lines are ignored.
 */
export function parseWords(text) {
  const entries = [];
  let category = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      category = header[1].trim();
    } else if (category) {
      entries.push({ word: line, category });
    }
  }
  return entries;
}

export function loadWords(path) {
  const entries = parseWords(readFileSync(path, 'utf8'));
  if (entries.length === 0) throw new Error(`No words found in ${path}`);
  return entries;
}

export function cleanName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

export class Game {
  /** @param {{ getWords: () => {word: string, category: string}[] }} opts */
  constructor({ getWords }) {
    this.getWords = getWords;
    this.rooms = new Map();
  }

  newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  createRoom(playerId, name) {
    const code = this.newCode();
    const room = {
      code,
      hostId: playerId,
      players: new Map(),
      round: null,
      usedWords: new Set(),
      category: null, // null = random across all categories
    };
    this.rooms.set(code, room);
    this.addPlayer(room, playerId, name);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(String(code ?? '').trim().toUpperCase());
  }

  addPlayer(room, playerId, name) {
    const existing = room.players.get(playerId);
    if (existing) {
      if (name) existing.name = name;
      return existing;
    }
    const player = { id: playerId, name, connected: true, joinedAt: Date.now() };
    room.players.set(playerId, player);
    return player;
  }

  removePlayer(room, playerId) {
    room.players.delete(playerId);
    if (room.players.size === 0) {
      this.closeRoom(room);
      return;
    }
    if (room.hostId === playerId) {
      // Hand hosting to whoever has been in the room longest.
      const next = [...room.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      room.hostId = next.id;
    }
    // A round can't carry on without enough players, so send everyone back to the lobby.
    if (room.round && room.players.size < MIN_PLAYERS) room.round = null;
    // Fewer voters can mean the votes already cast are now a majority.
    if (room.round) this.maybeSkip(room);
  }

  /** Host's "End game": everyone goes back to the lobby. */
  endRound(room) {
    room.round = null;
  }

  /** Deletes the room. Only removes it from the map if the code still points at this room. */
  closeRoom(room) {
    room.closed = true;
    if (this.rooms.get(room.code) === room) this.rooms.delete(room.code);
  }

  /** Category names in the order they appear in the words file. */
  categories() {
    return [...new Set(this.getWords().map((e) => e.category))];
  }

  /** Host's pick for upcoming rounds; null (or anything unknown) means random. */
  setCategory(room, category) {
    room.category = this.categories().includes(category) ? category : null;
  }

  pickWord(room) {
    const all = this.getWords();
    let candidates = room.category ? all.filter((e) => e.category === room.category) : all;
    // The category may have been removed from the words file since it was picked.
    if (candidates.length === 0) candidates = all;
    let pool = candidates.filter((e) => !room.usedWords.has(e.word));
    if (pool.length === 0) {
      for (const e of candidates) room.usedWords.delete(e.word);
      pool = candidates;
    }
    const entry = pool[randomInt(pool.length)];
    room.usedWords.add(entry.word);
    return entry;
  }

  /**
   * Starts a fresh round with a new word. The impostor is random unless `impostorId` is given
   * (used by vote-skip, which swaps the word but keeps the same impostor).
   */
  startRound(room, { impostorId = null, skipped = false } = {}) {
    const participants = [...room.players.keys()];
    if (participants.length < MIN_PLAYERS) {
      throw new Error(`Need at least ${MIN_PLAYERS} players to start`);
    }
    const { word, category } = this.pickWord(room);
    room.round = {
      number: (room.round?.number ?? 0) + 1,
      word,
      category,
      impostorId: room.players.has(impostorId) ? impostorId : participants[randomInt(participants.length)],
      participants: new Set(participants),
      skipVotes: new Set(),
      skipped,
    };
    return room.round;
  }

  /** Players who can vote to skip: dealt into this round and still in the room. */
  skipVoters(room) {
    return [...room.round.participants].filter((id) => room.players.has(id));
  }

  /** Strict majority of the players in the round. */
  skipNeeded(room) {
    return Math.floor(this.skipVoters(room).length / 2) + 1;
  }

  /** Toggle a player's skip vote. Returns true if that vote tipped it into a new word. */
  voteSkip(room, playerId) {
    const { round } = room;
    if (!round || !round.participants.has(playerId)) throw new Error('Only players in this round can vote');
    if (round.skipVotes.has(playerId)) round.skipVotes.delete(playerId);
    else round.skipVotes.add(playerId);
    return this.maybeSkip(room);
  }

  /** Once a majority wants to skip: new word, same impostor. */
  maybeSkip(room) {
    const { round } = room;
    if (!round) return false;
    const votes = this.skipVoters(room).filter((id) => round.skipVotes.has(id)).length;
    if (votes < this.skipNeeded(room)) return false;
    this.startRound(room, { impostorId: round.impostorId, skipped: true });
    return true;
  }

  /**
   * "They got me" / "End game": deal the next round, or return to the lobby if there
   * are no longer enough players for one. Returns the new round, or null for the lobby.
   */
  nextRound(room) {
    if (room.round && room.players.size < MIN_PLAYERS) {
      room.round = null;
      return null;
    }
    return this.startRound(room);
  }

  /** The view of the room that one specific player is allowed to see. */
  viewFor(room, playerId) {
    const { round } = room;
    let myRound = null;
    if (round) {
      const inRound = round.participants.has(playerId);
      const base = {
        number: round.number,
        category: round.category,
        skipped: round.skipped,
        skip: {
          votes: this.skipVoters(room).filter((id) => round.skipVotes.has(id)).length,
          needed: this.skipNeeded(room),
          voted: round.skipVotes.has(playerId),
          canVote: inRound,
        },
      };
      if (round.impostorId === playerId) {
        myRound = { ...base, role: 'impostor' };
      } else if (round.participants.has(playerId)) {
        myRound = { ...base, role: 'civilian', word: round.word };
      } else {
        // Joined mid-round: sees the word so they can follow along, never the impostor.
        myRound = { ...base, role: 'waiting', word: round.word };
      }
    }
    return {
      code: room.code,
      meId: playerId,
      hostId: room.hostId,
      minPlayers: MIN_PLAYERS,
      categories: this.categories(),
      category: room.category,
      players: [...room.players.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((p) => ({
          id: p.id,
          name: p.name,
          connected: p.connected,
          waiting: Boolean(round && !round.participants.has(p.id)),
        })),
      round: myRound,
    };
  }
}
