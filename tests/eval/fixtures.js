/**
 * Independent Evaluation Harness — Fixtures
 * Creates and manages isolated template databases for fixtures (OPEN, PROD, TINY, OVR, OVRC)
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const FIXTURES_DIR = path.join(__dirname, '.fixtures');

function ensureFixturesDir() {
  if (!fs.existsSync(FIXTURES_DIR)) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  }
}

function initTemplateDb(dbPath, setupFn) {
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Run schema creation matching store.js
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
      status         TEXT NOT NULL DEFAULT 'booked',
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      agent_id       TEXT NOT NULL DEFAULT 'default',
      PRIMARY KEY (sunday_date, token_number)
    );
    CREATE INDEX IF NOT EXISTS idx_tokens_phone
      ON appointments_tokens(patient_phone, sunday_date);

    CREATE TABLE IF NOT EXISTS name_audit (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      phone       TEXT NOT NULL,
      target_date TEXT NOT NULL,
      old_name    TEXT NOT NULL,
      new_name    TEXT NOT NULL,
      changed_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS voice_transcripts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id  TEXT,
      phone       TEXT,
      duration_s  REAL,
      transcript  TEXT,
      created_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_last4 TEXT NOT NULL,
      action      TEXT NOT NULL,
      result      TEXT NOT NULL,
      ms          INTEGER NOT NULL,
      created_at  TEXT NOT NULL
    );
  `);

  if (setupFn) {
    setupFn(db);
  }

  db.close();
}

function buildAllTemplates() {
  ensureFixturesDir();

  // 1. OPEN: Sunday clinic; window Sunday 08:00-18:00; max_tokens 45; morning 17; afternoon 28.
  initTemplateDb(path.join(FIXTURES_DIR, 'OPEN.sqlite'), (db) => {
    db.prepare(`
      INSERT OR REPLACE INTO agent_settings (
        agent_id, operating_days, booking_open_day, booking_open_time,
        booking_close_day, booking_close_time, max_tokens,
        morning_start, morning_end, morning_cap,
        afternoon_start, afternoon_end, afternoon_cap,
        break_start, break_end, rounding_minutes, updated_at
      ) VALUES (
        'default', 'Sunday', 'Sunday', '08:00',
        'Sunday', '18:00', 45,
        '11:00', '13:30', 17,
        '14:30', '18:30', 28,
        '13:30', '14:30', 30, '2026-10-18 00:00:00'
      )
    `).run();
  });

  // 2. PROD: like OPEN but window Sunday 08:00-09:00, max_tokens 50 (20/30).
  initTemplateDb(path.join(FIXTURES_DIR, 'PROD.sqlite'), (db) => {
    db.prepare(`
      INSERT OR REPLACE INTO agent_settings (
        agent_id, operating_days, booking_open_day, booking_open_time,
        booking_close_day, booking_close_time, max_tokens,
        morning_start, morning_end, morning_cap,
        afternoon_start, afternoon_end, afternoon_cap,
        break_start, break_end, rounding_minutes, updated_at
      ) VALUES (
        'default', 'Sunday', 'Sunday', '08:00',
        'Sunday', '09:00', 50,
        '11:00', '13:30', 20,
        '14:30', '18:30', 30,
        '13:30', '14:30', 30, '2026-10-18 00:00:00'
      )
    `).run();
  });

  // 3. TINY: OPEN with max_tokens 2 (1/1) and 2 tokens already seeded for 2026-10-18.
  initTemplateDb(path.join(FIXTURES_DIR, 'TINY.sqlite'), (db) => {
    db.prepare(`
      INSERT OR REPLACE INTO agent_settings (
        agent_id, operating_days, booking_open_day, booking_open_time,
        booking_close_day, booking_close_time, max_tokens,
        morning_start, morning_end, morning_cap,
        afternoon_start, afternoon_end, afternoon_cap,
        break_start, break_end, rounding_minutes, updated_at
      ) VALUES (
        'default', 'Sunday', 'Sunday', '08:00',
        'Sunday', '18:00', 2,
        '11:00', '13:30', 1,
        '14:30', '18:30', 1,
        '13:30', '14:30', 30, '2026-10-18 00:00:00'
      )
    `).run();

    // 2 seeded tokens
    db.prepare(`
      INSERT INTO appointments_tokens (
        sunday_date, token_number, slot_name, token_in_slot,
        patient_phone, patient_name, arrival_time, booked_at, status, agent_id
      ) VALUES
      ('2026-10-18', 1, 'morning', 1, '919800099991', 'Preseeded One', '11:00 AM', '2026-10-18 08:00:00', 'booked', 'default'),
      ('2026-10-18', 2, 'afternoon', 1, '919800099992', 'Preseeded Two', '02:30 PM', '2026-10-18 08:00:00', 'booked', 'default')
    `).run();
  });

  // 4. OVR: PROD + open_extra_day override on 2026-10-28 (Wednesday), tokens opening Tuesday 2026-10-27 21:00
  initTemplateDb(path.join(FIXTURES_DIR, 'OVR.sqlite'), (db) => {
    db.prepare(`
      INSERT OR REPLACE INTO agent_settings (
        agent_id, operating_days, booking_open_day, booking_open_time,
        booking_close_day, booking_close_time, max_tokens,
        morning_start, morning_end, morning_cap,
        afternoon_start, afternoon_end, afternoon_cap,
        break_start, break_end, rounding_minutes, updated_at
      ) VALUES (
        'default', 'Sunday', 'Sunday', '08:00',
        'Sunday', '09:00', 50,
        '11:00', '13:30', 20,
        '14:30', '18:30', 30,
        '13:30', '14:30', 30, '2026-10-18 00:00:00'
      )
    `).run();

    db.prepare(`
      INSERT INTO agent_overrides (
        agent_id, target_date, type, booking_opens_at, consultation_start, consultation_end, token_cap, created_by, created_at, notes
      ) VALUES (
        'default', '2026-10-28', 'open_extra_day', '2026-10-27 21:00', '11:00', '18:30', '45', 'Admin', '2026-10-14 00:00:00', 'Admin extra day'
      )
    `).run();
  });

  // 5. OVRC: PROD + closed override on 2026-10-25.
  initTemplateDb(path.join(FIXTURES_DIR, 'OVRC.sqlite'), (db) => {
    db.prepare(`
      INSERT OR REPLACE INTO agent_settings (
        agent_id, operating_days, booking_open_day, booking_open_time,
        booking_close_day, booking_close_time, max_tokens,
        morning_start, morning_end, morning_cap,
        afternoon_start, afternoon_end, afternoon_cap,
        break_start, break_end, rounding_minutes, updated_at
      ) VALUES (
        'default', 'Sunday', 'Sunday', '08:00',
        'Sunday', '09:00', 50,
        '11:00', '13:30', 20,
        '14:30', '18:30', 30,
        '13:30', '14:30', 30, '2026-10-18 00:00:00'
      )
    `).run();

    db.prepare(`
      INSERT INTO agent_overrides (
        agent_id, target_date, type, booking_opens_at, consultation_start, consultation_end, token_cap, created_by, created_at, notes
      ) VALUES (
        'default', '2026-10-25', 'closed', '', '', '', '0', 'Admin', '2026-10-14 00:00:00', 'Admin closed'
      )
    `).run();
  });
}

/**
 * Create a fresh temporary copy of a fixture DB for a single run
 */
function createRunDatabase(fixtureName, seedOthers, runKey) {
  ensureFixturesDir();
  const templatePath = path.join(FIXTURES_DIR, `${fixtureName || 'OPEN'}.sqlite`);
  if (!fs.existsSync(templatePath)) {
    buildAllTemplates();
  }

  const runDbPath = path.join(FIXTURES_DIR, `run_${runKey}_${Date.now()}.sqlite`);
  fs.copyFileSync(templatePath, runDbPath);

  if (seedOthers) {
    const db = new Database(runDbPath);
    db.prepare(`
      INSERT INTO appointments_tokens (
        sunday_date, token_number, slot_name, token_in_slot,
        patient_phone, patient_name, arrival_time, booked_at, status, agent_id
      ) VALUES
      ('2026-10-18', 1, 'morning', 1, '919800000101', 'Gita Pillai', '11:00 AM', '2026-10-18 08:00:00', 'booked', 'default'),
      ('2026-10-18', 2, 'morning', 2, '919800000102', 'Harsh Vora', '11:00 AM', '2026-10-18 08:00:00', 'booked', 'default'),
      ('2026-10-18', 3, 'morning', 3, '919800000103', 'Ishaan Nene', '11:30 AM', '2026-10-18 08:00:00', 'booked', 'default')
    `).run();
    db.close();
  }

  return runDbPath;
}

module.exports = {
  buildAllTemplates,
  createRunDatabase,
  FIXTURES_DIR
};
