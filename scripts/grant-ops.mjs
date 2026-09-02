#!/usr/bin/env node
/**
 * Make somebody an operator. **The only way `profiles.role` reaches `ops`.**
 *
 * There is no route, no policy and no UI that can grant this. `authenticated`
 * holds a column grant on `profiles` covering `display_name`, `jurisdiction` and
 * `languages` only, and `private.guard_profile_role_self_service` refuses a
 * `role` change from any writer carrying a JWT (`20260831110000`). `service_role`
 * writes with no claims, so `auth.uid()` reads null and the guard lets the server
 * path through — which is why this script needs **no migration of its own** and
 * why it is the whole of the granting mechanism.
 *
 * ---------- Why this is a second script and not a flag on invite-node ----------
 *
 * `scripts/invite-node.mjs` opens by saying it "is not an ops console and must
 * not be dressed up as one", and it refuses `admin` and `ops` accounts outright.
 * Adding `--role ops` to it would make that paragraph false in the same file it
 * is written in. The two acts are also different in kind: inviting a node
 * creates a marketplace record for somebody who will be **paid** through the
 * platform, and granting ops gives somebody authority **over other people's**
 * money. A shared entry point would blur which one was being performed.
 *
 * ---------- What this grants, stated plainly ----------
 *
 * An operator can read every open dispute, both parties' names, the escrow
 * holds, the payout rows and the raw `ledger_entries` behind them, and can
 * decide where disputed money goes: release it to the expert, refund it to the
 * client, split it, or send the step back to the market. Every decision is
 * written to `ops_actions` with their id and their stated reason, in the same
 * transaction as the money, so the trail cannot be omitted. It is not
 * revocable-by-them: only this script with `--revoke` puts the role back.
 *
 * Zero runtime dependencies, matching `invite-node.mjs` and `check-docs.mjs`:
 * plain `fetch` against PostgREST and GoTrue, so running it needs no install
 * step and no workspace build.
 *
 * Usage:
 *   node scripts/grant-ops.mjs --email someone@example.com --confirm
 *   node scripts/grant-ops.mjs --user-id <uuid> --confirm
 *   node scripts/grant-ops.mjs --email someone@example.com --revoke --confirm
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
 * Throws rather than calling `process.exit`, for the reason `invite-node.mjs`
 * records: `process.exit` tears the process down while `fetch`'s socket is open,
 * which on Windows trips a libuv assertion after the exit code is set and
 * replaces it with 127. A script whose refusals report "command not found" to a
 * pipeline is worse than one that does not refuse at all.
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
      'A role change is refused for any writer carrying a JWT (20260831110000), so the ' +
        'service key is the only way in. See .env.example.',
    );
  }

  const email = flag('email');
  const userIdArg = flag('user-id');
  if (!email && !userIdArg) {
    die('Give either --email or --user-id.', 'Usage is at the top of scripts/grant-ops.mjs.');
  }

  const revoking = argv.includes('--revoke');

  /**
   * **`admin` is refused, and that is deliberate.**
   *
   * `user_role` has carried both `admin` and `ops` since `20260724000000`, and
   * nothing in this build distinguishes them: `require-ops.ts` admits either.
   * Granting `admin` through this script would therefore hand out a role whose
   * extra powers do not exist yet and whose scope nobody has designed, which is
   * how a privilege ends up broader than the decision that created it. Scoped
   * permissions between the two are admin-ops.md's Phase-3 work; when they exist,
   * so can the flag.
   */
  const requested = flag('role');
  if (requested && requested !== 'ops') {
    die(
      `This script grants ops, not ${requested}.`,
      'admin and ops are indistinguishable in this build, so granting admin would hand out ' +
        'powers nobody has designed yet. See docs/30-modules/admin-ops.md.',
    );
  }

  const headers = {
    apikey: secret,
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/json',
  };

  /**
   * An account, never an email. The role is a column on a `profiles` row, so a
   * person who has never signed in has nothing to grant.
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
        'Ask them to sign up first. A role attaches to an account rather than creating one.',
      );
    }
    return match.id;
  }

  const userId = await resolveUserId();

  // Read the current role, so the plan below states what is actually changing
  // rather than what is assumed to be. A grant that turns out to be a no-op, or
  // one that would demote a node, should be visible before `--confirm`.
  const currentRes = await fetch(
    `${url}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=user_id,display_name,role`,
    { headers },
  );
  if (!currentRes.ok) {
    die(`Could not read that profile (${currentRes.status}).`, 'Check SUPABASE_URL and the key.');
  }
  const [profile] = await currentRes.json();
  if (!profile) {
    die(
      `No profile row for ${userId}.`,
      'A profile is created on first sign-in. Ask them to sign in once.',
    );
  }

  const target = revoking ? 'user' : 'ops';

  /**
   * **Refuse to demote a node through this script.**
   *
   * `--revoke` writes `'user'`, which for a `human_node` would silently strip
   * their marketplace eligibility while leaving their `node_profiles` row,
   * skills and credentials in place: an expert who could no longer be offered
   * work and no surface that said why. `invite_node` refuses the mirror of this
   * ("a promotion that runs backwards is a privilege bug wearing an onboarding
   * shape"), and the same reasoning runs in this direction.
   */
  if (revoking && profile.role !== 'ops' && profile.role !== 'admin') {
    die(
      `${profile.display_name ?? userId} is ${profile.role}, not an operator.`,
      'This script only takes back ops. Changing anything else about a role is not its job.',
    );
  }
  if (!revoking && profile.role === 'human_node') {
    die(
      `${profile.display_name ?? userId} is a human_node.`,
      'Making an expert an operator would let them decide disputes about work they can be ' +
        'offered. Use a separate account.',
    );
  }

  console.log('');
  console.log(revoking ? '  Taking back operator access' : '  Granting operator access');
  console.log(`    project     ${url}`);
  console.log(`    account     ${email ?? '(by id)'}`);
  console.log(`    user id     ${userId}`);
  console.log(`    name        ${profile.display_name ?? '(none set)'}`);
  console.log(`    role        ${profile.role}  ->  ${target}`);
  console.log('');
  if (profile.role === target) {
    console.log(`  They are already ${target}. Re-running this changes nothing.`);
    console.log('');
  } else if (!revoking) {
    console.log('  An operator can read every dispute, both parties and the ledger behind them,');
    console.log('  and can decide where disputed money goes: release it to the expert, refund it');
    console.log('  to the client, split it, or send the step back to the market. Every decision');
    console.log('  is written to ops_actions with their id and their reason.');
    console.log('');
  }

  // A privileged act should not happen on a typo, and this one is more
  // consequential than an invitation: it is authority over other people's money.
  if (!argv.includes('--confirm')) {
    die('Nothing was written.', 'Re-run with --confirm once the details above are right.');
  }

  const res = await fetch(`${url}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify({ role: target }),
  });

  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    // The guard's own hints are written for exactly this moment, so they are
    // printed rather than summarised.
    die(
      `The role change was refused (${res.status}): ${detail?.message ?? 'unknown error'}`,
      detail?.hint ??
        'If this says role changes are not self-service, the key in use is not the secret key.',
    );
  }

  const webUrl = process.env.WEB_URL ?? 'http://localhost:3000';
  console.log('  Done.');
  console.log('');
  if (revoking) {
    console.log(`  ${webUrl}/ops now redirects them to their workspace.`);
    console.log('  Everything they decided stays in ops_actions: the trail is append-only.');
  } else {
    console.log(`  Send them to ${webUrl}/ops. Open disputes are listed oldest first.`);
    console.log('  Every resolution asks for a reason, and records it against their account.');
  }
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
