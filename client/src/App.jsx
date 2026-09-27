import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import QRCode from 'qrcode';

const socket = io({ autoConnect: false });

// localStorage can throw (private mode, blocked storage) — the game must still work without it.
const storage = {
  get(key) {
    try {
      return localStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  },
  set(key, value) {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

// crypto.randomUUID only exists on HTTPS, and a self-hosted server is often plain HTTP.
function makeId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function getPlayerId() {
  let id = storage.get('faker.playerId');
  if (!id) {
    id = makeId();
    storage.set('faker.playerId', id);
  }
  return id;
}

const playerId = getPlayerId();

// Room code from an invite link / QR code (e.g. /?room=ABCD). Cleared once used, so leaving
// or a closed room doesn't land you back on that invite.
let inviteCode = (new URLSearchParams(window.location.search).get('room') || '')
  .toUpperCase()
  .replace(/[^A-Z]/g, '')
  .slice(0, 4);

function inviteUrl(code) {
  return `${window.location.origin}/?room=${code}`;
}

function emit(event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

export default function App() {
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [name, setName] = useState(() => storage.get('faker.name'));

  useEffect(() => {
    const onConnect = async () => {
      setConnected(true);
      // Rejoin automatically after a refresh or when a locked phone wakes up.
      const code = storage.get('faker.room');
      // A scanned invite to a different room wins over the last room we were in.
      if (code && (!inviteCode || inviteCode === code)) {
        const res = await emit('join', { playerId, code, name: storage.get('faker.name') });
        if (res?.error) {
          storage.set('faker.room', '');
          setState(null);
        }
      }
    };
    const onDisconnect = () => setConnected(false);
    const onState = (next) => {
      setState(next);
      storage.set('faker.room', next.code);
      // Drop ?room= once we're in, so a later refresh doesn't pull us back to an old invite.
      inviteCode = '';
      if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
    };
    const onClosed = () => {
      storage.set('faker.room', '');
      setState(null);
      setInfo('The host closed the room');
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('state', onState);
    socket.on('closed', onClosed);
    socket.connect();
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('state', onState);
      socket.off('closed', onClosed);
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!error && !info) return;
    const t = setTimeout(() => {
      setError('');
      setInfo('');
    }, 4000);
    return () => clearTimeout(t);
  }, [error, info]);

  const run = useCallback(async (event, payload) => {
    const res = await emit(event, payload);
    if (res?.error) setError(res.error);
    return res;
  }, []);

  const saveName = (value) => {
    setName(value);
    storage.set('faker.name', value.trim());
  };

  const leave = async () => {
    storage.set('faker.room', '');
    await run('leave');
    setState(null);
  };

  return (
    <div className="app">
      {!connected && <div className="banner">Connecting…</div>}
      <img className="site-logo" src="/gamenite-logo.png" alt="GameNite" draggable="false" />
      {state ? (
        <Room state={state} run={run} onLeave={leave} />
      ) : (
        <Home
          name={name}
          setName={saveName}
          disabled={!connected}
          onCreate={() => run('create', { playerId, name })}
          onJoin={(code) => run('join', { playerId, name, code })}
        />
      )}
      {(error || info) && (
        <div
          className={`toast ${error ? '' : 'info'}`}
          role={error ? 'alert' : 'status'}
          onClick={() => {
            setError('');
            setInfo('');
          }}
        >
          {error || info}
        </div>
      )}
    </div>
  );
}

function Home({ name, setName, disabled, onCreate, onJoin }) {
  const [code, setCode] = useState(inviteCode);
  const [invited, setInvited] = useState(inviteCode.length === 4);
  const hasName = name.trim().length > 0;

  if (invited) {
    return (
      <main className="home">
        <header className="brand">
          <div className="logo" aria-hidden="true">🕵️</div>
          <h1>Faker</h1>
          <p className="muted">
            You're joining room <strong className="accent">{code}</strong>
          </p>
        </header>
        <form
          className="join"
          onSubmit={(e) => {
            e.preventDefault();
            onJoin(code);
          }}
        >
          <label className="field">
            <span>Your name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={20}
              placeholder="e.g. Jamie"
              autoComplete="nickname"
              autoFocus
            />
          </label>
          <button type="submit" className="btn primary big" disabled={disabled || !hasName}>
            Join room
          </button>
        </form>
        <button className="btn ghost small center-self" onClick={() => setInvited(false)}>
          Use a different room
        </button>
      </main>
    );
  }

  return (
    <main className="home">
      <header className="brand">
        <div className="logo" aria-hidden="true">🕵️</div>
        <h1>Faker</h1>
        <p className="muted">Everyone gets the word. Except one.</p>
      </header>

      <label className="field">
        <span>Your name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={20}
          placeholder="e.g. Jamie"
          autoComplete="nickname"
        />
      </label>

      <form
        className="join"
        onSubmit={(e) => {
          e.preventDefault();
          onJoin(code);
        }}
      >
        <label className="field">
          <span>Room code</span>
          <input
            className="code-input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4))}
            placeholder="ABCD"
            autoCapitalize="characters"
            autoComplete="off"
            inputMode="text"
          />
        </label>
        <button type="submit" className="btn primary" disabled={disabled || !hasName || code.length !== 4}>
          Join room
        </button>
      </form>

      <div className="divider">
        <span>or</span>
      </div>

      <button className="btn" disabled={disabled || !hasName} onClick={onCreate}>
        Create a new room
      </button>
    </main>
  );
}

function Room({ state, run, onLeave }) {
  const isHost = state.hostId === state.meId;
  const { round } = state;
  const [showQr, setShowQr] = useState(false);

  return (
    <main className="room">
      <header className="room-header">
        <div>
          <div className="label">Room</div>
          <div className="room-code-row">
            <div className="room-code">{state.code}</div>
            <button className="qr-btn" onClick={() => setShowQr(true)} aria-label="Show QR code to join">
              <QrIcon />
            </button>
          </div>
        </div>
        {round && <div className="round-no">Round {round.number}</div>}
        <button className="btn ghost small" onClick={onLeave}>
          Leave
        </button>
      </header>

      {round ? (
        <RoundView key={round.number} round={round} isHost={isHost} run={run} />
      ) : (
        <Lobby state={state} isHost={isHost} run={run} />
      )}

      <PlayerList state={state} />
      {showQr && <QrModal code={state.code} onClose={() => setShowQr(false)} />}
    </main>
  );
}

function Lobby({ state, isHost, run }) {
  const count = state.players.length;
  const enough = count >= state.minPlayers;
  const host = state.players.find((p) => p.id === state.hostId);

  return (
    <section className="lobby">
      <p className="muted center">
        Friends join at this site with code <strong className="accent">{state.code}</strong>
      </p>
      {isHost ? (
        <>
          <CategoryPicker state={state} run={run} label="Category" />
          <button className="btn primary big" disabled={!enough} onClick={() => run('newRound')}>
            Start game
          </button>
          {!enough && (
            <p className="muted center small-text">
              Need at least {state.minPlayers} players ({count} so far)
            </p>
          )}
          <ConfirmButton className="btn danger" confirmText="Tap again to close the room for everyone" onConfirm={() => run('closeRoom')}>
            Close room
          </ConfirmButton>
        </>
      ) : (
        <>
          <p className="muted center">
            Category: <strong className="text">{state.category ?? 'Random'}</strong>
          </p>
          <p className="waiting center">Waiting for {host?.name ?? 'the host'} to start…</p>
        </>
      )}
    </section>
  );
}

function RoundView({ round, isHost, run }) {
  const [revealed, setRevealed] = useState(false);

  return (
    <section className="round">
      {round.role === 'waiting' && (
        <p className="notice">A round is already in progress. You'll be dealt in next round.</p>
      )}

      <div
        className={`card ${revealed ? 'revealed' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => setRevealed((r) => !r)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setRevealed((r) => !r);
          }
        }}
        aria-label={revealed ? 'Tap to hide' : 'Tap to reveal'}
      >
        {revealed ? (
          <CardFace round={round} run={run} />
        ) : (
          <div className="card-cover">
            <div className="cover-icon" aria-hidden="true">👁️</div>
            <div className="cover-title">Tap to reveal</div>
            <div className="muted small-text">Make sure nobody's peeking</div>
          </div>
        )}
      </div>
      <p className="muted center small-text">{revealed ? 'Tap the card to hide it' : ' '}</p>

      {isHost && (
        <ConfirmButton className="btn danger" confirmText="Tap again to end the game" onConfirm={() => run('endGame')}>
          End game
        </ConfirmButton>
      )}
    </section>
  );
}

function CardFace({ round, run }) {
  if (round.role === 'impostor') {
    return (
      <div className="card-face">
        <div className="role-tag">Impostor</div>
        <div className="impostor-line">You are the impostor, blend in</div>
        <div className="category">
          Category: <strong>{round.category}</strong>
        </div>
        {/* Lives inside the card so it can't give the impostor away while the card is hidden. */}
        <div onClick={(e) => e.stopPropagation()} className="card-action">
          <ConfirmButton className="btn danger" confirmText="Tap again to confirm" onConfirm={() => run('newRound')}>
            They got me
          </ConfirmButton>
        </div>
      </div>
    );
  }
  return (
    <div className="card-face">
      <div className="role-tag">{round.role === 'waiting' ? 'Spectating' : 'Your word'}</div>
      <div className="word">{round.word}</div>
      <div className="category">{round.category}</div>
    </div>
  );
}

/** Host-only category choice in the lobby; "Random" draws from every category. */
function CategoryPicker({ state, run, label }) {
  const options = [{ value: null, name: 'Random' }, ...state.categories.map((c) => ({ value: c, name: c }))];
  return (
    <div className="category-picker">
      <div className="label">{label}</div>
      <div className="chips" role="radiogroup" aria-label={label}>
        {options.map((o) => {
          const selected = (state.category ?? null) === o.value;
          return (
            <button
              key={o.name}
              role="radio"
              aria-checked={selected}
              className={`chip ${selected ? 'selected' : ''}`}
              onClick={() => !selected && run('setCategory', { category: o.value })}
            >
              {o.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A button that needs two taps, so a stray tap can't restart the round for everyone. */
function ConfirmButton({ children, confirmText, onConfirm, className }) {
  const [armed, setArmed] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const click = () => {
    if (armed) {
      clearTimeout(timer.current);
      setArmed(false);
      onConfirm();
      return;
    }
    setArmed(true);
    timer.current = setTimeout(() => setArmed(false), 3000);
  };

  return (
    <button className={`${className} ${armed ? 'armed' : ''}`} onClick={click}>
      {armed ? confirmText : children}
    </button>
  );
}

function PlayerList({ state }) {
  return (
    <section className="players">
      <h2>
        Players <span className="muted">({state.players.length})</span>
      </h2>
      <ul>
        {state.players.map((p) => (
          <li key={p.id} className={p.connected ? '' : 'offline'}>
            <span className="player-name">
              {p.name}
              {p.id === state.meId && <span className="muted"> (you)</span>}
            </span>
            <span className="tags">
              {p.id === state.hostId && <span className="tag host">Host</span>}
              {p.waiting && <span className="tag">Next round</span>}
              {!p.connected && <span className="tag">Offline</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function QrModal({ code, onClose }) {
  const [src, setSrc] = useState('');
  const url = inviteUrl(code);

  useEffect(() => {
    QRCode.toDataURL(url, { width: 720, margin: 2, errorCorrectionLevel: 'M' }).then(setSrc, () => setSrc(''));
  }, [url]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="qr-overlay" role="dialog" aria-modal="true" aria-label="Scan to join" onClick={onClose}>
      <div className="qr-title">Scan to join</div>
      <div className="qr-image">{src && <img src={src} alt={`QR code to join room ${code}`} />}</div>
      <div className="qr-code-text">{code}</div>
      <div className="muted small-text qr-url">{url}</div>
      <div className="muted small-text">Tap anywhere to close</div>
    </div>
  );
}

function QrIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
      <path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm8-2h2v2h-2v-2zm2 2h2v2h-2v-2zm2-2h2v2h-2v-2zm2 2h2v2h-2v-2zm-6 2h2v2h-2v-2zm2 2h2v2h-2v-2zm2-2h2v2h-2v-2zm2 2h2v2h-2v-2z" />
    </svg>
  );
}
