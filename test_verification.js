/**
 * Automated Verification Script
 *
 * Tests:
 * 1. Template Rendering & Placeholder Interpolation
 * 2. Dynamic computeArrivalTime() math & comparison with old static table
 * 3. Mockable Clock behavior & production safety gate
 * 4. Simulated Booking Conversations (Morning, Afternoon, No Preference) under MOCK_CURRENT_TIME
 * 5. Scenario A (Window OPEN) vs Scenario B (Window CLOSED)
 */

const assert = require('assert');
const schedule = require('./src/ai-bot/schedule');
const clock = require('./src/ai-bot/clock');
const patientAgent = require('./src/ai-bot/patient-agent');
const session = require('./src/ai-bot/session');

async function runTests() {
  console.log('================================================================');
  console.log('STARTING CLINIC APPOINTMENT TEMPLATE & MOCK CLOCK VERIFICATION');
  console.log('================================================================\n');

  // ────────────────────────────────────────────────────────────────
  // TEST 1: Template Rendering & Placeholders
  // ────────────────────────────────────────────────────────────────
  console.log('--- [TEST 1] Template Rendering & Placeholder Interpolation ---');
  const renderedPrompt = schedule.renderPromptTemplate();
  assert(renderedPrompt.includes('Dr. AI Clinic'), 'Clinic name missing');
  assert(renderedPrompt.includes('only on Sundays'), 'Operating days missing');
  assert(renderedPrompt.includes('45 tokens'), 'Max tokens missing');
  assert(renderedPrompt.includes('11:00 AM – 1:30 PM'), 'Morning timing missing');
  assert(renderedPrompt.includes('2:30 PM – 6:30 PM'), 'Afternoon timing missing');
  assert(renderedPrompt.includes('1:30 PM and 2:30 PM'), 'Break period missing');
  assert(!renderedPrompt.includes('{{'), 'Found un-interpolated {{placeholder}} in prompt!');
  assert(!renderedPrompt.includes('| Token | Approximate arrival |'), 'Static lookup table still exists in prompt!');
  console.log('✅ Template successfully rendered with all placeholders interpolated and static table removed.\n');

  // ────────────────────────────────────────────────────────────────
  // TEST 2: computeArrivalTime Mathematical Correctness
  // ────────────────────────────────────────────────────────────────
  console.log('--- [TEST 2] Dynamic computeArrivalTime Verification ---');
  const config = schedule.getScheduleConfig();
  const morningSlot = config.slots.morning;
  const afternoonSlot = config.slots.afternoon;

  console.log('Testing Key Milestone Tokens:');
  const t1 = schedule.computeArrivalTime(1, morningSlot, 30);
  console.log(`  Token #1 (Morning #1):   ${t1} (Expected: 11:00 AM)`);
  assert.strictEqual(t1, '11:00 AM');

  const t17 = schedule.computeArrivalTime(17, morningSlot, 30);
  console.log(`  Token #17 (Morning #17): ${t17} (Expected: 1:00 PM)`);
  assert.strictEqual(t17, '1:00 PM');

  const t18 = schedule.computeArrivalTime(1, afternoonSlot, 30);
  console.log(`  Token #18 (Afternoon #1): ${t18} (Expected: 2:30 PM)`);
  assert.strictEqual(t18, '2:30 PM');

  // Token #27 is afternoon token #10
  const t27 = schedule.computeArrivalTime(10, afternoonSlot, 30);
  console.log(`  Token #27 (Afternoon #10): ${t27} (Expected: 3:30 PM)`);
  assert.strictEqual(t27, '3:30 PM');

  const t45 = schedule.computeArrivalTime(28, afternoonSlot, 30);
  console.log(`  Token #45 (Afternoon #28): ${t45} (Expected: 6:00 PM)`);
  assert.strictEqual(t45, '6:00 PM');

  console.log('Checking Break Period Constraint:');
  for (let i = 1; i <= 17; i++) {
    const time = schedule.computeArrivalTime(i, morningSlot, 30);
    assert(time !== '1:30 PM' && time !== '2:00 PM', `Morning token ${i} arrived during break: ${time}`);
  }
  for (let i = 1; i <= 28; i++) {
    const time = schedule.computeArrivalTime(i, afternoonSlot, 30);
    assert(time !== '1:30 PM' && time !== '2:00 PM', `Afternoon token ${i} arrived during break: ${time}`);
  }
  console.log('✅ All milestone arrival times match expected values and break period constraint is preserved.\n');

  // ────────────────────────────────────────────────────────────────
  // TEST 3: Mockable Clock & Production Safety
  // ────────────────────────────────────────────────────────────────
  console.log('--- [TEST 3] Mockable Clock & Production Safety ---');
  // Test Production Gate
  process.env.NODE_ENV = 'production';
  process.env.MOCK_CURRENT_TIME = '2026-08-29T21:30:00';
  const prodTime = clock.getCurrentTime();
  const realYear = new Date().getFullYear();
  assert.strictEqual(prodTime.getFullYear(), realYear, 'Production must NOT use MOCK_CURRENT_TIME');
  console.log('✅ When NODE_ENV=production, MOCK_CURRENT_TIME is strictly ignored.');

  // Test Non-Production Mock
  process.env.NODE_ENV = 'test';
  process.env.MOCK_CURRENT_TIME = '2026-08-29T21:30:00';
  const testTime = clock.getCurrentTime();
  assert.strictEqual(testTime.toISOString().substring(0, 19), '2026-08-29T16:00:00' /* UTC equivalent depending on tz */, 'Mock time returned');
  assert.strictEqual(testTime.getDay(), 6, 'Should be Saturday');
  assert.strictEqual(testTime.getHours(), 21, 'Should be 21:00');
  console.log('✅ When NODE_ENV=test and MOCK_CURRENT_TIME is set, mocked time is active.\n');

  // Clean test data for target Sunday
  const targetSunday = schedule.getTargetSundayDate(testTime);
  schedule.resetTokensForTesting(targetSunday);

  // ────────────────────────────────────────────────────────────────
  // TEST 4: 3 Simulated Booking Conversations (under MOCK_CURRENT_TIME)
  // ────────────────────────────────────────────────────────────────
  console.log('--- [TEST 4] 3 Simulated Booking Conversations (Window OPEN) ---');
  process.env.NODE_ENV = 'test';
  process.env.MOCK_CURRENT_TIME = '2026-08-29T21:30:00'; // Saturday 9:30 PM

  // Conversation 1: Morning request
  console.log('\n[Conversation 1 — Morning Request]');
  const phone1 = '919876543211';
  session.clearSession(phone1);
  const msg1 = 'My name is Ahmed. I want a morning token.';
  console.log(`Patient: "${msg1}"`);
  const reply1 = await patientAgent.handlePatientMessage(phone1, msg1);
  console.log(`Bot Reply:\n${reply1}`);
  assert(reply1.includes('Ahmed') && reply1.includes('#1') && reply1.includes('11:00 AM'), 'Morning booking failed');

  // Conversation 2: Afternoon request
  console.log('\n[Conversation 2 — Afternoon Request]');
  const phone2 = '919876543212';
  session.clearSession(phone2);
  const msg2 = 'Can I get an afternoon token? My name is Fatima.';
  console.log(`Patient: "${msg2}"`);
  const reply2 = await patientAgent.handlePatientMessage(phone2, msg2);
  console.log(`Bot Reply:\n${reply2}`);
  assert(reply2.includes('Fatima') && reply2.includes('#18') && reply2.includes('2:30 PM'), 'Afternoon booking failed');

  // Conversation 3: No preference stated (2-turn conversation)
  console.log('\n[Conversation 3 — No Preference Stated (Multi-turn)]');
  const phone3 = '919876543213';
  session.clearSession(phone3);
  const msg3a = 'Token chahiye, mera naam Tariq hai.';
  console.log(`Patient (Turn 1): "${msg3a}"`);
  const reply3a = await patientAgent.handlePatientMessage(phone3, msg3a);
  console.log(`Bot Reply (Turn 1):\n${reply3a}`);
  assert(reply3a.includes('morning or afternoon'), 'Should ask for preference');

  const msg3b = 'Morning chalega';
  console.log(`Patient (Turn 2): "${msg3b}"`);
  const reply3b = await patientAgent.handlePatientMessage(phone3, msg3b);
  console.log(`Bot Reply (Turn 2):\n${reply3b}`);
  assert(reply3b.includes('Tariq') && reply3b.includes('#2') && reply3b.includes('morning'), 'Multi-turn preference booking failed');

  // ────────────────────────────────────────────────────────────────
  // TEST 5: Scenarios A & B (Window OPEN vs CLOSED)
  // ────────────────────────────────────────────────────────────────
  console.log('\n--- [TEST 5] Booking Window OPEN vs CLOSED Scenarios ---');

  // Scenario A: Window OPEN (Saturday 9:30 PM)
  console.log('\n[Scenario A — Window OPEN (Saturday 9:30 PM)]');
  process.env.NODE_ENV = 'test';
  process.env.MOCK_CURRENT_TIME = '2026-08-29T21:30:00';
  const phoneA = '919876543220';
  session.clearSession(phoneA);
  const msgA = 'token chahiye';
  console.log(`Patient: "${msgA}"`);
  const replyA = await patientAgent.handlePatientMessage(phoneA, msgA);
  console.log(`Bot Reply:\n${replyA}`);
  assert(replyA.includes('name') || replyA.includes('full name'), 'Should ask for name when booking window is open');

  // Scenario B: Window CLOSED (Tuesday 3:00 PM)
  console.log('\n[Scenario B — Window CLOSED (Tuesday 3:00 PM)]');
  process.env.NODE_ENV = 'test';
  process.env.MOCK_CURRENT_TIME = '2026-08-25T15:00:00';
  const phoneB = '919876543221';
  session.clearSession(phoneB);
  const msgB = 'token chahiye';
  console.log(`Patient: "${msgB}"`);
  const replyB = await patientAgent.handlePatientMessage(phoneB, msgB);
  console.log(`Bot Reply:\n${replyB}`);
  assert.strictEqual(replyB, 'Appointments for the coming Sunday will open at 9:00 PM on Saturday.');
  assert(!replyB.toLowerCase().includes('name'), 'Must not ask for name when window is closed');

  console.log('\n================================================================');
  console.log('ALL VERIFICATION CHECKS PASSED PERFECTLY!');
  console.log('================================================================');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
