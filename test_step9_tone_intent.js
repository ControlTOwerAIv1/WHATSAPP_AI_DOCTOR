/**
 * STEP 9: Tone-Based Intent Classification Verification Test
 *
 * Tests classifyAdminIntent() with phrasing that intentionally avoids any
 * traditional trigger words ("available", "cancel", "close", "change").
 *
 * QUERY examples:
 *   - "what's left for today"
 *   - "hey how many people am I seeing"
 *   - "any slots open right now"
 *
 * COMMAND examples:
 *   - "not going to be in today"
 *   - "skip today, I'm out"
 *   - "let's not take anyone this afternoon"
 */

require('dotenv').config();
const assert = require('assert');
const botConfig = require('./src/ai-bot/config');
const claude = require('./src/ai-bot/claude');

async function testStep9ToneIntent() {
  console.log('================================================================');
  console.log('STEP 9: TONE-BASED INTENT CLASSIFICATION TEST (NO TRIGGER WORDS)');
  console.log('================================================================\n');

  botConfig.init(process.cwd());

  const testCases = [
    // Queries without trigger words
    { message: "what's left for today", expected: 'QUERY' },
    { message: "hey how many people am I seeing", expected: 'QUERY' },
    { message: "any slots open right now", expected: 'QUERY' },

    // Commands without trigger words
    { message: "not going to be in today", expected: 'COMMAND' },
    { message: "skip today, I'm out", expected: 'COMMAND' },
    { message: "let's not take anyone this afternoon", expected: 'COMMAND' },
  ];

  console.log("Checking trigger words avoidance:");
  const forbidden = ['available', 'cancel', 'close', 'change'];
  for (const tc of testCases) {
    const lower = tc.message.toLowerCase();
    for (const f of forbidden) {
      assert(!lower.includes(f), `Test message "${tc.message}" must NOT contain forbidden keyword "${f}"`);
    }
  }
  console.log("✅ Verified: None of the test cases contain 'available', 'cancel', 'close', or 'change'.\n");

  const results = [];

  for (const tc of testCases) {
    console.log(`Input: "${tc.message}"`);
    const classified = await claude.classifyAdminIntent(tc.message);
    console.log(`  Expected: ${tc.expected}`);
    console.log(`  Actual:   ${classified}`);

    assert.strictEqual(
      classified,
      tc.expected,
      `Misclassification for "${tc.message}": expected ${tc.expected} but got ${classified}`
    );
    console.log(`  ✅ Passed\n`);
    results.push({ message: tc.message, expected: tc.expected, actual: classified, status: 'PASS' });
  }

  console.log('================================================================');
  console.log('SUMMARY OF TONE-BASED CLASSIFICATION RESULTS:');
  console.table(results);
  console.log('✅ STEP 9 TEST PASSED: All 6 tone-based phrases classified with 100% semantic accuracy!');
  console.log('================================================================\n');
}

testStep9ToneIntent().catch(err => {
  console.error('\n❌ STEP 9 TEST FAILED:', err);
  process.exit(1);
});
