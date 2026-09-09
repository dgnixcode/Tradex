// The authenticated panel's top bar. Carries the current section title, the
// rung-0 dry-run badge (the one fact a trader must not lose sight of), a passive
// desk-status chip when the brakes are engaged, the signed-in role, and — below
// the sidebar breakpoint — the button that opens the sidebar.

import { DeskStatus } from './DeskStatus.tsx';

interface Props {
  readonly title: string;
  readonly role: string;
  readonly onMenu: () => void;
}

export function AppTopbar({ title, role, onMenu }: Props) {
  return (
    <header className="app-topbar">
      <button className="app-menu-btn" aria-label="Open menu" onClick={onMenu}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 7h16" strokeLinecap="round" />
          <path d="M4 12h16" strokeLinecap="round" />
          <path d="M4 17h16" strokeLinecap="round" />
        </svg>
      </button>
      <h1>{title}</h1>
      <span className="rung-badge" title="Rung 0: the plan is previewed and dry-run only; no order is sent.">
        dry-run · no orders sent
      </span>
      <DeskStatus />
      <span className="spacer" />
      <span className="who">Signed in · {role}</span>
    </header>
  );
}
