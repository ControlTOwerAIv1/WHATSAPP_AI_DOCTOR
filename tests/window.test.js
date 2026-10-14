const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

// 1. Point to temp DB at the very top before requiring any project modules
const tempDbPath = path.join(os.tmpdir(), `test_relay_${Date.now()}_${Math.random().toString(36).substring(7)}.sqlite`);
process.env.RELAY_DB_PATH = tempDbPath;

// Record real relay.sqlite size + mtime before run
const realDbPath = path.join(process.cwd(), 'relay.sqlite');
const beforeStat = fs.statSync(realDbPath);
console.log(`[REAL DB BEFORE] Path: ${realDbPath} | Size: ${beforeStat.size} bytes | mtime: ${beforeStat.mtime.toISOString()}`);

// Now require project modules
const store = require('../src/ai-bot/store');
const schedule = require('../src/ai-bot/schedule');

let failedCount = 0;
const results = [];

function check(desc, actual, expected) {
  let passed = true;
  for (const [k, v] of Object.entries(expected)) {
    if (actual[k] !== v) {
      passed = false;
      break;
    }
  }
  results.push({ desc, passed, actual, expected });
  if (!passed) {
    failedCount++;
    console.error(`❌ FAIL: ${desc}`);
    console.error('   Expected:', expected);
    console.error('   Actual:  ', actual);
  } else {
    console.log(`✅ PASS: ${desc}`);
  }
}

try {
  // ─── Settings A (production-like) ──────────────────────────────────────────
  console.log('\n--- Testing Settings A ---');
  store.updateSettings({
    operating_days: 'Sunday',
    booking_open_day: 'Sunday',
    booking_open_time: '08:00',
    booking_close_day: 'Sunday',
    booking_close_time: '09:00',
    max_tokens: 50,
    morning_cap: 20,
    afternoon_cap: 30,
  });
  schedule.invalidateCache();
  store.getDb().prepare('DELETE FROM agent_overrides').run();

  // Sun 2026-10-18 00:30 -> closed, target 2026-10-18, clinic_day_today true, opens_in_minutes 450, 'today at 8:00 AM'
  let res = schedule.describeBookingWindow(new Date('2026-10-18T00:30:00+05:30'));
  check('Sun 2026-10-18 00:30 (Settings A)', res, {
    state: 'closed',
    target_date: '2026-10-18',
    clinic_day_today: true,
    opens_in_minutes: 450,
    next_open_text: 'today at 8:00 AM',
    closes_at_text: null,
  });

  // Sun 07:30 -> closed, 30, 'in about 30 minutes (8:00 AM today)'
  res = schedule.describeBookingWindow(new Date('2026-10-18T07:30:00+05:30'));
  check('Sun 07:30 (Settings A)', res, {
    state: 'closed',
    target_date: '2026-10-18',
    clinic_day_today: true,
    opens_in_minutes: 30,
    next_open_text: 'in about 30 minutes (8:00 AM today)',
    closes_at_text: null,
  });

  // Sun 07:53 -> closed, 7
  res = schedule.describeBookingWindow(new Date('2026-10-18T07:53:00+05:30'));
  check('Sun 07:53 (Settings A)', res, {
    state: 'closed',
    target_date: '2026-10-18',
    clinic_day_today: true,
    opens_in_minutes: 7,
    next_open_text: 'in about 7 minutes (8:00 AM today)',
    closes_at_text: null,
  });

  // Sun 08:00 -> open, closes_at_text '9:00 AM today'
  res = schedule.describeBookingWindow(new Date('2026-10-18T08:00:00+05:30'));
  check('Sun 08:00 (Settings A)', res, {
    state: 'open',
    target_date: '2026-10-18',
    clinic_day_today: true,
    opens_in_minutes: null,
    next_open_text: null,
    closes_at_text: '9:00 AM today',
  });

  // Sun 08:59 -> open
  res = schedule.describeBookingWindow(new Date('2026-10-18T08:59:00+05:30'));
  check('Sun 08:59 (Settings A)', res, {
    state: 'open',
    target_date: '2026-10-18',
    clinic_day_today: true,
    opens_in_minutes: null,
    next_open_text: null,
    closes_at_text: '9:00 AM today',
  });

  // Sun 09:01 -> closed, target 2026-10-25, clinic_day_today true, 'Sunday, 25 October at 8:00 AM'
  res = schedule.describeBookingWindow(new Date('2026-10-18T09:01:00+05:30'));
  check('Sun 09:01 (Settings A)', res, {
    state: 'closed',
    target_date: '2026-10-25',
    clinic_day_today: true,
    next_open_text: 'Sunday, 25 October at 8:00 AM',
    closes_at_text: null,
  });

  // Wed 2026-10-21 12:00 -> closed, target 2026-10-25, clinic_day_today false
  res = schedule.describeBookingWindow(new Date('2026-10-21T12:00:00+05:30'));
  check('Wed 2026-10-21 12:00 (Settings A)', res, {
    state: 'closed',
    target_date: '2026-10-25',
    clinic_day_today: false,
    next_open_text: 'Sunday, 25 October at 8:00 AM',
    closes_at_text: null,
  });

  // Sat 2026-10-24 23:30 -> closed, 'tomorrow at 8:00 AM', target 2026-10-25
  res = schedule.describeBookingWindow(new Date('2026-10-24T23:30:00+05:30'));
  check('Sat 2026-10-24 23:30 (Settings A)', res, {
    state: 'closed',
    target_date: '2026-10-25',
    clinic_day_today: false,
    next_open_text: 'tomorrow at 8:00 AM',
    closes_at_text: null,
  });

  // ─── Settings B (cross-day) ────────────────────────────────────────────────
  console.log('\n--- Testing Settings B ---');
  store.updateSettings({
    operating_days: 'Sunday',
    booking_open_day: 'Saturday',
    booking_open_time: '21:00',
    booking_close_day: 'Sunday',
    booking_close_time: '18:00',
  });
  schedule.invalidateCache();
  store.getDb().prepare('DELETE FROM agent_overrides').run();

  // Sat 2026-10-24 20:30 -> closed, 'in about 30 minutes (9:00 PM today)', target 2026-10-25
  res = schedule.describeBookingWindow(new Date('2026-10-24T20:30:00+05:30'));
  check('Sat 2026-10-24 20:30 (Settings B)', res, {
    state: 'closed',
    target_date: '2026-10-25',
    clinic_day_today: false,
    opens_in_minutes: 30,
    next_open_text: 'in about 30 minutes (9:00 PM today)',
    closes_at_text: null,
  });

  // Sat 21:30 -> open, target 2026-10-25, closes_at_text '6:00 PM tomorrow'
  res = schedule.describeBookingWindow(new Date('2026-10-24T21:30:00+05:30'));
  check('Sat 21:30 (Settings B)', res, {
    state: 'open',
    target_date: '2026-10-25',
    clinic_day_today: false,
    opens_in_minutes: null,
    next_open_text: null,
    closes_at_text: '6:00 PM tomorrow',
  });

  // ─── Overrides ─────────────────────────────────────────────────────────────
  console.log('\n--- Testing Overrides ---');
  // Back to Settings A
  store.updateSettings({
    operating_days: 'Sunday',
    booking_open_day: 'Sunday',
    booking_open_time: '08:00',
    booking_close_day: 'Sunday',
    booking_close_time: '09:00',
  });
  schedule.invalidateCache();

  // Override 1: closed override on 2026-10-25
  store.getDb().prepare('DELETE FROM agent_overrides').run();
  store.addOverride({
    target_date: '2026-10-25',
    type: 'closed',
    notes: 'Closed for testing',
  });
  schedule.invalidateCache();

  // Wed 2026-10-21 12:00 -> target 2026-11-01
  res = schedule.describeBookingWindow(new Date('2026-10-21T12:00:00+05:30'));
  check('Wed 2026-10-21 12:00 with 2026-10-25 Closed', res, {
    state: 'closed',
    target_date: '2026-11-01',
    clinic_day_today: false,
    next_open_text: 'Sunday, 1 November at 8:00 AM',
    closes_at_text: null,
  });

  // Override 2: open_extra_day on 2026-10-28 (Wednesday) with tokens opening Tuesday 2026-10-27 21:00
  store.getDb().prepare('DELETE FROM agent_overrides').run();
  store.addOverride({
    target_date: '2026-10-28',
    type: 'open_extra_day',
    booking_opens_at: 'Tuesday 21:00',
    consultation_start: '11:00',
    consultation_end: '18:30',
    token_cap: 45,
    notes: 'Special Wednesday clinic',
  });
  schedule.invalidateCache();

  // Tue 20:30 -> closed, 'in about 30 minutes (9:00 PM today)', target 2026-10-28
  res = schedule.describeBookingWindow(new Date('2026-10-27T20:30:00+05:30'));
  check('Tue 20:30 (Extra Day)', res, {
    state: 'closed',
    target_date: '2026-10-28',
    clinic_day_today: false,
    opens_in_minutes: 30,
    next_open_text: 'in about 30 minutes (9:00 PM today)',
    closes_at_text: null,
  });

  // Tue 21:30 -> open, target 2026-10-28
  res = schedule.describeBookingWindow(new Date('2026-10-27T21:30:00+05:30'));
  check('Tue 21:30 (Extra Day)', res, {
    state: 'open',
    target_date: '2026-10-28',
    clinic_day_today: false,
    opens_in_minutes: null,
    next_open_text: null,
  });

} finally {
  // Check real DB size + mtime after run
  const afterStat = fs.statSync(realDbPath);
  console.log(`\n[REAL DB AFTER]  Path: ${realDbPath} | Size: ${afterStat.size} bytes | mtime: ${afterStat.mtime.toISOString()}`);
  assert.strictEqual(afterStat.size, beforeStat.size, 'Real relay.sqlite size must NOT change');
  assert.strictEqual(afterStat.mtime.getTime(), beforeStat.mtime.getTime(), 'Real relay.sqlite mtime must NOT change');
  console.log('✅ Real DB verified untouched (size and mtime match exactly).');

  // Clean up temp DB
  try {
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(tempDbPath + '-wal')) fs.unlinkSync(tempDbPath + '-wal');
    if (fs.existsSync(tempDbPath + '-shm')) fs.unlinkSync(tempDbPath + '-shm');
  } catch (e) {}
}

if (failedCount > 0) {
  console.error(`\n❌ Total failures: ${failedCount}`);
  process.exit(1);
} else {
  console.log('\n🎉 ALL WINDOW TESTS PASSED (14/14)!');
  process.exit(0);
}
