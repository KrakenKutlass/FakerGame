import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const MIN_PLAYERS = 2;
export const MAX_NAME_LENGTH = 20;
// Modes where everyone acts at once (after the host taps Ready) instead of describing a word.
export const ACT_MODES = ['handsup', 'facecard', 'numbertaker'];
// Categories is standalone; Mixed deals a random act mode each round.
export const MODES = ['categories', ...ACT_MODES, 'mixed'];
// In act modes the impostor wins by surviving this many rounds in a row.
export const SURVIVAL_ROUNDS = 3;
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
  /**
   * @param {{
   *   getWords: () => {word: string, category: string}[],
   *   getPrompts?: (kind: string) => {word: string, category: string}[],
   * }} opts  getPrompts entries use category "Clean" or "18+".
   */
  constructor({ getWords, getPrompts = () => [] }) {
    this.getWords = getWords;
    this.getPrompts = getPrompts;
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
      usedPrompts: new Set(),
      category: null, // null = random across all categories
      mode: 'categories',
      adult: false, // 18+ statements in the act modes
    };
    this.rooms.set(code, room);
    this.addPlayer(room, playerId, name);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(String(code ?? '').trim().toUpperCase());
  }

  /**
   * Adds a player, or updates the name of one rejoining. Spectators (e.g. a TV) only ever see
   * public information and are never dealt in, voted, or made host. Rejoining keeps the role.
   */
  addPlayer(room, playerId, name, { spectator = false } = {}) {
    const existing = room.players.get(playerId);
    if (existing) {
      if (name) existing.name = name;
      return existing;
    }
    const player = { id: playerId, name, connected: true, joinedAt: Date.now(), spectator: Boolean(spectator) };
    room.players.set(playerId, player);
    return player;
  }

  /** Everyone who actually plays (not spectators), longest-in-room first. */
  activePlayers(room) {
    return [...room.players.values()].filter((p) => !p.spectator).sort((a, b) => a.joinedAt - b.joinedAt);
  }

  removePlayer(room, playerId) {
    room.players.delete(playerId);
    const active = this.activePlayers(room);
    // Nobody left to play (maybe just a TV spectator): the room is done.
    if (active.length === 0) {
      this.closeRoom(room);
      return;
    }
    // Hand hosting to whoever has been in the room longest.
    if (room.hostId === playerId) room.hostId = active[0].id;
    // A round can't carry on without enough players, so send everyone back to the lobby.
    if (room.round && active.length < MIN_PLAYERS) room.round = null;
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

  /** Host's game mode, lobby only. Unknown values fall back to Categories. */
  setMode(room, mode) {
    room.mode = MODES.includes(mode) ? mode : 'categories';
  }

  setAdult(room, adult) {
    room.adult = Boolean(adult);
  }

  pickPrompt(room, kind) {
    const all = this.getPrompts(kind);
    let candidates = all.filter((e) => room.adult || e.category !== '18+');
    if (candidates.length === 0) candidates = all;
    if (candidates.length === 0) throw new Error(`No statements found for ${kind}`);
    const key = (e) => `${kind}:${e.word}`;
    let pool = candidates.filter((e) => !room.usedPrompts.has(key(e)));
    if (pool.length === 0) {
      for (const e of candidates) room.usedPrompts.delete(key(e));
      pool = candidates;
    }
    const entry = pool[randomInt(pool.length)];
    room.usedPrompts.add(key(entry));
    return entry.word;
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
   * Deals a fresh round. The impostor is random unless `impostorId` is given and still here
   * (vote-skip and surviving an act-mode round keep the same impostor). `streak` is which of
   * the impostor's survival rounds this is in the act modes; it resets with a new impostor.
   */
  startRound(room, { impostorId = null, skipped = false, streak = 1 } = {}) {
    const participants = this.activePlayers(room).map((p) => p.id);
    if (participants.length < MIN_PLAYERS) {
      throw new Error(`Need at least ${MIN_PLAYERS} players to start`);
    }
    const keepImpostor = room.players.has(impostorId);
    const base = {
      number: (room.round?.number ?? 0) + 1,
      impostorId: keepImpostor ? impostorId : participants[randomInt(participants.length)],
      participants: new Set(participants),
      skipVotes: new Set(),
      skipped,
    };
    if (room.mode === 'categories') {
      const { word, category } = this.pickWord(room);
      room.round = { ...base, kind: 'categories', word, category };
    } else {
      const kind = room.mode === 'mixed' ? ACT_MODES[randomInt(ACT_MODES.length)] : room.mode;
      room.round = {
        ...base,
        kind,
        prompt: this.pickPrompt(room, kind),
        // reading -> (host Ready) acting -> (timer) revealed -> (host Next) next round / impostorWon
        phase: 'reading',
        streak: keepImpostor ? streak : 1,
      };
    }
    return room.round;
  }

  isActRound(round) {
    return Boolean(round && ACT_MODES.includes(round.kind));
  }

  /** Host's Ready: everyone acts on their statement at once. */
  ready(room) {
    const { round } = room;
    if (!this.isActRound(round) || round.phase !== 'reading') throw new Error('Nothing to get ready for');
    round.phase = 'acting';
    round.skipVotes.clear();
    return round;
  }

  /** After the act, the statement is shown to everyone. No-op if the round has moved on. */
  reveal(room, round) {
    if (room.round !== round || round.phase !== 'acting') return false;
    round.phase = 'revealed';
    return true;
  }

  /**
   * Host's Next in the act modes. After a revealed round the impostor survives into their next
   * round, until they've survived SURVIVAL_ROUNDS and win; after that a fresh impostor is dealt.
   */
  advance(room) {
    const { round } = room;
    if (!this.isActRound(round)) throw new Error('Not in an act round');
    if (round.phase === 'revealed') {
      if (round.streak >= SURVIVAL_ROUNDS && room.players.has(round.impostorId)) {
        round.phase = 'impostorWon';
        return room.round;
      }
      if (this.activePlayers(room).length < MIN_PLAYERS) return this.nextRound(room);
      return this.startRound(room, { impostorId: round.impostorId, streak: round.streak + 1 });
    }
    if (round.phase === 'impostorWon') return this.nextRound(room);
    throw new Error('Wait until the statement has been revealed');
  }

  /** Players who can vote to skip: dealt into this round and still in the room. */
  skipVoters(room) {
    return [...room.round.participants].filter((id) => room.players.has(id));
  }

  /** Strict majority of the players in the round. */
  skipNeeded(room) {
    return Math.floor(this.skipVoters(room).length / 2) + 1;
  }

  /** Skipping only makes sense before anyone has acted on the statement. */
  canSkip(round) {
    return Boolean(round) && (!this.isActRound(round) || round.phase === 'reading');
  }

  /** Toggle a player's skip vote. Returns true if that vote tipped it into a new word. */
  voteSkip(room, playerId) {
    const { round } = room;
    if (!round || !round.participants.has(playerId)) throw new Error('Only players in this round can vote');
    if (!this.canSkip(round)) throw new Error('Too late to skip this one');
    if (round.skipVotes.has(playerId)) round.skipVotes.delete(playerId);
    else round.skipVotes.add(playerId);
    return this.maybeSkip(room);
  }

  /** Once a majority wants to skip: new word, same impostor. */
  maybeSkip(room) {
    const { round } = room;
    if (!this.canSkip(round)) return false;
    const votes = this.skipVoters(room).filter((id) => round.skipVotes.has(id)).length;
    if (votes < this.skipNeeded(room)) return false;
    // A skipped statement doesn't count towards the impostor's survival rounds.
    this.startRound(room, { impostorId: round.impostorId, skipped: true, streak: round.streak });
    return true;
  }

  /**
   * "They got me" / "End game": deal the next round, or return to the lobby if there
   * are no longer enough players for one. Returns the new round, or null for the lobby.
   */
  nextRound(room) {
    if (room.round && this.activePlayers(room).length < MIN_PLAYERS) {
      room.round = null;
      return null;
    }
    return this.startRound(room);
  }

  /**
   * What a spectator (the TV) sees: only what everyone at the table already knows. Never the
   * word, never the impostor, and an act-mode statement only once it's been revealed to all.
   */
  publicRoundView(room) {
    const { round } = room;
    const view = {
      number: round.number,
      kind: round.kind,
      role: 'spectator',
      skipped: round.skipped,
      skip: {
        votes: this.skipVoters(room).filter((id) => round.skipVotes.has(id)).length,
        needed: this.skipNeeded(room),
        voted: false,
        canVote: false,
      },
    };
    if (!this.isActRound(round)) return { ...view, category: round.category };
    const public_ = round.phase === 'revealed' || round.phase === 'impostorWon';
    return {
      ...view,
      phase: round.phase,
      streak: round.streak,
      maxStreak: SURVIVAL_ROUNDS,
      prompt: public_ ? round.prompt : undefined,
      impostorName: round.phase === 'impostorWon' ? room.players.get(round.impostorId)?.name : undefined,
    };
  }

  /** The view of the room that one specific player is allowed to see. */
  viewFor(room, playerId) {
    const { round } = room;
    const spectator = Boolean(room.players.get(playerId)?.spectator);
    let myRound = null;
    if (round && spectator) {
      myRound = this.publicRoundView(room);
    } else if (round) {
      const inRound = round.participants.has(playerId);
      const base = {
        number: round.number,
        kind: round.kind,
        category: round.category,
        skipped: round.skipped,
        skip: {
          votes: this.skipVoters(room).filter((id) => round.skipVotes.has(id)).length,
          needed: this.skipNeeded(room),
          voted: round.skipVotes.has(playerId),
          canVote: inRound && this.canSkip(round),
        },
      };
      const role = round.impostorId === playerId ? 'impostor' : inRound ? 'civilian' : 'waiting';
      if (this.isActRound(round)) {
        const public_ = round.phase === 'revealed' || round.phase === 'impostorWon';
        myRound = {
          ...base,
          role,
          phase: round.phase,
          streak: round.streak,
          maxStreak: SURVIVAL_ROUNDS,
          // The impostor only learns the statement once it's shown to everyone.
          prompt: role !== 'impostor' || public_ ? round.prompt : undefined,
          impostorName: round.phase === 'impostorWon' ? room.players.get(round.impostorId)?.name : undefined,
        };
      } else if (role === 'impostor') {
        myRound = { ...base, role };
      } else {
        // Late joiners ('waiting') see the word so they can follow along, never the impostor.
        myRound = { ...base, role, word: round.word };
      }
    }
    return {
      code: room.code,
      meId: playerId,
      hostId: room.hostId,
      minPlayers: MIN_PLAYERS,
      categories: this.categories(),
      category: room.category,
      modes: MODES,
      mode: room.mode,
      adult: room.adult,
      spectator,
      players: [...room.players.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((p) => ({
          id: p.id,
          name: p.name,
          connected: p.connected,
          spectator: Boolean(p.spectator),
          waiting: Boolean(round && !p.spectator && !round.participants.has(p.id)),
        })),
      round: myRound,
    };
  }
}
