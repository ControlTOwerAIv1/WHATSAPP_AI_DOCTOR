/**
 * STEP 4 & 5: Doctor Agent Real SQLite Schedule & Today's Appointments Verification Test
 * Tests:
 * 1. Allocates test patient tokens in SQLite for a target operating date.
 * 2. Invokes doctor agent message handler under MOCK_CURRENT_TIME set to that date.
 * 3. Asserts _showTodayAppointments() displays real patient names, tokens, arrival times, and conditions.
 * 4. Asserts _showUpcomingSchedule() displays accurate booked and available counts matching SQLite.
 */

require('dotenv').config();
const assert = require('assert');
const botConfig = require('./src/ai-bot/config');
const schedule = require('./src/ai-bot/schedule');
const doctorAgent = require('./src/ai-bot/doctor-agent');
const session = require('./src/ai-bot/session');

async function testStep4And5Doctor() {
  console.log('================================================================');
  console.log("STEP 4 & 5: DOCTOR AGENT SCHEDULE & TODAY'S APPOINTMENTS TEST");
  console.log('================================================================\n');

  botConfig.init(process.cwd());

  const targetDate = '2026-10-11'; // A Sunday
  process.env.NODE_ENV = 'test';
  process.env.MOCK_CURRENT_TIME = `${targetDate}T10:00:00`;

  schedule.resetTokensForTesting(targetDate);

  const doctorInfo = {
    name: 'Sarah Jenkins',
    specialty: 'General Medicine',
  };
  const doctorPhone = '919876543000';

  console.log(`--- Allocating 2 test patients for ${targetDate} ---`);
  await schedule.allocateToken({
    phone: '919876543111',
    name: 'Alice Smith',
    slotPreference: 'morning',
    condition: 'Persistent Migraine',
    targetDate,
  });

  await schedule.allocateToken({
    phone: '919876543222',
    name: 'Bob Jones',
    slotPreference: 'morning',
    condition: 'Fever and Sore Throat',
    targetDate,
  });

  console.log('\n--- Testing Doctor Query: "what is my schedule for today" ---');
  session.clearSession(doctorPhone);
  const todayReply = await doctorAgent.handleDoctorMessage(
    doctorPhone,
    "what is my schedule for today",
    doctorInfo
  );

  console.log('🤖 Doctor Agent Reply:');
  console.log(todayReply);
  console.log('----------------------------------------------------------------\n');

  assert(todayReply.includes('Alice Smith'), "Reply must contain patient name 'Alice Smith'");
  assert(todayReply.includes('Bob Jones'), "Reply must contain patient name 'Bob Jones'");
  assert(todayReply.includes('Token #1'), 'Reply must contain Token #1');
  assert(todayReply.includes('Token #2'), 'Reply must contain Token #2');
  assert(todayReply.includes('Persistent Migraine'), 'Reply must contain Alice condition');
  assert(todayReply.includes('Fever and Sore Throat'), 'Reply must contain Bob condition');
  assert(todayReply.includes('2 booked'), 'Summary must report 2 booked');
  assert(todayReply.includes('43 available'), 'Summary must report 43 available (45 - 2)');
  console.log("✅ Step 5 Verified: _showTodayAppointments() displays real patient data and accurate summary.");

  console.log('\n--- Testing Doctor Query: "show upcoming schedule" ---');
  session.clearSession(doctorPhone);
  const upcomingReply = await doctorAgent.handleDoctorMessage(
    doctorPhone,
    "show upcoming schedule",
    doctorInfo
  );

  console.log('🤖 Doctor Agent Upcoming Schedule Reply:');
  console.log(upcomingReply);
  console.log('----------------------------------------------------------------\n');

  assert(upcomingReply.includes(targetDate), `Upcoming schedule must include target date ${targetDate}`);
  assert(upcomingReply.includes('2 booked'), 'Upcoming schedule must report 2 booked');
  assert(upcomingReply.includes('43 available'), 'Upcoming schedule must report 43 available');
  console.log("✅ Step 4 Verified: _showUpcomingSchedule() displays accurate booked and available counts matching SQLite.");

  console.log('\n✅ STEPS 4 & 5 TESTS PASSED: Doctor Agent fully integrated with SQLite and effective schedule!\n');
}

testStep4And5Doctor().catch(err => {
  console.error('\n❌ STEP 4 & 5 TEST FAILED:', err);
  process.exit(1);
});
