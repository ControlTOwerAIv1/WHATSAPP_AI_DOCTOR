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
const ADMIN_PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes
const { getCurrentTimestamp } = require('./clock');

const _sessions = new Map();

/**
 * Get the session for a phone number, creating a fresh one if needed
 * or if the existing one has expired.
 */
function getSession(phone) {
  const existing = _sessions.get(phone);

  if (existing) {
    // Check for expiration
    if (getCurrentTimestamp() - existing.lastActiveAt > SESSION_TTL_MS) {
      _sessions.delete(phone);
    } else {
      existing.lastActiveAt = getCurrentTimestamp();
      return existing;
    }
  }

  const session = {
    stage: 'start',
    name: null,
    condition: null,
    slotPreference: null,
    offeredSlot: null,
    offeredSlots: null,
    initialRequest: null,
    nameFailures: 0,
    conditionFailures: 0,
    adminPending: null,
    history: [],
    lastActiveAt: getCurrentTimestamp(),
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
  session.lastActiveAt = getCurrentTimestamp();
}

/**
 * Clear a session entirely (e.g., after successful booking or cancellation).
 */
function clearSession(phone) {
  _sessions.delete(phone);
}

/**
 * Get pending admin action for a phone number, expiring after 10 minutes.
 */
function getAdminPending(phone) {
  const session = getSession(phone);
  if (!session.adminPending) return null;

  const now = getCurrentTimestamp();
  if (now - (session.adminPending.createdAt || 0) > ADMIN_PENDING_TTL_MS) {
    session.adminPending = null;
    return null;
  }
  return session.adminPending;
}

/**
 * Set pending admin action for a phone number.
 */
function setAdminPending(phone, pendingAction) {
  const session = getSession(phone);
  session.adminPending = {
    ...pendingAction,
    createdAt: getCurrentTimestamp(),
  };
  session.lastActiveAt = getCurrentTimestamp();
}

/**
 * Clear pending admin action for a phone number.
 */
function clearAdminPending(phone) {
  const session = getSession(phone);
  session.adminPending = null;
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
  const last = session.history[session.history.length - 1];
  if (last && last.role === role && last.content === content) {
    session.lastActiveAt = getCurrentTimestamp();
    return;
  }
  session.history.push({ role, content });
  if (session.history.length > 20) {
    session.history = session.history.slice(-20);
  }
  session.lastActiveAt = getCurrentTimestamp();
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
  const now = getCurrentTimestamp();
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
  getAdminPending,
  setAdminPending,
  clearAdminPending,
  appendHistory,
  getHistory,
  cleanupExpiredSessions,
};
