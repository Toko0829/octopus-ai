'use client';

import { useEffect, useRef, useState } from 'react';
import { IconBell } from '../chat/icons';
import { InboxPanel } from './InboxPanel';
import type { InboxState } from './useInbox';

interface Props {
  inbox: InboxState;
  /**
   * Where a click should go. The caller decides, because `/app` can move rooms
   * in place while `/node` cannot, and the hook has no business knowing that.
   */
  onOpen: (href: string) => void;
}

/**
 * The bell, its count, and the panel it opens.
 *
 * **The badge has one rule and it is about hue, not about notifications.**
 * design-system.md says a hue carries a word: teal is the agent, coral is a
 * person, amber is "this needs your approval". So amber appears here only when
 * something is genuinely waiting on the reader, and the word "need you" is
 * rendered beside the number rather than implied by the colour (rule 15,
 * accessibility, and the reason `.work-state` pairs a dot with a word). Anything
 * else that is merely new counts in the neutral chip and says "new".
 *
 * The alternative was one amber count for everything unread. It was rejected for
 * the reason the design system gives against it: a hue asserting two claims is
 * how a badge stops meaning anything, and an owner whose badge is permanently
 * amber because an expert was paid last week will stop reading the one that says
 * work is waiting.
 *
 * **No glow.** `--glow-agent` and the `breathe` animation are reserved for live
 * agent presence and nothing else (AGENTS.md rule 14). A bell that pulsed would
 * be the second glowing thing on the page and the first one that is not alive.
 */
export function InboxBell({ inbox, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    function onClick(e: MouseEvent) {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    // `mousedown` rather than `click`, or the same press that opened it closes it.
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const { unread, needsYou } = inbox;
  const tone = needsYou > 0 ? 'needs' : 'new';
  const count = needsYou > 0 ? needsYou : unread;

  return (
    <div className="inbox-wrap" ref={wrap}>
      <button
        type="button"
        className="inbox-bell"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          unread > 0 ? `Notifications, ${unread} unread` : 'Notifications, nothing unread'
        }
        onClick={() => setOpen((v) => !v)}
      >
        <IconBell width={16} height={16} />
        {/* Hidden at zero: a badge reading 0 is noise, which the work button
            beside this one already established. */}
        {count > 0 && (
          <span className={`inbox-count mono inbox-count-${tone}`}>
            {count}
            <span className="inbox-count-word">{tone === 'needs' ? 'need you' : 'new'}</span>
          </span>
        )}
      </button>
      {open && (
        <InboxPanel
          inbox={inbox}
          onOpen={(href) => {
            setOpen(false);
            onOpen(href);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
