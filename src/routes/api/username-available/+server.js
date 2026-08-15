// GET /api/username-available?u=somename
//
// Checks whether a username is available for the current user to claim.
// "Available" means:
//   - Passes the format constraint (3-30 chars, lowercase a-z 0-9 _ -)
//   - Is not in the reserved-words list (admin, api, settings, etc.)
//   - Is either unused, OR already belongs to the current user
//
// Used by the Settings → Profile form for the debounced live check.

import { error, json } from '@sveltejs/kit';
import { checkUsernameCandidate } from '$lib/server/username.js';

/** @type {import('./$types').RequestHandler} */
export const GET = async ({ url, locals: { safeGetSession, supabase } }) => {
  const { user } = await safeGetSession();
  if (!user) throw error(401, 'Not signed in');

  const raw = (url.searchParams.get('u') ?? '').trim().toLowerCase();
  if (!raw) {
    return json({ available: false, reason: 'empty' });
  }
  const check = checkUsernameCandidate(raw);
  if (!check.ok) {
    return json({ available: false, reason: check.reason });
  }

  // Look up via case-insensitive comparison. We index on lower(username),
  // so this is cheap.
  const { data, error: dbErr } = await supabase
    .from('users')
    .select('id')
    .ilike('username', raw)
    .maybeSingle();
  if (dbErr) throw error(500, dbErr.message);

  // Available if either nobody has it, or it's the current user's own
  // username (returning available=true here keeps the "Save" button live
  // when the user hasn't changed their handle).
  const available = !data || data.id === user.id;
  return json({ available, reason: available ? null : 'taken' });
};
