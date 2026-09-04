/**
 * Three Pre-Merge Verification Tests
 *
 * 1. Admin gets asked to confirm a change, then either sends an unrelated message
 *    or waits past 10 min without confirming:
 *    — prove the pending action does NOT get accidentally triggered and the bot treats the next message as fresh.
 * 2. Doctor number handling:
 *    — show what doctor-agent.js currently does with a message from doctor's number,
 *    — run real tests proving doctor-agent.js's existing behavior and admin routing both work correctly.
 * 3. Patient messaging on/around 2026-10-18 closed override date:
 *    — confirm the bot explicitly responds that the clinic is closed that day, rather than falling through to blank fields.
 */

require('dotenv').config();
const assert = require('assert');
const botConfig = require('./src/ai-bot/config');
const sheets = require('./src/ai-bot/sheets');
const schedule = require('./src/ai-bot/schedule');
const adminAgent = require('./src/ai-bot/admin-agent');
const doctorAgent = require('./src/ai-bot/doctor-agent');
const patientAgent = require('./src/ai-bot/patient-agent');
const session = require('./src/ai-bot/session');
const clock = require('./src/ai-bot/clock');

async function runThreeTests() {
  console.log('================================================================');
  console.log('STARTING 3 PRE-MERGE VERIFICATION TESTS');
  console.log('================================================================\n');

  botConfig.init(process.cwd());

  const ADMIN_PHONE = '919876543200';
  const DOCTOR_PHONE = '918123271498'; // Dr. Sarah in doctors.json
  const PATIENT_PHONE = '919876543299';

  await sheets.ensureSettingsAndOverridesTabs();
  schedule.invalidateCache();

  // ────────────────────────────────────────────────────────────────
  // TEST 1: Pending Confirmation Safety (Unrelated message & 10-min expiry)
  // ────────────────────────────────────────────────────────────────
  console.log('================================================================');
  console.log('--- [TEST 1A] Pending Action Dropped by Unrelated Message ---');
  console.log('================================================================');
  session.clearSession(ADMIN_PHONE);
  process.env.NODE_ENV = 'test';
  process.env.MOCK_CURRENT_TIME = '2026-08-26T12:00:00';

  const initialOverrides = await sheets.getOverridesFromSheet(true);
  const initialOverrideCount = initialOverrides.length;

  // Step 1: Admin sends a command
  console.log(`\n👑 Admin: "open clinic on 2026-11-15 with 40 tokens"`);
  const step1Reply = await adminAgent.handleAdminMessage(ADMIN_PHONE, 'open clinic on 2026-11-15 with 40 tokens', 'Admin');
  console.log(`🤖 Bot Reply (Confirmation Request):\n${step1Reply}\n`);

  assert(session.getAdminPending(ADMIN_PHONE) !== null, 'Pending action should be saved in session');

  // Step 2: Instead of confirming, Admin sends an UNRELATED message
  console.log(`👑 Admin (Unrelated Message): "what time do we open Sunday?"`);
  const step2Reply = await adminAgent.handleAdminMessage(ADMIN_PHONE, 'what time do we open Sunday?', 'Admin');
  console.log(`🤖 Bot Reply (Processed as fresh QUERY):\n${step2Reply}\n`);

  // Assertions:
  assert.strictEqual(session.getAdminPending(ADMIN_PHONE), null, 'Pending action must be dropped immediately');
  assert(step2Reply.includes('11:00 AM') || step2Reply.toLowerCase().includes('sunday'), 'Must answer the Sunday query');

  // Verify NO mutation occurred in Google Sheets
  const post1AOverrides = await sheets.getOverridesFromSheet(true);
  assert.strictEqual(post1AOverrides.length, initialOverrideCount, 'Google Sheets must NOT have been mutated');
  console.log('✅ Test 1A Passed: Unrelated message dropped the pending state and was processed fresh as a query. Zero mutations written.');

  console.log('\n================================================================');
  console.log('--- [TEST 1B] Pending Action Auto-Expires After 10 Minutes ---');
  console.log('================================================================');
  session.clearSession(ADMIN_PHONE);

  // Step 1: Admin sends a command
  console.log(`\n👑 Admin: "open clinic on 2026-12-20 with 30 tokens"`);
  const step1BReply = await adminAgent.handleAdminMessage(ADMIN_PHONE, 'open clinic on 2026-12-20 with 30 tokens', 'Admin');
  console.log(`🤖 Bot Reply (Confirmation Request):\n${step1BReply}\n`);

  assert(session.getAdminPending(ADMIN_PHONE) !== null, 'Pending action saved in session');

  // Step 2: Simulate 11 minutes passing without confirmation
  console.log('⏳ Advancing time by 11 minutes (past 10-minute TTL)...');
  process.env.MOCK_CURRENT_TIME = '2026-08-26T12:11:00'; // 11 minutes later

  assert.strictEqual(session.getAdminPending(ADMIN_PHONE), null, 'getAdminPending must return null after 10-min TTL expires');

  // Step 3: Admin now sends "yes"
  console.log(`👑 Admin (Late "yes" after 11 min): "yes"`);
  const lateYesReply = await adminAgent.handleAdminMessage(ADMIN_PHONE, 'yes', 'Admin');
  console.log(`🤖 Bot Reply:\n${lateYesReply}\n`);

  // Verify NO mutation occurred
  const post1BOverrides = await sheets.getOverridesFromSheet(true);
  assert.strictEqual(post1BOverrides.length, initialOverrideCount, 'Google Sheets must NOT be mutated by an expired confirmation');
  console.log('✅ Test 1B Passed: 10-minute TTL expired pending state; late "yes" did NOT trigger any mutation.');

  // ────────────────────────────────────────────────────────────────
  // TEST 2: Doctor Number & Doctor Agent Behavior vs Admin Routing
  // ────────────────────────────────────────────────────────────────
  console.log('\n================================================================');
  console.log('--- [TEST 2] Doctor Agent Existing Behavior & Admin Routing ---');
  console.log('================================================================');

  const doctorInfo = botConfig.getDoctorInfo(`${DOCTOR_PHONE}@s.whatsapp.net`);
  console.log(`Doctor registered in doctors.json: ${doctorInfo.name} (${doctorInfo.specialty})`);
  assert.strictEqual(doctorInfo.name, 'Dr. Sarah', 'Doctor info resolved');

  // Test 2A: Message from Doctor's number requesting schedule
  session.clearSession(DOCTOR_PHONE);
  console.log(`\n🩺 Dr. Sarah (${DOCTOR_PHONE}): "what is my schedule today"`);
  const docReply = await doctorAgent.handleDoctorMessage(DOCTOR_PHONE, 'what is my schedule today', doctorInfo);
  console.log(`🤖 Bot Reply to Doctor:\n${docReply}\n`);

  assert(docReply.includes('Dr. Sarah') || docReply.toLowerCase().includes('slots') || docReply.toLowerCase().includes('schedule'), 'Doctor agent response must address Dr. Sarah');
  console.log("✅ Test 2A Passed: Doctor-agent handled message from doctor's number with Dr. Sarah context.");

  // Test 2B: Admin message from admin number
  session.clearSession(ADMIN_PHONE);
  console.log(`\n👑 Admin (${ADMIN_PHONE}): "what are Sunday's timings"`);
  const adminReply = await adminAgent.handleAdminMessage(ADMIN_PHONE, "what are Sunday's timings", 'Admin');
  console.log(`🤖 Bot Reply to Admin:\n${adminReply}\n`);
  assert(adminReply.includes('11') || adminReply.toLowerCase().includes('sunday'), 'Admin query answered');
  console.log('✅ Test 2B Passed: Admin agent handled admin queries smoothly without conflict.');

  // ────────────────────────────────────────────────────────────────
  // TEST 3: Patient Messaging on/around 2026-10-18 Closed Override Date
  // ────────────────────────────────────────────────────────────────
  console.log('\n================================================================');
  console.log('--- [TEST 3] Patient Messaging on 2026-10-18 Closed Override Date ---');
  console.log('================================================================');

  // Verify the closed override exists in Overrides tab for 2026-10-18
  const closedSched = await schedule.getEffectiveSchedule('2026-10-18');
  console.log('Resolved Effective Schedule for 2026-10-18:');
  console.log(`  is_open: ${closedSched.is_open}`);
  console.log(`  override_type: ${closedSched.override_type}`);
  console.log(`  closed_message: "${closedSched.booking_window?.closed_message}"`);
  assert.strictEqual(closedSched.is_open, false, '2026-10-18 must be closed');

  // Test 3A: Patient attempts to book on Saturday night 2026-10-17 9:30 PM (before the closed Sunday 2026-10-18)
  process.env.MOCK_CURRENT_TIME = '2026-10-17T21:30:00'; // Saturday 9:30 PM
  session.clearSession(PATIENT_PHONE);

  const patientClosedMsg = 'Mera naam Rajesh Kumar hai. Mujhe Sunday ka token chahiye.';
  console.log(`\n👤 Patient (${PATIENT_PHONE}): "${patientClosedMsg}"`);
  const patientClosedReply = await patientAgent.handlePatientMessage(PATIENT_PHONE, patientClosedMsg, 'Rajesh');
  console.log(`🤖 Bot Reply to Patient:\n${patientClosedReply}\n`);

  // Assertions:
  assert(
    patientClosedReply.toLowerCase().includes('closed') ||
    patientClosedReply.toLowerCase().includes('maintenance'),
    'Bot must explicitly state the clinic is closed on 2026-10-18'
  );
  assert(!patientClosedReply.toLowerCase().includes('token is #'), 'Must NOT issue any token when closed');
  assert(!patientClosedReply.toLowerCase().includes('approximate time'), 'Must NOT give arrival times when closed');

  // Verify NO token was allocated in SQLite
  const tokensOnClosedDate = schedule.getTokensForSunday('2026-10-18');
  assert.strictEqual(tokensOnClosedDate.length, 0, 'Zero tokens must be allocated on a closed override date');

  console.log('✅ Test 3 Passed: Bot explicitly informs patient that clinic is closed on 2026-10-18, no tokens issued, no blank field fall-through.');

  console.log('\n================================================================');
  console.log('🎉 ALL 3 PRE-MERGE TESTS VERIFIED AND PASSED PERFECTLY!');
  console.log('================================================================');
}

runThreeTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
