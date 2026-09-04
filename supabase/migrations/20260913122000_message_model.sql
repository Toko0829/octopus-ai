-- 20260913122000_message_model.sql — which model wrote an agent message, and
-- which one produced a task run's output.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/chat-discord.md,
--       docs/30-modules/business-projects-workflow.md,
--       docs/40-adr/0032-reasoning-providers-are-workspace-connectors.md
--
-- ---------- What this adds ----------
--
-- `20260913120000` and `20260913121000` gave a workspace somewhere to put its own
-- provider key and a way to say which model answers for each role. Nothing read
-- either of them: every agent message in this system was still written by the
-- house default, and nothing said so. This column is the other half. Node
-- resolves the room's route for the role, sends the target to `services/ai`, and
-- stamps back **the model that actually answered** — not the one it asked for,
-- because a service that ignored the target would otherwise misroute silently to
-- the house key and the audit trail would record our guess as a fact.
--
-- `task_runs` gets the same two facts for the executor's arm, so a delivered
-- artifact can be attributed after the fact (`heal.ts` re-delivers one from a run
-- it did not make) and per-provider approval rates can be joined without a second
-- table.
--
-- ---------- `text`, no closed vocabulary, and that is deliberate ----------
--
-- `messages.persona` one migration back closed its set with a named check, on the
-- argument that a client trusts the four names it renders. **This column does the
-- opposite on purpose.** Model ids are a vendor's vocabulary, not ours: they are
-- retired, renamed and superseded without anybody asking us, and
-- `packages/contracts` says so where the registry is defined. A closed check here
-- would mean that the day a vendor ships a model we have not listed, a run which
-- succeeded and produced real work **fails at the write**, and the person loses
-- the output to a label. `labelForModel` renders an id it does not recognise as
-- itself, because an id we do not know is still the true answer to what wrote a
-- thing.
--
-- So there is a length bound and nothing else. It is not a vocabulary check
-- wearing a smaller hat: it is the bound that stops an unbounded string from
-- reaching a jsonb payload and a chat bubble.
--
-- ---------- Which rows may carry one ----------
--
-- `messages_model_agent_only` is `persona`'s constraint for `persona`'s reason,
-- and it is only half of the rule. The other half cannot be a constraint and is
-- enforced in `apps/api`: **only text a model actually wrote gets a model.** A run
-- notice, a sweep notice, a waiting digest and a recorded answer are agent rows
-- written by TypeScript, so they are `agent` and they stay null; stamping them
-- would claim a model composed words it never saw. The table can refuse a model on
-- a system notice or on a person's message, which is the forgery half; it cannot
-- tell our own prose from a model's, and pretending otherwise would be a check
-- that reads as a guarantee and is not one.
--
-- **No backfill**, for `persona`'s reason and one more. Every existing agent row
-- was in fact written on the house default, so a backfill would even be accurate
-- today — and it would be a value written into an audit trail by inference rather
-- than by observation, which is the shape of thing that stops being accurate
-- quietly. Null means "nobody recorded which", and that is what is true of them.

alter table public.messages add column model text;

alter table public.messages
  add constraint messages_model_agent_only
    check (model is null or author_kind = 'agent'),
  add constraint messages_model_length
    check (model is null or char_length(model) between 1 and 120);

-- ---------- The client can never name one ----------
--
-- The same treatment `author_kind` has had since `20260904127000` and `persona`
-- since `20260912120000`, and the argument is stronger here than for either. A
-- client that could set `model` could file "written by Claude Opus 5" on a message
-- Claude never saw, beside a real audit trail, where a fabricated attribution and
-- a recorded one are indistinguishable. The route never sends the column; this is
-- the independent check that makes that a guarantee rather than a convention
-- (rule 6, ADR-0032 decision 4).
--
-- **`alter policy ... with check` REPLACES the expression, it does not append**,
-- so the whole `20260912120000` predicate is restated below. `and model is null`
-- is the only new conjunct; everything else is verbatim, including the
-- `and persona is null` that migration added. `message_model.sql` re-asserts the
-- two capabilities a bad retyping would silently drop — a room-scoped member
-- posting to the room stream, and a thread-scoped node posting into their own
-- thread — and `message_persona.sql` and `thread_scope.sql` assert them again.

alter policy "messages_insert_own" on public.messages
  with check (
    private.member_scope_covers(room_id, thread_id)
    and author_id = auth.uid()
    and persona is null
    and model is null
    and (
      author_kind = 'user'
      or (
        author_kind = 'node'
        and thread_id is not null
        and exists (
          select 1
          from public.room_members m
          where m.room_id = messages.room_id
            and m.user_id = auth.uid()
            and m.role = 'human_node'
            and m.scope = 'thread'
            and m.thread_id = messages.thread_id
            and (m.expires_at is null or m.expires_at > now())
        )
      )
    )
  );

comment on column public.messages.model is
  'Which model wrote this agent message: the raw vendor id, as reported by the service that '
  'answered rather than as requested (ADR-0032 decision 4). An open vocabulary with a length '
  'bound and no closed check, because vendors retire and rename ids and an id we do not '
  'recognise is still the true answer to what wrote a thing. NULL on every non-agent row, on '
  'every agent row written before this column, and on every agent row apps/api composed itself '
  'in TypeScript: only text a model actually wrote carries one. Never client-writable: '
  'messages_insert_own refuses any value from a client, exactly as it does for author_kind and '
  'persona.';

-- ---------- The executor's arm ----------
--
-- `task_runs` is per attempt, which is what makes it the right place for this: a
-- step that failed on one provider and succeeded on a retry after the owner
-- switched routes has two rows saying two different things, and both are true.
--
-- `provider` beside `model` rather than derived from it, because the derivation
-- runs the wrong way. A model id maps to a provider only through the registry we
-- happen to ship today, and the id of a model since dropped from it would resolve
-- to nothing; the provider is a fact the run knew at the time and costs one column
-- to keep. It is also the column a per-provider approval rate groups by, which is
-- the join learning-flywheel.md records.
--
-- Both bounded for the reason the message column is: these values are echoed from
-- an HTTP response, `GenerationTarget` bounds them on the way out, and this is
-- the independent re-check on the way in (rule 6). Neither is a vocabulary check.

alter table public.task_runs
  add column provider text,
  add column model    text;

alter table public.task_runs
  add constraint task_runs_provider_length
    check (provider is null or char_length(provider) between 1 and 40),
  add constraint task_runs_model_length
    check (model is null or char_length(model) between 1 and 120);

comment on column public.task_runs.provider is
  'Which registry provider answered this attempt (ADR-0032). NULL for every run before this '
  'column and for any attempt that failed before a model replied. Written by apps/api under the '
  'secret key; task_runs has no client write path.';

comment on column public.task_runs.model is
  'Which model answered this attempt, as reported by the service rather than as requested. Read '
  'back by the heal sweep so a re-delivered artifact is attributed to the run that produced it, '
  'and joined with feedback_events for per-provider approval rates.';
