import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Game, parseWords } from './game.js';

const words = [
  { word: 'Toaster', category: 'Objects' },
  { word: 'Friends', category: 'TV Shows' },
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

test('needs three players to start', () => {
  const { game, room } = roomWith(2);
  assert.throws(() => game.startRound(room));
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
