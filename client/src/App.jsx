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

// How each mode is named and worded on screen.
const MODE_INFO = {
  categories: { name: 'Categories' },
  handsup: {
    name: 'Hands Up',
    statement: (p) => `Raise your hand if you ${p}`,
    action: 'Hands up!',
    impostorHint: "You don't get the statement. When the countdown ends, read the room: hand up, or not?",
  },
  facecard: {
    name: 'Face Card',
    statement: (p) => `Pull the face you'd pull if ${p}`,
    action: 'Pull your face!',
    impostorHint: "You don't get the scenario. When the countdown ends, copy the room's face.",
  },
  numbertaker: {
    name: 'Numbertaker',
    statement: (p) => p,
    note: 'Answer 0–10 on your fingers',
    action: 'Show your number!',
    impostorHint: "You don't get the question. When the countdown ends, hold up a number that blends in (0–10).",
  },
  mixed: { name: 'Mixed' },
};
const isActKind = (kind) => kind === 'handsup' || kind === 'facecard' || kind === 'numbertaker';

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
    <div className={`app ${state?.spectator ? 'tv' : ''}`}>
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
          onJoin={(code, spectator) => run('join', { playerId, name, code, spectator })}
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
  const [spectator, setSpectator] = useState(false);
  const hasName = name.trim().length > 0;
  const spectatorSwitch = (
    <Toggle
      on={spectator}
      onChange={setSpectator}
      label="Join as spectator"
      sub={spectator ? "For a shared screen: you'll only see what everyone can see" : "You'll play as normal"}
    />
  );

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
            onJoin(code, spectator);
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
          {spectatorSwitch}
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
          onJoin(code, spectator);
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
        {spectatorSwitch}
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
  const [skipSplash, setSkipSplash] = useState(false);
  const lastRound = useRef(round?.number ?? null);

  // Only announce a skip when it happens live, not when rejoining a round that began with one.
  useEffect(() => {
    const prev = lastRound.current;
    lastRound.current = round?.number ?? null;
    if (round?.skipped && prev !== null && round.number > prev) setSkipSplash(Date.now());
    // Any other change (next round, End game, a new game) cuts the message short.
    else if (prev !== lastRound.current) setSkipSplash(false);
  }, [round?.number, round?.skipped]);

  useEffect(() => {
    if (!skipSplash) return;
    const t = setTimeout(() => setSkipSplash(false), 3000);
    return () => clearTimeout(t);
  }, [skipSplash]);

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
        {round && (
          <div className="round-no">
            <span className="round-word">Round </span>
            {isActKind(round.kind) ? `${round.streak}/${round.maxStreak}` : round.number}
          </div>
        )}
        <button className="btn ghost small" onClick={onLeave}>
          Leave
        </button>
      </header>

      {state.spectator ? (
        <SpectatorView state={state} announcingSkip={Boolean(skipSplash)} />
      ) : round ? (
        <RoundView
          key={round.number}
          round={round}
          isHost={isHost}
          run={run}
          announcingSkip={Boolean(skipSplash)}
          hostName={state.players.find((p) => p.id === state.hostId)?.name}
        />
      ) : (
        <Lobby state={state} isHost={isHost} run={run} />
      )}

      <PlayerList state={state} />
      {showQr && <QrModal code={state.code} onClose={() => setShowQr(false)} />}

    </main>
  );
}

function Lobby({ state, isHost, run }) {
  const count = state.players.filter((p) => !p.spectator).length;
  const enough = count >= state.minPlayers;
  const host = state.players.find((p) => p.id === state.hostId);

  return (
    <section className="lobby">
      <p className="muted center">
        Friends join at this site with code <strong className="accent">{state.code}</strong>
      </p>
      {isHost ? (
        <>
          <ModePicker state={state} run={run} />
          {state.mode === 'categories' ? (
            <CategoryPicker state={state} run={run} label="Category" />
          ) : (
            <AdultToggle state={state} run={run} />
          )}
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
            Mode: <strong className="text">{MODE_INFO[state.mode]?.name}</strong>
            {' · '}
            {state.mode === 'categories' ? (
              <>
                Category: <strong className="text">{state.category ?? 'Random'}</strong>
              </>
            ) : (
              <>
                18+: <strong className="text">{state.adult ? 'On' : 'Off'}</strong>
              </>
            )}
          </p>
          <p className="waiting center">Waiting for {host?.name ?? 'the host'} to start…</p>
        </>
      )}
    </section>
  );
}

function RoundView({ round, isHost, run, announcingSkip, hostName }) {
  const [revealed, setRevealed] = useState(false);
  const act = isActKind(round.kind);
  const info = MODE_INFO[round.kind];
  const phase = act ? round.phase : null;
  // During the skip message, the countdown, and the "Impostor won" screen the card can't be flipped.
  // After the reveal only the impostor can flip (to reach "They got me"); innocents have no reason to.
  const locked =
    announcingSkip ||
    phase === 'acting' ||
    phase === 'impostorWon' ||
    (phase === 'revealed' && round.role !== 'impostor');
  const toggle = () => !locked && setRevealed((r) => !r);

  // Each phase starts with the card face-down (e.g. the reveal shows the statement, not your card).
  useEffect(() => setRevealed(false), [phase]);

  return (
    <section className="round">
      {round.role === 'waiting' && (
        <p className="notice">A round is already in progress. You'll be dealt in next round.</p>
      )}

      <div
        className={`card ${revealed ? 'revealed' : ''}`}
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
        aria-label={revealed ? 'Tap to hide' : 'Tap to reveal'}
      >
        {announcingSkip ? (
          <div className="card-cover skip-announce" role="status">
            <div className="cover-title">{act ? 'Statement skipped' : 'Word skipped'}</div>
            <div className="skip-announce-sub">the impostor is still at large...</div>
          </div>
        ) : phase === 'acting' ? (
          <Countdown action={info.action} />
        ) : phase === 'impostorWon' ? (
          <div className="card-cover" role="status">
            <div className="cover-icon" aria-hidden="true">🕵️</div>
            <div className="won-title">Impostor won!</div>
            <div className="won-sub">
              <strong>{round.impostorName}</strong> survived {round.maxStreak} rounds without getting caught
            </div>
          </div>
        ) : revealed ? (
          <CardFace round={round} run={run} />
        ) : phase === 'revealed' ? (
          <div className="card-cover">
            <div className="role-tag">The statement was</div>
            <div className="statement">{info.statement(round.prompt)}</div>
          </div>
        ) : (
          <div className="card-cover">
            <div className="cover-icon" aria-hidden="true">👁️</div>
            <div className="cover-title">Tap to reveal</div>
            <div className="muted small-text">Make sure nobody's peeking</div>
          </div>
        )}
      </div>
      <p className="muted center small-text">
        {revealed && !locked
          ? 'Tap the card to hide it'
          : phase === 'reading' && !isHost
            ? `When everyone's read their card, ${hostName ?? 'the host'} will tap Ready`
            : ' '}
      </p>

      {isHost && phase === 'reading' && (
        <button className="btn primary big" onClick={() => run('ready')}>
          Ready
        </button>
      )}
      {isHost && (phase === 'revealed' || phase === 'impostorWon') && (
        <button className="btn primary big" onClick={() => run('next')}>
          Next round
        </button>
      )}

      {round.skip.canVote && (
        <button className={`btn small skip-btn ${round.skip.voted ? 'voted' : ''}`} onClick={() => run('voteSkip')}>
          {round.skip.voted ? 'Voted to skip' : act ? 'Skip statement' : 'Skip word'}
          <span className="skip-count">
            {round.skip.votes}/{round.skip.needed}
          </span>
        </button>
      )}

      {isHost && (
        <ConfirmButton className="btn danger" confirmText="Tap again to end the game" onConfirm={() => run('endGame')}>
          End game
        </ConfirmButton>
      )}
    </section>
  );
}

function CardFace({ round, run }) {
  if (isActKind(round.kind)) return <ActCardFace round={round} run={run} />;
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

function ActCardFace({ round, run }) {
  const info = MODE_INFO[round.kind];
  if (round.role === 'impostor') {
    return (
      <div className="card-face">
        <div className="role-tag">{info.name} · Impostor</div>
        <div className="impostor-line">You are the impostor, blend in</div>
        {round.prompt ? (
          <div className="category">
            The statement was: <strong>{info.statement(round.prompt)}</strong>
          </div>
        ) : (
          <div className="category">{info.impostorHint}</div>
        )}
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
      <div className="role-tag">{round.role === 'waiting' ? `${info.name} · Spectating` : info.name}</div>
      <div className="statement">{info.statement(round.prompt)}</div>
      {info.note && <div className="category">{info.note}</div>}
    </div>
  );
}

/**
 * The shared-screen view (e.g. a TV): only what everyone at the table can already see.
 * The server never sends a spectator the word, the impostor, or an unrevealed statement.
 */
function SpectatorView({ state, announcingSkip }) {
  const { round } = state;
  const host = state.players.find((p) => p.id === state.hostId);
  const url = inviteUrl(state.code);
  const qr = useQrCode(url);

  if (!round) {
    return (
      <section className="tv-lobby">
        <div className="tv-join">
          <div className="qr-image tv-qr">{qr && <img src={qr} alt={`QR code to join room ${state.code}`} />}</div>
          <div>
            <div className="label">Scan to join</div>
            <div className="tv-code">{state.code}</div>
            <div className="muted qr-url">{url}</div>
          </div>
        </div>
        <p className="tv-sub">
          {MODE_INFO[state.mode]?.name}
          {state.mode === 'categories'
            ? ` · ${state.category ?? 'Random'}`
            : state.adult
              ? ' · 18+'
              : ''}
        </p>
        <p className="waiting center">Waiting for {host?.name ?? 'the host'} to start…</p>
      </section>
    );
  }

  const act = isActKind(round.kind);
  const info = MODE_INFO[round.kind];
  let body;
  if (announcingSkip) {
    body = (
      <div className="card-cover skip-announce" role="status">
        <div className="cover-title">{act ? 'Statement skipped' : 'Word skipped'}</div>
        <div className="skip-announce-sub">the impostor is still at large...</div>
      </div>
    );
  } else if (!act) {
    body = (
      <div className="card-cover">
        <div className="role-tag">Category</div>
        <div className="statement">{round.category}</div>
        <div className="muted">Everyone's got the word, except one. Who's faking it?</div>
      </div>
    );
  } else if (round.phase === 'reading') {
    body = (
      <div className="card-cover">
        <div className="role-tag">{info.name}</div>
        <div className="statement">Check your phones</div>
        <div className="muted">Waiting for {host?.name ?? 'the host'} to tap Ready</div>
      </div>
    );
  } else if (round.phase === 'acting') {
    body = <Countdown action={info.action} />;
  } else if (round.phase === 'revealed') {
    body = (
      <div className="card-cover">
        <div className="role-tag">The statement was</div>
        <div className="statement">{info.statement(round.prompt)}</div>
        {info.note && <div className="muted">{info.note}</div>}
      </div>
    );
  } else {
    body = (
      <div className="card-cover" role="status">
        <div className="cover-icon" aria-hidden="true">🕵️</div>
        <div className="won-title">Impostor won!</div>
        <div className="won-sub">
          <strong>{round.impostorName}</strong> survived {round.maxStreak} rounds without getting caught
        </div>
      </div>
    );
  }

  return (
    <section className="round">
      <div className="card tv-card">{body}</div>
      {round.skip.votes > 0 && (!act || round.phase === 'reading') && (
        <p className="muted center">
          Skip votes: {round.skip.votes}/{round.skip.needed}
        </p>
      )}
    </section>
  );
}

/** 3-2-1 on every phone after the host taps Ready, then the action to perform. */
function Countdown({ action }) {
  const [n, setN] = useState(3);
  useEffect(() => {
    if (n === 0) return;
    const t = setTimeout(() => setN(n - 1), 1000);
    return () => clearTimeout(t);
  }, [n]);
  return (
    <div className="card-cover" role="status" aria-live="assertive">
      {n > 0 ? (
        <div key={n} className="count-number">
          {n}
        </div>
      ) : (
        <div className="count-action">{action}</div>
      )}
    </div>
  );
}

/** Host-only game mode choice in the lobby. */
function ModePicker({ state, run }) {
  return (
    <div className="category-picker">
      <div className="label">Mode</div>
      <div className="chips" role="radiogroup" aria-label="Mode">
        {state.modes.map((m) => {
          // Mixed plays all three act modes, so light them up along with Mixed itself.
          const selected = state.mode === m || (state.mode === 'mixed' && isActKind(m));
          return (
            <button
              key={m}
              role="radio"
              aria-checked={selected}
              className={`chip ${selected ? 'selected' : ''}`}
              onClick={() => state.mode !== m && run('setMode', { mode: m })}
            >
              {MODE_INFO[m]?.name ?? m}
            </button>
          );
        })}
      </div>
      {state.mode === 'mixed' && <p className="muted small-text">A random mix of Hands Up, Face Card and Numbertaker</p>}
    </div>
  );
}

function Toggle({ on, onChange, label, sub }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
      <span className="toggle-label">
        {label}
        {sub && <span className="muted small-text">{sub}</span>}
      </span>
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
    </button>
  );
}

function AdultToggle({ state, run }) {
  return (
    <Toggle
      on={state.adult}
      onChange={(adult) => run('setAdult', { adult })}
      label="18+ statements"
      sub={state.adult ? 'Spicy ones included' : 'Clean only'}
    />
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
        Players <span className="muted">({state.players.filter((p) => !p.spectator).length})</span>
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
              {p.spectator && <span className="tag">Spectator</span>}
              {p.waiting && <span className="tag">Next round</span>}
              {!p.connected && <span className="tag">Offline</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function useQrCode(url) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    QRCode.toDataURL(url, { width: 720, margin: 2, errorCorrectionLevel: 'M' }).then(setSrc, () => setSrc(''));
  }, [url]);
  return src;
}

function QrModal({ code, onClose }) {
  const url = inviteUrl(code);
  const src = useQrCode(url);

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
