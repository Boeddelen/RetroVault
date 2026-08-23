// ─────────────────────────────────────────────────────────────────────────
// /app/settings/delete — the destructive route
//
// Loads a small summary (record count, collection count) so the user can see
// what they're about to lose. The actual deletion happens in the `confirm`
// action below.
//
// Deletion strategy:
//   1. Validate the typed phrase server-side ("delete my account", exact)
//   2. Delete the public.users row — Postgres cascades through every owned
//      record, collection, junction row, track via FOREIGN KEY ... ON DELETE
//      CASCADE relationships already in place
//   3. Delete uploaded files (covers + avatar) from Storage — see note below
//   4. Delete the auth.users row via the Admin API, using the service-role
//      key. This is the one place in the codebase we need that key.
//   5. Sign the session out
//   6. Redirect to landing with ?deleted=1 so we can show a confirmation
//
// Storage cleanup (step 3) — history worth recording:
//   This used to be deferred to "a periodic job that sweeps orphans later,"
//   but that job was never actually built — meaning deleted users' files
//   persisted in Storage indefinitely, not "for a short period" as the
//   confirmation page used to (incorrectly) tell users. Since both the
//   `covers` and `avatars` buckets store files under a per-user folder
//   (`{bucket}/{userId}/...`, enforced by the bucket's own RLS policy),
//   a full synchronous sweep is simple: list the folder, delete everything
//   in it, using the same admin client already needed for auth.users below.
//   This is both more accurate to promise to users and closer to what GDPR
//   erasure expects — actual removal, not an indefinite maybe.
//
// Why use the service role for auth.users AND storage:
//   - The user can't delete their own auth.users row through the public
//     Supabase client — that's by design
//   - The service-role key bypasses RLS and CAN delete auth rows + any
//     user's storage files (not just their own uploads via the public client)
//   - It's read ONLY in this single file, never sent to the client, and
//     pulled from a Cloudflare encrypted runtime secret
// ─────────────────────────────────────────────────────────────────────────

import { error, fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import { createClient } from '@supabase/supabase-js';

const REQUIRED_PHRASE = 'delete my account';

/**
 * Delete every file this user has uploaded, across both storage buckets.
 * Both buckets store files under a per-user folder (`{bucket}/{userId}/...`,
 * enforced by the bucket's RLS policy requiring the path to start with the
 * uploader's own id), so a full sweep is just: list the folder, delete
 * everything found. Runs with the admin client since deleting another
 * user's-eye-view files isn't something the public client can do anyway —
 * here it's the same user's own files, but we're past their own session by
 * this point in the deletion flow.
 *
 * Failure here is logged but never blocks the rest of deletion — a stray
 * orphaned file is a minor ops cleanup item, not a reason to leave a user
 * account half-deleted.
 */
async function sweepUserStorage(admin, userId) {
  for (const bucket of ['covers', 'avatars']) {
    try {
      const { data: files, error: listErr } = await admin.storage.from(bucket).list(userId, { limit: 1000 });
      if (listErr) {
        console.error(`[account delete] storage list failed for ${bucket}/${userId}:`, listErr.message);
        continue;
      }
      if (!files || files.length === 0) continue;

      const paths = files.map((f) => `${userId}/${f.name}`);
      const { error: removeErr } = await admin.storage.from(bucket).remove(paths);
      if (removeErr) {
        console.error(`[account delete] storage remove failed for ${bucket}/${userId}:`, removeErr.message);
      }
    } catch (err) {
      console.error(`[account delete] storage sweep threw for ${bucket}/${userId}:`, err);
    }
  }
}

/** @type {import('./$types').PageServerLoad} */
export const load = async ({ locals: { safeGetSession, supabase } }) => {
  const { user } = await safeGetSession();
  if (!user) throw redirect(303, '/login');

  // Pull a small summary for the confirmation page. Defensive counts —
  // doesn't break the page if any of these fail.
  const [recordsCount, collectionsCount, profileRes] = await Promise.all([
    supabase
      .from('records')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('is_pending_delete', false),
    supabase
      .from('collections')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id),
    supabase
      .from('users')
      .select('username, display_name, created_at')
      .eq('id', user.id)
      .maybeSingle()
  ]);

  return {
    summary: {
      records: recordsCount.count ?? 0,
      collections: collectionsCount.count ?? 0,
      created_at: profileRes.data?.created_at ?? null,
      username: profileRes.data?.username ?? null,
      display_name: profileRes.data?.display_name ?? null
    }
  };
};

export const actions = {
  /**
   * Permanent account deletion. No second chances after this returns success.
   *
   * Steps in order:
   *   1. Validate the typed phrase server-side
   *   2. Delete public.users (cascades to all the user's owned rows via FKs)
   *   3. Delete uploaded covers + avatar from Storage (best-effort)
   *   4. Delete auth.users via the admin client (service-role key)
   *   5. Sign out the session
   *   6. Redirect to / with ?deleted=1
   */
  confirm: async ({ request, locals: { safeGetSession, supabase } }) => {
    const { user } = await safeGetSession();
    if (!user) throw redirect(303, '/login');

    const form = await request.formData();
    const phrase = (form.get('phrase') ?? '').toString().trim().toLowerCase();

    // ── 1. Phrase check ─────────────────────────────────────────────
    if (phrase !== REQUIRED_PHRASE) {
      return fail(400, {
        error: `You must type "${REQUIRED_PHRASE}" exactly to confirm deletion.`
      });
    }

    // ── 2. Service-role client setup ────────────────────────────────
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceKey) {
      console.error('SUPABASE_SERVICE_ROLE_KEY is not set — cannot delete account');
      return fail(500, {
        error: 'Account deletion is temporarily unavailable. Please contact support.'
      });
    }

    const admin = createClient(PUBLIC_SUPABASE_URL, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // ── 3. Delete the public.users row (cascades to everything) ─────
    // We do this BEFORE auth.users so RLS is still in effect for the public
    // schema while we delete owned rows. If something goes wrong here, the
    // user's auth account is still intact and they can retry.
    const { error: publicErr } = await admin
      .from('users')
      .delete()
      .eq('id', user.id);

    if (publicErr) {
      console.error('Public users delete failed:', publicErr);
      return fail(500, {
        error: 'Could not delete account data. Please try again or contact support.'
      });
    }

    // ── 3.5. Delete uploaded files (covers + avatar) ─────────────────
    // Best-effort — see sweepUserStorage's own comment for why a failure
    // here never blocks the rest of deletion.
    await sweepUserStorage(admin, user.id);

    // ── 4. Delete the auth.users row ────────────────────────────────
    // This is the irreversible step. If it fails here, the user already has
    // no public data (their session token will become invalid on next use)
    // but their auth row will be orphaned. That's a recoverable state for
    // ops to clean up, so still safer than the other ordering.
    const { error: authErr } = await admin.auth.admin.deleteUser(user.id);
    if (authErr) {
      console.error('Auth users delete failed (public row already gone):', authErr);
      // Still proceed — the user's data is gone and they're effectively
      // deleted from the app's perspective. Logging this lets ops clean up
      // the orphan auth row.
    }

    // ── 5. Sign out and redirect ────────────────────────────────────
    await supabase.auth.signOut();
    throw redirect(303, '/?deleted=1');
  }
};
