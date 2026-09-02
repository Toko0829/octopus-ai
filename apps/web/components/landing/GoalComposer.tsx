'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The hero's goal input.
 *
 * The landing had **zero form controls on the entire page**, and the product's
 * entry point is "type what you are building". A page that describes a composer
 * and does not give you one is a brochure for a thing you are standing in front
 * of.
 *
 * Three rules it holds.
 *
 * - **It degrades to a plain navigation.** The element is a real `<form>` whose
 *   action is `/app`, and the field carries **no `name`**, so a submit without
 *   JavaScript navigates to the app cleanly and produces no query string at all.
 * - **The goal never touches the URL.** With JS it is stashed in `sessionStorage`
 *   and the router pushes `/app`. That survives the `/sign-in?next=/app` round
 *   trip because it is the same origin, and it keeps what somebody typed out of
 *   server logs, browser history and any referrer header. A goal is the user's
 *   own words about their business; it does not belong in a query parameter.
 * - **The placeholder is the theatre's example.** You type the thing, and the
 *   section below shows that exact goal becoming a plan. The continuity is the
 *   point, so this string and `ProductFrame`'s opening message are deliberately
 *   the same sentence.
 */

/** Read and cleared by the chat composer on mount. */
export const GOAL_HANDOFF_KEY = 'octopus:pending-goal';

export function GoalComposer({ id = 'goal' }: { id?: string }) {
  const router = useRouter();
  const [value, setValue] = useState('');
  const ready = value.trim().length > 0;

  function handoff(e: React.FormEvent<HTMLFormElement>) {
    const goal = value.trim();
    if (!goal) return; // let the no-JS form do its plain thing
    e.preventDefault();
    try {
      sessionStorage.setItem(GOAL_HANDOFF_KEY, goal);
    } catch {
      // Private mode, or storage disabled. The goal is lost and the app still
      // opens, which is the right failure: never block the navigation on it.
    }
    router.push('/app');
  }

  return (
    <form className="goal" action="/app" onSubmit={handoff}>
      <label className="sr-only" htmlFor={id}>
        What are you building?
      </label>
      <input
        id={id}
        className="goal-input"
        type="text"
        autoComplete="off"
        placeholder="Launch a paid ads test for my ceramics studio, under 250 a month."
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button className="btn btn-primary goal-send" type="submit">
        {ready ? 'Start' : 'Open the app'}
      </button>
    </form>
  );
}
