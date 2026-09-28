/**
 * STEP 1: Concurrency Verification Test
 * Fire 10 concurrent simulated booking requests for the same date and confirm
 * all 10 get distinct sequential token numbers with zero duplicates.
 */

require('dotenv').config();
const assert = require('assert');
const schedule = require('./src/ai-bot/schedule');
const botConfig = require('./src/ai-bot/config');

async function testStep1Concurrency() {
  console.log('================================================================');
  console.log('STEP 1: TOKEN ALLOCATION CONCURRENCY & RACE CONDITION TEST');
  console.log('================================================================\n');

  botConfig.init(process.cwd());

  const testDate = '2026-09-20'; // A Sunday in the future
  schedule.resetTokensForTesting(testDate);

  // Warm schedule cache so 10 concurrent calls test pure token allocation concurrency
  await schedule.getEffectiveSchedule(testDate);

  console.log(`Target date: ${testDate}`);
  console.log('Firing 10 concurrent allocateToken calls simultaneously...\n');

  const concurrentRequests = [];
  for (let i = 1; i <= 10; i++) {
    const phone = `9198765430${String(i).padStart(2, '0')}`;
    const name = `TestPatient_${i}`;
    concurrentRequests.push(
      schedule.allocateToken({
        phone,
        name,
        slotPreference: 'morning',
        condition: `Condition for patient ${i}`,
        targetDate: testDate,
      })
    );
  }

  const results = await Promise.all(concurrentRequests);

  const tokens = [];
  const tokenNumbers = new Set();

  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    assert.strictEqual(res.success, true, `Request ${i + 1} must succeed`);
    assert(res.token, `Request ${i + 1} must return a token object`);
    
    const num = res.token.token_number;
    console.log(`Patient ${i + 1} (${res.token.patient_name}, phone: ${res.token.patient_phone}) => Token #${num}, Slot token: #${res.token.token_in_slot}, Arrival: ${res.token.arrival_time}`);
    
    assert(!tokenNumbers.has(num), `DUPLICATE TOKEN NUMBER DETECTED: #${num}`);
    tokenNumbers.add(num);
    tokens.push(res.token);
  }

  // Verify sequential ordering 1..10
  const sortedNumbers = Array.from(tokenNumbers).sort((a, b) => a - b);
  console.log('\nAllocated token numbers:', sortedNumbers);
  assert.strictEqual(sortedNumbers.length, 10, 'Must have exactly 10 distinct token numbers');
  assert.deepStrictEqual(sortedNumbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'Token numbers must be strictly sequential 1 through 10');

  // Verify SQLite persisted all 10 tokens
  const dbTokens = schedule.getTokensForSunday(testDate);
  console.log(`SQLite verified tokens count for ${testDate}: ${dbTokens.length}`);
  assert.strictEqual(dbTokens.length, 10, 'SQLite database must contain all 10 tokens');

  console.log('\n✅ STEP 1 TEST PASSED: All 10 concurrent requests received distinct, sequential tokens with 0 duplicates!\n');
}

testStep1Concurrency().catch(err => {
  console.error('\n❌ STEP 1 TEST FAILED:', err);
  process.exit(1);
});
