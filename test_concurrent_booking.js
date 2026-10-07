/**
 * test_concurrent_booking.js
 *
 * Stress-tests the atomic booking mechanism by firing 5 allocateToken() calls
 * at the exact same moment (Promise.all) and verifying that:
 *
 *   1. Each call gets a UNIQUE token number — no two patients share a slot.
 *   2. No token number exceeds max_tokens.
 *   3. All 5 succeed (assuming capacity >= 5).
 *   4. A duplicate phone number gets isDuplicate=true, not a second token.
 *   5. When capacity is capped and 5 patients race, the overflow get proper rejection.
 *
 * Run: node test_concurrent_booking.js
 */

'use strict';

require('dotenv').config();

const { allocateToken, getTokensForSunday, resetTokensForTesting, getEffectiveSchedule } = require('./src/ai-bot/schedule');
const store = require('./src/ai-bot/store');

// ── helpers ──────────────────────────────────────────────────────────────────

const GREEN  = s => `\x1b[32m${s}\x1b[0m`;
const RED    = s => `\x1b[31m${s}\x1b[0m`;
const YELLOW = s => `\x1b[33m${s}\x1b[0m`;
const BOLD   = s => `\x1b[1m${s}\x1b[0m`;
const DIM    = s => `\x1b[2m${s}\x1b[0m`;

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ${GREEN('✔')} ${label}`);
    passed++;
  } else {
    console.log(`  ${RED('✘')} ${label}${detail ? ' — ' + RED(detail) : ''}`);
    failed++;
  }
}

// Use a far-future Sunday date so tests never collide with live data
const TEST_DATE = '2099-03-01'; // a Sunday

// ── Test Suite ────────────────────────────────────────────────────────────────

async function runAll() {
  console.log(BOLD('\n══════════════════════════════════════════════════════'));
  console.log(BOLD('  Concurrent Booking Test  —  allocateToken()'));
  console.log(BOLD('══════════════════════════════════════════════════════\n'));

  // Ensure DB is initialised before we start
  store.getDb();

  // ────────────────────────────────────────────────────────────────────────────
  await test1_FiveUniqueTokens();
  await test2_DuplicatePhone();
  await test3_CapacityExceeded();
  await test4_MixedSlotPreference();
  await test5_TenRacers();
  // ────────────────────────────────────────────────────────────────────────────

  console.log(BOLD('\n══════════════════════════════════════════════════════'));
  console.log(`  Result: ${GREEN(passed + ' passed')}  ${failed ? RED(failed + ' failed') : DIM('0 failed')}`);
  console.log(BOLD('══════════════════════════════════════════════════════\n'));

  if (failed > 0) process.exit(1);
}

// ─── Test 1: 5 distinct patients race simultaneously ─────────────────────────
async function test1_FiveUniqueTokens() {
  console.log(BOLD('Test 1: 5 patients book at exactly the same moment'));
  resetTokensForTesting(TEST_DATE);

  const patients = [
    { phone: '9100000001', name: 'Alice',   slot: 'morning'   },
    { phone: '9100000002', name: 'Bob',     slot: 'morning'   },
    { phone: '9100000003', name: 'Charlie', slot: 'morning'   },
    { phone: '9100000004', name: 'Deepa',   slot: 'afternoon' },
    { phone: '9100000005', name: 'Elias',   slot: 'afternoon' },
  ];

  const t0 = Date.now();
  const results = await Promise.all(
    patients.map(p =>
      allocateToken({ phone: p.phone, name: p.name, slotPreference: p.slot, targetDate: TEST_DATE })
    )
  );
  const elapsed = Date.now() - t0;
  console.log(DIM(`  → All 5 completed in ${elapsed}ms`));

  const successes = results.filter(r => r.success && !r.isDuplicate);
  const tokenNums = successes.map(r => r.token.token_number);
  const uniqueTokenNums = new Set(tokenNums);

  assert(successes.length === 5,           'All 5 bookings succeeded',
    `only ${successes.length}/5 succeeded`);
  assert(uniqueTokenNums.size === 5,       'All 5 token numbers are unique',
    `got ${tokenNums.join(', ')}`);

  const config = await getEffectiveSchedule(TEST_DATE);
  assert(Math.max(...tokenNums) <= config.max_tokens, `No token exceeds max_tokens (${config.max_tokens})`);

  const tokens = getTokensForSunday(TEST_DATE);
  _printTokenTable(tokens);
}

// ─── Test 2: Same phone number races 3 times ─────────────────────────────────
async function test2_DuplicatePhone() {
  console.log(BOLD('\nTest 2: Same phone sends 3 concurrent booking requests'));
  resetTokensForTesting(TEST_DATE);

  const DUPE_PHONE = '9100000099';
  const requests = Array.from({ length: 3 }, (_, i) =>
    allocateToken({ phone: DUPE_PHONE, name: `Patient-${i}`, slotPreference: 'morning', targetDate: TEST_DATE })
  );

  const t0 = Date.now();
  const results = await Promise.all(requests);
  const elapsed = Date.now() - t0;
  console.log(DIM(`  → 3 concurrent requests for same phone in ${elapsed}ms`));

  const realBookings  = results.filter(r => r.success && !r.isDuplicate);
  const dupeResponses = results.filter(r => r.success &&  r.isDuplicate);

  assert(realBookings.length  === 1, 'Exactly 1 real booking created',
    `got ${realBookings.length}`);
  assert(dupeResponses.length === 2, '2 duplicate responses (isDuplicate=true)',
    `got ${dupeResponses.length}`);

  const tokens = getTokensForSunday(TEST_DATE);
  assert(tokens.length === 1, 'Only 1 token row in DB for this phone',
    `found ${tokens.length}`);
}

// ─── Test 3: Capacity hard limit with over-subscription ──────────────────────
async function test3_CapacityExceeded() {
  console.log(BOLD('\nTest 3: 5 patients race for 3 remaining morning slots (all afternoon full)'));
  resetTokensForTesting(TEST_DATE);

  // Read actual config so pre-fill is always correct regardless of DB settings
  const config = await getEffectiveSchedule(TEST_DATE);
  const morningCap   = config.slots.morning.token_cap;
  const afternoonCap = config.slots.afternoon.token_cap;
  const preFillMorning = morningCap - 3; // leave exactly 3 morning slots free

  console.log(DIM(`  Config: morning_cap=${morningCap}, afternoon_cap=${afternoonCap}, max_tokens=${config.max_tokens}`));
  console.log(DIM(`  Pre-filling ${preFillMorning} morning + all ${afternoonCap} afternoon`));

  const db  = store.getDb();
  const sql = "INSERT INTO appointments_tokens (sunday_date, token_number, slot_name, token_in_slot, patient_phone, patient_name, arrival_time, condition, booked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))";
  const stmt = db.prepare(sql);

  for (let i = 1; i <= preFillMorning; i++) {
    stmt.run(TEST_DATE, i, 'morning', i, '70000' + String(i).padStart(5, '0'), 'PreM' + i, '11:00 AM', '');
  }
  for (let i = 1; i <= afternoonCap; i++) {
    stmt.run(TEST_DATE, morningCap + i, 'afternoon', i, '80000' + String(i).padStart(5, '0'), 'PreA' + i, '2:30 PM', '');
  }
  console.log(DIM(`  Pre-fill total: ${preFillMorning + afternoonCap} rows — 3 morning free, afternoon full`));

  let results;
  const t0 = Date.now();
  try {
    results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        allocateToken({ phone: '9200000' + String(i + 1).padStart(3, '0'), name: 'Racer-' + (i + 1), slotPreference: 'morning', targetDate: TEST_DATE })
      )
    );
  } catch (err) {
    console.log(`  ${RED('✘')} Unexpected crash: ${err.message}`);
    failed++;
    return;
  }
  const elapsed = Date.now() - t0;
  console.log(DIM(`  → 5 racers for 3 remaining morning slots in ${elapsed}ms`));

  const succeeded = results.filter(r => r.success && !r.isDuplicate);
  const allFull   = results.filter(r => r.reason === 'all_full');
  const slotFull  = results.filter(r => r.reason === 'morning_full');
  console.log(DIM(`     succeeded=${succeeded.length}  allFull=${allFull.length}  slotFull=${slotFull.length}`));

  assert(succeeded.length === 3, 'Exactly 3 bookings succeeded (3 morning slots free)',
    `got ${succeeded.length}`);
  assert(allFull.length === 2, '2 rejections with reason=all_full (afternoon also full)',
    `got allFull=${allFull.length} slotFull=${slotFull.length}`);

  const allTokens = getTokensForSunday(TEST_DATE);
  const morningBooked = allTokens.filter(t => t.slot_name === 'morning');
  assert(morningBooked.length === morningCap, `Morning slot exactly at cap (${morningCap})`,
    `found ${morningBooked.length}`);
}

// ─── Test 4: Mixed slot preferences ──────────────────────────────────────────
async function test4_MixedSlotPreference() {
  console.log(BOLD('\nTest 4: Mixed morning/afternoon preferences — tokens land in correct slots'));
  resetTokensForTesting(TEST_DATE);

  const patients = [
    { phone: '9300000001', name: 'AM-1', slot: 'morning'   },
    { phone: '9300000002', name: 'PM-1', slot: 'afternoon' },
    { phone: '9300000003', name: 'AM-2', slot: 'morning'   },
    { phone: '9300000004', name: 'PM-2', slot: 'afternoon' },
    { phone: '9300000005', name: 'AM-3', slot: 'morning'   },
  ];

  await Promise.all(
    patients.map(p =>
      allocateToken({ phone: p.phone, name: p.name, slotPreference: p.slot, targetDate: TEST_DATE })
    )
  );

  const tokens = getTokensForSunday(TEST_DATE);
  const morningBooked   = tokens.filter(t => t.slot_name === 'morning');
  const afternoonBooked = tokens.filter(t => t.slot_name === 'afternoon');

  assert(morningBooked.length   === 3, '3 tokens in morning slot',   `got ${morningBooked.length}`);
  assert(afternoonBooked.length === 2, '2 tokens in afternoon slot', `got ${afternoonBooked.length}`);

  const tokenNums  = tokens.map(t => t.token_number);
  const uniqueNums = new Set(tokenNums);
  assert(uniqueNums.size === 5, 'All 5 token numbers are unique across slots',
    `got [${tokenNums.join(', ')}]`);

  _printTokenTable(tokens);
}

// ─── Test 5: 10 simultaneous racers ──────────────────────────────────────────
async function test5_TenRacers() {
  console.log(BOLD('\nTest 5: 10 patients race at once (stress test)'));
  resetTokensForTesting(TEST_DATE);

  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      allocateToken({
        phone: '9400000' + String(i + 1).padStart(3, '0'),
        name: 'Stress-' + (i + 1),
        slotPreference: i % 2 === 0 ? 'morning' : 'afternoon',
        targetDate: TEST_DATE,
      })
    )
  );
  const elapsed = Date.now() - t0;
  console.log(DIM(`  → 10 racers completed in ${elapsed}ms`));

  const successes  = results.filter(r => r.success && !r.isDuplicate);
  const tokenNums  = successes.map(r => r.token.token_number);
  const uniqueNums = new Set(tokenNums);

  assert(successes.length === 10, 'All 10 bookings succeeded (plenty of capacity)',
    `only ${successes.length}/10 succeeded`);
  assert(uniqueNums.size === 10, 'All 10 token numbers are unique',
    `duplicates found in [${tokenNums.join(', ')}]`);

  const tokens = getTokensForSunday(TEST_DATE);
  const dbTokenNums = new Set(tokens.map(t => t.token_number));
  assert(dbTokenNums.size === 10, 'DB has exactly 10 distinct token rows',
    `DB has ${tokens.length} rows`);

  _printTokenTable(tokens);

  // Clean up test data
  resetTokensForTesting(TEST_DATE);
  console.log(DIM('  → Test data cleaned up'));
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function _printTokenTable(tokens) {
  if (!tokens.length) { console.log(DIM('  (no tokens)')); return; }
  console.log(DIM('  ┌────┬───────────┬────────────┬────────────────────────┬───────────┐'));
  console.log(DIM('  │ #  │ Slot      │ Phone      │ Name                   │ Arrival   │'));
  console.log(DIM('  ├────┼───────────┼────────────┼────────────────────────┼───────────┤'));
  for (const t of tokens) {
    const num   = String(t.token_number).padEnd(2);
    const slot  = (t.slot_name || '').padEnd(9);
    const phone = (t.patient_phone || '').padEnd(10);
    const name  = (t.patient_name || '').substring(0, 22).padEnd(22);
    const arr   = (t.arrival_time || '').padEnd(9);
    console.log(DIM(`  │ ${num} │ ${slot} │ ${phone} │ ${name} │ ${arr} │`));
  }
  console.log(DIM('  └────┴───────────┴────────────┴────────────────────────┴───────────┘'));
}

// ─── Run ──────────────────────────────────────────────────────────────────────
runAll().catch(err => {
  console.error(RED('\n❌ Unexpected error: ' + err.message));
  console.error(err.stack);
  process.exit(1);
});
