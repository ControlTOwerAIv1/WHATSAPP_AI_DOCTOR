/**
 * AI Bot — In-Memory Session Store
 *
 * Tracks the conversational stage and collected data for each user's
 * interaction with the AI bot. Sessions auto-expire after 30 minutes
 * of inactivity to prevent stale state.
 *
 * Structure per phone:
 * {
 *   stage: 'start' | 'waiting_for_name' | 'waiting_for_condition' | 'waiting_for_slot',
 *   name: string | null,
 *   condition: string | null,
 *   offeredSlots: Array | null,
 *   initialRequest: string | null,
 *   nameFailures: 0,
 *   conditionFailures: 0,
 *   history: [{ role: 'user'|'assistant', content: string }],
 *   lastActiveAt: number (Date.now()),
 * }
 */

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

const _sessions = new Map();

/**
 * Get the session for a phone number, creating a fresh one if needed
 * or if the existing one has expired.
 */
function getSession(phone) {
  const existing = _sessions.get(phone);

  if (existing) {
    // Check for expiration
    if (Date.now() - existing.lastActiveAt > SESSION_TTL_MS) {
      _sessions.delete(phone);
    } else {
      existing.lastActiveAt = Date.now();
      return existing;
    }
  }

  const session = {
    stage: 'start',
    name: null,
    condition: null,
    offeredSlots: null,
    initialRequest: null,
    nameFailures: 0,
    conditionFailures: 0,
    history: [],
    lastActiveAt: Date.now(),
  };
  _sessions.set(phone, session);
  return session;
}

/**
 * Update specific fields in the session.
 */
function updateSession(phone, data) {
  const session = getSession(phone);
  Object.assign(session, data);
  session.lastActiveAt = Date.now();
}

/**
 * Clear a session entirely (e.g., after successful booking or cancellation).
 */
function clearSession(phone) {
  _sessions.delete(phone);
}

/**
 * Append a message to the conversation history for a phone number.
 * Keeps the last 20 messages.
 * @param {string} phone
 * @param {'user'|'assistant'} role
 * @param {string} content
 */
function appendHistory(phone, role, content) {
  const session = getSession(phone);
  session.history.push({ role, content });
  if (session.history.length > 20) {
    session.history = session.history.slice(-20);
  }
  session.lastActiveAt = Date.now();
}

/**
 * Get conversation history in Anthropic messages format.
 * @param {string} phone
 * @param {number} [lastN=10] - Number of recent messages to include
 * @returns {Array<{role: string, content: string}>}
 */
function getHistory(phone, lastN = 10) {
  const session = getSession(phone);
  return session.history.slice(-lastN);
}

/**
 * Periodic cleanup of expired sessions (call from a timer if desired).
 */
function cleanupExpiredSessions() {
  const now = Date.now();
  let cleaned = 0;
  for (const [phone, session] of _sessions) {
    if (now - session.lastActiveAt > SESSION_TTL_MS) {
      _sessions.delete(phone);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[AI-Bot] Cleaned up ${cleaned} expired session(s)`);
  }
}

module.exports = {
  getSession,
  updateSession,
  clearSession,
  appendHistory,
  getHistory,
  cleanupExpiredSessions,
};
