# Faker

A phone-in-hand party game for playing **Impostor / Faking It** around a table.

Everyone joins the same room on their phone. Each round, every player gets the same secret word except one
random player, the **impostor**, who only sees *"You are the impostor, blend in"* and the word's category.
Take turns saying something about the word and try to spot the faker.

## How to play

1. One person enters their name and taps **Create a new room**. They become the host.
2. Everyone else scans the QR code (tap the QR button next to the room code) and just enters their name, or
   types the 4-letter room code on the home page.
3. With at least 2 players, the host taps **Start game**.
4. Tap your card to reveal it (and tap again to hide it).
5. When the impostor is caught, the impostor taps **They got me**. The host can also tap **End game** at any
   time. Both deal a new round straight away, with a new word and a new random impostor. The same person can
   be the impostor twice in a row.

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
| `DISCONNECT_GRACE_MS` | `600000`         | How long a disconnected player is kept before removal |

## Editing the word list

`words.txt` holds the words grouped by category:

```
[Movies]
Jaws
Titanic
```

The category name is what the impostor sees. You can add new categories. The file is re-read at the start of
every round, and `docker-compose.yml` mounts it from the host, so edits take effect without a rebuild.

## Development

```sh
npm install
npm run dev                  # server on :3000 and Vite on :5173 (open :5173, also reachable on your LAN)
npm test                     # game logic tests
npm run build && npm start   # production build served from :3000
```

The code is a React (Vite) client in `client/` and an Express and Socket.IO server in `server/`. Room state
is kept in memory, so restarting the container clears all rooms.
