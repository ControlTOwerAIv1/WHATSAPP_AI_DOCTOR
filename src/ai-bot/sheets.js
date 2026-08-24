/**
 * AI Bot — Google Sheets Integration
 *
 * Reads doctor availability from an "availability" worksheet and writes
 * bookings to a "bookings" worksheet. Uses the googleapis npm package
 * with service account authentication.
 *
 * Sheet structure:
 *   availability: slot_id | doctor_name | specialty | date | start_time | end_time | status
 *   bookings:     booking_ref | slot_id | patient_name | patient_phone | condition | booked_at
 */

const { google } = require('googleapis');
const fs = require('fs');
const { getConfig } = require('./config');

let _sheets = null;
let _spreadsheetId = null;

// Availability cache (30-second TTL)
let _slotsCache = null;
let _slotsCacheTs = 0;
const CACHE_TTL_MS = 30000;

/**
 * Initialize the Google Sheets client (lazy, called on first use).
 */
function _getSheetsClient() {
  if (_sheets) return _sheets;

  const config = getConfig();
  _spreadsheetId = config.googleSheetId;

  if (!_spreadsheetId) {
    throw new Error('GOOGLE_SHEET_ID not configured');
  }

  if (!fs.existsSync(config.googleCredentialsFile)) {
    throw new Error(`Google credentials file not found: ${config.googleCredentialsFile}`);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: config.googleCredentialsFile,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });

  _sheets = google.sheets({ version: 'v4', auth });
  console.log('[AI-Bot] Google Sheets client initialized');
  return _sheets;
}

/**
 * Invalidate the slots cache (e.g., after booking).
 */
function _invalidateCache() {
  _slotsCache = null;
  _slotsCacheTs = 0;
}

/**
 * Read all rows from a worksheet and return as array of objects
 * (using the first row as headers).
 */
async function _readWorksheet(sheetName) {
  const sheets = _getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: _spreadsheetId,
    range: `${sheetName}`,
  });

  const rows = response.data.values;
  if (!rows || rows.length < 2) return [];

  const headers = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const records = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const record = {};
    for (let j = 0; j < headers.length; j++) {
      record[headers[j]] = (row[j] || '').toString().trim();
    }
    records.push({ ...record, _rowIndex: i + 1 }); // 1-based row index
  }

  return records;
}

/**
 * Get available appointment slots (status === 'open', date >= today).
 * Results are cached for 30 seconds.
 * @returns {Array<Object>}
 */
async function getAvailableSlots() {
  const now = Date.now();
  if (_slotsCache && (now - _slotsCacheTs) < CACHE_TTL_MS) {
    return _slotsCache;
  }

  try {
    const allRows = await _readWorksheet('availability');
    const todayStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    const openSlots = allRows.filter(row =>
      (row.status || '').toLowerCase() === 'open' &&
      (row.date || '') >= todayStr
    );

    _slotsCache = openSlots;
    _slotsCacheTs = Date.now();

    console.log(`[AI-Bot] Slots fetched: ${allRows.length} total, ${openSlots.length} open`);
    return openSlots;
  } catch (err) {
    console.error('[AI-Bot] Failed to fetch slots:', err.message);
    return [];
  }
}

/**
 * Book a slot by ID.
 *
 * 1. Re-reads the exact row (never trusts cache).
 * 2. If status is still 'open', updates to 'booked'.
 * 3. Appends a record to the 'bookings' worksheet.
 * 4. Invalidates the availability cache.
 *
 * @returns {Object|null} Booking details on success, null if slot is taken.
 */
async function bookSlot(slotId, patientName, patientPhone, condition) {
  try {
    const sheets = _getSheetsClient();

    // Re-read live rows (don't trust cache for booking)
    const allRows = await _readWorksheet('availability');
    const target = allRows.find(r => (r.slot_id || '').toString().trim() === slotId.toString().trim());

    if (!target) {
      console.warn('[AI-Bot] Slot not found:', slotId);
      return null;
    }

    if ((target.status || '').toLowerCase() !== 'open') {
      console.info('[AI-Bot] Slot already taken:', slotId);
      return null;
    }

    // Find the column index for 'status' in the header row
    const headerResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: _spreadsheetId,
      range: 'availability!1:1',
    });
    const headers = (headerResponse.data.values?.[0] || []).map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
    const statusColIdx = headers.indexOf('status');
    if (statusColIdx === -1) throw new Error("Column 'status' not found");

    // Convert column index to A1 notation (0=A, 1=B, etc.)
    const colLetter = String.fromCharCode(65 + statusColIdx);
    const cellRef = `availability!${colLetter}${target._rowIndex}`;

    // Update status to 'booked'
    await sheets.spreadsheets.values.update({
      spreadsheetId: _spreadsheetId,
      range: cellRef,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['booked']] },
    });

    // Generate booking reference
    const bookingRef = Math.random().toString(36).substring(2, 10).toUpperCase();
    const bookedAt = new Date().toISOString().replace('T', ' ').substring(0, 19);

    // Append to bookings worksheet
    await sheets.spreadsheets.values.append({
      spreadsheetId: _spreadsheetId,
      range: 'bookings',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[bookingRef, slotId, patientName, patientPhone, condition, bookedAt]],
      },
    });

    _invalidateCache();

    const booking = {
      booking_ref: bookingRef,
      slot_id: slotId,
      doctor_name: target.doctor_name || '',
      specialty: target.specialty || '',
      date: target.date || '',
      start_time: target.start_time || '',
      end_time: target.end_time || '',
      patient_name: patientName,
      patient_phone: patientPhone,
      condition,
      booked_at: bookedAt,
    };

    console.log(`[AI-Bot] Slot booked: ref=${bookingRef}, slot=${slotId}, doctor=${booking.doctor_name}`);
    return booking;
  } catch (err) {
    console.error('[AI-Bot] Booking failed:', err.message);
    return null;
  }
}

/**
 * Get bookings for a specific doctor (by name) for today.
 * @param {string} doctorName
 * @returns {Array<Object>}
 */
async function getDoctorBookings(doctorName) {
  try {
    const allBookings = await _readWorksheet('bookings');
    const allSlots = await _readWorksheet('availability');

    const todayStr = new Date().toISOString().split('T')[0];

    // Find slot IDs for this doctor that are booked today
    const doctorSlotIds = allSlots
      .filter(s =>
        (s.doctor_name || '').toLowerCase().includes(doctorName.toLowerCase()) &&
        (s.status || '').toLowerCase() === 'booked' &&
        (s.date || '') === todayStr
      )
      .map(s => s.slot_id);

    // Find matching bookings
    return allBookings.filter(b => doctorSlotIds.includes(b.slot_id));
  } catch (err) {
    console.error('[AI-Bot] Failed to fetch doctor bookings:', err.message);
    return [];
  }
}

/**
 * Get upcoming schedule for a specific doctor (by name).
 * @param {string} doctorName
 * @returns {Array<Object>}
 */
async function getDoctorSchedule(doctorName) {
  try {
    const allSlots = await _readWorksheet('availability');
    const todayStr = new Date().toISOString().split('T')[0];

    return allSlots.filter(s =>
      (s.doctor_name || '').toLowerCase().includes(doctorName.toLowerCase()) &&
      (s.date || '') >= todayStr
    );
  } catch (err) {
    console.error('[AI-Bot] Failed to fetch doctor schedule:', err.message);
    return [];
  }
}

module.exports = {
  getAvailableSlots,
  bookSlot,
  getDoctorBookings,
  getDoctorSchedule,
};
