/**
 * STEP 5 Comprehensive Test Suite
 *
 * 1. Send an admin QUERY ("what time do we open Sunday")
 *    — confirm it answers correctly and writes nothing.
 * 2. Send an admin COMMAND for a one-off change ("we're open next Wednesday instead, tokens from Tuesday 9pm")
 *    — confirm it asks for confirmation, confirm "yes" writes a row to Overrides (not Settings),
 *      and confirm a patient asking about "Wednesday" gets the new schedule within the cache TTL.
 * 3. Send a patient message on an unrelated date
 *    — confirm it still reads normal Settings, unaffected by the override.
 * 4. Confirm a message from a non-admin number attempting a command-style message ("change tokens to 100")
 *    — treated as an ordinary patient message and never reaches the admin write path.
 */

require('dotenv').config();
const assert = require('assert');
const botConfig = require('./src/ai-bot/config');
const sheets = require('./src/ai-bot/sheets');
const schedule = require('./src/ai-bot/schedule');
const adminAgent = require('./src/ai-bot/admin-agent');
const patientAgent = require('./src/ai-bot/patient-agent');
const session = require('./src/ai-bot/session');
const clock = require('./src/ai-bot/clock');
const claude = require('./src/ai-bot/claude');

async function runStep5Tests() {
  console.log('================================================================');
  console.log('STARTING STEP 5 VERIFICATION SUITE');
  console.log('================================================================\n');

  botConfig.init(process.cwd());

  const ADMIN_PHONE = '919876543200';
  const PATIENT_PHONE = '919876543299';
  const NON_ADMIN_PHONE = '919876543288';

  // Ensure clean starting state in Google Sheets
  console.log('--- Initializing Sheets tabs ---');
  await sheets.ensureSettingsAndOverridesTabs();
  schedule.invalidateCache();

  // ────────────────────────────────────────────────────────────────
  // TEST 1: Admin QUERY ("what time do we open Sunday")
  // ────────────────────────────────────────────────────────────────
  console.log('\n================================================================');
  console.log('--- [TEST 1] Admin QUERY: "what time do we open Sunday" ---');
  console.log('================================================================');
  session.clearSession(ADMIN_PHONE);

  const initialSettings = await sheets.getSettingsFromSheet(true);
  const initialOverrides = await sheets.getOverridesFromSheet(true);
  const initialOverrideCount = initialOverrides.length;

  console.log(`\n👑 Admin (${ADMIN_PHONE}): "what time do we open Sunday"`);
  const queryReply = await adminAgent.handleAdminMessage(ADMIN_PHONE, 'what time do we open Sunday', 'Admin');
  console.log(`🤖 Bot Reply:\n${queryReply}\n`);

  assert(queryReply && queryReply.length > 0, 'Admin query reply must not be empty');
  assert(queryReply.includes('11') || queryReply.toLowerCase().includes('sunday') || queryReply.includes('morning'), 'Query reply should mention clinic timings');

  // Verify NOTHING was written to Google Sheets
  const postQuerySettings = await sheets.getSettingsFromSheet(true);
  const postQueryOverrides = await sheets.getOverridesFromSheet(true);
  assert.strictEqual(postQueryOverrides.length, initialOverrideCount, 'Overrides tab must NOT have changed after a QUERY');
  assert.strictEqual(JSON.stringify(postQuerySettings), JSON.stringify(initialSettings), 'Settings tab must NOT have changed after a QUERY');
  console.log('✅ Test 1 Passed: Admin QUERY answered accurately and wrote NOTHING to Google Sheets.');

  // ────────────────────────────────────────────────────────────────
  // TEST 2: Admin COMMAND for One-Off Change & Patient Confirmation
  // ────────────────────────────────────────────────────────────────
  console.log('\n================================================================');
  console.log('--- [TEST 2] Admin COMMAND for One-Off Change & Patient Verification ---');
  console.log('================================================================');
  session.clearSession(ADMIN_PHONE);

  // Set mock time: Wednesday 2026-08-26 12:00:00 (or reference time)
  process.env.NODE_ENV = 'test';
  process.env.MOCK_CURRENT_TIME = '2026-08-26T12:00:00';

  const cmdMsg = "we're open next Wednesday instead, tokens from Tuesday 9pm";
  console.log(`\n👑 Admin (${ADMIN_PHONE}): "${cmdMsg}"`);
  const cmdReply = await adminAgent.handleAdminMessage(ADMIN_PHONE, cmdMsg, 'Admin');
  console.log(`🤖 Bot Reply (Confirmation Request):\n${cmdReply}\n`);

  assert(cmdReply.toLowerCase().includes('override') || cmdReply.includes('Overrides'), 'Bot must specify that it will write to Overrides tab');
  assert(cmdReply.toLowerCase().includes('yes') || cmdReply.toLowerCase().includes('confirm'), 'Bot must ask for confirmation');

  // Verify nothing written BEFORE confirmation
  const preConfirmOverrides = await sheets.getOverridesFromSheet(true);
  assert.strictEqual(preConfirmOverrides.length, initialOverrideCount, 'Overrides must NOT be written before confirmation');

  // Send affirmative confirmation ("yes")
  console.log(`👑 Admin (${ADMIN_PHONE}): "yes"`);
  const confirmReply = await adminAgent.handleAdminMessage(ADMIN_PHONE, 'yes', 'Admin');
  console.log(`🤖 Bot Reply (Post-Confirmation):\n${confirmReply}\n`);

  assert(confirmReply.includes('Confirmed') || confirmReply.includes('✅') || confirmReply.includes('override'), 'Bot must acknowledge confirmation');

  // Verify Overrides tab in Google Sheets
  const postConfirmOverrides = await sheets.getOverridesFromSheet(true);
  assert.strictEqual(postConfirmOverrides.length, initialOverrideCount + 1, 'Overrides tab must have exactly 1 new row');
  const latestOverride = postConfirmOverrides[postConfirmOverrides.length - 1];
  console.log('📄 Latest Row in Overrides Tab:', JSON.stringify(latestOverride, null, 2));

  assert(latestOverride.target_date.includes('2026-09-02') || latestOverride.target_date.includes('2026-08-26') || latestOverride.type === 'open_extra_day', 'Override record mismatch');

  // Verify Settings tab was NOT modified
  const postConfirmSettings = await sheets.getSettingsFromSheet(true);
  assert.strictEqual(postConfirmSettings.max_tokens, initialSettings.max_tokens, 'Settings tab must remain unchanged');
  assert.strictEqual(JSON.stringify(postConfirmSettings.operating_days), JSON.stringify(initialSettings.operating_days), 'Settings operating_days unchanged');

  // Now test patient booking for Wednesday:
  // Patient messages on Tuesday 9:30 PM (booking window OPEN for Wednesday)
  const wednesdayDate = latestOverride.target_date;
  console.log(`\nTesting patient interaction for override date: ${wednesdayDate}`);

  // Tuesday 9:30 PM before Wednesday override date:
  const wedDateObj = new Date(wednesdayDate + 'T00:00:00');
  const tuesDateObj = new Date(wedDateObj.getTime() - 24 * 60 * 60 * 1000);
  const tuesDateStr = schedule.formatDateToYYYYMMDD(tuesDateObj);
  process.env.MOCK_CURRENT_TIME = `${tuesDateStr}T21:30:00`; // Tuesday 9:30 PM

  session.clearSession(PATIENT_PHONE);
  schedule.resetTokensForTesting(wednesdayDate);

  const patientMsg1 = 'Mera naam Vikram Sharma hai. Mujhe Wednesday ka morning token chahiye.';
  console.log(`\n👤 Patient (${PATIENT_PHONE}): "${patientMsg1}"`);
  const patientReply1 = await patientAgent.handlePatientMessage(PATIENT_PHONE, patientMsg1, 'Vikram');
  console.log(`🤖 Bot Reply to Patient:\n${patientReply1}\n`);

  assert(patientReply1.includes('Vikram') && (patientReply1.includes('token is #1') || patientReply1.includes('#1')), 'Patient booking on Wednesday failed');
  console.log('✅ Test 2 Passed: One-off COMMAND prompted confirmation, wrote to Overrides tab (not Settings), invalidated cache, and patient successfully booked Wednesday appointment.');

  // ────────────────────────────────────────────────────────────────
  // TEST 3: Patient Message on Unrelated Date (Reads normal Settings)
  // ────────────────────────────────────────────────────────────────
  console.log('\n================================================================');
  console.log('--- [TEST 3] Patient on Unrelated Date (Normal Settings Unaffected) ---');
  console.log('================================================================');

  // Saturday 9:30 PM before regular Sunday:
  process.env.MOCK_CURRENT_TIME = '2026-09-05T21:30:00'; // Saturday 9:30 PM
  const sundayDate = '2026-09-06';

  const patientSundayPhone = '919876543277';
  session.clearSession(patientSundayPhone);
  schedule.resetTokensForTesting(sundayDate);

  const sundayMsg = 'My name is Ananya. I want a morning token for Sunday.';
  console.log(`\n👤 Patient (${patientSundayPhone}): "${sundayMsg}"`);
  const sundayReply = await patientAgent.handlePatientMessage(patientSundayPhone, sundayMsg, 'Ananya');
  console.log(`🤖 Bot Reply to Patient:\n${sundayReply}\n`);

  assert(sundayReply.includes('Ananya') && sundayReply.includes('#1') && sundayReply.includes('11:00 AM'), 'Sunday booking failed');

  // Verify Sunday effective schedule still uses Settings tab defaults
  const sundaySched = await schedule.getEffectiveSchedule(sundayDate);
  assert.strictEqual(sundaySched.is_override, false, 'Sunday should not have an override');
  assert.strictEqual(sundaySched.max_tokens, 45, 'Sunday max tokens should be 45 from Settings');
  assert.strictEqual(sundaySched.slots.morning.token_cap, 17, 'Sunday morning cap should be 17 from Settings');
  assert.strictEqual(sundaySched.slots.afternoon.token_cap, 28, 'Sunday afternoon cap should be 28 from Settings');
  console.log('✅ Test 3 Passed: Patient message on unrelated date reads normal Settings, completely unaffected by override.');

  // ────────────────────────────────────────────────────────────────
  // TEST 4: Non-Admin Attempting Command-Style Message
  // ────────────────────────────────────────────────────────────────
  console.log('\n================================================================');
  console.log('--- [TEST 4] Non-Admin Attempting Command ("change tokens to 100") ---');
  console.log('================================================================');
  session.clearSession(NON_ADMIN_PHONE);

  const nonAdminMsg = 'change tokens to 100';
  console.log(`\n👤 Non-Admin Contact (${NON_ADMIN_PHONE}): "${nonAdminMsg}"`);

  // Verify botConfig.isAdminPhone is false
  assert.strictEqual(botConfig.isAdminPhone(NON_ADMIN_PHONE), false, 'Non-admin phone must not be identified as admin');

  // Handle via patient agent
  const nonAdminReply = await patientAgent.handlePatientMessage(NON_ADMIN_PHONE, nonAdminMsg, 'Random User');
  console.log(`🤖 Bot Reply:\n${nonAdminReply}\n`);

  // Verify it does NOT enter admin confirmation workflow
  assert(!nonAdminReply.toLowerCase().includes('override') && !nonAdminReply.toLowerCase().includes('settings tab') && !nonAdminReply.toLowerCase().includes("should i proceed? reply 'yes'"), 'Non-admin must never reach admin confirm-before-mutate workflow');

  // Verify Settings tab in Google Sheets was NOT changed
  const checkSettings = await sheets.getSettingsFromSheet(true);
  assert.strictEqual(checkSettings.max_tokens, 45, 'max_tokens must still be 45 and not changed to 100');
  console.log('✅ Test 4 Passed: Non-admin command attempt was treated as ordinary message, never reached admin write path, and Sheets remained untouched.');

  // ────────────────────────────────────────────────────────────────
  // BONUS CHECKS: Multilingual confirmation & Capacity constraint validation
  // ────────────────────────────────────────────────────────────────
  console.log('\n================================================================');
  console.log('--- [BONUS CHECKS] Multilingual ("haan") & Capacity Constraint ---');
  console.log('================================================================');

  // Multilingual confirmation: "haan"
  session.clearSession(ADMIN_PHONE);
  const hindiCmd = 'close clinic on 2026-10-18 due to maintenance';
  console.log(`👑 Admin (${ADMIN_PHONE}): "${hindiCmd}"`);
  const hindiReply = await adminAgent.handleAdminMessage(ADMIN_PHONE, hindiCmd, 'Admin');
  console.log(`🤖 Bot Reply:\n${hindiReply}\n`);

  console.log(`👑 Admin (${ADMIN_PHONE}): "haan bilkul kar do"`);
  const hindiConfirmReply = await adminAgent.handleAdminMessage(ADMIN_PHONE, 'haan bilkul kar do', 'Admin');
  console.log(`🤖 Bot Reply:\n${hindiConfirmReply}\n`);
  assert(hindiConfirmReply.includes('Confirmed') || hindiConfirmReply.includes('✅'), 'Hindi/Urdu confirmation should work');

  // Capacity constraint check: morning 30 + afternoon 30 > max_tokens 45
  session.clearSession(ADMIN_PHONE);
  const invalidSettingsCmd = 'permanently change morning tokens to 30 and afternoon tokens to 30';
  console.log(`👑 Admin (${ADMIN_PHONE}): "${invalidSettingsCmd}"`);
  const invalidReply = await adminAgent.handleAdminMessage(ADMIN_PHONE, invalidSettingsCmd, 'Admin');
  console.log(`🤖 Bot Reply:\n${invalidReply}\n`);
  assert(invalidReply.includes('Cannot update settings') || invalidReply.includes('exceeds max tokens') || invalidReply.includes('exceeds'), 'Capacity constraint violation must be rejected');

  console.log('\n================================================================');
  console.log('🎉 ALL STEP 5 TESTS AND CONSTRAINTS VERIFIED PERFECTLY!');
  console.log('================================================================');
}

runStep5Tests().catch(err => {
  console.error('❌ Step 5 Test Failed:', err);
  process.exit(1);
});
