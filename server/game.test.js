import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Game, parseWords } from './game.js';

const words = [
  { word: 'Toaster', category: 'Objects' },
  { word: 'Friends', category: 'TV Shows' },
  { word: 'Kettle', category: 'Objects' },
];

function roomWith(n) {
  const game = new Game({ getWords: () => words });
  const room = game.createRoom('p0', 'Host');
  for (let i = 1; i < n; i++) game.addPlayer(room, `p${i}`, `P${i}`);
  return { game, room };
}

test('parses categories and ignores comments', () => {
  const parsed = parseWords('# hi\n[Objects]\nLamp\n\n[Movies]\nJaws\n');
  assert.deepEqual(parsed, [
    { word: 'Lamp', category: 'Objects' },
    { word: 'Jaws', category: 'Movies' },
  ]);
});

test('bundled words.txt has three categories and no duplicates', () => {
  const parsed = parseWords(readFileSync(new URL('../words.txt', import.meta.url), 'utf8'));
  assert.deepEqual([...new Set(parsed.map((e) => e.category))], ['Objects', 'TV Shows', 'Movies']);
  assert.equal(new Set(parsed.map((e) => e.word)).size, parsed.length);
  assert.ok(parsed.length >= 300);
});

test('needs two players to start', () => {
  assert.throws(() => roomWith(1).game.startRound(roomWith(1).room));
  const { game, room } = roomWith(2);
  assert.equal(game.startRound(room).participants.size, 2);
});

test('exactly one impostor, who sees only the category', () => {
  const { game, room } = roomWith(6);
  const round = game.startRound(room);
  const views = [...room.players.keys()].map((id) => game.viewFor(room, id).round);
  const impostors = views.filter((v) => v.role === 'impostor');
  assert.equal(impostors.length, 1);
  assert.equal(impostors[0].word, undefined);
  assert.equal(impostors[0].category, round.category);
  for (const v of views.filter((v) => v.role === 'civilian')) assert.equal(v.word, round.word);
  // Nobody's view reveals who the impostor is.
  assert.ok(!JSON.stringify(game.viewFor(room, 'p0')).includes('impostorId'));
});

test('mid-round joiners see the word and are dealt in next round', () => {
  const { game, room } = roomWith(3);
  game.startRound(room);
  game.addPlayer(room, 'late', 'Late');
  const view = game.viewFor(room, 'late');
  assert.equal(view.round.role, 'waiting');
  assert.equal(view.round.word, room.round.word);
  assert.ok(view.players.find((p) => p.id === 'late').waiting);
  game.startRound(room);
  assert.notEqual(game.viewFor(room, 'late').round.role, 'waiting');
});

test('host passes on when the host leaves; empty rooms are deleted', () => {
  const { game, room } = roomWith(3);
  game.removePlayer(room, 'p0');
  assert.equal(room.hostId, 'p1');
  game.removePlayer(room, 'p1');
  game.removePlayer(room, 'p2');
  assert.equal(game.rooms.size, 0);
});

test('words do not repeat until the list is used up', () => {
  const { game, room } = roomWith(3);
  const a = game.startRound(room).word;
  const b = game.startRound(room).word;
  assert.notEqual(a, b);
  game.startRound(room); // list exhausted -> resets rather than failing
});

test('ending a round with too few players returns to the lobby instead of failing', () => {
  const { game, room } = roomWith(2);
  game.startRound(room);
  room.players.delete('p0'); // simulate a leave without the auto-lobby in removePlayer
  assert.equal(game.nextRound(room), null);
  assert.equal(room.round, null);
  assert.throws(() => game.nextRound(room)); // starting from the lobby still needs 2
});

test('a round drops back to the lobby when players leave below the minimum', () => {
  const { game, room } = roomWith(2);
  game.startRound(room);
  game.removePlayer(room, 'p0');
  assert.equal(room.hostId, 'p1');
  assert.equal(room.round, null);
  assert.equal(game.viewFor(room, 'p1').round, null);
});

test('host-picked category is used for every round until changed', () => {
  const { game, room } = roomWith(2);
  assert.deepEqual(game.viewFor(room, 'p0').categories, ['Objects', 'TV Shows']);
  game.setCategory(room, 'Objects');
  assert.equal(game.viewFor(room, 'p1').category, 'Objects');
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    const r = game.nextRound(room);
    assert.equal(r.category, 'Objects');
    seen.add(r.word);
  }
  assert.deepEqual([...seen].sort(), ['Kettle', 'Toaster']); // cycles within the category
  game.setCategory(room, 'TV Shows');
  assert.equal(game.nextRound(room).word, 'Friends');
});

test('unknown category falls back to random', () => {
  const { game, room } = roomWith(2);
  game.setCategory(room, 'Nope');
  assert.equal(room.category, null);
  game.setCategory(room, 'Objects');
  game.setCategory(room, null);
  assert.equal(room.category, null);
});

test('host ending the game returns everyone to the lobby', () => {
  const { game, room } = roomWith(3);
  game.startRound(room);
  game.endRound(room);
  assert.equal(room.round, null);
  for (const id of room.players.keys()) assert.equal(game.viewFor(room, id).round, null);
  assert.equal(game.startRound(room).number, 1);
});

test('closing a room removes it, without touching a newer room that reuses the code', () => {
  const { game, room } = roomWith(2);
  game.closeRoom(room);
  assert.equal(game.getRoom(room.code), undefined);
  const newer = { code: room.code };
  game.rooms.set(room.code, newer);
  game.removePlayer(room, 'p0');
  game.removePlayer(room, 'p1'); // last player of the closed room leaving
  assert.equal(game.getRoom(room.code), newer);
});

test('must-have titles stay in the word list', () => {
  const parsed = parseWords(readFileSync(new URL('../words.txt', import.meta.url), 'utf8'));
  const has = (word, category) => parsed.some((e) => e.word === word && e.category === category);
  for (const w of ['The Walking Dead', 'Invincible', 'Game of Thrones', 'Breaking Bad']) assert.ok(has(w, 'TV Shows'), w);
  assert.ok(has('Pirates of the Caribbean', 'Movies'));
});

test('new rooms default to Random; the pick survives End game until the room closes', () => {
  const { game, room } = roomWith(2);
  assert.equal(game.viewFor(room, 'p0').category, null); // null = Random
  game.setCategory(room, 'Objects');
  game.startRound(room);
  game.endRound(room);
  assert.equal(game.viewFor(room, 'p1').category, 'Objects');
  game.closeRoom(room);
  const fresh = game.createRoom('p0', 'Host');
  assert.equal(fresh.category, null);
});

test('majority skip vote deals a new word with the same impostor', () => {
  const { game, room } = roomWith(4);
  const first = game.startRound(room);
  assert.equal(game.skipNeeded(room), 3);
  assert.equal(game.voteSkip(room, 'p0'), false);
  assert.equal(game.voteSkip(room, 'p0'), false); // toggled off
  assert.equal(game.viewFor(room, 'p0').round.skip.votes, 0);
  game.voteSkip(room, 'p0');
  game.voteSkip(room, 'p1');
  assert.equal(game.viewFor(room, 'p2').round.skip.votes, 2);
  assert.equal(game.voteSkip(room, 'p2'), true);
  const next = room.round;
  assert.equal(next.number, first.number + 1);
  assert.equal(next.impostorId, first.impostorId);
  assert.notEqual(next.word, first.word);
  assert.equal(next.skipped, true);
  assert.equal(game.viewFor(room, 'p0').round.skip.votes, 0);
});

test('two players both need to vote; late joiners cannot vote', () => {
  const { game, room } = roomWith(2);
  game.startRound(room);
  game.addPlayer(room, 'late', 'Late');
  assert.throws(() => game.voteSkip(room, 'late'));
  assert.equal(game.viewFor(room, 'late').round.skip.canVote, false);
  assert.equal(game.voteSkip(room, 'p0'), false);
  assert.equal(game.voteSkip(room, 'p1'), true);
  assert.equal(room.round.participants.has('late'), true); // dealt in on the new word
});

test('a player leaving can tip existing votes into a majority', () => {
  const { game, room } = roomWith(4);
  const first = game.startRound(room);
  game.voteSkip(room, 'p0');
  game.voteSkip(room, 'p1');
  const leaver = ['p2', 'p3'].find((id) => id !== first.impostorId);
  game.removePlayer(room, leaver); // 3 voters now, 2 votes is a majority
  assert.equal(room.round.number, first.number + 1);
  assert.equal(room.round.impostorId, first.impostorId);
});

// --- Act modes (Hands Up / Face Card / Numbertaker / Mixed) ---

const prompts = {
  handsup: [
    { word: 'can swim', category: 'Clean' },
    { word: 'have been on a plane', category: 'Clean' },
    { word: 'have sent a nude', category: '18+' },
  ],
  facecard: [{ word: 'you stepped on a Lego', category: 'Clean' }],
  numbertaker: [{ word: 'How many pets?', category: 'Clean' }],
};

function actRoom(n, mode = 'handsup') {
  const game = new Game({ getWords: () => words, getPrompts: (k) => prompts[k] });
  const room = game.createRoom('p0', 'Host');
  for (let i = 1; i < n; i++) game.addPlayer(room, `p${i}`, `P${i}`);
  game.setMode(room, mode);
  return { game, room };
}
const civilianOf = (room) => [...room.players.keys()].find((id) => id !== room.round.impostorId);

test('new rooms default to Categories with 18+ off; unknown modes fall back', () => {
  const { game, room } = roomWith(2);
  assert.equal(room.mode, 'categories');
  assert.equal(room.adult, false);
  game.setMode(room, 'nonsense');
  assert.equal(room.mode, 'categories');
});

test('act round: impostor gets no statement until it is revealed to everyone', () => {
  const { game, room } = actRoom(3);
  const round = game.startRound(room);
  assert.equal(round.kind, 'handsup');
  assert.equal(round.phase, 'reading');
  const imp = game.viewFor(room, round.impostorId).round;
  const civ = game.viewFor(room, civilianOf(room)).round;
  assert.equal(imp.prompt, undefined);
  assert.equal(civ.prompt, round.prompt);
  assert.throws(() => game.advance(room)); // can't Next before the reveal
  game.ready(room);
  assert.equal(game.viewFor(room, round.impostorId).round.prompt, undefined); // still hidden while acting
  assert.equal(game.reveal(room, round), true);
  assert.equal(game.viewFor(room, round.impostorId).round.prompt, round.prompt);
});

test('18+ statements only appear when the switch is on', () => {
  const { game, room } = actRoom(2);
  const seen = new Set();
  for (let i = 0; i < 10; i++) seen.add(game.startRound(room).prompt);
  assert.ok(!seen.has('have sent a nude'));
  game.setAdult(room, true);
  for (let i = 0; i < 10; i++) seen.add(game.startRound(room).prompt);
  assert.ok(seen.has('have sent a nude'));
});

test('impostor survives up to 3 rounds, then wins, then a fresh round is dealt', () => {
  const { game, room } = actRoom(3);
  const first = game.startRound(room);
  const imp = first.impostorId;
  for (let streak = 1; streak <= 3; streak++) {
    assert.equal(room.round.streak, streak);
    assert.equal(room.round.impostorId, imp);
    game.ready(room);
    game.reveal(room, room.round);
    game.advance(room);
  }
  assert.equal(room.round.phase, 'impostorWon');
  assert.equal(game.viewFor(room, civilianOf(room)).round.impostorName, room.players.get(imp).name);
  game.advance(room);
  assert.equal(room.round.phase, 'reading');
  assert.equal(room.round.streak, 1);
});

test('They got me resets the streak with a fresh impostor', () => {
  const { game, room } = actRoom(3);
  game.startRound(room);
  game.ready(room);
  game.reveal(room, room.round);
  game.advance(room);
  assert.equal(room.round.streak, 2);
  game.nextRound(room);
  assert.equal(room.round.streak, 1);
});

test('skipping keeps the impostor and does not count towards survival; only before Ready', () => {
  const { game, room } = actRoom(2);
  game.startRound(room);
  game.ready(room);
  game.reveal(room, room.round);
  game.advance(room); // now on survival round 2
  const imp = room.round.impostorId;
  game.voteSkip(room, 'p0');
  game.voteSkip(room, 'p1');
  assert.equal(room.round.skipped, true);
  assert.equal(room.round.streak, 2);
  assert.equal(room.round.impostorId, imp);
  game.ready(room);
  assert.equal(game.viewFor(room, 'p0').round.skip.canVote, false);
  assert.throws(() => game.voteSkip(room, 'p0'));
});

test('a stale reveal timer does nothing once the round has moved on', () => {
  const { game, room } = actRoom(2);
  const old = game.startRound(room);
  game.ready(room);
  game.nextRound(room);
  assert.equal(game.reveal(room, old), false);
  assert.equal(room.round.phase, 'reading');
});

test('Mixed deals only act modes, never Categories', () => {
  const { game, room } = actRoom(2, 'mixed');
  const kinds = new Set();
  for (let i = 0; i < 40; i++) kinds.add(game.startRound(room).kind);
  assert.deepEqual([...kinds].sort(), ['facecard', 'handsup', 'numbertaker']);
});

test('bundled statement files have Clean and 18+ sections', () => {
  for (const file of ['hands-up.txt', 'face-card.txt', 'numbertaker.txt']) {
    const parsed = parseWords(readFileSync(new URL(`../prompts/${file}`, import.meta.url), 'utf8'));
    assert.deepEqual([...new Set(parsed.map((e) => e.category))], ['Clean', '18+'], file);
    assert.equal(new Set(parsed.map((e) => e.word)).size, parsed.length, `${file} has duplicates`);
    assert.ok(parsed.filter((e) => e.category === 'Clean').length >= 50, file);
  }
});
