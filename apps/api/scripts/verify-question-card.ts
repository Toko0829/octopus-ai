/**
 * Drive the question-card answer path against the LIVE database, without the
 * ticker.
 *
 * Every route test in this package stubs the Supabase client, so no test here
 * can fail on a PostgREST filter, an rpc name or a column. This script builds
 * the routes the slices touch into a bare Fastify app, mints real sessions
 * for two throwaway users, and drives the chain end to end in a throwaway room.
 * It deliberately does NOT build the whole server: `startTicker` would fire a
 * pass against live projects with no AI service reachable.
 *
 * The AI service is pointed at a closed port on purpose. A finished card
 * continues the run, the run fails to reach the service, and the failure notice
 * it posts is the evidence that `continueFromCard` ran through `requestIntake`
 * and `requestPlan` to `postSystemNotice` against real rows.
 *
 * Run from `apps/api`:
 *   npx tsx --env-file=.env scripts/verify-question-card.ts
 *
 * Creates and deletes: two auth users, one room (cascading its messages, cards
 * and members). Nothing else is touched.
 */

import Fastify from 'fastify';
import { createClient } from '@supabase/supabase-js';
import { createAuthVerifier } from '../src/plugins/auth';
import { createServiceClient, type SupabaseConfig } from '../src/lib/supabase';
import { embedRoutes } from '../src/routes/embeds';
import { agentRunRoutes } from '../src/routes/agent-runs';
import { messageRoutes } from '../src/routes/messages';
import { roomRoutes } from '../src/routes/rooms';

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

const verify = createAuthVerifier(need('SUPABASE_JWKS_URL'), process.env.SUPABASE_JWT_ISSUER);
const admin = createServiceClient(supabase);

function check(cond: unknown, label: string) {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`ok - ${label}`);
}

async function mintUser(tag: string): Promise<{ id: string; token: string }> {
  const email = `qa-${tag}-${Date.now()}@test.invalid`;
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (error || !created.user) throw error ?? new Error('no user');
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
  return { id: created.user.id, token: session.session.access_token };
}

async function waitFor<T>(label: string, read: () => Promise<T | null>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await read();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`FAIL: timed out waiting for ${label}`);
}

async function main() {
  const owner = await mintUser('owner');
  const stranger = await mintUser('member');
  let roomId: string | null = null;

  try {
    const { data: room, error: roomError } = await admin
      .from('rooms')
      .insert({ name: 'QA question card', owner_id: owner.id })
      .select('id')
      .single();
    if (roomError) throw roomError;
    roomId = room.id as string;

    const { error: memberError } = await admin.from('room_members').insert([
      { room_id: roomId, user_id: owner.id, role: 'user' },
      { room_id: roomId, user_id: stranger.id, role: 'user' },
    ]);
    if (memberError) throw memberError;

    const RUN = 'run-qa-1';
    async function postCard(key: string, payload: Record<string, unknown>) {
      const { data: message, error } = await admin
        .from('messages')
        .insert({
          room_id: roomId,
          author_id: null,
          author_kind: 'agent',
          body: 'questions',
          idempotency_key: `qa:${key}:${Date.now()}`,
        })
        .select('id')
        .single();
      if (error) throw error;
      const { data: embed, error: embedError } = await admin
        .from('action_embeds')
        .insert({
          message_id: message.id,
          room_id: roomId,
          component: 'question',
          payload,
          required_role: 'owner',
          state: 'pending',
        })
        .select('id')
        .single();
      if (embedError) throw embedError;
      return embed.id as string;
    }

    const intake = {
      awaiting: 'answers',
      goal: 'get my first 100 customers',
      questions: [
        { slot: 'icp', question: 'Who is it for?' },
        { slot: 'budget_band', question: 'How much a month?' },
      ],
      slots: [{ key: 'offer', value: 'a course', source: 'inferred' }],
      round: 0,
      answers: [],
      stalls: 0,
      taskIds: [],
      runId: RUN,
    };
    const cardId = await postCard('intake', intake);
    const staleId = await postCard('stale', { ...intake, runId: 'run-qa-2' });
    const taskCardId = await postCard('tasks', {
      awaiting: 'task_answers',
      goal: '',
      questions: [],
      slots: [],
      round: 0,
      answers: [],
      stalls: 0,
      taskIds: ['11111111-1111-4111-8111-111111111111'],
      tasks: [{ id: '11111111-1111-4111-8111-111111111111', title: 'A step' }],
    });

    const app = Fastify({ logger: { level: 'warn' } });
    const ai = { aiServiceUrl: 'http://127.0.0.1:9', aiTimeoutMs: 3000, intakeTimeoutMs: 3000 };
    await app.register(embedRoutes, { verify, supabase, ...ai });
    await app.register(agentRunRoutes, { verify, supabase, ...ai });
    await app.register(messageRoutes, { verify, supabase });
    await app.register(roomRoutes, { verify, supabase });

    const act = (token: string, embedId: string, payload: unknown) =>
      app.inject({
        method: 'POST',
        url: `/api/rooms/${roomId}/embeds/${embedId}/actions`,
        headers: { authorization: `Bearer ${token}` },
        payload,
      });

    // 1. A member who is not the owner is refused before anything is written.
    const r1 = await act(stranger.token, cardId, { action: 'answer', slot: 'icp', value: 'x' });
    check(r1.statusCode === 403, `non-owner answer refused (${r1.statusCode})`);

    // 2. The owner answers one slot: rpc through PostgREST, payload comes back.
    const r2 = await act(owner.token, cardId, {
      action: 'answer',
      slot: 'icp',
      value: 'solo founders',
    });
    check(r2.statusCode === 200, `owner slot answer accepted (${r2.statusCode} ${r2.body})`);
    const b2 = r2.json();
    check(b2.state === 'pending', 'card stays pending after one of two');
    check(JSON.stringify(b2.remaining) === '["budget_band"]', 'remaining names the other slot');
    check(
      b2.payload.slots.some(
        (s: { key: string; source: string }) => s.key === 'icp' && s.source === 'stated',
      ),
      'response payload carries the stated slot',
    );

    // 3. Correcting the same slot keeps one entry.
    const r3 = await act(owner.token, cardId, { action: 'answer', slot: 'icp', value: 'creators' });
    check(r3.statusCode === 200, 'a correction is accepted');
    const { data: row3 } = await admin
      .from('action_embeds')
      .select('payload')
      .eq('id', cardId)
      .single();
    const icp = (row3!.payload as { slots: { key: string; value: string }[] }).slots.filter(
      (s) => s.key === 'icp',
    );
    check(
      icp.length === 1 && icp[0]!.value === 'creators',
      'the row holds one icp entry, corrected',
    );

    // 4. A verdict on a question card has nothing to approve.
    const r4 = await act(owner.token, cardId, { action: 'approve' });
    check(r4.statusCode === 409, `verdict on a question refused (${r4.statusCode})`);

    // 5. The last required slot closes the card and continues the run.
    const r5 = await act(owner.token, cardId, {
      action: 'answer',
      slot: 'budget_band',
      value: '500_2k',
    });
    check(r5.statusCode === 200, `last slot accepted (${r5.statusCode} ${r5.body})`);
    check(r5.json().state === 'answered', 'card reports answered');
    const { data: row5 } = await admin
      .from('action_embeds')
      .select('state, acted_by')
      .eq('id', cardId)
      .single();
    check(
      row5!.state === 'answered' && row5!.acted_by === owner.id,
      'row is answered by the owner',
    );

    // 6. The continuation ran: with no AI service, it posts the failure notice
    //    under the deterministic continuation run id.
    await waitFor('continuation failure notice', async () => {
      const { data } = await admin
        .from('messages')
        .select('id, body')
        .eq('room_id', roomId!)
        .eq('idempotency_key', `agent-run:${RUN}:r1:failed`)
        .maybeSingle();
      return data;
    });
    check(true, 'continuation reached the runner and reported the unreachable service');

    // 6b. The slot answers were remembered as facts about the business, with
    //     the correction winning and the inferred offer never persisted.
    const { data: profile } = await admin
      .from('room_profiles')
      .select('icp, offer, budget_band, updated_by')
      .eq('room_id', roomId)
      .maybeSingle();
    check(
      profile?.icp === 'creators' && profile?.budget_band === '500_2k' && profile?.offer === null,
      'room profile holds the stated icp and budget band, and not the inferred offer',
    );
    check(profile?.updated_by === owner.id, 'profile is attributed to the owner');

    // 6c. The profile routes: the owner reads and writes, a member reads nulls
    //     and cannot write, and only the keys sent are written.
    const p1 = await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}/profile`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    check(
      p1.statusCode === 200 && p1.json().profile.icp === 'creators',
      `owner reads the profile through RLS (${p1.statusCode} ${p1.body})`,
    );
    const p2 = await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}/profile`,
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    check(
      p2.statusCode === 200 && p2.json().profile.icp === null,
      'a member reads nulls, not the facts the owner stated',
    );
    const p3 = await app.inject({
      method: 'PATCH',
      url: `/api/rooms/${roomId}/profile`,
      headers: { authorization: `Bearer ${stranger.token}` },
      payload: { offer: 'x' },
    });
    check(p3.statusCode === 403, `a member cannot write the profile (${p3.statusCode})`);
    const p4 = await app.inject({
      method: 'PATCH',
      url: `/api/rooms/${roomId}/profile`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { offer: 'a paid course' },
    });
    check(
      p4.statusCode === 200 &&
        p4.json().profile.offer === 'a paid course' &&
        p4.json().profile.icp === 'creators',
      'the owner writes one key and the others survive',
    );

    // 7. Answering the closed card again is refused by the function, not by us.
    const r7 = await act(owner.token, cardId, { action: 'answer', slot: 'icp', value: 'late' });
    check(r7.statusCode === 409, `answer on a closed card refused (${r7.statusCode})`);

    // 8. The read path parses the new fields.
    const r8 = await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}/messages`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    check(r8.statusCode === 200, `messages read (${r8.statusCode})`);
    const embeds = (
      r8.json().messages as {
        embed: { id: string; state: string; payload: { runId?: string; slots: unknown[] } } | null;
      }[]
    )
      .map((m) => m.embed)
      .filter(Boolean);
    const read = embeds.find((e) => e!.id === cardId)!;
    check(
      read &&
        read.state === 'answered' &&
        read.payload.runId === RUN &&
        read.payload.slots.length === 3,
      'the answered card round-trips through the message reader with runId and three slots',
    );
    check(
      embeds.some((e) => e!.id === taskCardId),
      'a task card carrying titles parses',
    );

    // 9. An owner's new goal dismisses the stale intake card and not the task card.
    const r9 = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/agent-runs`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { goal: 'get more customers for my course' },
    });
    check(r9.statusCode === 202, `new goal accepted (${r9.statusCode})`);
    await waitFor('stale intake card dismissed', async () => {
      const { data } = await admin.from('action_embeds').select('state').eq('id', staleId).single();
      return data?.state === 'dismissed' ? data : null;
    });
    check(true, 'stale intake card dismissed by the new goal');
    await waitFor('started notice for the new goal', async () => {
      const { data } = await admin
        .from('messages')
        .select('id, body')
        .eq('room_id', roomId!)
        .like('idempotency_key', `agent-run:${r9.json().runId}:started`)
        .maybeSingle();
      return data;
    });
    check(true, 'the room is told work has started before the plan arrives');
    const { data: taskRow } = await admin
      .from('action_embeds')
      .select('state')
      .eq('id', taskCardId)
      .single();
    check(taskRow!.state === 'pending', 'task card left pending');

    await app.close();
    console.log('\nall checks passed');
  } finally {
    if (roomId) await admin.from('rooms').delete().eq('id', roomId);
    await admin.auth.admin.deleteUser(owner.id);
    await admin.auth.admin.deleteUser(stranger.id);
    console.log('cleaned up');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
