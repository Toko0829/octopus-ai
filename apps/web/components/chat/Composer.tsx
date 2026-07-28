'use client';

import { useState } from 'react';
import { IconPlus, IconSend } from './icons';

interface Props {
  channelName: string | null;
  onSend: (text: string) => void;
}

export function Composer({ channelName, onSend }: Props) {
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
        <button className="icon-btn" aria-label="Add attachment">
          <IconPlus />
        </button>
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
