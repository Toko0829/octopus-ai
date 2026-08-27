'use client';

import { useRef, useState } from 'react';
import { addSource } from '../../lib/api-client';

/**
 * Telling Octopus what this business is.
 *
 * Every deliverable it wrote used to end by saying what it could not include:
 * the corpus is marketing principles, so it knew marketing and not the product.
 * This is where that gap gets filled, and the copy says so plainly rather than
 * calling it "knowledge base management", which describes the mechanism instead
 * of the reason.
 *
 * Three ways in, because people have their description in different places. A
 * file is read **in the browser** and its text goes into the same box as a
 * paste: no upload endpoint, no multipart handling, no storage. `.md` and `.txt`
 * only, because a PDF is not text until something parses it and pretending
 * otherwise would store mojibake and call it a source.
 *
 * The result is not shown here. It arrives in the room as a message, which is
 * the surface this product already uses to say what it did.
 */

interface Props {
  roomId: string;
  onClose: () => void;
  onAccepted: () => void;
}

const READABLE = /\.(md|markdown|txt|text)$/i;

export function AddSourcePanel({ roomId, onClose, onAccepted }: Props) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function readFile(file: File) {
    if (!READABLE.test(file.name)) {
      setError('Text and markdown files can be read. For a PDF, paste the text instead.');
      return;
    }
    setError(null);
    const contents = await file.text();
    setText((current) => (current ? `${current}\n\n${contents}` : contents));
    // The filename is a reasonable title and a terrible one to overwrite, so it
    // fills the field only when the person has not already named it.
    setTitle((current) => current || file.name.replace(READABLE, ''));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmedText = text.trim();
    const trimmedUrl = url.trim();

    // Mirrors the server's rule rather than trusting it to be the only check:
    // both would mean guessing which was meant, neither is an empty request.
    if (Boolean(trimmedText) === Boolean(trimmedUrl)) {
      setError('Give me either a description or a web address, not both.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await addSource(roomId, {
        title: title.trim() || undefined,
        text: trimmedText || undefined,
        url: trimmedUrl || undefined,
      });
      onAccepted();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That could not be sent.');
      setBusy(false);
    }
  }

  return (
    <div className="cmdk-scrim" role="dialog" aria-modal="true" aria-label="Add a source">
      <form className="source-panel" onSubmit={submit}>
        <h2 className="source-title">What should I know about your business?</h2>
        <p className="source-lede">
          I plan and write from what I have read. Tell me what you sell, who buys it, and what makes
          it different, and I will use it from the next plan onward.
        </p>

        <label className="source-label" htmlFor="source-name">
          Name it
        </label>
        <input
          id="source-name"
          className="source-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What Bluelly is"
          maxLength={140}
          disabled={busy}
        />

        <label className="source-label" htmlFor="source-text">
          Describe it
        </label>
        <textarea
          id="source-text"
          className="source-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Bluelly turns lecture notes into flashcards. Students paste a PDF and get a deck in under a minute."
          rows={7}
          disabled={busy}
        />

        <div className="source-file">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
          >
            Read a file
          </button>
          <span className="source-hint">Markdown or plain text</span>
          <input
            ref={fileRef}
            type="file"
            accept=".md,.markdown,.txt,.text"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void readFile(file);
              e.target.value = '';
            }}
          />
        </div>

        <div className="source-or">or</div>

        <label className="source-label" htmlFor="source-url">
          Give me a page to read
        </label>
        <input
          id="source-url"
          className="source-input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://bluelly.com"
          disabled={busy}
        />

        {error && (
          <p className="source-error" role="alert">
            {error}
          </p>
        )}

        <div className="source-actions">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Sending' : 'Add source'}
          </button>
        </div>
      </form>
    </div>
  );
}
