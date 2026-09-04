/**
 * AI Bot — Centralized Clock Module
 *
 * Provides a single, centralized access point for the current time across the
 * appointment, booking, and scheduling logic.
 *
 * Production Safety:
 * - When process.env.NODE_ENV === 'production', the mock is strictly ignored
 *   and real system time (new Date()) is always returned.
 * - In non-production environments (e.g. test / development), if process.env.MOCK_CURRENT_TIME
 *   is set to a valid ISO datetime string, it returns new Date(process.env.MOCK_CURRENT_TIME).
 * - Logs a loud, prominent warning whenever mock time is active.
 */

/**
 * Get the current time.
 * @returns {Date}
 */
function getCurrentTime() {
  const isProd = process.env.NODE_ENV === 'production';
  const mockTimeStr = process.env.MOCK_CURRENT_TIME;

  if (!isProd && mockTimeStr) {
    const parsed = new Date(mockTimeStr);
    if (!isNaN(parsed.getTime())) {
      console.warn(`⚠️  MOCKED TIME ACTIVE — pretending current time is ${mockTimeStr}`);
      return parsed;
    }
  }

  return new Date();
}

/**
 * Get the current timestamp in milliseconds (consistent with getCurrentTime()).
 * @returns {number}
 */
function getCurrentTimestamp() {
  return getCurrentTime().getTime();
}

module.exports = {
  getCurrentTime,
  getCurrentTimestamp,
};
