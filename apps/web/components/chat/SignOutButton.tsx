'use client';

import { useRouter } from 'next/navigation';
import { createClient } from '../../lib/supabase/client';

export function SignOutButton({ className = 'empty-signout' }: { className?: string }) {
  const router = useRouter();

  async function signOut() {
    await createClient().auth.signOut();
    router.push('/sign-in');
    router.refresh();
  }

  return (
    <button type="button" className={className} onClick={signOut}>
      Sign out
    </button>
  );
}
