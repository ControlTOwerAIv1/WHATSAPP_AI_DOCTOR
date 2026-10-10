require('dotenv').config();
const assert = require('assert');
const path = require('path');
const { init } = require('./src/ai-bot/config');
init(__dirname);

const adminAgent = require('./src/ai-bot/admin-agent');
const schedule = require('./src/ai-bot/schedule');
const store = require('./src/ai-bot/store');
const cloudapi = require('./src/cloudapi');
const session = require('./src/ai-bot/session');

async function run() {
  console.log('===============================================================');
  console.log('🧪 TESTING SINGLE TOKEN CANCELLATION & CONFIRMATION FLOW');
  console.log('===============================================================');

  const ADMIN_PHONE = '919821139201'; // Salman
  const TARGET_SUNDAY = '2026-10-11';

  // Ensure clean session
  session.clearSession(ADMIN_PHONE);

  // Setup: Ensure Molly has Token #1 for 2026-10-11
  store.deleteTokensForDate(TARGET_SUNDAY);
  schedule.resetTokensForTesting(TARGET_SUNDAY);
  schedule.invalidateCache();

  const alloc = await schedule.allocateToken({
    phone: '919845845421',
    name: 'Molly Varghese',
    slotPreference: 'morning',
    targetDate: TARGET_SUNDAY,
  });
  assert(alloc.success, 'Test setup: token allocation for Molly must succeed');
  console.log(`✅ Setup: Token #${alloc.token.token_number} allocated for Molly Varghese`);

  // Mock cloudapi
  const sentPatientMessages = [];
  adminAgent.setNotificationSender(async (phone, text) => {
    sentPatientMessages.push({ phone, text });
    return { success: true };
  });

  // Test 1: "cancel this token"
  console.log('\n--- Test 1: Admin sends "cancel this token" ---');
  // First simulate asking for tokens as in the screenshot
  session.appendHistory(ADMIN_PHONE, 'user', 'gimme a list of token given out and the data');
  session.appendHistory(ADMIN_PHONE, 'assistant', `Good day, Admin.\n\nSchedule for Sunday, 2026-10-11 (next clinic day):\n\nToken #1 (MORNING): Molly Varghese\nArrival: around 11:00 AM\nPhone: 919845845421\n\nSummary: 1 booked, 44 available.`);

  const reply1 = await adminAgent.handleAdminMessage(ADMIN_PHONE, 'cancel this token', 'Salman');
  console.log('Bot Reply:\n' + reply1);

  assert(!reply1.includes('schedule change request'), 'Must NOT complain about schedule change request!');
  assert(reply1.includes('Molly Varghese') || reply1.includes('Molly'), 'Must recognize Molly Varghese from context/token');
  assert(reply1.includes('Token: #1') || reply1.includes('#1'), 'Must identify Token #1');
  assert(reply1.toLowerCase().includes('confirm'), 'Must ask for confirmation before deleting');
  console.log('✅ PASS: "cancel this token" generated cancellation summary for Molly!');

  // Test 2: Admin says "no" to abort
  console.log('\n--- Test 2: Admin aborts with "no" ---');
  const replyAbort = await adminAgent.handleAdminMessage(ADMIN_PHONE, 'no', 'Salman');
  console.log('Bot Reply:\n' + replyAbort);
  assert(replyAbort.includes('aborted') || replyAbort.includes('cancelled'), 'Must confirm abortion');

  // Verify token STILL exists in SQLite
  const existingToken = schedule.getTokenByPhone('919845845421', TARGET_SUNDAY);
  assert(existingToken, 'Token must NOT be deleted after aborting!');
  console.log('✅ PASS: Token was preserved after aborting.');

  // Test 3: Admin sends "cancel the token #1 from the database molly"
  console.log('\n--- Test 3: Admin sends "cancel the token #1 from the database molly" ---');
  const reply3 = await adminAgent.handleAdminMessage(ADMIN_PHONE, 'cancel the token #1 from the database molly', 'Salman');
  console.log('Bot Reply:\n' + reply3);

  assert(!reply3.includes('schedule change request'), 'Must NOT complain about schedule change request!');
  assert(reply3.includes('Molly Varghese') || reply3.includes('Molly'), 'Must identify Molly');
  assert(reply3.includes('#1'), 'Must identify Token #1');
  console.log('✅ PASS: "cancel the token #1 from the database molly" correctly generated confirmation summary!');

  // Test 4: Admin confirms with "yes"
  console.log('\n--- Test 4: Admin confirms deletion with "yes" ---');
  const replyConfirm = await adminAgent.handleAdminMessage(ADMIN_PHONE, 'yes', 'Salman');
  console.log('Bot Reply:\n' + replyConfirm);

  assert(replyConfirm.includes('Cancelled Token #1') || replyConfirm.includes('Token #1'), 'Must confirm Token #1 cancelled');

  // Verify token is DELETED in SQLite
  const tokenAfter = schedule.getTokenByPhone('919845845421', TARGET_SUNDAY);
  assert(!tokenAfter, 'Token must be DELETED from SQLite!');
  console.log('✅ PASS: Token #1 was deleted from SQLite database!');

  // Verify patient was notified via WhatsApp
  assert(sentPatientMessages.length > 0, 'Patient must be notified via WhatsApp!');
  assert(sentPatientMessages[0].phone === '919845845421', 'Notification must be sent to Molly (919845845421)!');
  assert(sentPatientMessages[0].text.includes('Token #1') || sentPatientMessages[0].text.includes('cancelled'),
    'Notification text must mention Token #1 cancellation!');
  console.log('✅ PASS: Patient notification sent to Molly: ' + sentPatientMessages[0].text);

  // Test 5: Admin tries to cancel token #1 again when none exist
  console.log('\n--- Test 5: Admin tries to cancel token #1 when none exist ---');
  const reply5 = await adminAgent.handleAdminMessage(ADMIN_PHONE, 'cancel token #1', 'Salman');
  console.log('Bot Reply:\n' + reply5);
  assert(reply5.includes('No active token') || reply5.includes('no active booked tokens'), 'Must state token does not exist');
  console.log('✅ PASS: Handled non-existent token gracefully.');

  console.log('\n===============================================================');
  console.log('🎉 ALL TOKEN CANCELLATION TESTS PASSED!');
  console.log('===============================================================');
  process.exit(0);
}

run().catch(err => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
