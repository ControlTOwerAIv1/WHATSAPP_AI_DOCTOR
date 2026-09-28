/**
 * AI Bot — Chat-Based Data Export Handler (Part 4)
 *
 * When the admin or doctor sends a message like "export bookings" or
 * "export last month", this module:
 *
 *  1. Parses the requested date range from the message
 *  2. Queries SQLite for booking rows in that range
 *  3. If ≤15 rows → replies with an inline text table
 *  4. If >15 rows → writes a temp CSV file and uploads it via WhatsApp document
 *
 * Usage: called from patient-agent / admin-agent intent detection.
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const store  = require('./store');
const { buildExportCsv } = require('./export');
const { getCurrentTime } = require('./clock');

const INLINE_ROW_LIMIT = 15;

/**
 * Detect whether a message is an export request.
 * Returns true for messages containing "export", "download", "send bookings", etc.
 */
function isExportRequest(message) {
  const lower = (message || '').toLowerCase();
  return (
    lower.includes('export') ||
    lower.includes('download booking') ||
    lower.includes('send booking') ||
    lower.includes('export appointment') ||
    lower.includes('booking list') ||
    lower.includes('appointments list') ||
    (lower.includes('all booking') && lower.includes('csv'))
  );
}

/**
 * Parse date range from message text.
 * Returns { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
 * Defaults to the upcoming Sunday's date (for the current clinic session).
 */
function parseDateRange(message) {
  const lower  = (message || '').toLowerCase();
  const now    = getCurrentTime();

  // "last month"
  if (lower.includes('last month')) {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last  = new Date(now.getFullYear(), now.getMonth(), 0);
    return { from: _fmt(first), to: _fmt(last) };
  }

  // "this month"
  if (lower.includes('this month')) {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: _fmt(first), to: _fmt(now) };
  }

  // "last week"
  if (lower.includes('last week')) {
    const monday = new Date(now);
    monday.setDate(monday.getDate() - monday.getDay() - 6); // prev Monday
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);
    return { from: _fmt(monday), to: _fmt(sunday) };
  }

  // Explicit YYYY-MM-DD date
  const dateMatch = message.match(/(\d{4}-\d{2}-\d{2})/g);
  if (dateMatch && dateMatch.length >= 2) {
    const [a, b] = dateMatch.sort();
    return { from: a, to: b };
  }
  if (dateMatch && dateMatch.length === 1) {
    return { from: dateMatch[0], to: dateMatch[0] };
  }

  // Default: last 30 days
  const d30 = new Date(now);
  d30.setDate(d30.getDate() - 30);
  return { from: _fmt(d30), to: _fmt(now) };
}

function _fmt(d) {
  return d.toISOString ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

/**
 * Handle an export request from an admin or doctor.
 *
 * @param {string} message   - The WhatsApp message
 * @param {string} senderPhone - Normalized phone of the requester
 * @param {Function} sendText  - Async fn(phone, text) to reply inline
 * @param {Function} [sendDoc] - Async fn(phone, filename, buffer, mimetype) to send file
 * @param {string} [agentId]
 * @returns {Promise<string>} The text reply (for session history)
 */
async function handleExportRequest(message, senderPhone, sendText, sendDoc, agentId = 'default') {
  const { from, to } = parseDateRange(message);
  const rows = store.getBookingsInRange(from, to, agentId);

  store.logExport({
    requestedBy: senderPhone,
    agentId,
    fromDate:  from,
    toDate:    to,
    rowCount:  rows.length,
    format:    rows.length > INLINE_ROW_LIMIT ? 'csv' : 'text',
  });

  if (rows.length === 0) {
    const reply = `No bookings found between ${from} and ${to}.`;
    await sendText(senderPhone, reply);
    return reply;
  }

  if (rows.length <= INLINE_ROW_LIMIT) {
    // Inline text table
    const lines = [`*Bookings ${from} → ${to}* (${rows.length} records)\n`];
    for (const r of rows) {
      lines.push(
        `🔢 Token #${r.token_number} — ${r.patient_name}\n` +
        `   📅 ${r.date}  🕐 ~${r.arrival_time}  [${r.slot_name}]\n` +
        `   📱 ${r.patient_phone}  |  ${r.condition || 'No condition'}`
      );
    }
    const reply = lines.join('\n');
    await sendText(senderPhone, reply);
    return reply;
  }

  // More than 15 rows — send CSV file
  const csv      = buildExportCsv(rows);
  const filename = `bookings_${from}_to_${to}.csv`;
  const tmpPath  = path.join(os.tmpdir(), filename);

  try {
    fs.writeFileSync(tmpPath, csv, 'utf8');
    if (typeof sendDoc === 'function') {
      const buf = fs.readFileSync(tmpPath);
      await sendDoc(senderPhone, filename, buf, 'text/csv');
      const reply = `📎 Sent ${rows.length} booking records (${from} → ${to}) as CSV.`;
      await sendText(senderPhone, reply);
      return reply;
    } else {
      // Fallback: send inline summary if doc upload not available
      const reply = `Found ${rows.length} bookings (${from} → ${to}). Export as CSV not available in this channel.`;
      await sendText(senderPhone, reply);
      return reply;
    }
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

module.exports = {
  isExportRequest,
  parseDateRange,
  handleExportRequest,
};
