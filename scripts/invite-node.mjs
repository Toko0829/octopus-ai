#!/usr/bin/env node
/**
 * Invite an expert to the marketplace. **The only way a node comes into
 * existence.**
 *
 * There is no route, no policy and no client grant that can create a
 * `node_profiles` row: `public.invite_node` is reachable by `service_role`
 * alone, and this file is its only caller. That is the cold-start decision in
 * docs/30-modules/human-nodes-marketplace.md, and it is structural rather than
 * procedural. A person who completes identity verification and is never offered
 * anything is a dead end in this repository's exact sense, and it bites the
 * moment onboarding exists without a matcher. "An empty marketplace with three
 * invited notaries is a decision; an empty marketplace with a public sign-up
 * form is a dead end."
 *
 * **This is not an ops console and must not be dressed up as one.** The admin
 * surfaces are Phase 3 (docs/30-modules/admin-ops.md). A script run by somebody
 * holding the secret key is the honest amount of tooling for a decision that
 * gets made a handful of times, and it introduces no role-gated route,
 * no `profiles.role` authorisation, and no half-built console to maintain.
 *
 * Zero runtime dependencies on purpose, matching `check-docs.mjs`: plain
 * `fetch` against PostgREST and GoTrue, so running it needs no install step and
 * no workspace build.
 *
 * Usage:
 *   node scripts/invite-node.mjs --email someone@example.com \
 *     --jurisdictions US-TX,US --languages en --confirm
 *
 *   node scripts/invite-node.mjs --user-id <uuid> \
 *     --jurisdictions US --languages en,ka --confirm
 *
 * Environment (the same variables `apps/api` reads):
 *   SUPABASE_URL, SUPABASE_SECRET_KEY
 */

const argv = process.argv.slice(2);

function flag(name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

/**
 * Refuse, with a reason and a non-zero exit code.
 *
 * It throws rather than calling `process.exit`, and that is a fix rather than a
 * style choice. `process.exit` tears the process down while `fetch`'s socket is
 * still open, which on Windows trips a libuv assertion **after** the exit code is
 * set and replaces it with 127. A script whose refusals report "command not
 * found" to a pipeline is worse than one that does not refuse at all, because the
 * failure looks like the wrong thing. Throwing lets the runtime unwind, and
 * `main()`'s catch sets `process.exitCode` so Node exits 1 once the loop drains.
 */
class Refused extends Error {}

function die(message, hint) {
  const err = new Refused(message);
  err.hint = hint;
  throw err;
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url) die('SUPABASE_URL is not set.', 'See .env.example.');
  if (!secret) {
    die(
      'SUPABASE_SECRET_KEY is not set.',
      'invite_node is granted to service_role alone, so there is no other way in. See .env.example.',
    );
  }

  const email = flag('email');
  const userIdArg = flag('user-id');
  if (!email && !userIdArg) {
    die('Give either --email or --user-id.', 'Usage is at the top of scripts/invite-node.mjs.');
  }

  const jurisdictions = (flag('jurisdictions') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const languages = (flag('languages') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Both are required here as well as in SQL, so an operator learns it before a
  // round trip rather than from a raise. A node who serves nowhere and speaks
  // nothing can never be matched, which would be the dead end this script exists
  // to avoid creating.
  if (jurisdictions.length === 0) {
    die(
      '--jurisdictions is required, comma separated.',
      'Hierarchical codes, for example US-TX,US. See ADR-0015.',
    );
  }
  if (languages.length === 0) die('--languages is required, comma separated. For example: en,ka');

  const headers = {
    apikey: secret,
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/json',
  };

  /**
   * An account, never an email.
   *
   * `invite_node` refuses a user with no profile, and this refuses one step
   * earlier with a sentence somebody can act on. Creating the account here would
   * mean minting a credential for somebody who has not agreed to anything, which
   * an invitation must not do.
   */
  async function resolveUserId() {
    if (userIdArg) return userIdArg;

    const res = await fetch(
      `${url}/auth/v1/admin/users?filter=${encodeURIComponent(email)}&per_page=200`,
      { headers },
    );
    if (!res.ok) {
      die(
        `Could not search accounts (${res.status}).`,
        'Check SUPABASE_URL and that SUPABASE_SECRET_KEY is the secret key, not the publishable one.',
      );
    }
    const body = await res.json();
    const users = Array.isArray(body) ? body : (body.users ?? []);
    // Exact match, case insensitive. The filter is a substring search, so
    // "sam@x.com" would otherwise also return "sam@x.community".
    const match = users.find((u) => String(u.email ?? '').toLowerCase() === email.toLowerCase());
    if (!match) {
      die(
        `No Octopus account for ${email}.`,
        'Ask them to sign up first. An invitation attaches to an account rather than creating one.',
      );
    }
    return match.id;
  }

  const userId = await resolveUserId();

  console.log('');
  console.log('  Inviting an expert to the marketplace');
  console.log(`    project        ${url}`);
  console.log(`    account        ${email ?? '(by id)'}`);
  console.log(`    user id        ${userId}`);
  console.log(`    jurisdictions  ${jurisdictions.join(', ')}`);
  console.log(`    languages      ${languages.join(', ')}`);
  console.log('');
  console.log('  This creates their marketplace record and promotes their role to human_node,');
  console.log('  which makes them eligible for paid work funded from a budget somebody');
  console.log('  else authorised.');
  console.log('');

  // A privileged act should not happen on a typo. The confirmation is cheap and
  // the mistake it prevents is turning the wrong person into a node.
  if (!argv.includes('--confirm')) {
    die('Nothing was written.', 'Re-run with --confirm once the details above are right.');
  }

  const res = await fetch(`${url}/rest/v1/rpc/invite_node`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      p_user_id: userId,
      p_jurisdictions: jurisdictions,
      p_languages: languages,
    }),
  });

  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    // The function's own hints are written for exactly this moment, so they are
    // printed rather than summarised.
    die(
      `invite_node refused (${res.status}): ${detail?.message ?? 'unknown error'}`,
      detail?.hint ?? '',
    );
  }

  const webUrl = process.env.WEB_URL ?? 'http://localhost:3000';
  console.log('  Done.');
  console.log('');
  console.log(`  Send them to ${webUrl}/node to finish their profile and verify their identity.`);
  console.log('  They start paused and unverified, and cannot make themselves available until');
  console.log('  the identity check passes.');
  console.log('');
  console.log('  Re-running this with the same account is safe: it will not reset anything.');
  console.log('');
}

main().catch((err) => {
  if (err instanceof Refused) {
    console.error(`\n  ${err.message}`);
    if (err.hint) console.error(`  ${err.hint}`);
    console.error('');
  } else {
    console.error(`\n  Unexpected failure: ${err?.message ?? err}\n`);
  }
  process.exitCode = 1;
});
