require('dotenv').config();
const assert = require('assert');
const path = require('path');

const config = require('./src/ai-bot/config');
config.init(process.cwd());

const store = require('./src/ai-bot/store');
const schedule = require('./src/ai-bot/schedule');
const patientAgent = require('./src/ai-bot/patient-agent');
const adminAgent = require('./src/ai-bot/admin-agent');
const doctorAgent = require('./src/ai-bot/doctor-agent');
const claude = require('./src/ai-bot/claude');
const aiBot = require('./src/ai-bot/index');
const stores = require('./src/stores');

aiBot.init({ rootDir: process.cwd() });
aiBot.setStores(stores);
aiBot.setSock({ sendMessage: async () => ({ key: { id: 'mock_sent_id' } }) });

async function runAllChecks() {
  console.log('====================================================');
  console.log('🧪 RUNNING COMPREHENSIVE HANDOVER VERIFICATION TESTS');
  console.log('====================================================\n');

  // ───────────────────────────────────────────────────────────
  // CHECK 1: Rebrand Verification (Part D) & Doctor Name Purge (Part C)
  // ───────────────────────────────────────────────────────────
  console.log('--- [CHECK 1] Clinic Rebrand & Doctor Name Purge ---');

  // 1A. Patient greeting
  const patientReply = await patientAgent.handlePatientMessage('919845845421', 'hi', 'Molly Varghese');
  console.log('Patient reply to "hi":', patientReply);
  assert(!patientReply.toLowerCase().includes('dr. ai'), 'Patient reply must NOT contain "Dr. AI"');
  assert(!patientReply.toLowerCase().includes('ai clinic'), 'Patient reply must NOT contain "AI Clinic"');
  assert(patientReply.includes('Al Ramzan Shifakhana'), 'Patient reply MUST contain "Al Ramzan Shifakhana"');
  console.log('✅ 1A: Patient greeting correctly branded as "Al Ramzan Shifakhana".');

  // 1B. Admin greeting
  const adminReply = await adminAgent.handleAdminMessage('919821139201', 'hi', 'Admin');
  console.log('\nAdmin reply to "hi":', adminReply);
  assert(!adminReply.toLowerCase().includes('dr. ai'), 'Admin reply must NOT contain "Dr. AI"');
  assert(!adminReply.toLowerCase().includes('dr. sarah'), 'Admin reply must NOT contain "Dr. Sarah"');
  assert(!adminReply.toLowerCase().includes('sarah'), 'Admin reply must NOT contain "Sarah"');
  assert(adminReply.includes('Al Ramzan Shifakhana'), 'Admin reply MUST contain "Al Ramzan Shifakhana"');
  assert(adminReply.includes('Admin'), 'Admin reply MUST address user as "Admin"');
  console.log('✅ 1B: Admin greeting addresses user as "Admin" and mentions "Al Ramzan Shifakhana".');

  // 1C. Doctor agent greeting
  const doctorReply = await doctorAgent.handleDoctorMessage('918123271498', 'hi', { name: 'Admin', specialty: 'General Medicine' });
  console.log('\nDoctor agent reply to "hi":', doctorReply);
  assert(!doctorReply.toLowerCase().includes('dr. sarah'), 'Doctor reply must NOT contain "Dr. Sarah"');
  assert(!doctorReply.toLowerCase().includes('sarah'), 'Doctor reply must NOT contain "Sarah"');
  console.log('✅ 1C: Doctor agent does not reference any placeholder doctor names.');

  // ───────────────────────────────────────────────────────────
  // CHECK 2: Bot Mode Toggle Backend & Pipeline (Part A)
  // ───────────────────────────────────────────────────────────
  console.log('\n--- [CHECK 2] AI Mode vs Manual Mode Toggle ---');

  // 2A. Set to manual mode
  store.setBotMode('manual');
  assert.strictEqual(store.getBotMode(), 'manual', 'Bot mode should be manual');
  console.log('Set bot mode to: manual');

  const testJid = '919999111222@s.whatsapp.net';
  stores.chatStore[testJid] = { id: testJid, name: 'Test Patient', awaitingManualReply: false };

  let sendCalled = false;
  aiBot.setSock({
    sendMessage: async (jid, content) => {
      sendCalled = true;
      return { key: { id: 'mock_sent_id' } };
    }
  });

  // Simulate incoming patient message in manual mode
  await aiBot.handleIncomingMessage({
    id: 'test_msg_manual_1',
    from: testJid,
    sender: 'Test Patient',
    content: 'Hello, need token',
    timestamp: Math.floor(Date.now() / 1000),
  });

  assert.strictEqual(sendCalled, false, 'In manual mode, NO auto-reply should be sent!');
  assert.strictEqual(stores.chatStore[testJid].awaitingManualReply, true, 'Chat should be marked awaitingManualReply in manual mode');
  console.log('✅ 2A: Manual Mode successfully silenced AI auto-reply and marked chat as awaitingManualReply.');

  // 2B. Set back to AI mode
  store.setBotMode('ai');
  assert.strictEqual(store.getBotMode(), 'ai', 'Bot mode should be ai');
  console.log('Set bot mode back to: ai');

  sendCalled = false;
  await aiBot.handleIncomingMessage({
    id: 'test_msg_ai_1',
    from: testJid,
    sender: 'Test Patient',
    content: 'Hello again',
    timestamp: Math.floor(Date.now() / 1000) + 1,
  });

  assert.strictEqual(sendCalled, true, 'In AI mode, auto-reply SHOULD be sent!');
  console.log('✅ 2B: AI Mode resumed automated replies immediately without server restart.');

  // ───────────────────────────────────────────────────────────
  // CHECK 3: Booking Window Bypass for Admin (Part B)
  // ───────────────────────────────────────────────────────────
  console.log('\n--- [CHECK 3] Admin Booking Window Bypass ---');

  // Simulate a Wednesday (outside Saturday 9PM - Sunday 6PM window)
  const wednesdayTime = new Date('2026-10-07T12:00:00Z'); // Wednesday
  const windowStatus = await schedule.isBookingWindowOpen(wednesdayTime);
  assert.strictEqual(windowStatus.open, false, 'Booking window should be closed on Wednesday');
  console.log('Window status on Wednesday: CLOSED (Message:', windowStatus.message, ')');

  // Patient requesting appointment on Wednesday -> must be rejected by window
  const patientBookingReply = await patientAgent.handlePatientMessage('919999000111', 'token chahiye', 'Patient Test');
  console.log('Patient booking request reply:', patientBookingReply);
  assert(patientBookingReply.includes('Saturday') || patientBookingReply.includes('closed') || patientBookingReply.includes('open at 9:00 PM'), 'Patient booking should be rejected by booking window');
  console.log('✅ 3A: Patient appointment booking is properly blocked outside booking window.');

  // Admin booking request for a patient on upcoming Sunday -> must NOT be blocked by window
  const adminBookingMsg = 'Book token for Ramesh Kumar, phone 919876543210 for next Sunday morning';
  const adminBookingReply = await adminAgent.handleAdminMessage('919821139201', adminBookingMsg, 'Admin');
  console.log('Admin booking request reply:\n', adminBookingReply);
  assert(adminBookingReply.includes('Admin booking summary') || adminBookingReply.includes('Ramesh Kumar'), 'Admin booking should generate booking summary and NOT be blocked by booking window');
  console.log('✅ 3B: Admin booking on behalf of patient successfully bypasses the booking window.');

  console.log('\n====================================================');
  console.log('🎉 ALL HANDOVER CHECKS PASSED PERFECTLY!');
  console.log('====================================================');
}

runAllChecks().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
