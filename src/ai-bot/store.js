/**
 * AI Bot — SQLite Data Store (replaces Google Sheets)
 *
 * Owns:
 *   - agent_settings  (one row per agent_id — was the Settings tab)
 *   - agent_overrides (one row per override per agent_id — was the Overrides tab)
 *   - appointments_tokens (extended with status, created_at, agent_id columns)
 *   - export_log       (audit trail for CSV/Excel exports)
 *   - dashboard_sessions (HTTP session tokens for the Echo dashboard)
 *
 * All reads are direct synchronous SQLite reads — no caching needed.
 * All writes happen inside explicit transactions.
 *
 * DB file: relay.sqlite (same file already used by schedule.js and db.js)
 */

'use strict';

const Database = require('better-sqlite3');
const path = require('path');

let _db = null;

/**
 * Return (and lazily open) the shared relay.sqlite connection.
 * Idempotent — calling multiple times returns the same instance.
 */
function getDb() {
  if (_db) return _db;
  const dbPath = path.join(process.cwd(), 'relay.sqlite');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _runMigrations(_db);
  return _db;
}

// ─── Migrations (idempotent) ─────────────────────────────────────────────────

function _runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_settings (
      agent_id             TEXT NOT NULL PRIMARY KEY,
      operating_days       TEXT NOT NULL DEFAULT 'Sunday',
      booking_open_day     TEXT NOT NULL DEFAULT 'Saturday',
      booking_open_time    TEXT NOT NULL DEFAULT '21:00',
      booking_close_day    TEXT NOT NULL DEFAULT 'Sunday',
      booking_close_time   TEXT NOT NULL DEFAULT '18:00',
      max_tokens           INTEGER NOT NULL DEFAULT 45,
      morning_start        TEXT NOT NULL DEFAULT '11:00',
      morning_end          TEXT NOT NULL DEFAULT '13:30',
      morning_cap          INTEGER NOT NULL DEFAULT 17,
      afternoon_start      TEXT NOT NULL DEFAULT '14:30',
      afternoon_end        TEXT NOT NULL DEFAULT '18:30',
      afternoon_cap        INTEGER NOT NULL DEFAULT 28,
      break_start          TEXT NOT NULL DEFAULT '13:30',
      break_end            TEXT NOT NULL DEFAULT '14:30',
      rounding_minutes     INTEGER NOT NULL DEFAULT 30,
      updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_overrides (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id             TEXT NOT NULL DEFAULT 'default',
      target_date          TEXT NOT NULL,
      type                 TEXT NOT NULL DEFAULT 'open_extra_day',
      booking_opens_at     TEXT,
      consultation_start   TEXT,
      consultation_end     TEXT,
      token_cap            TEXT,
      created_by           TEXT NOT NULL DEFAULT 'Admin',
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      notes                TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_overrides_agent_date
      ON agent_overrides(agent_id, target_date);

    CREATE TABLE IF NOT EXISTS appointments_tokens (
      sunday_date    TEXT NOT NULL,
      token_number   INTEGER NOT NULL,
      slot_name      TEXT NOT NULL,
      token_in_slot  INTEGER NOT NULL,
      patient_phone  TEXT NOT NULL,
      patient_name   TEXT NOT NULL,
      arrival_time   TEXT NOT NULL,
      condition      TEXT,
      booked_at      TEXT NOT NULL,
      PRIMARY KEY (sunday_date, token_number)
    );
    CREATE INDEX IF NOT EXISTS idx_tokens_phone
      ON appointments_tokens(patient_phone, sunday_date);

    CREATE TABLE IF NOT EXISTS export_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      requested_by TEXT NOT NULL,
      agent_id     TEXT NOT NULL DEFAULT 'default',
      from_date    TEXT NOT NULL,
      to_date      TEXT NOT NULL,
      row_count    INTEGER NOT NULL DEFAULT 0,
      format       TEXT NOT NULL DEFAULT 'csv',
      exported_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dashboard_sessions (
      token       TEXT PRIMARY KEY,
      username    TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires
      ON dashboard_sessions(expires_at);
  `);

  // Add columns that may be missing from an existing appointments_tokens table
  _addColumnIfMissing(db, 'appointments_tokens', 'status',     "TEXT NOT NULL DEFAULT 'booked'");
  _addColumnIfMissing(db, 'appointments_tokens', 'created_at', 'TEXT');
  _addColumnIfMissing(db, 'appointments_tokens', 'agent_id',   "TEXT NOT NULL DEFAULT 'default'");

  // Backfill created_at from booked_at
  db.exec(`UPDATE appointments_tokens SET created_at = booked_at WHERE created_at IS NULL`);

  // Ensure default agent settings row exists
  db.prepare(`INSERT OR IGNORE INTO agent_settings (agent_id) VALUES ('default')`).run();

  console.log('[Store] SQLite migrations complete');
}

function _addColumnIfMissing(db, table, column, definition) {
  const existing = db.pragma(`table_info(${table})`).map(r => r.name);
  if (!existing.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[Store] Migration: added column ${table}.${column}`);
  }
}

// ─── Settings ────────────────────────────────────────────────────────────────

const SETTINGS_DEFAULTS = {
  operating_days:    'Sunday',
  booking_open_day:  'Saturday',
  booking_open_time: '21:00',
  booking_close_day: 'Sunday',
  booking_close_time:'18:00',
  max_tokens:        45,
  morning_start:     '11:00',
  morning_end:       '13:30',
  morning_cap:       17,
  afternoon_start:   '14:30',
  afternoon_end:     '18:30',
  afternoon_cap:     28,
  break_start:       '13:30',
  break_end:         '14:30',
  rounding_minutes:  30,
};

function getSettings(agentId = 'default') {
  const db = getDb();
  let row = db.prepare('SELECT * FROM agent_settings WHERE agent_id = ?').get(agentId);
  if (!row) {
    db.prepare(`INSERT OR IGNORE INTO agent_settings (agent_id) VALUES (?)`).run(agentId);
    row = db.prepare('SELECT * FROM agent_settings WHERE agent_id = ?').get(agentId);
  }
  return _rowToSettings(row);
}

function _rowToSettings(row) {
  const r          = row || {};
  const morningCap   = Number(r.morning_cap)   || SETTINGS_DEFAULTS.morning_cap;
  const afternoonCap = Number(r.afternoon_cap) || SETTINGS_DEFAULTS.afternoon_cap;
  const maxTokens    = Number(r.max_tokens)    || (morningCap + afternoonCap);
  const opDaysRaw    = r.operating_days || SETTINGS_DEFAULTS.operating_days;
  const operatingDays = opDaysRaw.split(',').map(d => d.trim()).filter(Boolean);

  return {
    operating_days:     operatingDays.length > 0 ? operatingDays : ['Sunday'],
    booking_open_day:   r.booking_open_day   || SETTINGS_DEFAULTS.booking_open_day,
    booking_open_time:  r.booking_open_time  || SETTINGS_DEFAULTS.booking_open_time,
    booking_close_day:  r.booking_close_day  || SETTINGS_DEFAULTS.booking_close_day,
    booking_close_time: r.booking_close_time || SETTINGS_DEFAULTS.booking_close_time,
    max_tokens:         maxTokens,
    morning_start:      r.morning_start      || SETTINGS_DEFAULTS.morning_start,
    morning_end:        r.morning_end        || SETTINGS_DEFAULTS.morning_end,
    morning_cap:        morningCap,
    afternoon_start:    r.afternoon_start    || SETTINGS_DEFAULTS.afternoon_start,
    afternoon_end:      r.afternoon_end      || SETTINGS_DEFAULTS.afternoon_end,
    afternoon_cap:      afternoonCap,
    break_start:        r.break_start        || SETTINGS_DEFAULTS.break_start,
    break_end:          r.break_end          || SETTINGS_DEFAULTS.break_end,
    rounding_minutes:   Number(r.rounding_minutes) || SETTINGS_DEFAULTS.rounding_minutes,
  };
}

function updateSettings(updates = {}, agentId = 'default') {
  const current = getSettings(agentId);
  const merged  = { ...current, ...updates };

  if (Array.isArray(merged.operating_days)) {
    merged.operating_days = merged.operating_days.join(', ');
  }

  const maxTokens    = Number(merged.max_tokens);
  const morningCap   = Number(merged.morning_cap);
  const afternoonCap = Number(merged.afternoon_cap);

  if (morningCap + afternoonCap > maxTokens) {
    const err = `Cannot update settings: Morning cap (${morningCap}) + Afternoon cap (${afternoonCap}) = ${morningCap + afternoonCap}, which exceeds max tokens (${maxTokens}).`;
    return { success: false, error: err };
  }

  const db = getDb();
  db.prepare(`
    INSERT INTO agent_settings (
      agent_id, operating_days, booking_open_day, booking_open_time,
      booking_close_day, booking_close_time, max_tokens,
      morning_start, morning_end, morning_cap,
      afternoon_start, afternoon_end, afternoon_cap,
      break_start, break_end, rounding_minutes, updated_at
    ) VALUES (
      @agent_id, @operating_days, @booking_open_day, @booking_open_time,
      @booking_close_day, @booking_close_time, @max_tokens,
      @morning_start, @morning_end, @morning_cap,
      @afternoon_start, @afternoon_end, @afternoon_cap,
      @break_start, @break_end, @rounding_minutes, datetime('now')
    )
    ON CONFLICT(agent_id) DO UPDATE SET
      operating_days    = excluded.operating_days,
      booking_open_day  = excluded.booking_open_day,
      booking_open_time = excluded.booking_open_time,
      booking_close_day  = excluded.booking_close_day,
      booking_close_time = excluded.booking_close_time,
      max_tokens        = excluded.max_tokens,
      morning_start     = excluded.morning_start,
      morning_end       = excluded.morning_end,
      morning_cap       = excluded.morning_cap,
      afternoon_start   = excluded.afternoon_start,
      afternoon_end     = excluded.afternoon_end,
      afternoon_cap     = excluded.afternoon_cap,
      break_start       = excluded.break_start,
      break_end         = excluded.break_end,
      rounding_minutes  = excluded.rounding_minutes,
      updated_at        = excluded.updated_at
  `).run({
    agent_id:           agentId,
    operating_days:     merged.operating_days,
    booking_open_day:   merged.booking_open_day,
    booking_open_time:  merged.booking_open_time,
    booking_close_day:  merged.booking_close_day,
    booking_close_time: merged.booking_close_time,
    max_tokens:         maxTokens,
    morning_start:      merged.morning_start,
    morning_end:        merged.morning_end,
    morning_cap:        morningCap,
    afternoon_start:    merged.afternoon_start,
    afternoon_end:      merged.afternoon_end,
    afternoon_cap:      afternoonCap,
    break_start:        merged.break_start,
    break_end:          merged.break_end,
    rounding_minutes:   Number(merged.rounding_minutes) || 30,
  });

  console.log('[Store] Settings updated for agent:', agentId);
  return { success: true, settings: getSettings(agentId) };
}

// ─── Overrides ───────────────────────────────────────────────────────────────

function getOverrides(agentId = 'default') {
  const db = getDb();
  return db.prepare(`
    SELECT target_date, type, booking_opens_at, consultation_start,
           consultation_end, token_cap, created_by, created_at, notes
    FROM agent_overrides
    WHERE agent_id = ?
    ORDER BY id ASC
  `).all(agentId);
}

function addOverride(override = {}, agentId = 'default') {
  try {
    const db = getDb();
    const now       = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const createdAt = override.created_at || now;

    db.prepare(`
      INSERT INTO agent_overrides
        (agent_id, target_date, type, booking_opens_at, consultation_start,
         consultation_end, token_cap, created_by, created_at, notes)
      VALUES
        (@agent_id, @target_date, @type, @booking_opens_at, @consultation_start,
         @consultation_end, @token_cap, @created_by, @created_at, @notes)
    `).run({
      agent_id:           agentId,
      target_date:        override.target_date        || '',
      type:               override.type               || 'open_extra_day',
      booking_opens_at:   override.booking_opens_at   || null,
      consultation_start: override.consultation_start || null,
      consultation_end:   override.consultation_end   || null,
      token_cap:          override.token_cap !== undefined && override.token_cap !== null
                            ? String(override.token_cap) : null,
      created_by:         override.created_by         || 'Admin',
      created_at:         createdAt,
      notes:              override.notes              || null,
    });

    console.log(`[Store] Override added for ${override.target_date} (${override.type}) agent=${agentId}`);
    return { success: true, override: { ...override, created_at: createdAt } };
  } catch (err) {
    console.error('[Store] Failed to add override:', err.message);
    return { success: false, error: err.message };
  }
}

// ─── Bookings / Tokens ────────────────────────────────────────────────────────

function getBookingsInRange(fromDate, toDate, agentId = 'default') {
  const db = getDb();
  return db.prepare(`
    SELECT
      sunday_date   AS date,
      token_number,
      patient_name,
      patient_phone,
      arrival_time,
      COALESCE(status, 'booked')    AS status,
      COALESCE(condition, '')       AS condition,
      COALESCE(created_at, booked_at, '') AS created_at
    FROM appointments_tokens
    WHERE sunday_date >= ? AND sunday_date <= ?
    ORDER BY sunday_date ASC, token_number ASC
  `).all(fromDate, toDate);
}

// ─── Export log ──────────────────────────────────────────────────────────────

function logExport({ requestedBy, agentId = 'default', fromDate, toDate, rowCount, format = 'csv' }) {
  try {
    getDb().prepare(`
      INSERT INTO export_log (requested_by, agent_id, from_date, to_date, row_count, format)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(requestedBy, agentId, fromDate, toDate, rowCount, format);
  } catch (e) {
    console.error('[Store] Failed to log export:', e.message);
  }
}

// ─── Dashboard sessions ───────────────────────────────────────────────────────

const SESSION_IDLE_MS     = 8  * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 24 * 60 * 60 * 1000;

function createSession(username, token) {
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO dashboard_sessions (token, username, created_at, last_seen, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(token, username, now, now, now + SESSION_ABSOLUTE_MS);
}

function getSession(token) {
  if (!token) return null;
  const db  = getDb();
  const now = Date.now();
  const row = db.prepare('SELECT * FROM dashboard_sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (now > row.expires_at)                  { deleteSession(token); return null; }
  if (now > row.last_seen + SESSION_IDLE_MS) { deleteSession(token); return null; }
  db.prepare('UPDATE dashboard_sessions SET last_seen = ? WHERE token = ?').run(now, token);
  return row;
}

function deleteSession(token) {
  try { getDb().prepare('DELETE FROM dashboard_sessions WHERE token = ?').run(token); } catch (_) {}
}

function pruneExpiredSessions() {
  try {
    const now = Date.now();
    const { changes } = getDb().prepare(
      'DELETE FROM dashboard_sessions WHERE expires_at < ? OR last_seen < ?'
    ).run(now, now - SESSION_IDLE_MS);
    if (changes > 0) console.log(`[Store] Pruned ${changes} expired sessions`);
  } catch (_) {}
}

setInterval(pruneExpiredSessions, 60 * 60 * 1000).unref();

// ─── Login rate-limiting (in-process sliding window) ─────────────────────────

const _loginAttempts   = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;
const RATE_LIMIT_MAX    = 5;

function recordLoginAttempt(ip, username) {
  const now = Date.now();
  for (const key of [`ip:${ip}`, `user:${username}`]) {
    const entry = _loginAttempts.get(key) || { count: 0, windowStart: now };
    if (now - entry.windowStart > RATE_LIMIT_WINDOW) { entry.count = 0; entry.windowStart = now; }
    entry.count++;
    _loginAttempts.set(key, entry);
  }
}

function isLoginRateLimited(ip, username) {
  const now = Date.now();
  for (const key of [`ip:${ip}`, `user:${username}`]) {
    const entry = _loginAttempts.get(key);
    if (!entry) continue;
    if (now - entry.windowStart > RATE_LIMIT_WINDOW) continue;
    if (entry.count >= RATE_LIMIT_MAX) return true;
  }
  return false;
}

module.exports = {
  getDb,
  getSettings,
  updateSettings,
  getOverrides,
  addOverride,
  getBookingsInRange,
  logExport,
  createSession,
  getSession,
  deleteSession,
  pruneExpiredSessions,
  recordLoginAttempt,
  isLoginRateLimited,
};
