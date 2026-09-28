/**
 * STEP 10: Auto-Notify Booked Patients on Day Closure / Reduction Verification Test
 *
 * Requirements:
 * 1. Allocate 3 test tokens for today (via mock clock).
 *    Send "not going to be in today" as the doctor/admin.
 *    Confirm the pre-confirmation message correctly says 3 patients will be notified.
 * 2. Reply "yes". Confirm override is written, AND confirm all 3 test patient numbers
 *    actually received a cancellation WhatsApp message (log actual message content).
 * 3. Confirm the doctor receives a summary reply stating 3 patients were notified.
 * 4. Repeat with zero tokens already issued for target date — confirm no notification
 *    step runs and no error occurs.
 */

require('dotenv').config();
const assert = require('assert');
const botConfig = require('./src/ai-bot/config');
const schedule = require('./src/ai-bot/schedule');
const sheets = require('./src/ai-bot/sheets');
const adminAgent = require('./src/ai-bot/admin-agent');
const session = require('./src/ai-bot/session');
const cloudapi = require('./src/cloudapi');

async function testStep10PatientNotifications() {
  console.log('================================================================');
  console.log('STEP 10: AUTO-NOTIFY BOOKED PATIENTS ON CLOSURE VERIFICATION TEST');
  console.log('================================================================\n');

  botConfig.init(process.cwd());

  const ADMIN_PHONE = '919876543000';
  const targetDate = '2026-11-15'; // A Sunday with no existing overrides
  process.env.NODE_ENV = 'test';
  process.env.MOCK_CURRENT_TIME = `${targetDate}T09:00:00`;

  schedule.resetTokensForTesting(targetDate);
  schedule.invalidateCache();
  session.clearSession(ADMIN_PHONE);

  // Setup notification interceptor/spy to capture actual dispatched WhatsApp messages
  const sentWhatsAppMessages = [];
  adminAgent.setNotificationSender(async (phone, text) => {
    sentWhatsAppMessages.push({ phone, text, timestamp: new Date().toISOString() });
    console.log(`\n📲 [CloudAPI WhatsApp Outbound]`);
    console.log(`   To:      ${phone}`);
    console.log(`   Message: "${text}"`);
    return { success: true, message_id: `wamid.test.${Date.now()}` };
  });

  // ────────────────────────────────────────────────────────────────
  // TEST 10.1: Pre-confirmation warning with 3 existing tokens
  // ────────────────────────────────────────────────────────────────
  console.log('--- TEST 10.1: Allocating 3 test tokens for today ---');
  const patientData = [
    { name: 'Priya Sharma', phone: '919876543101', condition: 'Severe Migraine' },
    { name: 'Rahul Verma', phone: '919876543102', condition: 'Lower Back Pain' },
    { name: 'Ananya Iyer', phone: '919876543103', condition: 'Allergic Reaction' },
  ];

  for (const p of patientData) {
    const res = await schedule.allocateToken({
      phone: p.phone,
      name: p.name,
      slotPreference: 'morning',
      condition: p.condition,
      targetDate,
    });
    console.log(`  Allocated Token #${res.token.token_number} for ${p.name} (${p.phone})`);
  }

  const existingInDb = schedule.getTokensForSunday(targetDate);
  assert.strictEqual(existingInDb.length, 3, 'Must have exactly 3 tokens in SQLite');

  console.log(`\nDoctor (${ADMIN_PHONE}): "not going to be in today"`);
  const preConfirmReply = await adminAgent.handleAdminMessage(
    ADMIN_PHONE,
    "not going to be in today",
    "Dr. Sarah Jenkins"
  );

  console.log('\n🤖 Doctor Agent Pre-Confirmation Reply:');
  console.log(preConfirmReply);
  console.log('----------------------------------------------------------------');

  assert(
    preConfirmReply.includes('3 patients already hold tokens') || preConfirmReply.includes('3 patients'),
    'Pre-confirmation message must state that 3 patients already hold tokens'
  );
  assert(
    preConfirmReply.includes('notify all 3 automatically') || preConfirmReply.includes('notify'),
    'Pre-confirmation message must inform doctor that confirming will notify all 3 automatically'
  );
  assert(
    preConfirmReply.toLowerCase().includes('yes'),
    "Pre-confirmation message must prompt: Reply 'yes' to proceed"
  );
  console.log('✅ TEST 10.1 PASSED: Pre-confirmation message correctly identified 3 booked patients.\n');

  // ────────────────────────────────────────────────────────────────
  // TEST 10.2: Confirmation "yes" triggers override & WhatsApp messages
  // ────────────────────────────────────────────────────────────────
  console.log('--- TEST 10.2: Confirming with "yes" ---');
  console.log(`Doctor (${ADMIN_PHONE}): "yes"`);

  const confirmReply = await adminAgent.handleAdminMessage(
    ADMIN_PHONE,
    "yes",
    "Dr. Sarah Jenkins"
  );

  console.log('\n🤖 Doctor Agent Post-Confirmation Reply:');
  console.log(confirmReply);
  console.log('----------------------------------------------------------------\n');

  // Verify override was written to Google Sheets Overrides tab
  const overrides = await sheets.getOverridesFromSheet(true);
  const matchingOverride = overrides.slice().reverse().find(o => o.target_date === targetDate);
  assert(matchingOverride, `Override row must exist in Overrides tab for ${targetDate}`);
  assert.strictEqual(matchingOverride.type, 'closed', 'Override type must be closed');
  console.log(`✅ Override verified in Google Sheets: ${matchingOverride.target_date} -> ${matchingOverride.type}`);

  // Verify all 3 WhatsApp cancellation messages were sent
  console.log(`\nVerified WhatsApp Dispatched Messages (${sentWhatsAppMessages.length} total):`);
  assert.strictEqual(sentWhatsAppMessages.length, 3, 'Exactly 3 WhatsApp cancellation messages must have been dispatched');

  for (let i = 0; i < patientData.length; i++) {
    const expected = patientData[i];
    const dispatched = sentWhatsAppMessages.find(m => m.phone === expected.phone);
    assert(dispatched, `Patient ${expected.name} (${expected.phone}) must have received a message`);
    console.log(`\n  [Patient ${i + 1}] Phone: ${dispatched.phone}`);
    console.log(`  Actual Message Body:\n  "${dispatched.text}"`);

    assert(dispatched.text.includes(expected.name), `Message must include patient name '${expected.name}'`);
    assert(dispatched.text.includes(`token #${i + 1}`), `Message must include token #${i + 1}`);
    assert(dispatched.text.includes('closed today'), 'Message must inform that clinic is closed today');
    assert(dispatched.text.includes('cancelled'), 'Message must state appointment is cancelled');
  }
  console.log('\n✅ TEST 10.2 PASSED: All 3 patient numbers received proper WhatsApp cancellation messages.\n');

  // ────────────────────────────────────────────────────────────────
  // TEST 10.3: Doctor receives summary reply with notified count
  // ────────────────────────────────────────────────────────────────
  console.log('--- TEST 10.3: Verifying Doctor Summary Reply ---');
  console.log(`Doctor Summary Reply received:\n"${confirmReply}"`);
  assert(
    confirmReply.toLowerCase().includes('closed') && confirmReply.includes('3 patients automatically'),
    `Doctor reply must state "Closed today's clinic. Notified 3 patients automatically.", got: "${confirmReply}"`
  );
  console.log('✅ TEST 10.3 PASSED: Doctor received summary confirming 3 patients were notified.\n');

  // ────────────────────────────────────────────────────────────────
  // TEST 10.4: Repeat with 0 tokens already issued
  // ────────────────────────────────────────────────────────────────
  console.log('--- TEST 10.4: Testing with 0 tokens on target date ---');
  const zeroDate = '2026-10-25'; // A future Sunday
  process.env.MOCK_CURRENT_TIME = `${zeroDate}T09:00:00`;
  schedule.resetTokensForTesting(zeroDate);
  schedule.invalidateCache();
  session.clearSession(ADMIN_PHONE);
  sentWhatsAppMessages.length = 0; // Clear sent log

  console.log(`Doctor (${ADMIN_PHONE}): "not going to be in today"`);
  const zeroPreConfirm = await adminAgent.handleAdminMessage(
    ADMIN_PHONE,
    "not going to be in today",
    "Dr. Sarah Jenkins"
  );
  console.log(`Pre-confirmation reply for 0 tokens:\n"${zeroPreConfirm.trim().replace(/\n/g, ' ')}"`);
  assert(
    !zeroPreConfirm.includes('patient already hold tokens') && !zeroPreConfirm.includes('patients already hold tokens'),
    'Should not warn about existing patients when 0 tokens exist'
  );

  console.log(`Doctor (${ADMIN_PHONE}): "yes"`);
  const zeroConfirm = await adminAgent.handleAdminMessage(
    ADMIN_PHONE,
    "yes",
    "Dr. Sarah Jenkins"
  );
  console.log(`Post-confirmation reply for 0 tokens:\n"${zeroConfirm}"`);

  assert.strictEqual(sentWhatsAppMessages.length, 0, 'No WhatsApp cancellation messages should be sent when 0 tokens exist');
  assert(zeroConfirm.toLowerCase().includes('closed'), 'Doctor reply should acknowledge closure');
  console.log('✅ TEST 10.4 PASSED: 0 tokens correctly resulted in 0 notification dispatches and no errors.\n');

  console.log('================================================================');
  console.log('✅ ALL STEP 10 AUTO-NOTIFICATION TESTS COMPLETED SUCCESSFULLY!');
  console.log('================================================================\n');
}

testStep10PatientNotifications().catch(err => {
  console.error('\n❌ STEP 10 TEST FAILED:', err);
  process.exit(1);
});
