'use client';

import { useEffect, useState } from 'react';
import { GOAL_HANDOFF_KEY } from '../landing/GoalComposer';
import { IconPlus, IconSend } from './icons';

interface Props {
  channelName: string | null;
  onSend: (text: string) => void;
  /**
   * Opens the add-source panel. Absent for anyone who is not the workspace
   * owner, and the button is then not rendered at all rather than rendered and
   * refused: an affordance that only fails when used is worse than none.
   */
  onAddSource?: () => void;
}

export function Composer({ channelName, onSend, onAddSource }: Props) {
  const [value, setValue] = useState('');

  /**
   * Pick up a goal typed on the landing page.
   *
   * It arrives in `sessionStorage` rather than the URL, so it survives the
   * sign-in redirect without ever being written to a log or a referrer. It is
   * **prefilled, never auto-sent**: posting a message on someone's behalf the
   * instant a page loads is the kind of side effect this product exists to ask
   * permission for, and the whole point is that they press send.
   *
   * Cleared on read, so a later reload does not resurrect it.
   */
  useEffect(() => {
    let pending: string | null = null;
    try {
      pending = sessionStorage.getItem(GOAL_HANDOFF_KEY);
      if (pending) sessionStorage.removeItem(GOAL_HANDOFF_KEY);
    } catch {
      return; // storage unavailable; nothing to carry over
    }
    if (pending) setValue((current) => current || pending);
  }, []);

  function submit() {
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue('');
  }

  return (
    <div className="composer">
      <div className="composer-box">
        {onAddSource && (
          <button
            className="icon-btn"
            onClick={onAddSource}
            aria-label="Tell Octopus about your business"
            title="Tell Octopus about your business"
          >
            <IconPlus />
          </button>
        )}
        <input
          className="composer-input"
          placeholder={channelName ? `Message #${channelName}` : 'Message this room'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="send" onClick={submit} disabled={!value.trim()} aria-label="Send">
          <IconSend width={17} height={17} />
        </button>
      </div>
      <div className="composer-hint">
        <kbd>⌘</kbd>
        <kbd>K</kbd> actions · Octopus never spends or posts without your approval
      </div>
    </div>
  );
}
