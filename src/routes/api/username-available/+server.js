// GET /api/username-available?u=somename
//
// Checks whether a username is available for the current user to claim.
// "Available" means:
//   - Passes the format constraint (3-30 chars, lowercase a-z 0-9 _ -)
//   - Is not in the reserved-words list (admin, api, settings, etc.)
//   - Is either unused, OR already belongs to the current user
//
// Used by the Settings → Profile form for the debounced live check.
//
// Reason values returned: 'empty' | 'format' | 'unavailable'.
// 'reserved' and 'taken' are deliberately collapsed into one 'unavailable'
// reason before this ever reaches the client — telling a user WHY a handle
// is blocked (system-reserved vs. already registered by someone else) is
// information a legitimate user doesn't need and an attacker could use to
// map out reserved/internal names. 'format' stays specific since that's
// just helping fix a typo, not a security-relevant distinction.

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
    // format stays specific (helps fix a typo); reserved is reported the
    // same as taken, below — never surfaced as its own distinct reason.
    if (check.reason === 'format') return json({ available: false, reason: 'format' });
    return json({ available: false, reason: 'unavailable' });
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
  return json({ available, reason: available ? null : 'unavailable' });
};
