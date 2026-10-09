import { useEffect, useRef } from 'react';

const dialogs: HTMLElement[] = [];
const focusable = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';

/** Keep keyboard focus inside the active dialog and return to its opener on close. */
export function useSafeDialog(onClose: () => void, busy = false) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef({ onClose, busy });
  latest.current = { onClose, busy };
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogs.push(dialog);
    const candidates = () => [...dialog.querySelectorAll<HTMLElement>(focusable)].filter((el) => !el.hidden && el.getClientRects().length > 0);
    // Start on the close control, never on a money-moving action.
    (dialog.querySelector<HTMLElement>('.position-modal-close') ?? candidates()[0] ?? dialog).focus();
    const onKey = (event: KeyboardEvent) => {
      if (dialogs.at(-1) !== dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!latest.current.busy) latest.current.onClose();
      } else if (event.key === 'Enter' && event.repeat) {
        event.preventDefault(); event.stopImmediatePropagation();
      } else if (event.key === 'Tab') {
        const nodes = candidates();
        const first = nodes[0], last = nodes.at(-1);
        if (!first || !last) { event.preventDefault(); dialog.focus(); }
        else if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const index = dialogs.indexOf(dialog);
      if (index >= 0) dialogs.splice(index, 1);
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return ref;
}
