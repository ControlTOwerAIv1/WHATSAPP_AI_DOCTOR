/**
 * AI Bot — Google Sheets Integration
 *
 * Reads doctor availability from an "availability" worksheet and writes
 * bookings to a "bookings" worksheet.
 * Manages "Settings" and "Overrides" worksheets for clinic schedule config.
 * Uses the googleapis npm package with service account authentication.
 *
 * Sheet structure:
 *   availability: slot_id | doctor_name | specialty | date | start_time | end_time | status
 *   bookings:     booking_ref | slot_id | patient_name | patient_phone | condition | booked_at
 *   Settings:     operating_days | booking_open_day | booking_open_time | booking_close_day | booking_close_time | max_tokens | morning_start | morning_end | morning_cap | afternoon_start | afternoon_end | afternoon_cap | break_start | break_end | rounding_minutes
 *   Overrides:    target_date | type | booking_opens_at | consultation_start | consultation_end | token_cap | created_by | created_at | notes
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config');
const { getCurrentTime, getCurrentTimestamp } = require('./clock');

let _sheets = null;
let _spreadsheetId = null;

// Availability cache (30-second TTL)
let _slotsCache = null;
let _slotsCacheTs = 0;
const CACHE_TTL_MS = 30000;

// Schedule Settings & Overrides cache (60-second TTL)
let _settingsCache = null;
let _settingsCacheTs = 0;
let _overridesCache = null;
let _overridesCacheTs = 0;
const SCHEDULE_CACHE_TTL_MS = 60000;

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
 * Invalidate the schedule (Settings & Overrides) cache.
 */
function invalidateScheduleCache() {
  _settingsCache = null;
  _settingsCacheTs = 0;
  _overridesCache = null;
  _overridesCacheTs = 0;
  _slotsCache = null;
  _slotsCacheTs = 0;
  console.log('[AI-Bot] 🔄 Schedule cache invalidated');
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
      record[headers[j]] = (row[j] !== undefined && row[j] !== null ? row[j] : '').toString().trim();
    }
    records.push({ ...record, _rowIndex: i + 1 }); // 1-based row index
  }

  return records;
}

/**
 * Ensure a specific worksheet exists in the spreadsheet. If not, creates it and seeds initial rows.
 */
async function _ensureTabExists(title, headerRow, initialRows = []) {
  const sheets = _getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: _spreadsheetId });
  const sheetList = meta.data.sheets || [];
  const exists = sheetList.some(s => (s.properties?.title || '').toLowerCase() === title.toLowerCase());

  if (!exists) {
    console.log(`[AI-Bot] Worksheet '${title}' not found. Creating...`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: _spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: { title },
            },
          },
        ],
      },
    });

    const values = [headerRow, ...initialRows];
    await sheets.spreadsheets.values.update({
      spreadsheetId: _spreadsheetId,
      range: `${title}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });
    console.log(`[AI-Bot] Worksheet '${title}' created and seeded with ${values.length} rows`);
  }
}

/**
 * Load default clinic schedule config from json file for fallback/seeding.
 */
function _loadSeedScheduleConfig() {
  const candidates = [
    path.join(__dirname, 'config', 'clinic-schedule.json'),
    path.join(__dirname, '..', '..', 'ai-bot', 'config', 'clinic-schedule.json'),
    path.join(process.cwd(), 'ai-bot', 'config', 'clinic-schedule.json'),
    path.join(process.cwd(), 'src', 'ai-bot', 'config', 'clinic-schedule.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (e) {
        // ignore
      }
    }
  }
  return {
    clinic_name: 'Dr. AI Clinic',
    operating_days: ['Sunday'],
    booking_window: {
      start_day: 'Saturday',
      start_time: '21:00',
      end_day: 'Sunday',
      end_time: '18:00',
    },
    max_tokens: 45,
    rounding_interval_minutes: 30,
    break_period: {
      start_time: '13:30',
      end_time: '14:30',
    },
    slots: {
      morning: {
        start_time: '11:00',
        end_time: '13:30',
        token_cap: 17,
      },
      afternoon: {
        start_time: '14:30',
        end_time: '18:30',
        token_cap: 28,
      },
    },
  };
}

const SETTINGS_HEADERS = [
  'operating_days',
  'booking_open_day',
  'booking_open_time',
  'booking_close_day',
  'booking_close_time',
  'max_tokens',
  'morning_start',
  'morning_end',
  'morning_cap',
  'afternoon_start',
  'afternoon_end',
  'afternoon_cap',
  'break_start',
  'break_end',
  'rounding_minutes',
];

const OVERRIDES_HEADERS = [
  'target_date',
  'type',
  'booking_opens_at',
  'consultation_start',
  'consultation_end',
  'token_cap',
  'created_by',
  'created_at',
  'notes',
];

/**
 * Ensure Settings and Overrides tabs exist and are properly initialized in Google Sheets.
 */
async function ensureSettingsAndOverridesTabs() {
  const seed = _loadSeedScheduleConfig();
  const morning = seed.slots?.morning || {};
  const afternoon = seed.slots?.afternoon || {};
  const breakPeriod = seed.break_period || {};
  const bookingWindow = seed.booking_window || {};

  const seededSettingsRow = [
    Array.isArray(seed.operating_days) ? seed.operating_days.join(', ') : (seed.operating_days || 'Sunday'),
    bookingWindow.start_day || 'Saturday',
    bookingWindow.start_time || '21:00',
    bookingWindow.end_day || 'Sunday',
    bookingWindow.end_time || '18:00',
    seed.max_tokens || 45,
    morning.start_time || '11:00',
    morning.end_time || '13:30',
    morning.token_cap || 17,
    afternoon.start_time || '14:30',
    afternoon.end_time || '18:30',
    afternoon.token_cap || 28,
    breakPeriod.start_time || '13:30',
    breakPeriod.end_time || '14:30',
    seed.rounding_interval_minutes || 30,
  ];

  await _ensureTabExists('Settings', SETTINGS_HEADERS, [seededSettingsRow]);
  await _ensureTabExists('Overrides', OVERRIDES_HEADERS, []);
}

/**
 * Read Settings from the "Settings" tab in Google Sheets with 60s TTL cache.
 */
async function getSettingsFromSheet(forceRefresh = false) {
  const now = getCurrentTimestamp();
  if (!forceRefresh && _settingsCache && (now - _settingsCacheTs) < SCHEDULE_CACHE_TTL_MS) {
    return _settingsCache;
  }

  try {
    await ensureSettingsAndOverridesTabs();
    const rows = await _readWorksheet('Settings');

    let rawSettings = {};
    if (rows && rows.length > 0) {
      rawSettings = rows[0];
    }

    const operatingDaysRaw = rawSettings.operating_days || 'Sunday';
    const operatingDays = operatingDaysRaw.split(',').map(d => d.trim()).filter(Boolean);

    const morningCap = Number(rawSettings.morning_cap) || 17;
    const afternoonCap = Number(rawSettings.afternoon_cap) || 28;
    const maxTokens = Number(rawSettings.max_tokens) || (morningCap + afternoonCap) || 45;

    const settings = {
      operating_days: operatingDays.length > 0 ? operatingDays : ['Sunday'],
      booking_open_day: rawSettings.booking_open_day || 'Saturday',
      booking_open_time: rawSettings.booking_open_time || '21:00',
      booking_close_day: rawSettings.booking_close_day || 'Sunday',
      booking_close_time: rawSettings.booking_close_time || '18:00',
      max_tokens: maxTokens,
      morning_start: rawSettings.morning_start || '11:00',
      morning_end: rawSettings.morning_end || '13:30',
      morning_cap: morningCap,
      afternoon_start: rawSettings.afternoon_start || '14:30',
      afternoon_end: rawSettings.afternoon_end || '18:30',
      afternoon_cap: afternoonCap,
      break_start: rawSettings.break_start || '13:30',
      break_end: rawSettings.break_end || '14:30',
      rounding_minutes: Number(rawSettings.rounding_minutes) || 30,
    };

    _settingsCache = settings;
    _settingsCacheTs = getCurrentTimestamp();
    return settings;
  } catch (err) {
    console.error('[AI-Bot] Failed to read Settings tab:', err.message);
    if (_settingsCache) return _settingsCache;
    // Fallback to json values if offline
    const seed = _loadSeedScheduleConfig();
    return {
      operating_days: seed.operating_days || ['Sunday'],
      booking_open_day: seed.booking_window?.start_day || 'Saturday',
      booking_open_time: seed.booking_window?.start_time || '21:00',
      booking_close_day: seed.booking_window?.end_day || 'Sunday',
      booking_close_time: seed.booking_window?.end_time || '18:00',
      max_tokens: seed.max_tokens || 45,
      morning_start: seed.slots?.morning?.start_time || '11:00',
      morning_end: seed.slots?.morning?.end_time || '13:30',
      morning_cap: seed.slots?.morning?.token_cap || 17,
      afternoon_start: seed.slots?.afternoon?.start_time || '14:30',
      afternoon_end: seed.slots?.afternoon?.end_time || '18:30',
      afternoon_cap: seed.slots?.afternoon?.token_cap || 28,
      break_start: seed.break_period?.start_time || '13:30',
      break_end: seed.break_period?.end_time || '14:30',
      rounding_minutes: seed.rounding_interval_minutes || 30,
    };
  }
}

/**
 * Read Overrides from the "Overrides" tab in Google Sheets with 60s TTL cache.
 */
async function getOverridesFromSheet(forceRefresh = false) {
  const now = getCurrentTimestamp();
  if (!forceRefresh && _overridesCache && (now - _overridesCacheTs) < SCHEDULE_CACHE_TTL_MS) {
    return _overridesCache;
  }

  try {
    await ensureSettingsAndOverridesTabs();
    const rows = await _readWorksheet('Overrides');
    _overridesCache = rows || [];
    _overridesCacheTs = getCurrentTimestamp();
    return _overridesCache;
  } catch (err) {
    console.error('[AI-Bot] Failed to read Overrides tab:', err.message);
    return _overridesCache || [];
  }
}

/**
 * Update the Settings tab in Google Sheets (Permanent changes).
 * Validates morning_cap + afternoon_cap <= max_tokens.
 *
 * @param {Object} updates - Fields to update
 * @returns {Promise<{ success: boolean, settings?: Object, error?: string }>}
 */
async function updateSettingsInSheet(updates = {}) {
  try {
    const current = await getSettingsFromSheet(true);
    const merged = { ...current, ...updates };

    // Format operating_days
    if (Array.isArray(merged.operating_days)) {
      merged.operating_days = merged.operating_days;
    } else if (typeof merged.operating_days === 'string') {
      merged.operating_days = merged.operating_days.split(',').map(d => d.trim()).filter(Boolean);
    }

    const maxTokens = Number(merged.max_tokens);
    const morningCap = Number(merged.morning_cap);
    const afternoonCap = Number(merged.afternoon_cap);

    // Enforce morning_cap + afternoon_cap <= max_tokens
    if (morningCap + afternoonCap > maxTokens) {
      const err = `Cannot update settings: Morning cap (${morningCap}) + Afternoon cap (${afternoonCap}) = ${morningCap + afternoonCap}, which exceeds max tokens (${maxTokens}).`;
      console.warn(`[AI-Bot] ❌ ${err}`);
      return { success: false, error: err };
    }

    const sheets = _getSheetsClient();
    const rowValues = [
      merged.operating_days.join(', '),
      merged.booking_open_day,
      merged.booking_open_time,
      merged.booking_close_day,
      merged.booking_close_time,
      maxTokens,
      merged.morning_start,
      merged.morning_end,
      morningCap,
      merged.afternoon_start,
      merged.afternoon_end,
      afternoonCap,
      merged.break_start,
      merged.break_end,
      Number(merged.rounding_minutes) || 30,
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId: _spreadsheetId,
      range: 'Settings!A2:O2',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowValues] },
    });

    invalidateScheduleCache();
    console.log('[AI-Bot] ✅ Settings tab successfully updated in Google Sheets');
    return { success: true, settings: merged };
  } catch (err) {
    console.error('[AI-Bot] Failed to update Settings tab:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Append a row to the Overrides tab in Google Sheets (One-off exceptions).
 *
 * @param {Object} override
 * @param {string} override.target_date - YYYY-MM-DD
 * @param {'open_extra_day'|'closed'|'capacity_change'} override.type
 * @param {string} [override.booking_opens_at]
 * @param {string} [override.consultation_start]
 * @param {string} [override.consultation_end]
 * @param {number|string} [override.token_cap]
 * @param {string} [override.created_by]
 * @param {string} [override.created_at]
 * @param {string} [override.notes]
 * @returns {Promise<{ success: boolean, override?: Object, error?: string }>}
 */
async function addOverrideToSheet(override = {}) {
  try {
    await ensureSettingsAndOverridesTabs();
    const sheets = _getSheetsClient();

    const createdAt = override.created_at || getCurrentTime().toISOString().replace('T', ' ').substring(0, 19);
    const rowValues = [
      override.target_date || '',
      override.type || 'open_extra_day',
      override.booking_opens_at || '',
      override.consultation_start || '',
      override.consultation_end || '',
      override.token_cap !== undefined && override.token_cap !== null ? String(override.token_cap) : '',
      override.created_by || 'Admin',
      createdAt,
      override.notes || '',
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: _spreadsheetId,
      range: 'Overrides',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [rowValues],
      },
    });

    invalidateScheduleCache();
    console.log(`[AI-Bot] ✅ Override appended to Overrides tab for ${override.target_date} (${override.type})`);
    return { success: true, override: { ...override, created_at: createdAt } };
  } catch (err) {
    console.error('[AI-Bot] Failed to add Override to sheet:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Get available appointment slots (status === 'open', date >= today).
 * Results are cached for 30 seconds.
 * @returns {Array<Object>}
 */
async function getAvailableSlots() {
  const now = getCurrentTimestamp();
  if (_slotsCache && (now - _slotsCacheTs) < CACHE_TTL_MS) {
    return _slotsCache;
  }

  try {
    const allRows = await _readWorksheet('availability');
    const todayStr = getCurrentTime().toISOString().split('T')[0]; // YYYY-MM-DD

    const openSlots = allRows.filter(row =>
      (row.status || '').toLowerCase() === 'open' &&
      (row.date || '') >= todayStr
    );

    _slotsCache = openSlots;
    _slotsCacheTs = getCurrentTimestamp();

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
    const bookedAt = getCurrentTime().toISOString().replace('T', ' ').substring(0, 19);

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

    const todayStr = getCurrentTime().toISOString().split('T')[0];

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
    const todayStr = getCurrentTime().toISOString().split('T')[0];

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
  ensureSettingsAndOverridesTabs,
  getSettingsFromSheet,
  getOverridesFromSheet,
  updateSettingsInSheet,
  addOverrideToSheet,
  invalidateScheduleCache,
  getAvailableSlots,
  bookSlot,
  getDoctorBookings,
  getDoctorSchedule,
};
