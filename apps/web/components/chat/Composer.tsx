'use client';

import { useState } from 'react';
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
