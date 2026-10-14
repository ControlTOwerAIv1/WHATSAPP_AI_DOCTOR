const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

// Temp DB setup before requiring modules
const tempDbPath = path.join(os.tmpdir(), `test_guards_${Date.now()}_${Math.random().toString(36).substring(7)}.sqlite`);
process.env.RELAY_DB_PATH = tempDbPath;

// Print real relay.sqlite stats before
const realDbPath = path.join(process.cwd(), 'relay.sqlite');
const beforeStat = fs.statSync(realDbPath);
console.log(`[REAL DB BEFORE] Path: ${realDbPath} | Size: ${beforeStat.size} bytes | mtime: ${beforeStat.mtime.toISOString()}`);

const store = require('../src/ai-bot/store');
const schedule = require('../src/ai-bot/schedule');
const guards = require('../src/ai-bot/guards');

let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`❌ FAIL: ${name} ->`, err.message);
  }
}

try {
  // ─── 2a. validatePatientName Tests ─────────────────────────────────────────
  console.log('\n--- 2a. validatePatientName Tests ---');

  test("'Rahim Sheikh' ok", () => {
    const res = guards.validatePatientName('Rahim Sheikh');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.name, 'Rahim Sheikh');
  });

  test("'rahim sheikh.' -> 'Rahim Sheikh'", () => {
    const res = guards.validatePatientName('rahim sheikh.');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.name, 'Rahim Sheikh');
  });

  test("'a' rejected", () => {
    const res = guards.validatePatientName('a');
    assert.strictEqual(res.ok, false);
  });

  test("'Aisha (child) and Zaid (parent)' rejected", () => {
    const res = guards.validatePatientName('Aisha (child) and Zaid (parent)');
    assert.strictEqual(res.ok, false);
  });

  test("'Imran 123' rejected", () => {
    const res = guards.validatePatientName('Imran 123');
    assert.strictEqual(res.ok, false);
  });

  test("'सना अली' ok", () => {
    const res = guards.validatePatientName('सना अली');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.name, 'सना अली');
  });

  test("a 6-word name rejected", () => {
    const res = guards.validatePatientName('Mohammad Ali Khan Bahadur Shah Zafar');
    assert.strictEqual(res.ok, false);
  });

  // ─── 2b. isRepeat Tests ───────────────────────────────────────────────────
  console.log('\n--- 2b. isRepeat Tests ---');

  test("isRepeat true for identical text", () => {
    const last3 = [
      'To reserve your token, may I please have your full name?',
      'Appointments for the coming Sunday will open at 8:00 AM on Sunday.',
      'Token reserve karne ke liye, kripya apna pura naam batayein.',
    ];
    assert.strictEqual(guards.isRepeat('Token reserve karne ke liye, kripya apna pura naam batayein.', last3), true);
  });

  test("isRepeat true for text differing only in punctuation", () => {
    const last3 = [
      'Token reserve karne ke liye, kripya apna pura naam batayein.',
    ];
    assert.strictEqual(guards.isRepeat('Token reserve karne ke liye kripya apna pura naam batayein!', last3), true);
  });

  test("isRepeat false for two different sentences", () => {
    const last3 = [
      'Token reserve karne ke liye, kripya apna pura naam batayein.',
      'Date: 18th October, Name: Rahim Sheikh, Token: #1',
    ];
    assert.strictEqual(guards.isRepeat('What should I bring for consultation?', last3), false);
  });

  // ─── 2c. correctTokenName Tests ───────────────────────────────────────────
  console.log('\n--- 2c. correctTokenName Tests ---');

  test("correctTokenName on temp DB", async () => {
    const db = store.getDb();
    const targetDate = '2026-10-18';
    const phone1 = '919800000001';
    const phone2 = '919800000002';

    // Seed test settings
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

    // Allocate token for Phone 1
    const alloc1 = await schedule.allocateToken({
      phone: phone1,
      name: 'Rahim Sheikh',
      slotPreference: 'morning',
      currentTime: new Date('2026-10-18T08:15:00+05:30'),
      targetDate,
    });
    assert.strictEqual(alloc1.success, true, 'Phone 1 allocation failed');

    // Allocate token for Phone 2
    const alloc2 = await schedule.allocateToken({
      phone: phone2,
      name: 'Imran Qureshi',
      slotPreference: 'morning',
      currentTime: new Date('2026-10-18T08:16:00+05:30'),
      targetDate,
    });
    assert.strictEqual(alloc2.success, true, 'Phone 2 allocation failed');

    // Correct name for Phone 1
    const correctRes = guards.correctTokenName(phone1, targetDate, 'rahim sheikh shaikh.');
    assert.strictEqual(correctRes.success, true, 'Correction failed');
    assert.strictEqual(correctRes.token.patient_name, 'Rahim Sheikh Shaikh');

    // Verify DB state for Phone 1
    const p1Token = schedule.getTokenByPhone(phone1, targetDate);
    assert.strictEqual(p1Token.patient_name, 'Rahim Sheikh Shaikh');

    // Verify audit row was created
    const auditRow = db.prepare('SELECT * FROM name_audit WHERE phone = ? AND target_date = ?').get(phone1, targetDate);
    assert(auditRow, 'name_audit row missing');
    assert.strictEqual(auditRow.old_name, 'Rahim Sheikh');
    assert.strictEqual(auditRow.new_name, 'Rahim Sheikh Shaikh');
    console.log('   name_audit verified:', auditRow);

    // Verify Phone 2 is completely unaffected
    const p2Token = schedule.getTokenByPhone(phone2, targetDate);
    assert.strictEqual(p2Token.patient_name, 'Imran Qureshi');
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

if (failed > 0) {
  console.error(`\n❌ Total failures: ${failed}`);
  process.exit(1);
} else {
  console.log('\n🎉 ALL GUARDS TESTS PASSED!');
  process.exit(0);
}
