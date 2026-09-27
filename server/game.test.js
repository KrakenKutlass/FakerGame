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
