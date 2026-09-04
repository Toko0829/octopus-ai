/**
 * The envelope, tested as the control it is rather than as a round trip.
 *
 * A round trip passing proves almost nothing here: `seal` and `open` would still
 * agree if the tag were ignored, if the AAD were dropped, or if the key were
 * derived from a constant. What matters is that every way of getting it wrong
 * FAILS, so most of what is below asserts a throw.
 *
 * The AAD cases are the ones worth reading twice. They are what makes a
 * ciphertext copied from one room's row into another's useless, which is the
 * property that survives an attacker who has the database.
 */

import { describe, expect, it } from 'vitest';
import {
  EnvelopeError,
  keyHint,
  modelConnectionAad,
  open,
  parseMasterKey,
  seal,
  secretEquals,
} from './envelope';

const HEX = 'a'.repeat(64);
const OTHER_HEX = 'b'.repeat(64);
const KEY = parseMasterKey(HEX);
const AAD = modelConnectionAad('room-1', 'anthropic', 1);
const SECRET = 'sk-ant-api03-not-a-real-key-4f2a';

describe('parseMasterKey', () => {
  it('accepts exactly 64 hex characters', () => {
    expect(parseMasterKey(HEX)).toHaveLength(32);
  });

  it('refuses a 16-byte key, which would silently become AES-128', () => {
    expect(() => parseMasterKey('a'.repeat(32))).toThrow(EnvelopeError);
  });

  it.each(['', 'not-hex', 'a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(63)}z`])(
    'refuses %o',
    (bad) => {
      expect(() => parseMasterKey(bad)).toThrow(EnvelopeError);
    },
  );
});

describe('seal and open', () => {
  it('round trips', () => {
    expect(open(seal(SECRET, KEY, AAD), KEY, AAD)).toBe(SECRET);
  });

  it('never stores the plaintext', () => {
    const sealed = seal(SECRET, KEY, AAD);
    const asText = JSON.stringify(sealed);
    expect(asText).not.toContain(SECRET);
    // Nor any recognisable run of it: a construction that leaked a prefix would
    // still pass a whole-string check.
    expect(asText).not.toContain('sk-ant');
    expect(Buffer.from(sealed.ciphertext, 'base64').toString('utf8')).not.toContain('sk-ant');
  });

  it('uses a fresh IV every time', () => {
    // Not a style point. GCM with a repeated IV under one key leaks the XOR of
    // the two plaintexts AND the authentication subkey, which turns the tag from
    // a guarantee into decoration.
    const a = seal(SECRET, KEY, AAD);
    const b = seal(SECRET, KEY, AAD);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('refuses a tampered ciphertext rather than returning something else', () => {
    const sealed = seal(SECRET, KEY, AAD);
    const bytes = Buffer.from(sealed.ciphertext, 'base64');
    // `readUInt8`/`writeUInt8` rather than an index, because indexed access is
    // `number | undefined` under this tsconfig and a `?? 0` here would silently
    // flip a byte that was never read.
    bytes.writeUInt8(bytes.readUInt8(0) ^ 0xff, 0);
    expect(() => open({ ...sealed, ciphertext: bytes.toString('base64') }, KEY, AAD)).toThrow(
      EnvelopeError,
    );
  });

  it('refuses a tampered tag', () => {
    const sealed = seal(SECRET, KEY, AAD);
    const bytes = Buffer.from(sealed.tag, 'base64');
    // `readUInt8`/`writeUInt8` rather than an index, because indexed access is
    // `number | undefined` under this tsconfig and a `?? 0` here would silently
    // flip a byte that was never read.
    bytes.writeUInt8(bytes.readUInt8(0) ^ 0xff, 0);
    expect(() => open({ ...sealed, tag: bytes.toString('base64') }, KEY, AAD)).toThrow(
      EnvelopeError,
    );
  });

  it('refuses a truncated tag rather than accepting a weaker one', () => {
    // `setAuthTag` accepts several lengths, so without the explicit check a
    // 4-byte tag would be 2^32 times easier to forge and still be "valid GCM".
    const sealed = seal(SECRET, KEY, AAD);
    const short = Buffer.from(sealed.tag, 'base64').subarray(0, 4).toString('base64');
    expect(() => open({ ...sealed, tag: short }, KEY, AAD)).toThrow(EnvelopeError);
  });

  it('refuses a swapped IV', () => {
    const sealed = seal(SECRET, KEY, AAD);
    const other = seal(SECRET, KEY, AAD);
    expect(() => open({ ...sealed, iv: other.iv }, KEY, AAD)).toThrow(EnvelopeError);
  });

  it('refuses the wrong master key', () => {
    const sealed = seal(SECRET, KEY, AAD);
    expect(() => open(sealed, parseMasterKey(OTHER_HEX), AAD)).toThrow(EnvelopeError);
  });

  it('refuses the wrong AAD, which is what binds a key to its row', () => {
    const sealed = seal(SECRET, KEY, AAD);
    for (const wrong of [
      modelConnectionAad('room-2', 'anthropic', 1),
      modelConnectionAad('room-1', 'openai', 1),
      modelConnectionAad('room-1', 'anthropic', 2),
    ]) {
      expect(() => open(sealed, KEY, wrong)).toThrow(EnvelopeError);
    }
  });

  it('says nothing about which part was wrong', () => {
    // Telling them apart would tell an attacker which half of their guess was
    // right, and the caller's next move is identical either way.
    const sealed = seal(SECRET, KEY, AAD);
    const wrongKey = (() => {
      try {
        open(sealed, parseMasterKey(OTHER_HEX), AAD);
      } catch (err) {
        return (err as Error).message;
      }
      return '';
    })();
    const wrongAad = (() => {
      try {
        open(sealed, KEY, 'model_connections:other:openai:v1');
      } catch (err) {
        return (err as Error).message;
      }
      return '';
    })();
    expect(wrongKey).toBe(wrongAad);
    expect(wrongKey).not.toContain(SECRET);
  });
});

describe('keyHint', () => {
  it('is the last four characters', () => {
    expect(keyHint(SECRET)).toBe('4f2a');
  });

  it('reveals nothing when the key is too short to hint at', () => {
    // The one case where a hint could BE the credential is the case nobody
    // thinks about.
    expect(keyHint('abc')).toBe('••••');
    expect(keyHint('abcd')).toBe('••••');
  });

  it('ignores surrounding whitespace, which a paste carries', () => {
    expect(keyHint(`  ${SECRET}\n`)).toBe('4f2a');
  });
});

describe('secretEquals', () => {
  it('is true only for an exact match', () => {
    expect(secretEquals('abc', 'abc')).toBe(true);
    expect(secretEquals('abc', 'abd')).toBe(false);
    expect(secretEquals('abc', 'abcd')).toBe(false);
    expect(secretEquals('', '')).toBe(true);
  });
});
