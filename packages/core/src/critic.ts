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
