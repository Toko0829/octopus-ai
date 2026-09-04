/**
 * Every sentence the Models block says.
 *
 * **This file is why the copy is in TypeScript rather than inline in JSX.**
 * AGENTS.md rule 22 bans em dashes in product copy, and this block is the one
 * surface where somebody pastes a paid credential, so its wording is worth
 * checking on every push rather than on every review. Strings in JSX can only be
 * checked by a person reading the component; strings in an exported object can
 * be walked by a machine.
 *
 * Beyond rule 22 the assertions here are about honesty: nothing claims a key is
 * safe, the two sentences about it say what actually happens to it, and the
 * Creative note admits that a route set there is not yet read by anything.
 */

import { describe, expect, it } from 'vitest';
import { ModelRole } from '@octopus/contracts';
import {
  MODELS_COPY,
  MODEL_ROLE_LABELS,
  MODEL_ROLE_NOTES,
  MODEL_STATUS_COPY,
  autoOptionLabel,
} from './models-copy';

/** Every string this module can put on a page, including the composed ones. */
const everySentence = [
  ...Object.values(MODELS_COPY),
  ...Object.values(MODEL_STATUS_COPY),
  ...Object.values(MODEL_ROLE_LABELS),
  ...Object.values(MODEL_ROLE_NOTES),
  autoOptionLabel(null),
  autoOptionLabel({ provider: 'openai', model: 'gpt-5.4' }),
  autoOptionLabel({ provider: 'openai', model: 'an-id-nobody-listed' }),
];

describe('the Models block copy', () => {
  it('writes no em dash anywhere', () => {
    for (const line of everySentence) {
      expect(line).not.toContain('—');
    }
  });

  it('says nothing empty', () => {
    for (const line of everySentence) {
      expect(line.trim().length).toBeGreaterThan(0);
    }
  });

  it('has a label for every role the contract declares', () => {
    // A role added to the enum with no label would render as nothing beside a
    // select that changes which model composes somebody's work.
    for (const role of ModelRole.options) {
      expect(MODEL_ROLE_LABELS[role]).toBeTruthy();
    }
  });

  it('explains the two roles that are not one of the four voices', () => {
    // Strategist, Content, Ads and Analyst are named in the members panel and the
    // mention list. These two are not, so their names alone do not say what
    // routing them would do.
    expect(MODEL_ROLE_NOTES.fallback).toBeTruthy();
    expect(MODEL_ROLE_NOTES.creative).toBeTruthy();
    expect(MODEL_ROLE_NOTES.strategist).toBeUndefined();
  });

  it('says the Creative route draws, and that the brief is written either way', () => {
    // It read "Nothing produces an image yet" for one slice, which was true then.
    // It now says what routing it does, and it still names the brief, because the
    // brief is the deliverable and the images are what comes with it (ADR-0033).
    // A person who reads this and connects nothing has still lost nothing.
    expect(MODEL_ROLE_NOTES.creative).toContain('brief');
    expect(MODEL_ROLE_NOTES.creative).not.toContain('Nothing produces an image');
  });

  it('says what happens to the key rather than that it is safe', () => {
    expect(MODELS_COPY.keyStorage).toContain('Stored encrypted');
    expect(MODELS_COPY.keyStorage).toContain('this workspace');
    expect(MODELS_COPY.keyStorage.toLowerCase()).not.toContain('secure');
    expect(MODELS_COPY.keyStorage.toLowerCase()).not.toContain('never shared');
  });

  it('warns that disconnecting takes the routes with it', () => {
    expect(MODELS_COPY.disconnectNote).toContain('clears every role');
  });

  it('ends its status words with a full stop only where they are sentences', () => {
    // Rule 15: a status is a word, and the dot beside it is the indicator, not
    // punctuation. "Connected" and "Disconnected" are labels, not sentences.
    expect(MODEL_STATUS_COPY.active).toBe('Connected');
    expect(MODEL_STATUS_COPY.revoked).toBe('Disconnected');
    expect(MODEL_STATUS_COPY.active.endsWith('.')).toBe(false);
  });
});

describe('autoOptionLabel', () => {
  it('names the house default when the service reported one', () => {
    expect(autoOptionLabel({ provider: 'openai', model: 'gpt-5.4' })).toBe(
      'Auto (house default: GPT-5.4)',
    );
  });

  it('renders an unregistered house model verbatim', () => {
    expect(autoOptionLabel({ provider: 'openai', model: 'gpt-9' })).toBe(
      'Auto (house default: gpt-9)',
    );
  });

  it('offers Auto without naming a model when the service did not answer', () => {
    // Guessing a name here would invent the one fact this option reports.
    expect(autoOptionLabel(null)).toBe('Auto (house default)');
  });
});
