-- 20260912120000_message_persona.sql — which agent voice wrote an agent message.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/chat-discord.md,
--       docs/30-modules/ai-orchestrator.md,
--       docs/40-adr/0031-an-agent-persona-is-a-voice-not-a-writer.md
--
-- ---------- What this adds, and what it deliberately does not ----------
--
-- The chat has had exactly one AI identity since `20260728120000`: every agent
-- message is `author_id = null, author_kind = 'agent'`, and the client renders
-- all of them under one hardcoded name. This column names which of four voices
-- wrote a given agent message, so the plan, a delivered artifact, a campaign card
-- and a pause notice can arrive from the specialist that produced them.
--
-- **A persona is a voice, not a writer** ([ADR-0031](../../docs/40-adr/0031-an-agent-persona-is-a-voice-not-a-writer.md)).
-- Nothing about who may act changes here. The task DAG keeps its single writer,
-- the router still parks high-risk steps, `checkSpendCap` still holds the
-- ceiling, and `required_role` still decides who may press a card's button. The
-- value is chosen in Node from the step's own `tasks.stage`, which already
-- exists, so no model picks it and no new authorisation surface appears.
--
-- ---------- `text` + `check`, not an enum ----------
--
-- Three shapes were available.
--
-- **A `room_members` row per persona** is impossible without a schema change:
-- `room_members.user_id` is `not null references auth.users (id)`, so an agent
-- would need a real auth user, and `public.user_role` has no agent value. Giving
-- the AI credentials to sit in a membership table is a larger security decision
-- than a chat label deserves.
--
-- **A Postgres enum** would be the obvious mirror of `author_kind`, and is the
-- one shape that cannot be undone: an enum value cannot be dropped. This set is
-- expected to move — Creative, SEO, CRO and Scout each arrive with their provider,
-- and any of the four here could be merged or renamed — so ADR-0022's reasoning
-- applies directly ("would strand an unremovable enum value"). `text` + a named
-- check is the repository's existing answer to a set that may shrink, as
-- `room_members_scope_known` already is.
--
-- **`text` + `check`, which is this.** Two constraints rather than one, because
-- they refuse two different mistakes and a reader should be told which fired:
-- `messages_persona_known` catches a value nobody defined, and
-- `messages_persona_agent_only` catches a persona on a row that is not the
-- agent's — a system notice or, worse, a person's message wearing an AI's name.
--
-- **No backfill.** Every existing agent row keeps `persona = null`, which the
-- client renders as the single legacy voice it already showed. Backfilling would
-- mean guessing which specialist wrote a message from before specialists existed,
-- and a guess written into an audit trail is indistinguishable from a fact.

alter table public.messages add column persona text;

alter table public.messages
  add constraint messages_persona_known
    check (persona is null or persona in ('strategist', 'content', 'ads', 'analyst')),
  add constraint messages_persona_agent_only
    check (persona is null or author_kind = 'agent');

-- ---------- The client can never name one ----------
--
-- `author_kind` is derived from the caller's own membership row and re-checked
-- here (`20260904127000`); a persona needs the same treatment for the same
-- reason. A client that could set `persona` could file a message under the Ads
-- specialist's name in somebody's audit trail, and the route would not even be
-- involved. The route never sends the column, and this is the independent check
-- that makes that a guarantee rather than a convention (rule 6).
--
-- **`alter policy ... with check` REPLACES the expression, it does not append**,
-- so the whole `20260904127000` predicate is restated below. `and persona is
-- null` is the only new conjunct; everything else is verbatim. `message_persona.sql`
-- re-asserts the two capabilities that restatement could silently drop: a
-- room-scoped member posting to the room stream, and a thread-scoped node posting
-- into their own thread.

alter policy "messages_insert_own" on public.messages
  with check (
    private.member_scope_covers(room_id, thread_id)
    and author_id = auth.uid()
    and persona is null
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

comment on column public.messages.persona is
  'Which agent voice wrote this: strategist, content, ads or analyst. A voice, not a writer '
  '(ADR-0031) — the task DAG keeps its single writer and this changes no authorisation. Chosen '
  'in apps/api from the step''s tasks.stage, never by a model. NULL on every row written before '
  'this column and on every non-agent row, and the client renders a NULL agent row under the '
  'single legacy name. Never client-writable: messages_insert_own refuses any value from a '
  'client, exactly as it does for author_kind.';
