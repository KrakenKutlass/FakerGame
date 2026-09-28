# Faker

A phone-in-hand party game for playing **Impostor / Faking It** around a table.

Everyone joins the same room on their phone. Each round, every player gets the same secret word or statement
except one random player, the **impostor**, who has to blend in without it.

## Modes

- **Categories**: everyone gets the same word; the impostor only sees its category. Take turns saying
  something about the word and try to spot the faker.
- **Hands Up**: everyone but the impostor gets a "Raise your hand if you..." statement.
- **Face Card**: everyone but the impostor gets a "Pull the face you'd pull if..." scenario.
- **Numbertaker**: everyone but the impostor gets a question with a 0–10 answer to hold up on their fingers.
- **Mixed**: a random one of Hands Up, Face Card and Numbertaker each round. (Categories is standalone.)

In Hands Up, Face Card and Numbertaker, everyone reads their card, then the host taps **Ready**. Every phone
counts down 3-2-1 and everyone acts at once. A few seconds later the statement is shown to everyone, impostor
included, so you can argue about who got it wrong. The host taps **Next round** to carry on. The impostor stays
the same until they're caught (**They got me**); if they survive 3 rounds, every phone shows **Impostor won!**
and the next round has a new impostor. The host can switch on **18+ statements** in the lobby.

## How to play

1. One person enters their name and taps **Create a new room**. They become the host.
2. Everyone else scans the QR code (tap the QR button next to the room code) and just enters their name, or
   types the 4-letter room code on the home page.
3. The host picks a mode (and a category, or the 18+ switch) and, with at least 2 players, taps
   **Start game**. These stay the same for the whole game.
4. Tap your card to reveal it (and tap again to hide it).
5. When the impostor is caught, the impostor taps **They got me**. That deals a new round straight away, with
   a new word and a new random impostor. The same person can be the impostor twice in a row.
   If the word's a dud, anyone can tap **Skip word**. Once more than half the players have voted, everyone
   gets a new word from the same category and the impostor stays the same. In the other modes you can skip a
   statement before the host taps Ready; a skipped statement doesn't count towards the impostor's 3 rounds.
6. The host can tap **End game** at any time to send everyone back to the lobby. From there they can pick a
   different category and start again, or tap **Close room** to shut the room and send everyone home.

**Spectators:** switch on **Join as spectator** when joining to use a device (like a TV) as a shared screen.
A spectator is never dealt in and only shows what everyone can already see: the join QR code in the lobby, the
category in Categories, the countdown and the statement once it's revealed in the other modes, skips, and
"Impostor won!". Spectators don't count towards the player minimum, and the room closes if only spectators are
left.

People who join mid-round are shown the word (never the impostor) and are dealt in from the next round.
Refreshing the page or locking your phone doesn't lose your place. You rejoin automatically, and players are
only removed after 10 minutes offline.

## Running with Docker

```sh
docker compose up -d --build
```

Then open `http://<your-server>:3000` on everyone's phones. To use a different port, change the left side of
`ports` in `docker-compose.yml`.

Or without compose:

```sh
docker build -t faker .
docker run -d -p 3000:3000 --restart unless-stopped --name faker faker
```

The QR code points at whatever address the host's phone used to open the site, so open it using an address
everyone else's phone can reach too (e.g. `http://192.168.1.20:3000`, not `localhost`).

If you put it behind a reverse proxy (nginx, Traefik, Caddy, etc.), make sure WebSocket upgrades are allowed
on `/socket.io/`.

### Environment variables

| Variable              | Default          | Description                                           |
| --------------------- | ---------------- | ----------------------------------------------------- |
| `PORT`                | `3000`           | Port the server listens on inside the container       |
| `WORDS_FILE`          | `/app/words.txt` | Path to the word list                                 |
| `PROMPTS_DIR`         | `/app/prompts`   | Folder with the Hands Up/Face Card/Numbertaker lists  |
| `DISCONNECT_GRACE_MS` | `600000`         | How long a disconnected player is kept before removal |

## Editing the word list

`words.txt` holds the words grouped by category:

```
[Movies]
Jaws
Titanic
```

The category name is what the impostor sees. You can add new categories, and they appear in the host's category picker automatically. The file is re-read at the start of
every round, and `docker-compose.yml` mounts it from the host, so edits take effect without a rebuild.

## Editing the statements

The statements for the other modes live in `prompts/`: `hands-up.txt` (each line finishes "Raise your hand if
you..."), `face-card.txt` (finishes "Pull the face you'd pull if...") and `numbertaker.txt` (full questions,
answered 0–10). Each file has a `[Clean]` section and an `[18+]` section, which is only used when the host
turns on 18+ statements. Like `words.txt`, edits take effect without a rebuild.

## Development

```sh
npm install
npm run dev                  # server on :3000 and Vite on :5173 (open :5173, also reachable on your LAN)
npm test                     # game logic tests
npm run build && npm start   # production build served from :3000
```

The code is a React (Vite) client in `client/` and an Express and Socket.IO server in `server/`. Room state
is kept in memory, so restarting the container clears all rooms.
