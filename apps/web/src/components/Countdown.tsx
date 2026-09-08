import { useEffect, useState } from 'react';

// The preview countdown (T04.6). It counts down to the SERVER's expiry timestamp,
// not a client-started timer — the value shown must match what the server will
// enforce, so an expired preview looks expired here at the same instant the
// server would refuse to confirm it. When it reaches zero the confirm action is
// disabled by the parent; the server is still the authority that rejects a stale
// token, this is only the visible half of that contract.

interface Props {
  /** The server's preview_expires_at, in epoch ms. */
  readonly expiresAtMs: number;
  /** Called once when the countdown crosses zero. */
  readonly onExpire: () => void;
}

export function Countdown({ expiresAtMs, onExpire }: Props) {
  const [remainingMs, setRemainingMs] = useState(() => expiresAtMs - Date.now());

  useEffect(() => {
    const tick = () => {
      const next = expiresAtMs - Date.now();
      setRemainingMs(next);
      if (next <= 0) onExpire();
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [expiresAtMs, onExpire]);

  const expired = remainingMs <= 0;
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));

  return (
    <span className={`countdown${expired ? ' expired' : ''}`}>
      {expired ? 'Preview expired — re-preview for fresh prices' : `Expires in ${seconds}s`}
    </span>
  );
}
