/**
 * Test: Verification of fixes for:
 * 1. Bot trying to give out token before 8 AM
 * 2. Bot asking about morning and afternoon slots (which it should never do)
 */

require('dotenv').config();
const assert = require('assert');
const config = require('./src/ai-bot/config');
config.init(__dirname);
const schedule = require('./src/ai-bot/schedule');
const session = require('./src/ai-bot/session');
const patientAgent = require('./src/ai-bot/patient-agent');

async function runTests() {
  console.log('====================================================');
  console.log('🧪 RUNNING VERIFICATION FOR PRE-8AM & NO-SLOT PROMPT');
  console.log('====================================================\n');

  delete process.env.NODE_ENV;
  // Time before 8:00 AM on Sunday 2026-10-11 (7:44 AM IST = 02:14 UTC)
  process.env.MOCK_CURRENT_TIME = '2026-10-11T02:14:00.000Z';

  const testPhone = '919999900001';
  const testPhone2 = '919999900002';
  const store = require('./src/ai-bot/store');
  const db = store.getDb();
  db.prepare('DELETE FROM appointments_tokens WHERE patient_phone IN (?, ?)').run(testPhone, testPhone2);
  session.clearSession(testPhone);
  session.clearSession(testPhone2);

  // Test 1: General location message before 8 AM ("nala supara sea hu")
  console.log('[Test 1] Patient sends: "nala supara sea hu" at 7:44 AM IST');
  const reply1 = await patientAgent.handlePatientMessage(testPhone, 'nala supara sea hu');
  console.log('Bot Reply:', reply1);
  assert(!reply1.toLowerCase().includes('would you like to book'), 'Must NOT offer or invite booking before 8 AM');
  assert(!reply1.toLowerCase().includes('morning or afternoon'), 'Must NOT mention morning or afternoon');
  console.log('✅ Test 1 Passed: Bot did NOT offer booking before 8 AM!\n');

  // Test 2: Patient explicitly asks for token before 8 AM ("tokan chahiye hazrat")
  console.log('[Test 2] Patient sends: "tokan chahiye hazrat" at 7:44 AM IST');
  const reply2 = await patientAgent.handlePatientMessage(testPhone, 'tokan chahiye hazrat');
  console.log('Bot Reply:', reply2);
  assert(reply2.includes('8:00 AM on Sunday'), 'Must return booking window closed message');
  assert(!reply2.toLowerCase().includes('morning or afternoon'), 'Must NOT mention morning or afternoon');
  console.log('✅ Test 2 Passed: Bot correctly returned closed message!\n');

  // Test 3: Patient replies "yes" or provides a name before 8 AM
  console.log('[Test 3] Patient sends: "kamrunNisha" at 7:44 AM IST');
  const reply3 = await patientAgent.handlePatientMessage(testPhone, 'kamrunNisha');
  console.log('Bot Reply:', reply3);
  assert(!reply3.toLowerCase().includes('morning or afternoon'), 'Must NOT ask for morning or afternoon preference');
  console.log('✅ Test 3 Passed: Zero slot preference question asked!\n');

  // Test 4: Time AFTER 8:00 AM on Sunday (8:05 AM IST = 02:35 UTC)
  process.env.MOCK_CURRENT_TIME = '2026-10-11T02:35:00.000Z';

  session.clearSession(testPhone2);

  console.log('[Test 4] Patient sends: "Token chahiye" with no name at 8:05 AM IST');
  const reply4 = await patientAgent.handlePatientMessage(testPhone2, 'Token chahiye');
  console.log('Bot Reply (Turn 1):', reply4);
  assert(reply4.toLowerCase().includes('naam') || reply4.toLowerCase().includes('name'), 'Must ask ONLY for name');
  assert(!reply4.toLowerCase().includes('morning or afternoon'), 'Must NOT ask morning or afternoon preference');

  console.log('Patient provides name: "Kamrun Nisha"');
  const reply5 = await patientAgent.handlePatientMessage(testPhone2, 'Kamrun Nisha');
  console.log('Bot Reply (Turn 2):', reply5);
  assert(!reply5.toLowerCase().includes('morning or afternoon'), 'Must NOT ask morning or afternoon preference on Turn 2');
  assert(reply5.includes('Kamrun Nisha'), 'Must confirm token for Kamrun Nisha');
  assert(reply5.includes('#') || reply5.includes('Token'), 'Must confirm token number');
  console.log('✅ Test 4 Passed: Automatic sequential allocation with ZERO slot questions!\n');

  // Clean up mock time and test tokens
  delete process.env.MOCK_CURRENT_TIME;
  db.prepare('DELETE FROM appointments_tokens WHERE patient_phone IN (?, ?)').run(testPhone, testPhone2);

  console.log('====================================================');
  console.log('🎉 ALL TESTS PASSED! NO LEAKS, NO PREFERENCE PROMPTS');
  console.log('====================================================');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
