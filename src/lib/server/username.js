/**
 * Shared username format + reserved-word rules.
 *
 * Single source of truth used by every place a username can be set:
 *   - /welcome/profile   (onboarding — first handle a user ever picks)
 *   - /app/settings      (profile edit)
 *   - /api/username-available (live availability check while typing)
 *
 * Previously this list was hand-copied into two files, and had already
 * drifted apart (one had extra entries — the operator's own name, a few
 * profanities — that the other lacked). /welcome/profile never had the
 * check wired in at all, which is exactly how "admin" slipped through as
 * a valid handle. Consolidating here removes that whole class of bug:
 * add a word once, every consumer gets it, and a brand-new consumer can't
 * forget to import it because there's nothing to hand-copy anymore.
 */

export const USERNAME_RE = /^[a-z0-9_-]{3,30}$/;

export const RESERVED_USERNAMES = new Set([
  // Routes (current + reserved for future)
  'admin', 'administrator', 'api', 'app', 'auth', 'login', 'logout', 'signup',
  'signout', 'register', 'settings', 'account', 'profile', 'u', 'user', 'users',
  'help', 'support', 'contact', 'about', 'pricing', 'home', 'feed', 'dashboard',
  'stats', 'collection', 'collections', 'records', 'record', 'discogs',
  'callback', 'connect', 'disconnect', 'all', 'archive', 'archived', 'tags',
  // Legal / operational
  'terms', 'privacy', 'gdpr', 'legal', 'cookies', 'security', 'abuse',
  'dmca', 'tos', 'eula', 'imprint',
  // Generic
  'www', 'mail', 'email', 'webmail', 'ftp', 'ssh', 'root', 'system',
  'public', 'private', 'official', 'staff', 'team', 'mod', 'moderator',
  'bot', 'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  // Brand (current + legacy, kept blocked to prevent impersonation)
  'hyllah', 'hylla', 'retrovault', 'retro-vault', 'retro_vault', 'vault', 'anthropic',
  // Inflammatory / impersonation magnets
  'null', 'undefined', 'anonymous', 'me', 'you',
  // Operator identity + profanity, kept blocked (merged from settings' local list)
  'frederik', 'flakne', 'fuck', 'satan', 'god', 'g0d', 'crappyslarre'
]);

/**
 * Validate a lowercase, trimmed username candidate against format + reserved
 * words. Does NOT check the database for uniqueness — callers do that
 * themselves, since "is this taken" logic differs slightly by context (e.g.
 * "available to me because it's already mine" vs. a fresh pick).
 *
 * @param {string} raw - already trimmed + lowercased
 * @returns {{ ok: true } | { ok: false, reason: 'format' | 'reserved' }}
 */
export function checkUsernameCandidate(raw) {
  if (!USERNAME_RE.test(raw)) return { ok: false, reason: 'format' };
  if (RESERVED_USERNAMES.has(raw)) return { ok: false, reason: 'reserved' };
  return { ok: true };
}
