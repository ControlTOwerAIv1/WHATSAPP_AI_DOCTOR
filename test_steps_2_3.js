/**
 * Test Step 2 (Hindi mirroring on name prompt) and Step 3 (Dr. Dr. duplicate fix).
 */

require('dotenv').config();
const path = require('path');
const botConfig = require('./src/ai-bot/config');
botConfig.init(__dirname);

const patientAgent = require('./src/ai-bot/patient-agent');
const doctorAgent = require('./src/ai-bot/doctor-agent');
const adminAgent = require('./src/ai-bot/admin-agent');
const session = require('./src/ai-bot/session');
const clock = require('./src/ai-bot/clock');

// Mock clock to open booking window: Saturday 9:30 PM
const MOCK_TIME = new Date('2026-09-12T21:30:00+05:30');
clock.getCurrentTime = () => new Date(MOCK_TIME.getTime());
clock.getCurrentTimestamp = () => MOCK_TIME.getTime();

async function run() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('STEP 2: TESTING HINDI MIRRORING ON "PLEASE GIVE YOUR NAME"');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Test 2A: "token dena"
  const phoneA = '919999000777';
  session.clearSession(phoneA);
  const replyA = await patientAgent.handlePatientMessage(phoneA, 'token dena', 'Molly Varghese');
  console.log('Input: "token dena"');
  console.log('Literal bot reply:\n---\n' + replyA + '\n---\n');

  // Test 2B: "ek token chahiye"
  const phoneB = '919999000888';
  session.clearSession(phoneB);
  const replyB = await patientAgent.handlePatientMessage(phoneB, 'ek token chahiye', 'Molly Varghese');
  console.log('Input: "ek token chahiye"');
  console.log('Literal bot reply:\n---\n' + replyB + '\n---\n');

  // Test 2C: Non-name phrase like "Samaj nhi aya" after being asked for name
  console.log('Input after name prompt: "Samaj nhi aya"');
  const replyC = await patientAgent.handlePatientMessage(phoneA, 'Samaj nhi aya', 'Molly Varghese');
  console.log('Literal bot reply:\n---\n' + replyC + '\n---\n');

  console.log('═══════════════════════════════════════════════════════════');
  console.log('STEP 3: TESTING "Dr. Dr." DUPLICATE FIX');
  console.log('═══════════════════════════════════════════════════════════\n');

  const doctorInfo = { name: 'Dr. Sarah', specialty: 'General Medicine' };
  const doctorPhone = '918123271498';
  session.clearSession(doctorPhone);

  // Test 3A: Direct doctor agent query
  const replyDoc = await doctorAgent.handleDoctorMessage(doctorPhone, 'how many tokens for this Sunday', doctorInfo);
  console.log('Input (Doctor): "how many tokens for this Sunday"');
  console.log('Literal bot reply:\n---\n' + replyDoc + '\n---\n');

  // Test 3B: Via admin agent delegation (as occurred in live logs: "Gimme the list of all 16")
  session.clearSession(doctorPhone);
  const replyAdminDelegated = await adminAgent.handleAdminMessage(doctorPhone, 'Gimme the list of all 16', 'Pristin Varghese', doctorInfo);
  console.log('Input (Admin/Doctor): "Gimme the list of all 16"');
  console.log('Literal bot reply (first 300 chars):\n---\n' + replyAdminDelegated.substring(0, 300) + '...\n---\n');

  // Verify double "Dr. Dr."
  const hasDrDr = replyDoc.includes('Dr. Dr.') || replyAdminDelegated.includes('Dr. Dr.');
  console.log(`Contains "Dr. Dr.": ${hasDrDr ? 'YES (BUG)' : 'NO (PASSED ✅)'}`);
}

run().catch(err => console.error('Test error:', err));
