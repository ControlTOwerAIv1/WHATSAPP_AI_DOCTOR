require('dotenv').config();
const assert = require('assert');
const botConfig = require('./src/ai-bot/config');
botConfig.init('c:\\projects-imp\\whatsapp-relay');
const schedule = require('./src/ai-bot/schedule');
const adminAgent = require('./src/ai-bot/admin-agent');
const patientAgent = require('./src/ai-bot/patient-agent');
const session = require('./src/ai-bot/session');
const sheets = require('./src/ai-bot/sheets');

async function runTest() {
  console.log('=== TEST: Booking Window Override Resolution and Patient Booking ===\n');

  const ADMIN_PHONE = '919876543000';
  const PATIENT_PHONE = '919999888777';

  // 1. Doctor Admin sets mock time to Saturday 2026-09-12 20:15
  process.env.NODE_ENV = 'test';
  process.env.MOCK_CURRENT_TIME = '2026-09-12T20:15:00';

  session.clearSession(ADMIN_PHONE);
  session.clearSession(PATIENT_PHONE);

  console.log('Step 1: Admin sends booking window override command...');
  const cmd = 'Start taking appointments from 12th 20:30 pm';
  const reply1 = await adminAgent.handleAdminMessage(ADMIN_PHONE, cmd, 'Dr. Tariq');
  console.log('Admin Agent Reply 1:\n', reply1);

  // Check pending state in session
  const pending = session.getAdminPending(ADMIN_PHONE);
  assert(pending, 'Must have pending confirmation');
  console.log('Pending target_date:', pending.data?.target_date);
  console.log('Pending booking_opens_at:', pending.data?.booking_opens_at);

  assert.strictEqual(pending.data?.target_date, '2026-09-13', 'Target date MUST be clinic date 2026-09-13');
  assert.strictEqual(pending.target_tab, 'Overrides', 'Must target Overrides tab');

  // 2. Admin confirms
  console.log('\nStep 2: Admin confirms with "yes"...');
  const reply2 = await adminAgent.handleAdminMessage(ADMIN_PHONE, 'yes', 'Dr. Tariq');
  console.log('Admin Agent Reply 2:\n', reply2);
  assert(reply2.includes('Confirmed') || reply2.includes('2026-09-13'), 'Must confirm override for 2026-09-13');

  // 3. Verify effective schedule for 2026-09-13
  const effSched = await schedule.getEffectiveSchedule('2026-09-13');
  console.log('\nEffective schedule for 2026-09-13:');
  console.log('  start_time:', effSched.booking_window?.start_time);
  console.log('  start_display:', effSched.booking_window?.start_display);
  assert.strictEqual(effSched.booking_window?.start_time, '20:30', 'Booking window start_time must be 20:30');

  // 4. Test before 20:30 (e.g. 20:25) -> should be closed
  const timeBefore = new Date('2026-09-12T20:25:00');
  const statusBefore = await schedule.isBookingWindowOpen(timeBefore, '2026-09-13');
  console.log('\nWindow status at 20:25:', statusBefore.open, '| message:', statusBefore.message);
  assert.strictEqual(statusBefore.open, false, 'Window should be closed before 20:30');

  // 5. Test after 20:30 (e.g. 20:32) -> should be OPEN
  const timeAfter = new Date('2026-09-12T20:32:00');
  const statusAfter = await schedule.isBookingWindowOpen(timeAfter, '2026-09-13');
  console.log('Window status at 20:32:', statusAfter.open, '| message:', statusAfter.message);
  assert.strictEqual(statusAfter.open, true, 'Window should be OPEN after 20:30');

  // 6. Test Patient booking at 20:32
  process.env.MOCK_CURRENT_TIME = '2026-09-12T20:32:00';
  console.log('\nStep 3: Patient requests token at 20:32 (mocked)...');
  const patientReply1 = await patientAgent.handlePatientMessage(PATIENT_PHONE, 'I need an appointment with Dr. Tariq Khan', 'Test Patient');
  console.log('Patient Bot Reply 1:\n', patientReply1);

  // Bot should NOT say window closed ("will open at 9:00 PM"). It should proceed with booking!
  assert(!patientReply1.toLowerCase().includes('will open at'), 'Must not say booking window is closed');

  console.log('\n✅ ALL VERIFICATION CHECKS PASSED!');
  process.exit(0);
}

runTest().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
