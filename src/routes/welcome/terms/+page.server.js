import { fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import { createClient } from '@supabase/supabase-js';
import { CURRENT_TOS_VERSION } from '$lib/server/legal.js';

/** @type {import('./$types').PageServerLoad} */
export const load = async ({ locals: { safeGetSession, supabase } }) => {
  const { user } = await safeGetSession();
  if (!user) throw redirect(303, '/login');

  // If they've already accepted the current version, skip ahead.
  const { data: profile, error: loadError } = await supabase
    .from('users')
    .select('display_name, tos_accepted_at, tos_version')
    .eq('id', user.id)
    .maybeSingle();

  if (loadError) {
    console.error('[welcome/terms] load query failed for user', user.id, ':', loadError.message);
  }

  if (profile?.tos_accepted_at && profile?.tos_version === CURRENT_TOS_VERSION) {
    throw redirect(303, profile.display_name ? '/app/all' : '/welcome/profile');
  }

  // Is this an existing user being re-gated (vs. a brand-new signup)?
  // We use this to choose friendly copy on the page itself.
  const isReturningUser = Boolean(profile?.display_name);

  return { isReturningUser, currentVersion: CURRENT_TOS_VERSION };
};

/** @type {import('./$types').Actions} */
export const actions = {
  accept: async ({ request, locals: { safeGetSession, supabase } }) => {
    const { user } = await safeGetSession();
    if (!user) throw redirect(303, '/login');

    const form = await request.formData();
    if (form.get('agreed') !== 'on') {
      return fail(400, { error: 'You must agree to the Terms and Privacy Policy to continue.' });
    }

    // A new signup's public.users row is created by a DB trigger on
    // auth.users insert (see schema.sql: on_auth_user_created). That trigger
    // is transactional and should have already run by the time a session
    // exists — but as a safety net against any timing edge case, retry once
    // after a short pause before treating a zero-row match as a real failure.
    // (There's no INSERT policy for regular users on this table — only the
    // trigger can create the row — so a client-side upsert isn't an option;
    // a brief retry is the safe fallback.)
    async function tryAccept() {
      return supabase
        .from('users')
        .update({
          tos_accepted_at: new Date().toISOString(),
          tos_version: CURRENT_TOS_VERSION
        })
        .eq('id', user.id)
        .select('id, display_name')
        .maybeSingle();
    }

    let { data: updated, error } = await tryAccept();

    if (!error && !updated) {
      console.warn('[welcome/terms] first update matched no row for user', user.id, '— retrying once');
      await new Promise((resolve) => setTimeout(resolve, 500));
      ({ data: updated, error } = await tryAccept());
    }

    if (error) {
      console.error('[welcome/terms] update failed:', error.message);
      return fail(500, { error: 'Something went wrong. Please try again.' });
    }
    if (!updated) {
      console.error('[welcome/terms] update matched no row for user (after retry):', user.id);
      return fail(500, { error: 'Could not save your acceptance — please try again.' });
    }

    // Mirror the acceptance into auth.users' app_metadata, purely so it's
    // visible in Supabase Dashboard → Authentication → Users without a SQL
    // query. public.users (above) remains the single source of truth — if
    // these two ever disagree, public.users wins. app_metadata (unlike
    // user_metadata) can ONLY be written via the service-role key, never by
    // the signed-in user's own client calls, so it stays a trustworthy
    // audit mirror rather than something a user could quietly edit.
    //
    // Best-effort: if this fails or the key isn't configured, the user's
    // actual acceptance above already succeeded and isn't affected — we
    // only log it, never fail the request over a dashboard convenience.
    const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (serviceKey) {
      try {
        const admin = createClient(PUBLIC_SUPABASE_URL, serviceKey, {
          auth: { autoRefreshToken: false, persistSession: false }
        });
        const { error: metaErr } = await admin.auth.admin.updateUserById(user.id, {
          app_metadata: {
            tos_accepted_at: new Date().toISOString(),
            tos_version: CURRENT_TOS_VERSION
          }
        });
        if (metaErr) {
          console.error('[welcome/terms] app_metadata mirror failed:', metaErr.message);
        }
      } catch (err) {
        console.error('[welcome/terms] app_metadata mirror threw:', err);
      }
    } else {
      console.warn('[welcome/terms] SUPABASE_SERVICE_ROLE_KEY not set — skipping dashboard mirror');
    }

    throw redirect(303, updated.display_name ? '/app/all' : '/welcome/profile');
  }
};
