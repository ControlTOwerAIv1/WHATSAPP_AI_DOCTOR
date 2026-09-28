/**
 * CSV export builder for appointment bookings.
 * Used by the /api/export route and the chat-based export handler.
 */

'use strict';

/**
 * Convert an array of booking rows to CSV text.
 * Columns: Date, Token#, Slot, Patient Name, Phone, Arrival Time, Condition, Status, Booked At
 *
 * @param {Array<object>} rows - rows from store.getBookingsInRange()
 * @returns {string} UTF-8 CSV (with BOM for Excel compatibility)
 */
function buildExportCsv(rows = []) {
  const HEADER = ['Date', 'Token #', 'Slot', 'Patient Name', 'Phone', 'Arrival Time', 'Condition', 'Status', 'Booked At'];

  const escape = (val) => {
    const s = String(val === null || val === undefined ? '' : val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const lines = [
    HEADER.map(escape).join(','),
    ...rows.map(r => [
      r.date        || r.sunday_date || '',
      r.token_number || '',
      r.slot_name   || '',
      r.patient_name || '',
      r.patient_phone || '',
      r.arrival_time || '',
      r.condition   || '',
      r.status      || 'booked',
      r.booked_at   || r.created_at || '',
    ].map(escape).join(',')),
  ];

  // BOM prefix so Excel opens UTF-8 CSV correctly
  return '\uFEFF' + lines.join('\r\n');
}

module.exports = { buildExportCsv };
