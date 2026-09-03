/**
 * A throwaway workspace with a pending question card, and a browser session
 * for its owner, so `QuestionCard` can be looked at and clicked in a real page.
 *
 * There is no password for any test account and no auth callback route in the
 * web app, so a browser session cannot be had by signing in. This mints one:
 * GoTrue's admin link, verified through the publishable client, then wrapped
 * the way `@supabase/ssr` stores it in the cookie the web app reads.
 *
 * Run from `apps/api`:
 *   npx tsx --env-file=.env scripts/qa-question-fixture.ts
 *   npx tsx --env-file=.env scripts/qa-question-fixture.ts --cleanup <roomId> <userId>
 */

import { createClient } from '@supabase/supabase-js';
import { createServiceClient, type SupabaseConfig } from '../src/lib/supabase';

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name}`);
  return v;
}

const supabase: SupabaseConfig = {
  url: need('SUPABASE_URL'),
  publishableKey: need('SUPABASE_PUBLISHABLE_KEY'),
  secretKey: need('SUPABASE_SECRET_KEY'),
} as SupabaseConfig;
const admin = createServiceClient(supabase);

async function cleanup(roomId: string, userId: string) {
  await admin.from('rooms').delete().eq('id', roomId);
  await admin.auth.admin.deleteUser(userId);
  console.log('cleaned up');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--cleanup') return cleanup(argv[1]!, argv[2]!);

  const email = `qa-card-${Date.now()}@test.invalid`;
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (error || !created.user) throw error ?? new Error('no user');
  const userId = created.user.id;

  const { data: room, error: roomError } = await admin
    .from('rooms')
    .insert({ name: 'QA card room', owner_id: userId })
    .select('id')
    .single();
  if (roomError) throw roomError;
  const roomId = room.id as string;
  await admin.from('room_members').insert({ room_id: roomId, user_id: userId, role: 'user' });

  async function post(body: string, payload: Record<string, unknown> | null, kind = 'agent') {
    const { data: message, error: mErr } = await admin
      .from('messages')
      .insert({
        room_id: roomId,
        author_id: kind === 'user' ? userId : null,
        author_kind: kind,
        body,
        idempotency_key: `qa-card:${Date.now()}:${Math.random()}`,
      })
      .select('id')
      .single();
    if (mErr) throw mErr;
    if (!payload) return;
    const { error: eErr } = await admin.from('action_embeds').insert({
      message_id: message.id,
      room_id: roomId,
      component: 'question',
      payload,
      required_role: 'owner',
      state: 'pending',
    });
    if (eErr) throw eErr;
  }

  await post('get my first 100 customers', null, 'user');
  await post(
    'A few things would make this plan sharper.\n\n- Who is it for?\n- What are you measuring?\n- How much a month?\n\nAnswer on the card, in any order. I will plan with whatever you give me.',
    {
      awaiting: 'answers',
      goal: 'get my first 100 customers',
      questions: [
        { slot: 'icp', question: 'Who is this for? A sentence about your customer.' },
        { slot: 'target_metric', question: 'What number tells you it worked?' },
        { slot: 'budget_band', question: 'Roughly how much can you spend a month?' },
      ],
      slots: [{ key: 'offer', value: 'an online course for founders', source: 'inferred' }],
      round: 0,
      answers: [],
      stalls: 0,
      taskIds: [],
      runId: 'qa-card-run',
    },
  );
  await post(
    'I have started on the plan and one step needs you:\n\n- Confirm the monthly ad budget',
    {
      awaiting: 'task_answers',
      goal: '',
      questions: [],
      slots: [],
      round: 0,
      answers: [],
      stalls: 0,
      taskIds: ['11111111-1111-4111-8111-111111111111'],
      tasks: [
        { id: '11111111-1111-4111-8111-111111111111', title: 'Confirm the monthly ad budget' },
      ],
    },
  );

  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (linkError) throw linkError;
  const pub = createClient(supabase.url, supabase.publishableKey);
  const { data: session, error: otpError } = await pub.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: 'magiclink',
  });
  if (otpError || !session.session) throw otpError ?? new Error('no session');

  const ref = new URL(supabase.url).hostname.split('.')[0];
  const json = JSON.stringify(session.session);
  const cookie = `base64-${Buffer.from(json, 'utf8').toString('base64url')}`;

  console.log(JSON.stringify({ roomId, userId, cookieName: `sb-${ref}-auth-token`, cookie }));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
