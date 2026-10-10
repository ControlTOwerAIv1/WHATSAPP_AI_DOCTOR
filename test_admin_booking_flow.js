require('dotenv').config();
const assert = require('assert');
const path = require('path');
const { init } = require('./src/ai-bot/config');
init(__dirname);

const adminAgent = require('./src/ai-bot/admin-agent');
const schedule = require('./src/ai-bot/schedule');
const store = require('./src/ai-bot/store');
const cloudapi = require('./src/cloudapi');

async function run() {
  console.log('===============================================================');
  console.log('🧪 TESTING ADMIN PATIENT BOOKING VS OVERRIDE CLASSIFICATION');
  console.log('===============================================================');

  const ADMIN_PHONE = '919821139201'; // Salman from contacts
  const TARGET_SUNDAY = '2026-10-11';

  // Clean test state for date
  store.deleteTokensForDate(TARGET_SUNDAY);
  schedule.resetTokensForTesting(TARGET_SUNDAY);
  schedule.invalidateCache();

  // Mock cloudapi so WhatsApp isn't really called
  const originalSendText = cloudapi.sendText;
  const sentPatientMessages = [];
  cloudapi.sendText = async (phone, text) => {
    sentPatientMessages.push({ phone, text });
    return {
      key: { id: `wamid.test.${Date.now()}`, remoteJid: `${phone}@s.whatsapp.net`, fromMe: true },
      status: 1,
      message: { conversation: text },
    };
  };

  // Test 1: "hi book an appointment molly"
  console.log('\n--- Test 1: Admin sends "hi book an appointment molly" ---');
  const reply1 = await adminAgent.handleAdminMessage(ADMIN_PHONE, 'hi book an appointment molly', 'Salman');
  console.log('Bot Reply:\n' + reply1);

  // Assert it DID NOT ask for an override or mention Overrides tab
  assert(!reply1.toLowerCase().includes('override'), 'Bot MUST NOT ask for an override when admin books for a patient!');
  assert(!reply1.toLowerCase().includes('open bookings'), 'Bot MUST NOT offer to open bookings when admin books for a patient!');
  assert(reply1.includes('Admin booking summary') || reply1.includes('Molly'),
    'Bot MUST recognize patient booking and offer booking summary for Molly!');
  assert(reply1.includes('919845845421'), 'Bot should auto-resolve Molly Varghese phone (919845845421) from contacts!');
  console.log('✅ PASS: "hi book an appointment molly" correctly routed to Admin Booking instead of Overrides tab!');

  // Test 2: Admin confirms with "yes"
  console.log('\n--- Test 2: Admin confirms booking with "yes" ---');
  const confirmReply = await adminAgent.handleAdminMessage(ADMIN_PHONE, 'yes', 'Salman');
  console.log('Bot Reply:\n' + confirmReply);

  assert(confirmReply.includes('booked for Molly') || confirmReply.includes('Molly Varghese'),
    'Bot must confirm booking for Molly');
  
  // Verify token in database
  const token = schedule.getTokenByPhone('919845845421', TARGET_SUNDAY);
  assert(token, 'Token for Molly must be stored in appointments_tokens in SQLite!');
  assert(token.patient_name.toLowerCase().includes('molly'), 'Token patient name must be Molly');
  console.log(`✅ PASS: Token #${token.token_number} allocated for Molly Varghese on ${TARGET_SUNDAY} in SQLite!`);

  // Test 3: Admin books with phone number "book token for David 919999888777"
  console.log('\n--- Test 3: Admin books with explicit name and phone ---');
  const reply3 = await adminAgent.handleAdminMessage(ADMIN_PHONE, 'book token for David 919999888777', 'Salman');
  console.log('Bot Reply:\n' + reply3);
  assert(!reply3.toLowerCase().includes('override'), 'Bot MUST NOT ask for an override!');
  assert(reply3.includes('David') && reply3.includes('919999888777'), 'Bot must summarize booking for David with phone');
  console.log('✅ PASS: Explicit name and phone booking summary generated without override prompt!');

  // Cancel David draft
  await adminAgent.handleAdminMessage(ADMIN_PHONE, 'cancel', 'Salman');

  // Test 4: Regression check - Admin question should NOT trigger booking
  console.log('\n--- Test 4: Regression check - Question does NOT trigger booking ---');
  const reply4 = await adminAgent.handleAdminMessage(ADMIN_PHONE, 'even though i changed the booking opening window why can we book an appointment?', 'Salman');
  assert(!reply4.includes('Admin booking summary'), 'Inquiry must NOT trigger booking flow');
  console.log('✅ PASS: Inquiries remain correctly classified as questions!');

  // Restore mock
  cloudapi.sendText = originalSendText;

  console.log('\n===============================================================');
  console.log('🎉 ALL ADMIN BOOKING TESTS PASSED PERFECTLY!');
  console.log('===============================================================');
  process.exit(0);
}

run().catch(err => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
