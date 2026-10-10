/**
 * Comprehensive verification test for the 3 Admin/Booking fixes:
 * 1. Booking window update clears stale overrides, inquiry questions do NOT trigger booking flow,
 *    and patient bookings are strictly blocked outside the new window.
 * 2. Admin queries for token numbers/names return authoritative patient data.
 * 3. Bulk cancellation ("cancel all given appointments for today") automatically cancels tokens,
 *    clears SQLite records, and dispatches WhatsApp cancellation notifications without manual effort.
 */

require('dotenv').config();
const assert = require('assert');
const path = require('path');

const botConfig = require('./src/ai-bot/config');
botConfig.init(__dirname);

const adminAgent = require('./src/ai-bot/admin-agent');
const patientAgent = require('./src/ai-bot/patient-agent');
const schedule = require('./src/ai-bot/schedule');
const store = require('./src/ai-bot/store');
const session = require('./src/ai-bot/session');
const clock = require('./src/ai-bot/clock');

async function run() {
  console.log('===============================================================');
  console.log('🧪 TESTING FIXES FOR ALL THREE BUGS');
  console.log('===============================================================\n');

  const ADMIN_PHONE = '919821139201'; // Salman (Admin)
  const TARGET_SUNDAY = '2026-10-11';
  // Saturday 10:44 AM IST
  const MOCK_TIME = new Date('2026-10-10T10:44:00+05:30');
  clock.getCurrentTime = () => new Date(MOCK_TIME.getTime());
  clock.getCurrentTimestamp = () => MOCK_TIME.getTime();

  // Clear session & reset test data
  session.clearSession(ADMIN_PHONE);
  store.deleteTokensForDate(TARGET_SUNDAY);
  store.deleteOverridesForDate(TARGET_SUNDAY);
  schedule.invalidateCache();

  // Intercept WhatsApp patient notifications
  const sentNotifications = [];
  adminAgent.setNotificationSender(async (phone, text) => {
    sentNotifications.push({ phone, text });
    console.log(`   📲 [WhatsApp Outbound to ${phone}]: "${text}"`);
    return { success: true, message_id: `msg_${Date.now()}` };
  });

  // ─────────────────────────────────────────────────────────────
  // SETUP: Pre-allocate 3 tokens for Sunday (Shaheeb, Vaidha, Shahid)
  // ─────────────────────────────────────────────────────────────
  console.log('--- Step 0: Allocating 3 test tokens for 2026-10-11 ---');
  await schedule.allocateToken({
    phone: '919819749201',
    name: 'Shaheeb',
    slotPreference: 'morning',
    targetDate: TARGET_SUNDAY,
  });
  await schedule.allocateToken({
    phone: '919321652626',
    name: 'Vaidha Mimman',
    slotPreference: 'morning',
    targetDate: TARGET_SUNDAY,
  });
  await schedule.allocateToken({
    phone: '919322265260',
    name: 'Shahid',
    slotPreference: 'morning',
    targetDate: TARGET_SUNDAY,
  });

  let tokensInDb = schedule.getTokensForSunday(TARGET_SUNDAY);
  assert.strictEqual(tokensInDb.length, 3, 'Must have 3 tokens in SQLite');
  console.log('✅ 3 tokens allocated in SQLite\n');

  // ─────────────────────────────────────────────────────────────
  // BUG 2 VERIFICATION: Admin asks for token numbers and patient names
  // ─────────────────────────────────────────────────────────────
  console.log('--- Test Bug 2: Admin asks for token numbers and names ---');
  const queryMsg = 'What are the numbers and names of the three tokens';
  console.log(`Admin query: "${queryMsg}"`);
  const queryReply = await adminAgent.handleAdminMessage(ADMIN_PHONE, queryMsg, 'Salman');
  console.log('Bot Reply:\n' + queryReply);

  assert(queryReply.includes('Shaheeb'), 'Reply must include patient Shaheeb');
  assert(queryReply.includes('Vaidha Mimman'), 'Reply must include patient Vaidha Mimman');
  assert(queryReply.includes('Shahid'), 'Reply must include patient Shahid');
  assert(queryReply.includes('Token #1') || queryReply.includes('#1'), 'Reply must show Token #1');
  assert(queryReply.includes('Token #2') || queryReply.includes('#2'), 'Reply must show Token #2');
  assert(queryReply.includes('Token #3') || queryReply.includes('#3'), 'Reply must show Token #3');
  assert(!queryReply.toLowerCase().includes("i don't have information about specific token numbers"), 'Must NEVER claim no token information');
  console.log('✅ PASS: Bug 2 fixed - Admin received all patient names and token numbers!\n');

  // ─────────────────────────────────────────────────────────────
  // BUG 1 VERIFICATION: Booking window update and negative guard
  // ─────────────────────────────────────────────────────────────
  console.log('--- Test Bug 1a: Admin inquires "why can we book..." does NOT trigger booking flow ---');
  session.clearSession(ADMIN_PHONE);
  const inquiryMsg = 'even though i changed the booking opening window why can we book an appointment?';
  console.log(`Admin inquiry: "${inquiryMsg}"`);
  const inquiryReply = await adminAgent.handleAdminMessage(ADMIN_PHONE, inquiryMsg, 'Salman');
  console.log('Bot Reply:\n' + inquiryReply);

  const pendingAfterInquiry = session.getAdminPending(ADMIN_PHONE);
  assert(!pendingAfterInquiry || pendingAfterInquiry.type !== 'ADMIN_BOOK_PARTIAL',
    'Inquiry must NOT enter ADMIN_BOOK_PARTIAL state');
  assert(!inquiryReply.includes('Please provide:\n• Patient full name'),
    'Must NOT ask admin for patient full name upon an inquiry');
  console.log('✅ PASS: Bug 1a fixed - Inquiry question did not falsely trigger booking flow!\n');

  console.log('--- Test Bug 1b: Set booking window to Sunday 8am-9am and clear stale overrides ---');
  // First simulate an old stale override for Saturday 9am
  store.addOverride({
    target_date: TARGET_SUNDAY,
    type: 'capacity_change',
    booking_opens_at: 'Saturday 9:00 AM',
  });
  schedule.invalidateCache();

  // Admin updates booking window to Sunday 8:00 AM to 9:00 AM
  const setWindowMsg = 'change the booking window to sunday 8am to 9 am only for the coming weeks';
  const promptReply = await adminAgent.handleAdminMessage(ADMIN_PHONE, setWindowMsg, 'Salman');
  console.log('Bot Pre-confirmation prompt:\n' + promptReply);

  // Admin confirms "yes"
  const confirmSettingsReply = await adminAgent.handleAdminMessage(ADMIN_PHONE, 'yes', 'Salman');
  console.log('Bot Confirmation reply:\n' + confirmSettingsReply);

  // Check window status on Saturday 10:44 AM
  const windowStatus = await schedule.isBookingWindowOpen(clock.getCurrentTime(), TARGET_SUNDAY);
  console.log('Window status on Saturday 10:44 AM (should be closed):', windowStatus.open, '| message:', windowStatus.message);
  assert.strictEqual(windowStatus.open, false, 'Booking window must be CLOSED on Saturday 10:44 AM');

  // Try patient booking on Saturday 10:44 AM -> MUST BE REJECTED
  const PATIENT_PHONE = '919845845421'; // Molly
  session.clearSession(PATIENT_PHONE);
  const patientReply = await patientAgent.handlePatientMessage(PATIENT_PHONE, 'hi can i book an appointment', 'Molly');
  console.log('Patient reply on Saturday (outside window):\n' + patientReply);
  assert(!patientReply.includes('token is #'), 'Must NOT issue token outside window');
  assert(patientReply.includes('8:00 AM on Sunday') || patientReply.includes('Sunday') || patientReply.includes('closed') || patientReply.includes('open at'),
    'Must inform patient of closed window / open time');

  const countAfterPatientTry = schedule.getTokensForSunday(TARGET_SUNDAY).length;
  assert.strictEqual(countAfterPatientTry, 3, 'No new token should be allocated outside the window');
  console.log('✅ PASS: Bug 1b fixed - Stale override cleared and booking correctly blocked outside window!\n');

  // ─────────────────────────────────────────────────────────────
  // BUG 3 VERIFICATION: Bulk cancellation of tokens & automatic WhatsApp notifications
  // ─────────────────────────────────────────────────────────────
  console.log('--- Test Bug 3: Admin cancels all appointments for today/tomorrow ---');
  session.clearSession(ADMIN_PHONE);
  sentNotifications.length = 0; // reset counter

  const cancelCmd = 'cancel all given appointments for today';
  console.log(`Admin command: "${cancelCmd}"`);
  const cancelPromptReply = await adminAgent.handleAdminMessage(ADMIN_PHONE, cancelCmd, 'Salman');
  console.log('Bot Pre-confirmation Prompt:\n' + cancelPromptReply);

  assert(!cancelPromptReply.includes('Got the name: (unknown)'), 'Must NOT treat cancel command as patient name');
  assert(!cancelPromptReply.toLowerCase().includes('manual cancellation'), 'Must NOT claim manual cancellation is required');
  assert(cancelPromptReply.includes('3 patients hold tokens') || cancelPromptReply.includes('3') || cancelPromptReply.includes('cancel all'),
    'Prompt must recognize the 3 existing bookings');

  // Admin confirms "yes"
  console.log('\nAdmin confirms with "yes"...');
  const cancelConfirmReply = await adminAgent.handleAdminMessage(ADMIN_PHONE, 'yes', 'Salman');
  console.log('Bot Final Confirmation Reply:\n' + cancelConfirmReply);

  // 1. Confirm notifications were sent to all 3 patients
  assert.strictEqual(sentNotifications.length, 3, 'All 3 patients must receive WhatsApp cancellation notices');
  assert(sentNotifications.some(n => n.phone === '919819749201' && n.text.includes('Shaheeb')), 'Shaheeb notified');
  assert(sentNotifications.some(n => n.phone === '919321652626' && n.text.includes('Vaidha Mimman')), 'Vaidha notified');
  assert(sentNotifications.some(n => n.phone === '919322265260' && n.text.includes('Shahid')), 'Shahid notified');

  // 2. Confirm tokens were deleted in SQLite
  const remainingTokens = schedule.getTokensForSunday(TARGET_SUNDAY);
  assert.strictEqual(remainingTokens.length, 0, 'All tokens in SQLite must be deleted / reset to 0');

  // 3. Confirm admin reply summarizes the cancellation
  assert(cancelConfirmReply.includes('Cancelled all 3') || cancelConfirmReply.includes('Cancelled 3') || cancelConfirmReply.includes('3'),
    'Admin reply must confirm cancellation of 3 appointments');
  console.log('✅ PASS: Bug 3 fixed - Tokens deleted in SQLite and patients automatically notified via WhatsApp!\n');

  // ─────────────────────────────────────────────────────────────
  // ECHO DASHBOARD RECORDING VERIFICATION
  // ─────────────────────────────────────────────────────────────
  console.log('--- Test Echo Dashboard: Notification recorded in stores.recordOutboundMessage ---');
  adminAgent.setNotificationSender(null); // use real _sendPatientNotification path

  const cloudapi = require('./src/cloudapi');
  const stores = require('./src/stores');
  const recordedOutbound = [];
  const originalRecordOutbound = stores.recordOutboundMessage;
  stores.recordOutboundMessage = async (params) => {
    recordedOutbound.push(params);
    return originalRecordOutbound(params);
  };

  const originalSendText = cloudapi.sendText;
  cloudapi.sendText = async (phone, text) => {
    return {
      key: { id: `wamid.test.${Date.now()}`, remoteJid: `${phone}@s.whatsapp.net`, fromMe: true },
      status: 1,
      message: { conversation: text },
    };
  };

  // Re-allocate a token for Molly
  await schedule.allocateToken({
    phone: '919845845421',
    name: 'Molly Varghese',
    slotPreference: 'morning',
    targetDate: TARGET_SUNDAY,
  });

  // Cancel again through admin agent
  const cancelMolly = await adminAgent.handleAdminMessage(ADMIN_PHONE, 'cancel all given appointments for today', 'Salman');
  console.log('Cancel prompt:\n' + cancelMolly);
  const confirmMolly = await adminAgent.handleAdminMessage(ADMIN_PHONE, 'yes', 'Salman');
  console.log('Confirm reply:\n' + confirmMolly);

  assert(recordedOutbound.some(r => r.jid.includes('919845845421') && r.message.content.includes('Molly Varghese')),
    'Echo store MUST record outbound cancellation message to Molly Varghese so it shows in the Echo dashboard');
  console.log('✅ PASS: Outbound patient notification is recorded in Echo dashboard store!\n');

  // Restore mocks
  cloudapi.sendText = originalSendText;
  stores.recordOutboundMessage = originalRecordOutbound;

  console.log('===============================================================');
  console.log('🎉 ALL TESTS PASSED SUCCESSFULLY! ALL 3 BUGS RESOLVED!');
  console.log('===============================================================');
}

run().catch(err => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
