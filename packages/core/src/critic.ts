/**
 * The checker half of maker-checker: does this artifact count as the task done?
 *
 * **Deliberately deterministic, and that is a decision rather than a placeholder.**
 * business-projects-workflow.md describes an "AI critic", and an LLM judge is the
 * obvious reading. The project already rejected that shape once, for the
 * generation eval: a judge bills per call and returns a different answer each
 * time, which makes it a poor gate and a fine diagnostic. The same reasoning
 * applies harder here, because this gate decides whether a task **unblocks its
 * dependents**, so a flaky verdict propagates through the graph.
 *
 * So this checks the things that are actually checkable, and refuses to pretend
 * about the rest. It cannot tell you whether the positioning advice is any good.
 * It can tell you the maker returned nothing, or cited a source it was never
 * given, or dropped every citation from a task that was supposed to rest on one,
 * and those are the failures that otherwise reach a person as confident output.
 *
 * An LLM critic belongs on top of this later, as an additional opinion on quality
 * once these floor conditions already hold. Not instead of it.
 */

/** What the maker produced, as the checker sees it. */
export interface ReviewableArtifact {
  /** Inline output. Empty or whitespace counts as nothing produced. */
  body: string;
  /** Source labels the maker says it used. */
  citations: string[];
}

/** What the task expected, drawn from the plan step that created it. */
export interface ReviewContext {
  /**
   * Source labels the task was given. A citation outside this set is fabricated:
   * the maker cannot have used a source it never saw.
   */
  availableSources: string[];
  /**
   * Whether the plan step this task came from carried citations. A step that was
   * grounded must stay grounded once executed; a step that never was cannot be
   * held to a standard the plan did not set.
   */
  expectsCitations: boolean;
}

export type CriticFailure = 'empty_output' | 'too_short' | 'lost_grounding' | 'fabricated_citation';

export interface CriticVerdict {
  passed: boolean;
  failures: CriticFailure[];
  /** One sentence per failure, in the order they were found. */
  reasons: string[];
}

/**
 * Below this, the output is a stub rather than a draft. Chosen to be obviously
 * too small rather than tuned: the point is to catch "OK." and an empty heading,
 * not to have an opinion about length.
 */
const MIN_BODY_CHARS = 40;

export function review(artifact: ReviewableArtifact, context: ReviewContext): CriticVerdict {
  const failures: CriticFailure[] = [];
  const reasons: string[] = [];

  const body = artifact.body.trim();

  if (body.length === 0) {
    // Checked before everything else and returned early: an empty artifact fails
    // every other test too, and reporting four problems for one cause makes the
    // real one harder to see.
    return {
      passed: false,
      failures: ['empty_output'],
      reasons: ['The step produced no output.'],
    };
  }

  if (body.length < MIN_BODY_CHARS) {
    failures.push('too_short');
    reasons.push('The output is too short to be a usable draft.');
  }

  // Rule 10, applied to what the task produced. A grounded plan step whose
  // execution cites nothing has quietly become ungrounded, and the plan card
  // would still show the step as cited.
  if (context.expectsCitations && artifact.citations.length === 0) {
    failures.push('lost_grounding');
    reasons.push('The step was grounded in the plan but its output cites nothing.');
  }

  // A source the maker was never given. Distinct from `lost_grounding` because
  // it is worse: a missing citation is unverified output, an invented one is
  // output that claims verification it does not have.
  const available = new Set(context.availableSources);
  const fabricated = artifact.citations.filter((c) => !available.has(c));
  if (fabricated.length > 0) {
    failures.push('fabricated_citation');
    reasons.push(
      `Cites ${fabricated.length} source(s) that were not supplied: ${fabricated.join(', ')}.`,
    );
  }

  return { passed: failures.length === 0, failures, reasons };
}

/**
 * Where a task goes after review.
 *
 * A failure is not automatically a retry. `fabricated_citation` means the maker
 * invented a source, and asking the same maker to try again is how you get a
 * second invented source; that goes to a human. Everything else is worth one
 * bounded re-run, because "produced nothing" and "too short" are the failures a
 * retry plausibly fixes.
 */
export function nextStateAfterReview(
  verdict: CriticVerdict,
  attempt: number,
  maxAttempts = 2,
): 'approved' | 'ai_running' | 'escalated' {
  if (verdict.passed) return 'approved';
  if (verdict.failures.includes('fabricated_citation')) return 'escalated';
  return attempt < maxAttempts ? 'ai_running' : 'escalated';
}

/* ------------------------------------------------------- proof of completion */

/**
 * The checker half of maker-checker, pointed at a **person's** work rather than
 * the model's.
 *
 * `review` above is the wrong function for this and the difference is not
 * cosmetic. Its three real checks are about **citations**: a step that was
 * grounded must stay grounded, and a source the maker was never given is
 * fabricated. A node's proof is evidence that something was done in the world.
 * It cites nothing by construction, so `lost_grounding` would fail every proof
 * ever submitted and `fabricated_citation` could never fire.
 *
 * **What this can check is small, and saying so is the point.** It cannot tell
 * you whether the creative is any good, whether the shoot was worth the money,
 * or whether the numbers in the write-up are true. **The owner is the checker**;
 * this is the floor that stops a submission which is obviously not a submission
 * from reaching them and consuming a decision.
 *
 * An LLM judge is deliberately not here, and the reason is stronger than it was
 * for `review`: this gate stands between a person and being paid. A verdict that
 * differs between two runs of the same input is not something to put there, and
 * `stage-skills.ts` already refused to hand a model authority over which humans
 * get work. When an LLM opinion lands it belongs **on top** of this floor as an
 * advisory note to the owner, never instead of it and never as the gate.
 *
 * **`tasks.acceptance_criteria` gets its first reader here.** The column has been
 * written by the planner since `20260816120000` and read by nothing, which that
 * migration named as the cost it was accepting: "the marketplace's maker-checker
 * validates a node's proof against it, and backfilling criteria for finished work
 * is far more expensive than emitting them with the step."
 */

/** What the node submitted, as the checker sees it. */
export interface SubmittedProof {
  /** The write-up. Empty or whitespace counts as nothing submitted. */
  note: string;
  /**
   * One response per acceptance criterion, in the order the criteria are stored
   * on the task. The route pairs them; a length mismatch never reaches here.
   */
  responses: string[];
  /** How many files came with it. Zero is legitimate for a written deliverable. */
  fileCount: number;
}

/** What the step asked for, drawn from the task row. */
export interface ProofContext {
  /** `tasks.acceptance_criteria`, in order. Empty is normal on an older task. */
  acceptanceCriteria: string[];
}

export type ProofFailure = 'empty_proof' | 'too_short' | 'unaddressed_criteria';

export interface ProofVerdict {
  passed: boolean;
  failures: ProofFailure[];
  /** One sentence per failure, in the order they were found. Shown to the node. */
  reasons: string[];
  /**
   * Which criteria were left blank, by index. The node's form needs to point at
   * the field rather than saying "one of these is empty".
   */
  unaddressed: number[];
}

/**
 * Below this, the note is a placeholder rather than a hand-off. Chosen to be
 * obviously too small rather than tuned, on `MIN_BODY_CHARS`' reasoning: it is
 * here to catch "done" and "see attached", not to have an opinion about how much
 * somebody should write.
 */
const MIN_PROOF_CHARS = 40;

export function reviewProof(proof: SubmittedProof, context: ProofContext): ProofVerdict {
  const failures: ProofFailure[] = [];
  const reasons: string[] = [];
  const note = proof.note.trim();

  // Checked first and returned early, for `review`'s reason: an empty submission
  // fails every other test too, and reporting three problems for one cause makes
  // the real one harder to see.
  //
  // **A file is not a substitute for the note.** A photo with no word about what
  // it shows is not something the owner can review, and the criteria responses
  // are the part this function can actually check.
  if (note.length === 0) {
    return {
      passed: false,
      failures: ['empty_proof'],
      reasons: ['Say what you did. A file on its own is not something the owner can review.'],
      unaddressed: [],
    };
  }

  if (note.length < MIN_PROOF_CHARS) {
    failures.push('too_short');
    reasons.push('That is too short to tell the owner what happened. A few sentences is enough.');
  }

  // The one check that reads the plan. A criterion left blank is the difference
  // between "I did the work" and "I did the thing that was asked", and it is
  // exactly what the owner would otherwise have to notice for themselves.
  const unaddressed = context.acceptanceCriteria
    .map((_, i) => i)
    .filter((i) => (proof.responses[i] ?? '').trim().length === 0);

  if (unaddressed.length > 0) {
    failures.push('unaddressed_criteria');
    reasons.push(
      unaddressed.length === 1
        ? 'One of the things this step asked for has no answer against it.'
        : `${unaddressed.length} of the things this step asked for have no answer against them.`,
    );
  }

  return { passed: failures.length === 0, failures, reasons, unaddressed };
}

/**
 * Where a task goes after a proof is checked.
 *
 * **Two states, and neither of them is a failure state**, which is the whole
 * difference from `nextStateAfterReview`. That function can escalate, because a
 * model that invented a citation will invent another one and there is nothing to
 * be gained by asking again. A person who left a field blank fixes it in ten
 * seconds. So a failed floor check returns the step to `in_progress` with its
 * reasons, and there is no attempt counter: bouncing somebody twice is not worse
 * than bouncing them once, and a limit would eventually strand a node mid-task
 * with money held against work they are still trying to deliver.
 *
 * `in_review` means the owner now has it. Nothing here can reach `approved`:
 * that arc belongs to the owner's own action, because the AI does not decide
 * that a person's work is finished.
 */
export function nextStateAfterProofReview(verdict: ProofVerdict): 'in_review' | 'in_progress' {
  return verdict.passed ? 'in_review' : 'in_progress';
}
