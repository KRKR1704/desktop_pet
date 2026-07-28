// Typed error for provider adapters (backend/providers/*.js), so the Forge
// UI can show a specific reason (rate limit / content policy / auth / bad
// network) instead of a generic "failed" on a tile, and so backend/forge.js
// doesn't have to string-match provider-specific error bodies more than once.
'use strict';

const KINDS = ['auth', 'rate_limit', 'content_policy', 'network', 'unknown'];

class ForgeError extends Error {
  constructor(kind, message, { cause } = {}) {
    super(message);
    this.name = 'ForgeError';
    this.kind = KINDS.includes(kind) ? kind : 'unknown';
    if (cause) this.cause = cause;
  }
}

// Best-effort classification shared by every provider adapter: HTTP status
// codes are fairly standardized across OpenAI/Stability/Gemini for these
// cases, so this one heuristic covers all three rather than re-implementing
// it per adapter. Falls back to 'unknown' rather than guessing wrong.
function classifyHttpError(status, bodyText) {
  const text = (bodyText || '').toLowerCase();
  if (status === 401 || status === 403) return 'auth';
  // Verified live 2026-07: Gemini returns plain 400 (not 401/403) for an
  // invalid key, with reason "API_KEY_INVALID" in the body — status code
  // alone isn't enough to classify auth failures across all 3 providers.
  if (text.includes('api key') || text.includes('api_key_invalid') || text.includes('invalid_api_key')) return 'auth';
  if (status === 429) return 'rate_limit';
  if (text.includes('content_policy') || text.includes('content policy') ||
      text.includes('safety') || text.includes('moderation') || text.includes('blocked')) {
    return 'content_policy';
  }
  if (status >= 500) return 'network';
  return 'unknown';
}

module.exports = { ForgeError, KINDS, classifyHttpError };
