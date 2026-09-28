/**
 * Verification Test for BUG 1, BUG 2, and BUG 3 fixes
 *
 * Reproduces the exact reported scenarios:
 * 1. Bug 1: Doctor queries "Gimme the list of all the token given for this Sunday along with the names and details"
 *    - Semantic classification handles DOCTOR_BOOKINGS vs CLINIC_CONFIG vs CLINIC_CAPACITY.
 *    - Relative date "this Sunday" resolves to upcoming Sunday.
 *    - Returns real SQLite patient records (names, tokens, arrival times, conditions, phones) — never settings summary.
 * 2. Bug 2: "Token chahiye"
 *    - Auto-allocates morning-first then afternoon without asking morning/afternoon preference.
 *    - With WhatsApp name: zero follow-up questions.
 *    - With explicit name in message: zero follow-up questions.
 *    - With missing name: asks ONLY for name, then immediately allocates upon receiving name.
 * 3. Bug 3: Warmer confirmations + Hindi mirroring
 *    - Clear visual separation of Name, Token, and Time.
 *    - Short, simple words suitable for limited literacy.
 *    - Language mirrored (Hindi/Hinglish vs English).
 */

require('dotenv').config();
const assert = require('assert');
const botConfig = require('./src/ai-bot/config');
const schedule = require('./src/ai-bot/schedule');
const doctorAgent = require('./src/ai-bot/doctor-agent');
const adminAgent = require('./src/ai-bot/admin-agent');
const patientAgent = require('./src/ai-bot/patient-agent');
const session = require('./src/ai-bot/session');
const claude = require('./src/ai-bot/claude');
const clock = require('./src/ai-bot/clock');

async function runVerification() {
  console.log('================================================================');
  console.log('VERIFICATION TEST: BUGS 1, 2, AND 3');
  console.log('================================================================\n');

  botConfig.init(process.cwd());

  const DOCTOR_ADMIN_PHONE = '918123271498'; // Dr. Sarah & Admin
  const doctorInfo = { name: 'Dr. Sarah', specialty: 'General Medicine' };

  // Set mock clock to Wednesday 2026-08-26 12:00:00
  const MOCK_TIME = '2026-08-26T12:00:00';
  process.env.NODE_ENV = 'test';
  process.env.MOCK_CURRENT_TIME = MOCK_TIME;

  const currentRefTime = clock.getCurrentTime();
  console.log(`Clock Reference: Wednesday ${MOCK_TIME}`);
  const expectedSunday = '2026-08-30';
  console.log(`Expected "this Sunday": ${expectedSunday}\n`);

  // ────────────────────────────────────────────────────────────────
  // PART 1: Semantic Classification of Doctor Queries (Bug 1)
  // ────────────────────────────────────────────────────────────────
  console.log('--- [PART 1] Semantic Classification of Admin/Doctor Queries ---');
  const semanticCases = [
    {
      query: 'Gimme the list of all the token given for this Sunday along with the names and details',
      expected: 'DOCTOR_BOOKINGS',
    },
    {
      query: 'who all am I seeing this weekend',
      expected: 'DOCTOR_BOOKINGS',
    },
    {
      query: 'pull up the files and reasons for visits for tomorrow',
      expected: 'DOCTOR_BOOKINGS',
    },
    {
      query: 'what are the clinic operational hours',
      expected: 'CLINIC_CONFIG',
    },
    {
      query: 'when is our lunch break scheduled',
      expected: 'CLINIC_CONFIG',
    },
    {
      query: 'how many total slots are still available this weekend',
      expected: 'CLINIC_CAPACITY',
    },
  ];

  for (const sc of semanticCases) {
    const classification = await claude.classifyAdminQueryType(sc.query);
    console.log(`Query: "${sc.query}" -> Classified: ${classification} (Expected: ${sc.expected})`);
    assert.strictEqual(classification, sc.expected, `Semantic classification failed for: "${sc.query}"`);
  }
  console.log('✅ Semantic classification of all 3 categories passed without keyword dependency!\n');

  // ────────────────────────────────────────────────────────────────
  // PART 2: Bug 1 Exact Failing Message Reproduction
  // ────────────────────────────────────────────────────────────────
  console.log('--- [PART 2] Bug 1 Exact Failing Message Reproduction ---');
  console.log(`Seeding SQLite tokens for upcoming Sunday (${expectedSunday})...`);
  schedule.resetTokensForTesting(expectedSunday);

  await schedule.allocateToken({
    phone: '919821139201',
    name: 'Salman Khan',
    slotPreference: 'morning',
    condition: 'Persistent dry cough and mild fever',
    targetDate: expectedSunday,
  });

  await schedule.allocateToken({
    phone: '919819749201',
    name: 'Shaheen Akhtar',
    slotPreference: 'afternoon',
    condition: 'Routine follow-up blood pressure check',
    targetDate: expectedSunday,
  });

  session.clearSession(DOCTOR_ADMIN_PHONE);

  const doctorQuery = 'Gimme the list of all the token given for this Sunday along with the names and details';
  console.log(`Doctor Query from ${DOCTOR_ADMIN_PHONE}: "${doctorQuery}"`);

  const doctorReply = await adminAgent.handleAdminMessage(
    DOCTOR_ADMIN_PHONE,
    doctorQuery,
    'Pristin Varghese',
    doctorInfo
  );

  console.log('\n🤖 Bot Reply to Doctor:');
  console.log('------------------------------------------------------------');
  console.log(doctorReply);
  console.log('------------------------------------------------------------\n');

  // Assertions for Bug 1
  assert(doctorReply.includes('Salman Khan'), 'Must list patient Salman Khan');
  assert(doctorReply.includes('Shaheen Akhtar'), 'Must list patient Shaheen Akhtar');
  assert(doctorReply.includes('Token #1'), 'Must display Token #1');
  assert(doctorReply.includes('Token #18') || doctorReply.includes('Token #19'), 'Must display afternoon Token #18 or #19');
  assert(doctorReply.includes('Persistent dry cough'), 'Must display condition for Salman');
  assert(doctorReply.includes('blood pressure check'), 'Must display condition for Shaheen');
  assert(doctorReply.includes('919821139201'), 'Must include patient phone number');
  assert(doctorReply.includes(expectedSunday), `Must reference resolved date ${expectedSunday}`);
  assert(!doctorReply.toLowerCase().includes("don't have access to booking records"), 'Must NEVER claim no access');
  assert(!doctorReply.includes('settings_tab'), 'Must not dump settings');
  console.log('✅ Bug 1 Verified: Doctor query delegates to real SQLite data for the correct resolved relative date!\n');

  // ────────────────────────────────────────────────────────────────
  // PART 3: Bug 2 & 3 — "Token chahiye" Flow (Zero Follow-up & Warm Wording)
  // ────────────────────────────────────────────────────────────────
  console.log('--- [PART 3] Bug 2 & 3: "Token chahiye" and Warm Confirmation ---');

  // Scenario 3A: Patient texts "Token chahiye" with WhatsApp push name "Salman"
  // Saturday 9:30 PM (booking window OPEN)
  const OPEN_TIME = '2026-08-29T21:30:00';
  process.env.MOCK_CURRENT_TIME = OPEN_TIME;
  const targetSundayDate = '2026-08-30';
  schedule.resetTokensForTesting(targetSundayDate);

  const phonePatient1 = '919821139201';
  session.clearSession(phonePatient1);

  console.log('[Scenario 3A: "Token chahiye" with WhatsApp display name "Salman"]');
  const reply3A = await patientAgent.handlePatientMessage(phonePatient1, 'Token chahiye', 'Salman');
  console.log('Bot Reply:');
  console.log(reply3A);
  console.log('------------------------------------------------------------');

  // Assertions for 3A:
  // Must NOT ask for preference or follow-up question
  assert(!reply3A.toLowerCase().includes('morning or afternoon'), 'Must NOT ask morning or afternoon preference');
  assert(!reply3A.toLowerCase().includes('full name'), 'Must NOT ask for name when WhatsApp name is available');
  assert(reply3A.includes('Salman'), 'Must address Salman');
  assert(reply3A.includes('#1'), 'Must allocate Token #1 (auto morning)');
  assert(reply3A.includes('👤') && reply3A.includes('🎫') && reply3A.includes('⏰'), 'Must have visual separation with icons');
  assert(reply3A.includes('Namaste') || reply3A.includes('Aapka token confirm'), 'Must mirror Hindi/Hinglish warmly');
  console.log('✅ Scenario 3A Passed: Zero follow-up, auto-morning, warm Hindi confirmation with visual separation!\n');

  // Scenario 3B: Patient texts "Token chahiye, mera naam Tariq hai" (explicit name in text)
  const phonePatient2 = '919821139202';
  session.clearSession(phonePatient2);

  console.log('[Scenario 3B: "Token chahiye, mera naam Tariq hai"]');
  const reply3B = await patientAgent.handlePatientMessage(phonePatient2, 'Token chahiye, mera naam Tariq hai');
  console.log('Bot Reply:');
  console.log(reply3B);
  console.log('------------------------------------------------------------');

  assert(!reply3B.toLowerCase().includes('morning or afternoon'), 'Must NOT ask morning or afternoon preference');
  assert(!reply3B.toLowerCase().includes('full name'), 'Must NOT ask for name when stated in text');
  assert(reply3B.includes('Tariq'), 'Must address Tariq');
  assert(reply3B.includes('#2'), 'Must allocate Token #2');
  assert(reply3B.includes('👤') && reply3B.includes('🎫') && reply3B.includes('⏰'), 'Must have visual separation with icons');
  console.log('✅ Scenario 3B Passed: Name extracted from text, allocated directly without asking preference!\n');

  // Scenario 3C: English Booking Flow
  const phonePatient3 = '919821139203';
  session.clearSession(phonePatient3);

  console.log('[Scenario 3C: English Request "Hello, my name is Sarah. I need an appointment."]');
  const reply3C = await patientAgent.handlePatientMessage(phonePatient3, 'Hello, my name is Sarah. I need an appointment.');
  console.log('Bot Reply:');
  console.log(reply3C);
  console.log('------------------------------------------------------------');

  assert(reply3C.includes('Sarah'), 'Must address Sarah');
  assert(reply3C.includes('#3'), 'Must allocate Token #3');
  assert(reply3C.includes('Hello Sarah! Your appointment is confirmed.'), 'Must use warm English confirmation');
  assert(reply3C.includes('👤 Name: Sarah'), 'Must use visual Name line in English');
  assert(reply3C.includes('🎫 Token: #3 (Morning)'), 'Must use visual Token line in English');
  assert(reply3C.includes('⏰ Time: Around'), 'Must use visual Time line in English');
  console.log('✅ Scenario 3C Passed: Warm English confirmation with visual separation!\n');

  // Scenario 3D: Genuinely missing name -> ask ONLY for name, zero preference question
  const phonePatient4 = '919821139204';
  session.clearSession(phonePatient4);

  console.log('[Scenario 3D: "Token chahiye" with genuinely missing name (no push name, no text name)]');
  const reply3D_1 = await patientAgent.handlePatientMessage(phonePatient4, 'Token chahiye', null);
  console.log('Turn 1 Bot Reply:');
  console.log(reply3D_1);

  assert(reply3D_1.includes('naam') || reply3D_1.includes('name'), 'Must ask ONLY for name');
  assert(!reply3D_1.toLowerCase().includes('morning or afternoon'), 'Must NOT ask morning/afternoon preference');

  console.log('\nPatient provides name: "Imran"');
  const reply3D_2 = await patientAgent.handlePatientMessage(phonePatient4, 'Imran');
  console.log('Turn 2 Bot Reply:');
  console.log(reply3D_2);
  console.log('------------------------------------------------------------');

  assert(reply3D_2.includes('Imran'), 'Must address Imran');
  assert(reply3D_2.includes('#4'), 'Must allocate Token #4 immediately upon receiving name');
  assert(!reply3D_2.toLowerCase().includes('morning or afternoon'), 'Must NOT ask preference on Turn 2 either');
  console.log('✅ Scenario 3D Passed: Asks strictly for name when missing, then directly allocates token!\n');

  console.log('================================================================');
  console.log('🎉 ALL VERIFICATION TESTS FOR BUGS 1, 2, AND 3 PASSED PERFECTLY!');
  console.log('================================================================\n');
}

runVerification().catch(err => {
  console.error('\n❌ VERIFICATION TEST FAILED:', err);
  process.exit(1);
});
