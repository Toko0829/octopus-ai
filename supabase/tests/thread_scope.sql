-- Thread-scoped membership tests — covers 20260901120000 … 20260901123000,
-- and 20260906120000, which gave a thread its own realtime topic.
--
-- Verified green against the live database: 46/46 at slice 2. Slice 6 widened it
-- to 54, and **14 of those have been re-run against the applied migrations and
-- are green**: the eleven realtime and deliberate-absence assertions, and the
-- three owner-side `room_members` ones added with `20260906125000`. The other 40
-- are untouched by either change and were last run at slice 5, so a full-file run
-- still wants a `DATABASE_URL`. Four of the eleven are
-- new and one flipped, which is the shape this file was written for: it pinned
-- "there is no thread topic branch" with a message naming the slice that would
-- add one, so the addition reads as a dated decision rather than as drift. Two
-- assertions found
-- something rather than confirming it: the room_members count caught
-- 20260901122000 reusing a predicate that asks a different question on the one
-- table whose rows are themselves scopes (corrected in 20260901123000), and the
-- cross-room membership case first returned 23505 rather than 23503, because the
-- fixture used a user who already held a row in the target room.
--
-- The slice has **no writer**, so its only caller today is this file, exactly as
-- `marketplace_rls.sql` is the only caller of the marketplace domain. That is
-- what makes guards landing ahead of writers defensible rather than dead: every
-- constraint and every narrowed policy is exercised here.
--
-- Two halves, split the way `marketplace_rls.sql` splits them and for the same
-- reasons.
--
--   * The **RLS and privilege half** runs as `authenticated` with
--     `request.jwt.claims` set, exactly as PostgREST would. Running it as
--     `postgres` would prove nothing: that role bypasses RLS entirely, which is
--     precisely how a policy bug survives review.
--   * The **constraint half** runs as `postgres` on purpose. These are checks and
--     foreign keys, not policies: they bind trusted server code, and
--     `service_role` is the only role that will ever write `threads`. A guard
--     that only refused clients would refuse nobody who was ever going to write
--     this table.
--
-- The regression half matters as much as the narrowing half here, and is what
-- most of the room-scoped assertions are for: a predicate rewritten one conjunct
-- too far would take the owner's own room away from them, and every one of those
-- failures reads as "nothing loads" rather than as a security change.
--
-- Everything is inside a transaction that ROLLBACKs, so the fixtures never
-- persist and this is safe against a live database.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/thread_scope.sql

begin;

select extensions.plan(55);

-- ---------------------------------------------------------------- fixtures

create temporary table tsids (k text primary key, v uuid);
insert into tsids (k, v) values
  ('owner',      gen_random_uuid()),
  ('member',     gen_random_uuid()),
  ('tnode',      gen_random_uuid()),
  ('texpired',   gen_random_uuid()),
  ('outsider',   gen_random_uuid()),
  ('room',       gen_random_uuid()),
  ('other_room', gen_random_uuid()),
  ('chan',       gen_random_uuid()),
  ('chan2',      gen_random_uuid()),
  ('other_chan', gen_random_uuid()),
  ('project',    gen_random_uuid()),
  ('task',       gen_random_uuid()),
  ('task2',      gen_random_uuid()),
  ('t1',         gen_random_uuid()),
  ('t2',         gen_random_uuid()),
  ('m_room',     gen_random_uuid()),
  ('m_t1',       gen_random_uuid()),
  ('m_t2',       gen_random_uuid());

create or replace function pg_temp.tsid(text) returns uuid language sql stable as
  $$ select v from tsids where k = $1 $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
select pg_temp.tsid(k), '00000000-0000-0000-0000-000000000000', 'authenticated',
       'authenticated', k || '@threads.invalid', '', now(), now(), now()
from (values ('owner'), ('member'), ('tnode'), ('texpired'), ('outsider')) as t(k);

insert into public.rooms (id, name, owner_id)
values (pg_temp.tsid('room'), 'Thread test room', pg_temp.tsid('owner')),
       (pg_temp.tsid('other_room'), 'Somebody else''s room', pg_temp.tsid('outsider'));

-- Two channels in the test room. The second is what proves the channel narrowing
-- is a narrowing: with one channel, "sees their thread's channel" and "sees every
-- channel" are the same answer.
insert into public.channels (id, room_id, name)
values (pg_temp.tsid('chan'),       pg_temp.tsid('room'),       'brief'),
       (pg_temp.tsid('chan2'),      pg_temp.tsid('room'),       'creative'),
       (pg_temp.tsid('other_chan'), pg_temp.tsid('other_room'), 'brief');

insert into public.projects (id, owner_id, goal)
values (pg_temp.tsid('project'), pg_temp.tsid('owner'), 'Grow the newsletter');
-- The legacy room link; `is_project_member` accepts it and it needs no plan card.
update public.rooms set project_id = pg_temp.tsid('project') where id = pg_temp.tsid('room');

insert into public.tasks (id, project_id, title, owner_type)
values (pg_temp.tsid('task'),  pg_temp.tsid('project'), 'Shoot the launch video', 'human'),
       (pg_temp.tsid('task2'), pg_temp.tsid('project'), 'Draft the launch email', 'ai');

-- T1 is the engaged task's thread; T2 is another thread in another channel that
-- the node must not reach.
insert into public.threads (id, room_id, channel_id, task_id, title)
values (pg_temp.tsid('t1'), pg_temp.tsid('room'), pg_temp.tsid('chan'),
        pg_temp.tsid('task'), 'Launch video shoot'),
       (pg_temp.tsid('t2'), pg_temp.tsid('room'), pg_temp.tsid('chan2'),
        pg_temp.tsid('task2'), 'Launch email draft');

-- The cast. `tnode` is admitted to T1 only; nothing in the product can create
-- this row yet, which is the point of the slice.
insert into public.room_members (room_id, user_id, role, scope, thread_id, expires_at)
values (pg_temp.tsid('room'), pg_temp.tsid('owner'),  'user',       'room',   null, null),
       (pg_temp.tsid('room'), pg_temp.tsid('member'), 'user',       'room',   null, now() + interval '1 day'),
       (pg_temp.tsid('room'), pg_temp.tsid('tnode'),  'human_node', 'thread', pg_temp.tsid('t1'), now() + interval '1 day'),
       (pg_temp.tsid('room'), pg_temp.tsid('texpired'), 'human_node', 'thread', pg_temp.tsid('t1'), now() - interval '1 hour'),
       (pg_temp.tsid('other_room'), pg_temp.tsid('outsider'), 'user', 'room', null, null);

-- Three messages: the room stream, T1, T2.
insert into public.messages (id, room_id, channel_id, thread_id, author_id, author_kind,
                             body, idempotency_key)
values (pg_temp.tsid('m_room'), pg_temp.tsid('room'), pg_temp.tsid('chan'), null,
        pg_temp.tsid('owner'), 'user', 'What is our launch plan?', 'ts-room-1'),
       (pg_temp.tsid('m_t1'), pg_temp.tsid('room'), pg_temp.tsid('chan'), pg_temp.tsid('t1'),
        pg_temp.tsid('owner'), 'user', 'Shoot is booked for Tuesday.', 'ts-t1-1'),
       (pg_temp.tsid('m_t2'), pg_temp.tsid('room'), pg_temp.tsid('chan2'), pg_temp.tsid('t2'),
        pg_temp.tsid('owner'), 'user', 'Subject line options.', 'ts-t2-1');

-- One embed on a message the node can see, one on a message it cannot. The
-- second is the whole reason action_embeds needed its own helper.
insert into public.action_embeds (message_id, room_id, component, payload)
values (pg_temp.tsid('m_room'), pg_temp.tsid('room'), 'plan', '{"stages":[]}'),
       (pg_temp.tsid('m_t1'),   pg_temp.tsid('room'), 'artifact', '{"kind":"video"}');

insert into public.feedback_events (room_id, actor_id, verdict, subject)
values (pg_temp.tsid('room'), pg_temp.tsid('owner'), 'approved', '{"plan":"v1"}');

insert into public.profiles (user_id, display_name)
values (pg_temp.tsid('owner'), 'Owner'),
       (pg_temp.tsid('member'), 'Member'),
       (pg_temp.tsid('tnode'), 'Node')
on conflict (user_id) do nothing;

-- Helper: run a count as a given user, exactly as PostgREST would.
create or replace function pg_temp.tscount_as(p_user uuid, p_sql text)
returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  execute p_sql into n;
  perform set_config('role', 'postgres', true);
  return n;
end $$;

-- Helper: the SQLSTATE a statement raises as a given user, or null if it
-- succeeds. The code rather than a boolean, so a typo'd table name cannot pass as
-- an enforced refusal. The role is reset on both paths.
create or replace function pg_temp.tserr_as(p_user uuid, p_sql text)
returns text language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  execute p_sql;
  perform set_config('role', 'postgres', true);
  return null;
exception when others then
  perform set_config('role', 'postgres', true);
  return sqlstate;
end $$;

-- Helper: the SQLSTATE a statement raises as `postgres`. For the constraint half,
-- where being privileged is the point.
create or replace function pg_temp.tserr(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate;
end $$;

-- Helper: attempt a presence write on a topic, as a given user. realtime.topic()
-- reads current_setting('realtime.topic'), verified against the live database
-- rather than assumed, so the policy can be exercised without the Realtime
-- service in the loop.
create or replace function pg_temp.tspresence_as(p_user uuid, p_topic text)
returns text language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('realtime.topic', p_topic, true);
  insert into realtime.messages (topic, extension) values (p_topic, 'presence');
  perform set_config('role', 'postgres', true);
  return null;
exception when others then
  perform set_config('role', 'postgres', true);
  return sqlstate;
end $$;

-- ------------------------------------- what a thread-scoped member sees (9)
--
-- The narrowing half. Every number here except the room shell is 1 or 0.

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('tnode'), 'select count(*) from public.rooms'),
  1::bigint,
  'a thread-scoped member sees the room shell: is_room_member is deliberately unchanged, '
  'because a client that cannot read the room cannot render anything at all'
);

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('tnode'), 'select count(*) from public.messages'),
  1::bigint,
  'a thread-scoped member sees exactly one message of the three in the room'
);

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('tnode'), format(
    'select count(*) from public.messages where id = %L', pg_temp.tsid('m_t1'))),
  1::bigint,
  'and it is their own thread''s message, named rather than counted'
);

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('tnode'),
    'select count(*) from public.messages where thread_id is null'),
  0::bigint,
  'the null-thread room stream is invisible to a thread-scoped member: that is the owner''s '
  'conversation with the AI and is the bulk of what a node must not read'
);

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('tnode'), 'select count(*) from public.threads'),
  1::bigint,
  'a thread-scoped member sees their own thread and not the room''s other one'
);

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('tnode'), 'select count(*) from public.channels'),
  1::bigint,
  'and only the channel their thread lives in, of the room''s two'
);

-- The assertion that caught 20260901122000. Two rows point at T1 (tnode's own and
-- the expired node's), so the room-scoped predicate reused verbatim returned both:
-- on room_members the rows *are* the scopes, and "does my scope reach this row"
-- stops meaning "is this row mine". 20260901123000 is the correction.
select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('tnode'), 'select count(*) from public.room_members'),
  1::bigint,
  'a thread-scoped member sees only their own membership row: not the room roster, and '
  'not the other node admitted to the same thread'
);

-- ------------------------- and the side nobody was asserting (3)
--
-- **The assertion that was missing, and its absence is why the drift survived.**
-- Every room_members case above asks what a thread-scoped member sees. None asked
-- what the OWNER sees, so a predicate too generous to room-scoped callers had
-- nothing watching it, and `20260901123000` corrected one direction of this
-- policy while leaving the other wrong.
--
-- Measured on the live database before `20260906125000`: the owner saw all four
-- rows, both thread-scoped ones included, while design-system-frontend.md said a
-- thread-scoped membership was invisible to them. The same misreading as the
-- correction above, on the other side of the same predicate:
-- `member_scope_covers` asks about the CALLER, not about the row.

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('owner'), 'select count(*) from public.room_members'),
  2::bigint,
  'the owner sees the room-scoped roster and neither thread-scoped row: a node is admitted '
  'to a thread, not to the room, and listing them in it claims access they do not have'
);

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('member'),
    'select count(*) from public.room_members where scope = ''thread'''),
  0::bigint,
  'and so does every other room-scoped member, because the grant was to that whole '
  'population rather than to the owner and is narrowed for all of them together'
);

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('owner'), 'select count(*) from public.rooms'),
  1::bigint,
  'while the owner still reads their own room, which is the regression half: a narrowing '
  'one conjunct too far presents as nothing loading rather than as a security change'
);

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('tnode'), 'select count(*) from public.action_embeds'),
  1::bigint,
  'embeds follow their message: the card on the room-stream message is invisible, which '
  'plain is_room_member(room_id) would have leaked'
);

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('tnode'), 'select count(*) from public.feedback_events'),
  0::bigint,
  'no feedback events: a verdict on the owner''s plan is not thread work'
);

-- ------------------------------------- the room-scoped member is unchanged (5)
--
-- The regression half. A predicate narrowed one conjunct too far fails here, and
-- would present in the product as "nothing loads" rather than as a security change.

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('owner'), 'select count(*) from public.messages'),
  3::bigint,
  'a room-scoped member still sees every message including both threads'''
);

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('owner'), 'select count(*) from public.threads'),
  2::bigint,
  'and both threads'
);

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('owner'), 'select count(*) from public.channels'),
  2::bigint,
  'and both channels'
);

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('owner'), 'select count(*) from public.action_embeds'),
  2::bigint,
  'and both embeds'
);

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('owner'), 'select count(*) from public.feedback_events'),
  1::bigint,
  'and the feedback event, which member_scope_covers(room_id, null) still admits'
);

-- --------------------------------------- the time-box still outranks scope (4)

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('texpired'), 'select count(*) from public.rooms'),
  0::bigint,
  'an expired thread-scoped member sees no room at all: the time-box is checked in the '
  'new helpers exactly as it was in the old ones'
);

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('texpired'), 'select count(*) from public.messages'),
  0::bigint,
  'an expired thread-scoped member sees no messages, including their own thread''s'
);

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('texpired'), 'select count(*) from public.threads'),
  0::bigint,
  'an expired thread-scoped member sees no threads'
);

-- The half of 20260901123000 that is easy to drop. Its own-row clause is
-- `user_id = auth.uid() and is_room_member(room_id)`, and without the second
-- conjunct an expired member would read their own row back, because owning a row
-- has nothing to do with the time-box.
select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('texpired'), 'select count(*) from public.room_members'),
  0::bigint,
  'and not even their own membership row: an expired node still sees nothing at all, '
  'which rls_membership.sql has asserted since 20260728160000'
);

-- ------------------------------------------------------------- outsiders (1)

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('outsider'), 'select count(*) from public.threads'),
  0::bigint,
  'a member of a different room sees none of this room''s threads'
);

-- ------------------------------------ the narrowing this slice exists for (2)

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('tnode'), 'select count(*) from public.projects'),
  0::bigint,
  'a thread-scoped member is not a project member: this is the KNOWN NARROWING that '
  '20260813120000 and 20260827110000 both recorded as landing with threads'
);

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('owner'), 'select count(*) from public.projects'),
  1::bigint,
  'and the owner still sees their project, which is the half that would break silently'
);

-- -------------------------------------------- the profile leak, closed (3)

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('tnode'), 'select count(*) from public.profiles'),
  1::bigint,
  'a thread-scoped member reads only their own profile: shares_room_with would otherwise '
  'have handed them the whole room roster, which neither narrowing comment mentioned'
);

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('owner'), format(
    'select count(*) from public.profiles where user_id = %L', pg_temp.tsid('tnode'))),
  0::bigint,
  'and the owner cannot read the node''s profile either, because there is no engagement in '
  'this fixture: profiles_select_counterparty (20260904126000) joins through engagements, and '
  'marketplace_engagements.sql asserts the pair opening and closing with one'
);

select extensions.is(
  pg_temp.tscount_as(pg_temp.tsid('owner'), format(
    'select count(*) from public.profiles where user_id = %L', pg_temp.tsid('member'))),
  1::bigint,
  'two room-scoped members still see each other: the member list is not collateral damage'
);

-- ------------------------------------------- writing, as the client (3)

select extensions.is(
  pg_temp.tserr_as(pg_temp.tsid('tnode'), format(
    'insert into public.messages (room_id, channel_id, thread_id, author_id, author_kind, '
    'body, idempotency_key) values (%L, %L, %L, %L, ''user'', ''On my way.'', ''ts-write-1'')',
    pg_temp.tsid('room'), pg_temp.tsid('chan'), pg_temp.tsid('t1'), pg_temp.tsid('tnode'))),
  null::text,
  'a thread-scoped member can post into their own thread: the narrowing is not a mute'
);

select extensions.is(
  pg_temp.tserr_as(pg_temp.tsid('tnode'), format(
    'insert into public.messages (room_id, channel_id, thread_id, author_id, author_kind, '
    'body, idempotency_key) values (%L, %L, null, %L, ''user'', ''Hello room.'', ''ts-write-2'')',
    pg_temp.tsid('room'), pg_temp.tsid('chan'), pg_temp.tsid('tnode'))),
  '42501',
  'and cannot post into the room stream: a node must not be able to write where it '
  'cannot read'
);

select extensions.is(
  pg_temp.tserr_as(pg_temp.tsid('tnode'), format(
    'insert into public.messages (room_id, channel_id, thread_id, author_id, author_kind, '
    'body, idempotency_key) values (%L, %L, %L, %L, ''user'', ''Wrong thread.'', ''ts-write-3'')',
    pg_temp.tsid('room'), pg_temp.tsid('chan2'), pg_temp.tsid('t2'), pg_temp.tsid('tnode'))),
  '42501',
  'nor into somebody else''s thread in the same room'
);

-- ------------------------------------------- constraints, as postgres (8)
--
-- `service_role` is the only role that will ever write these tables, so these run
-- privileged on purpose: a guard that only refused clients would refuse nobody.

select extensions.is(
  pg_temp.tserr(format(
    'insert into public.room_members (room_id, user_id, scope, thread_id) '
    'values (%L, %L, ''thread'', null)', pg_temp.tsid('room'), pg_temp.tsid('member'))),
  '23514',
  'a thread-scoped membership with no thread is refused: it would be invisible to every '
  'predicate and would read as a policy bug'
);

select extensions.is(
  pg_temp.tserr(format(
    'insert into public.room_members (room_id, user_id, scope, thread_id) '
    'values (%L, %L, ''room'', %L)',
    pg_temp.tsid('room'), pg_temp.tsid('member'), pg_temp.tsid('t1'))),
  '23514',
  'and a room-scoped membership carrying a thread is refused: it would claim a narrowing '
  'it does not have'
);

select extensions.is(
  pg_temp.tserr(format(
    'insert into public.room_members (room_id, user_id, scope) values (%L, %L, ''banana'')',
    pg_temp.tsid('room'), pg_temp.tsid('member'))),
  '23514',
  'scope is a closed set: it was unconstrained text with no reader for 44 migrations'
);

-- `member` rather than `outsider`, and the difference is the whole assertion: the
-- primary key is (room_id, user_id), so a user who already belongs to other_room
-- is refused with 23505 before the foreign key is ever consulted, and the test
-- would have passed for a reason that has nothing to do with threads. Measured,
-- not reasoned: the first run of this suite returned 23505 here.
select extensions.is(
  pg_temp.tserr(format(
    'insert into public.room_members (room_id, user_id, scope, thread_id) '
    'values (%L, %L, ''thread'', %L)',
    pg_temp.tsid('other_room'), pg_temp.tsid('member'), pg_temp.tsid('t1'))),
  '23503',
  'a membership cannot be scoped to a thread in a different room'
);

select extensions.is(
  pg_temp.tserr(format(
    'insert into public.messages (room_id, thread_id, author_kind, body) '
    'values (%L, %L, ''system'', ''wrong room'')',
    pg_temp.tsid('other_room'), pg_temp.tsid('t1'))),
  '23503',
  'and a message cannot be paired to a thread in a different room: the composite foreign '
  'key expresses what messages.ts has to check in the handler for channels'
);

select extensions.is(
  pg_temp.tserr(format(
    'insert into public.threads (room_id, channel_id, task_id, title) '
    'values (%L, %L, %L, ''Second thread for one task'')',
    pg_temp.tsid('room'), pg_temp.tsid('chan'), pg_temp.tsid('task'))),
  '23505',
  'one thread per task, ever: a reassignment must continue the same trail rather than '
  'start a second one'
);

select extensions.is(
  pg_temp.tserr(format('delete from public.threads where id = %L', pg_temp.tsid('t1'))),
  '23503',
  'a thread holding messages cannot be deleted: SET NULL would re-home them into the room '
  'stream, which is a widening disguised as a cleanup'
);

select extensions.is(
  pg_temp.tserr(format('delete from public.channels where id = %L', pg_temp.tsid('chan'))),
  '23503',
  'nor can a channel holding threads be deleted'
);

-- ------------------------------------------- privileges, not policies (5)
--
-- RLS filters rows a grant already permits. A missing policy and a missing grant
-- fail very differently, so the grants are asserted directly.

select extensions.ok(
  not has_table_privilege('authenticated', 'public.threads', 'INSERT'),
  'authenticated cannot INSERT a thread: creation lands with the matcher, and a client '
  'that could open a thread could open one nobody is engaged for'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.threads', 'UPDATE'),
  'authenticated cannot UPDATE a thread'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.threads', 'DELETE'),
  'authenticated cannot DELETE a thread'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.threads', 'TRUNCATE'),
  'authenticated cannot TRUNCATE threads: TRUNCATE is not row-level and ignores RLS'
);

select extensions.ok(
  not has_table_privilege('anon', 'public.threads', 'SELECT'),
  'anon holds no SELECT on threads'
);

-- ------------------------------------------------------------- realtime (8)
--
-- The socket half of the narrowing. Without these two policies changing, a
-- thread-scoped node would receive the broadcast payload of every message in the
-- room, which carries the whole row, while correctly seeing none of the table
-- rows.
--
-- `20260906120000` gave a thread its own topic, so the question these assertions
-- answer changed shape: it is no longer "does a thread-scoped member have any
-- realtime" but "does each member reach exactly one topic family". The room half
-- below is unchanged in verdict and re-dated in wording.

select extensions.is(
  pg_temp.tspresence_as(pg_temp.tsid('owner'), 'chat:room:' || pg_temp.tsid('room')::text),
  null::text,
  'a room-scoped member can still publish presence on the room topic'
);

select extensions.is(
  pg_temp.tspresence_as(pg_temp.tsid('tnode'), 'chat:room:' || pg_temp.tsid('room')::text),
  '42501',
  'a thread-scoped member cannot reach the room topic, which is the whole narrowing: the '
  'room stream is the owner''s conversation with the AI, and the broadcast carries the row'
);

select extensions.is(
  pg_temp.tspresence_as(pg_temp.tsid('texpired'), 'chat:room:' || pg_temp.tsid('room')::text),
  '42501',
  'and an expired one certainly cannot'
);

select extensions.is(
  pg_temp.tspresence_as(pg_temp.tsid('tnode'), 'chat:thread:' || pg_temp.tsid('t1')::text),
  null::text,
  'a thread-scoped member reaches their OWN thread topic, which is what 20260906120000 '
  'added and what replaces the ten-second poll slice 5 shipped'
);

select extensions.is(
  pg_temp.tspresence_as(pg_temp.tsid('tnode'), 'chat:thread:' || pg_temp.tsid('t2')::text),
  '42501',
  'and not another thread''s, so the disjunct narrows to the one thread rather than to '
  'threads in general'
);

select extensions.is(
  pg_temp.tspresence_as(pg_temp.tsid('texpired'), 'chat:thread:' || pg_temp.tsid('t1')::text),
  '42501',
  'an expired member reaches their own thread topic no more than the room topic: the '
  'disjunct was added INSIDE the existing predicate, so there is still one expires_at check'
);

select extensions.is(
  pg_temp.tspresence_as(pg_temp.tsid('owner'), 'chat:thread:' || pg_temp.tsid('t1')::text),
  '42501',
  'and the owner does not reach a thread topic either. They read thread messages, and they '
  'read them on the room topic, because 20260906120000 broadcasts to both rather than moving'
);

select extensions.is(
  (select count(*) from pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and policyname in ('realtime_room_members_can_receive', 'realtime_room_members_can_send')
      and coalesce(qual, '') || coalesce(with_check, '') like '%scope%'),
  2::bigint,
  'both realtime policies carry the scope conjunct: they inline their predicate rather than '
  'calling a helper, so neither picks up a narrowing for free and both must be altered by hand'
);

-- ------------------------------------------ deliberate absences, pinned (3)
--
-- `20260815220000` silently dropped eight state arcs with nothing asserting they
-- had been there. Pinning what is deliberately missing is what makes a later
-- slice's addition read as a dated decision rather than as drift.

select extensions.is(
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'threads'),
  1::bigint,
  'threads still has exactly one policy, for SELECT. accept_offer (20260904125000) is now '
  'the writer, and it runs under the secret key, so creating a thread needed a grant rather '
  'than a policy: no client writes here even now that something does'
);

select extensions.is(
  (select count(*) from pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and coalesce(qual, '') || coalesce(with_check, '') like '%chat:thread:%'),
  2::bigint,
  'the thread topic branch landed in BOTH existing policies (20260906120000) and not as a '
  'third one, so there is still exactly one copy of the expires_at time-box per policy'
);

select extensions.is(
  (select count(*) from pg_policies
   where schemaname = 'realtime' and tablename = 'messages'
     and policyname in ('realtime_room_members_can_receive', 'realtime_room_members_can_send')),
  2::bigint,
  'and the CHAT half of realtime.messages still carries exactly two policies. A separate '
  'additive policy for a chat topic would union to the same rows and leave a second '
  'expires_at check to keep in step, which is how an expired node keeps a live socket while '
  'correctly losing the rows'
);

-- Amended 20260909122000, which added a third policy for the per-user inbox
-- topic `notify:user:<uid>`. The assertion above was a bare count of every policy
-- on the table and is now scoped to the two it is actually about, because what
-- it defends is the single copy of the `expires_at` time-box rather than the
-- number of policies. The inbox topic has no membership row and no time-box, so
-- there is nothing for it to duplicate; ADR-0028 argues that in full. The count
-- of all three is asserted in `notifications.sql`, so changing it still costs
-- somebody an argument in a suite.
select extensions.is(
  (select count(*) from pg_policies where schemaname = 'realtime' and tablename = 'messages'),
  3::bigint,
  'and the table carries three in total: the two chat policies plus the inbox topic, which '
  'is a predicate about a person rather than about a room'
);

select * from extensions.finish();

rollback;
