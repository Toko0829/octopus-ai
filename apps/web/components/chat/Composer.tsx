'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AGENT_PERSONAS, type AgentPersona } from '@octopus/contracts';
import { GOAL_HANDOFF_KEY } from '../landing/GoalComposer';
import { mentionQuery } from '../../lib/mention-query';
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
  /**
   * Whether to offer the mention list.
   *
   * Only the owner's mention routes anywhere: a member's message is an ordinary
   * goal whether or not it names a voice. Offering the list to everybody would
   * be the same "affordance that only fails when used" the add-source button
   * avoids, so it is absent rather than present and inert.
   */
  mentionable?: boolean;
}

const PERSONA_KEYS = Object.keys(AGENT_PERSONAS) as AgentPersona[];

export function Composer({ channelName, onSend, onAddSource, mentionable = false }: Props) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * The mention list.
   *
   * `caret` is state rather than read from the input on demand, because the list
   * has to close when somebody clicks elsewhere in their own text, and that is a
   * selection change with no value change behind it.
   */
  const [caret, setCaret] = useState(0);
  const [highlighted, setHighlighted] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const query = mentionable && !dismissed ? mentionQuery(value, caret) : null;
  const matches = useMemo(() => {
    if (!query) return [];
    const q = query.query.toLowerCase();
    return PERSONA_KEYS.filter((key) => AGENT_PERSONAS[key].name.toLowerCase().startsWith(q));
  }, [query]);
  const open = matches.length > 0;

  // Keep the highlight in range when the query narrows the list under it.
  useEffect(() => {
    setHighlighted((h) => (h < matches.length ? h : 0));
  }, [matches.length]);

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

  function sync(el: HTMLInputElement) {
    setCaret(el.selectionStart ?? el.value.length);
  }

  /** Replace the token being typed with the chosen name, and a trailing space. */
  function choose(persona: AgentPersona) {
    if (!query) return;
    const name = AGENT_PERSONAS[persona].name;
    const next = `${value.slice(0, query.start)}@${name} ${value.slice(caret)}`;
    const at = query.start + name.length + 2;
    setValue(next);
    setDismissed(true);
    // Put the caret after the inserted name rather than at the end, so a mention
    // completed mid-sentence does not send the person back to the end of it.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(at, at);
      setCaret(at);
    });
  }

  function submit() {
    const text = value.trim();
    if (!text) return;
    onSend(text);
    setValue('');
    setDismissed(false);
    setCaret(0);
  }

  return (
    <div className="composer">
      {open && (
        <ul className="composer-suggest" id="composer-suggest" role="listbox">
          {matches.map((key, i) => (
            <li
              key={key}
              id={`composer-suggest-${key}`}
              role="option"
              aria-selected={i === highlighted}
              onMouseDown={(e) => {
                // Before blur, or the input loses the caret this reads.
                e.preventDefault();
                choose(key);
              }}
              onMouseEnter={() => setHighlighted(i)}
            >
              <span className="suggest-name">{AGENT_PERSONAS[key].name}</span>
              <span className="suggest-summary">{AGENT_PERSONAS[key].summary}</span>
            </li>
          ))}
        </ul>
      )}
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
          ref={inputRef}
          className="composer-input"
          placeholder={channelName ? `Message #${channelName}` : 'Message this room'}
          value={value}
          aria-autocomplete={mentionable ? 'list' : undefined}
          aria-controls={open ? 'composer-suggest' : undefined}
          aria-expanded={mentionable ? open : undefined}
          aria-activedescendant={
            open ? `composer-suggest-${matches[highlighted] ?? matches[0]}` : undefined
          }
          onChange={(e) => {
            setValue(e.target.value);
            setDismissed(false);
            sync(e.target);
          }}
          onSelect={(e) => sync(e.currentTarget)}
          onBlur={() => setDismissed(true)}
          onKeyDown={(e) => {
            if (open) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHighlighted((h) => (h + 1) % matches.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHighlighted((h) => (h - 1 + matches.length) % matches.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                // Enter completes the mention rather than sending. Sending a
                // half-typed name because the list happened to be open is the
                // one failure this component must not have.
                e.preventDefault();
                choose(matches[highlighted] ?? matches[0]!);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setDismissed(true);
                return;
              }
            }
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
