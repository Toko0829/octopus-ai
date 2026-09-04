import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * AES-256-GCM for the customer credentials this system stores, which today
 * means the model keys in `model_connections` (ADR-0032 decision 7).
 *
 * **Plain `node:crypto`, no dependency.** One algorithm, one key size, one
 * well-documented construction, in a file short enough to read in full. A
 * library here would be a supply-chain surface around forty lines of standard
 * library.
 *
 * **GCM rather than CBC, because the tag is the point.** This is not only about
 * confidentiality: a ciphertext somebody could edit is a ciphertext that decrypts
 * to a key of their choosing, which is an outbound request to an endpoint of
 * their choosing. GCM authenticates, so a tampered ciphertext throws rather than
 * producing plausible garbage.
 *
 * **And the AAD binds a sealed value to the row it belongs to.** The additional
 * authenticated data is not encrypted and does not need to be; it is mixed into
 * the tag, so opening with a different AAD fails. That is what makes copying one
 * room's ciphertext into another room's row useless: the sealed key for room A's
 * Anthropic connection cannot be opened as room B's, even by somebody holding
 * both the database and the master key.
 *
 * **Why not Supabase Vault**, which would have been less code: Vault decrypts
 * inside Postgres for any role that can read `vault.decrypted_secrets`, and
 * `services/ai` holds `service_role`. The property this file exists to buy is
 * that decryption happens only in the Node code that builds the outbound
 * request, and Vault would have handed the Python container every customer's key
 * behind a select.
 */

/** Thrown when a value cannot be opened. Never carries the ciphertext or the key. */
export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

/** A sealed value, as three base64 strings. Stored as three columns. */
export interface Sealed {
  ciphertext: string;
  iv: string;
  tag: string;
}

/** 96 bits, which is the size GCM is specified and optimised for. */
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * Turn the hex in `MODEL_KEY_SECRET` into a key, or throw.
 *
 * Validated here as well as in the env schema, and the duplication is
 * deliberate: the schema catches a bad value at boot for the API, and this
 * catches one reaching any other caller. A 16-byte key would otherwise silently
 * become AES-128 under a variable whose whole documented meaning is AES-256.
 */
export function parseMasterKey(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new EnvelopeError(
      'MODEL_KEY_SECRET must be exactly 64 hex characters (openssl rand -hex 32).',
    );
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== KEY_BYTES) {
    throw new EnvelopeError('MODEL_KEY_SECRET did not decode to 32 bytes.');
  }
  return key;
}

/**
 * Seal a value under `key`, bound to `aad`.
 *
 * A fresh random IV every time, which is not optional: GCM with a repeated IV
 * under the same key leaks the XOR of the two plaintexts and, worse, the
 * authentication subkey, which turns the tag from a guarantee into decoration.
 * So the IV travels with the ciphertext rather than being derived from anything
 * about the row, and two seals of the same key differ.
 */
export function seal(plaintext: string, key: Buffer, aad: string): Sealed {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * Open a sealed value, or throw `EnvelopeError`.
 *
 * Every failure is the same error with the same message: a wrong key, a tampered
 * ciphertext, a swapped tag and the wrong AAD are indistinguishable to the
 * caller on purpose. Telling them apart would tell an attacker which half of
 * their guess was right, and the caller's next move is identical either way.
 *
 * The message names no value. A thrown string ends up in a log, and this
 * function's inputs are a customer's credential and our master key.
 */
export function open(sealed: Sealed, key: Buffer, aad: string): string {
  let tag: Buffer;
  let iv: Buffer;
  try {
    tag = Buffer.from(sealed.tag, 'base64');
    iv = Buffer.from(sealed.iv, 'base64');
  } catch {
    throw new EnvelopeError('Could not open the stored credential.');
  }
  // Checked before `setAuthTag`, which accepts several lengths and would let a
  // truncated tag weaken the very check it is: a 4-byte tag is 2^32 times easier
  // to forge than a 16-byte one, and both are "valid GCM".
  if (tag.length !== 16 || iv.length !== IV_BYTES) {
    throw new EnvelopeError('Could not open the stored credential.');
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new EnvelopeError('Could not open the stored credential.');
  }
}

/**
 * The additional authenticated data for one connection row.
 *
 * Every component is a fact about WHICH row this is, so a ciphertext is only
 * openable where it was written. `key_version` is in it as well, so a rotation
 * cannot accidentally open a v1 ciphertext as a v2 one and return bytes that are
 * not the key.
 *
 * Built here rather than at the call sites so the seal and the open cannot
 * disagree about its shape, which would be a total, silent failure to decrypt
 * every stored key.
 */
export function modelConnectionAad(roomId: string, provider: string, keyVersion: number): string {
  return `model_connections:${roomId}:${provider}:v${keyVersion}`;
}

/**
 * The last four characters of a key, for telling two apart in a list.
 *
 * Four is the card-number convention and is chosen for the same reason: enough
 * to recognise a key you hold, useless to anybody who does not. Short keys are
 * padded rather than revealed in full, because the one case where a hint could
 * BE the credential is the case nobody thinks about.
 */
export function keyHint(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 4) return '••••';
  return trimmed.slice(-4);
}

/**
 * Constant-time equality for two short secrets of equal length.
 *
 * Exported because the fake provider's key check compares a literal prefix and
 * `===` on secrets is the habit worth not forming. Length is compared first and
 * leaks, which is the standard and acceptable disclosure.
 */
export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
