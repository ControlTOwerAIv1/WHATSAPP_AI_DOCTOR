/**
 * Test script for Bugs 1-4 verification.
 * Tests tone, name resolution, sheets write correctness, and concurrency.
 *
 * Usage: node test_bugs_1234.js
 */

require('dotenv').config();
const path = require('path');

// Initialize bot config (needed before requiring agents)
const botConfig = require('./src/ai-bot/config');
botConfig.init(__dirname);

const patientAgent = require('./src/ai-bot/patient-agent');
const session = require('./src/ai-bot/session');
const schedule = require('./src/ai-bot/schedule');
const sheets = require('./src/ai-bot/sheets');
const { google } = require('googleapis');
const fs = require('fs');

// Override clock to ensure booking window is open (Saturday 9 PM)
const clock = require('./src/ai-bot/clock');
const MOCK_TIME = new Date('2026-09-12T21:30:00+05:30'); // Saturday 9:30 PM — window open
clock.getCurrentTime = () => new Date(MOCK_TIME.getTime());
clock.getCurrentTimestamp = () => MOCK_TIME.getTime();

const TARGET_DATE = '2026-09-13'; // Sunday

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    testsPassed++;
  } else {
    console.log(`  ❌ FAIL: ${message}`);
    testsFailed++;
  }
}

// ─── BUG 1: Tone Tests ─────────────────────────────────────────────

async function testBug1_Tone() {
  console.log('\n═══ BUG 1: TONE TESTS ═══\n');

  // Reset tokens for clean state
  schedule.resetTokensForTesting(TARGET_DATE);

  // Test English confirmation
  const phone1 = '919999900001';
  session.clearSession(phone1);

  // Set name in session, then book
  session.updateSession(phone1, { name: 'Tariq', stage: 'booking_waiting_for_name' });
  const replyEn = await patientAgent.handlePatientMessage(phone1, 'Tariq', 'SomeWhatsAppName');
  
  console.log('--- English Confirmation ---');
  console.log(replyEn);
  console.log('---');

  assert(!replyEn.includes('Namaste'), 'No "Namaste" in English reply');
  assert(!replyEn.includes('ji!'), 'No "ji!" in English reply');
  assert(!replyEn.includes('🙏'), 'No 🙏 emoji in English reply');
  assert(!replyEn.includes('👤'), 'No 👤 emoji in English reply');
  assert(!replyEn.includes('🎫'), 'No 🎫 emoji in English reply');
  assert(!replyEn.includes('⏰'), 'No ⏰ emoji in English reply');
  assert(replyEn.includes('Your appointment is confirmed'), 'Contains professional confirmation');
  assert(replyEn.includes('Name: Tariq'), 'Contains Name: field');
  assert(replyEn.includes('Token: #'), 'Contains Token: field');
  assert(replyEn.includes('Time: Approx.'), 'Contains Time: Approx. field');
  assert(replyEn.includes('Please arrive around this time'), 'Contains professional closing');

  // Test Hindi confirmation
  const phone2 = '919999900002';
  session.clearSession(phone2);
  schedule.resetTokensForTesting(TARGET_DATE);

  session.updateSession(phone2, { name: 'Rahul', stage: 'booking_waiting_for_name' });
  const replyHi = await patientAgent.handlePatientMessage(phone2, 'Mera naam Rahul hai, token chahiye', 'SomeContact');

  console.log('\n--- Hindi Confirmation ---');
  console.log(replyHi);
  console.log('---');

  assert(!replyHi.includes('Namaste'), 'No "Namaste" in Hindi reply');
  assert(!replyHi.includes('ji!'), 'No "ji!" in Hindi reply');
  assert(!replyHi.includes('🙏'), 'No 🙏 emoji in Hindi reply');
  assert(!replyHi.includes('👤'), 'No 👤 emoji in Hindi reply');
  assert(replyHi.includes('confirm ho gaya'), 'Contains Hindi confirmation');
  assert(replyHi.includes('Naam:'), 'Contains Naam: field');
  assert(replyHi.includes('Token: #'), 'Contains Token: field');
  assert(replyHi.includes('Samay: Lagbhag'), 'Contains Samay: Lagbhag field');

  // Test duplicate notice
  const replyDup = await patientAgent.handlePatientMessage(phone2, 'Token chahiye', 'SomeContact');
  console.log('\n--- Hindi Duplicate Notice ---');
  console.log(replyDup);
  console.log('---');

  assert(!replyDup.includes('Namaste'), 'No "Namaste" in duplicate notice');
  assert(!replyDup.includes('ji!'), 'No "ji!" in duplicate notice');
  assert(!replyDup.includes('🙏'), 'No 🙏 emoji in duplicate notice');
  assert(replyDup.includes('pehle se booked'), 'Contains "already booked" in Hindi');

  // Print formatted versions for review
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  FINAL ENGLISH WORDING (for review):         ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(replyEn);

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  FINAL HINDI WORDING (for review):           ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(replyHi);
}

// ─── BUG 2: Name Resolution Tests ──────────────────────────────────

async function testBug2_NameResolution() {
  console.log('\n\n═══ BUG 2: NAME RESOLUTION TESTS ═══\n');

  schedule.resetTokensForTesting(TARGET_DATE);

  // Scenario: "Token chahiye" from a phone with WhatsApp display name "Salman"
  const phone = '919999900003';
  session.clearSession(phone);

  const reply = await patientAgent.handlePatientMessage(phone, 'Token chahiye', 'Salman');

  console.log('--- Reply when senderName="Salman" but no name in message ---');
  console.log(reply);
  console.log('---');

  // The bot should ASK for name, not use "Salman" from WhatsApp push name
  assert(!reply.includes('Salman'), 'Does NOT use WhatsApp push name "Salman"');
  assert(
    reply.includes('naam') || reply.includes('name') || reply.includes('Name'),
    'Asks for name explicitly'
  );

  // Verify session stage is waiting for name
  const sess = session.getSession(phone);
  assert(sess.stage === 'booking_waiting_for_name', 'Session stage set to booking_waiting_for_name');

  // Now provide the name
  const reply2 = await patientAgent.handlePatientMessage(phone, 'Fatima', 'Salman');
  console.log('\n--- Reply after providing name "Fatima" ---');
  console.log(reply2);
  console.log('---');

  assert(reply2.includes('Fatima'), 'Booking uses explicitly typed name "Fatima"');
  assert(!reply2.includes('Salman'), 'Does NOT use WhatsApp push name in booking');

  // Test with phone number as senderName (the root cause of Bug 3a)
  const phone3 = '919999900004';
  session.clearSession(phone3);
  schedule.resetTokensForTesting(TARGET_DATE);

  const reply3 = await patientAgent.handlePatientMessage(phone3, 'I need an appointment', '919999900004');
  console.log('\n--- Reply when senderName=phone number ---');
  console.log(reply3);
  console.log('---');

  assert(
    reply3.includes('name') || reply3.includes('Name'),
    'Asks for name when senderName is a phone number'
  );
  assert(!reply3.includes('919999900004'), 'Does NOT use phone number as name');
}

// ─── BUG 3: Sheets Write Tests ──────────────────────────────────────

async function testBug3_SheetsWrites() {
  console.log('\n\n═══ BUG 3: SHEETS WRITE TESTS ═══\n');

  schedule.resetTokensForTesting(TARGET_DATE);

  // Test single booking with real name and phone — verify RAW mode
  const phone = '919876543210';
  const name = 'Ahmad Khan';
  session.clearSession(phone);

  // Pre-set name in session to skip the ask-for-name flow
  session.updateSession(phone, { name, stage: 'booking_waiting_for_name' });
  const reply = await patientAgent.handlePatientMessage(phone, name, phone);
  
  console.log('--- Booking reply ---');
  console.log(reply);
  console.log('---');

  assert(reply.includes('Ahmad Khan'), 'Booking contains correct name');
  assert(reply.includes('confirmed') || reply.includes('confirm'), 'Booking is confirmed');

  // Wait for fire-and-forget Sheets sync to complete
  console.log('\n  Waiting 5s for Sheets sync...');
  await new Promise(res => setTimeout(res, 5000));

  // Verify in Google Sheets
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: path.join(__dirname, process.env.GOOGLE_CREDENTIALS_FILE || 'credentials.json'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheetsClient = google.sheets({ version: 'v4', auth });
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'bookings',
    });
    const rows = response.data.values || [];
    console.log(`  Sheets bookings tab: ${rows.length} rows (including header)`);

    if (rows.length > 1) {
      const lastRow = rows[rows.length - 1];
      console.log(`  Last row: ${lastRow.join(' | ')}`);

      // Check name column (index 2) and phone column (index 3)
      const sheetName = lastRow[2];
      const sheetPhone = lastRow[3];
      assert(sheetName === 'Ahmad Khan', `Sheets name field = "${sheetName}" (expected "Ahmad Khan")`);
      assert(sheetPhone === '919876543210', `Sheets phone stored as plain text: "${sheetPhone}"`);
      assert(!sheetPhone.startsWith("'"), 'Phone does not have leading apostrophe');
    }
  } catch (err) {
    console.log(`  ⚠️ Could not verify Sheets (${err.message}) — will verify manually`);
  }
}

// ─── BUG 3c: Concurrent Stress Test ────────────────────────────────

async function testBug3_ConcurrentStress() {
  console.log('\n\n═══ BUG 3c: CONCURRENT STRESS TEST ═══\n');

  schedule.resetTokensForTesting(TARGET_DATE);

  const NUM_CONCURRENT = 15;
  console.log(`  Launching ${NUM_CONCURRENT} concurrent bookings...`);

  const promises = [];
  for (let i = 1; i <= NUM_CONCURRENT; i++) {
    const phone = `9199990${String(i).padStart(5, '0')}`;
    const name = `StressTest_${i}`;
    session.clearSession(phone);
    session.updateSession(phone, { name, stage: 'booking_waiting_for_name' });

    promises.push(
      patientAgent.handlePatientMessage(phone, name, phone)
        .then(reply => ({ phone, name, reply, success: true }))
        .catch(err => ({ phone, name, error: err.message, success: false }))
    );
  }

  const results = await Promise.all(promises);

  let confirmed = 0;
  let failed = 0;
  for (const r of results) {
    if (r.success && (r.reply.includes('confirmed') || r.reply.includes('confirm'))) {
      confirmed++;
    } else {
      failed++;
      console.log(`  ⚠️ ${r.name}: ${r.reply?.substring(0, 80) || r.error}`);
    }
  }

  console.log(`\n  Results: ${confirmed} confirmed, ${failed} failed/other`);
  assert(confirmed === NUM_CONCURRENT, `All ${NUM_CONCURRENT} bookings confirmed`);

  // Count SQLite rows
  const sqliteTokens = schedule.getTokensForSunday(TARGET_DATE);
  console.log(`  SQLite rows for ${TARGET_DATE}: ${sqliteTokens.length}`);
  assert(sqliteTokens.length === NUM_CONCURRENT, `SQLite has exactly ${NUM_CONCURRENT} tokens`);

  // Wait for Sheets sync
  console.log('  Waiting 10s for all Sheets syncs to complete...');
  await new Promise(res => setTimeout(res, 10000));

  // Count Sheets rows
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: path.join(__dirname, process.env.GOOGLE_CREDENTIALS_FILE || 'credentials.json'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheetsClient = google.sheets({ version: 'v4', auth });
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'bookings',
    });
    const rows = response.data.values || [];
    const dataRows = rows.length > 0 ? rows.length - 1 : 0; // Subtract header
    console.log(`  Sheets bookings data rows: ${dataRows}`);

    // Account for the single booking from testBug3_SheetsWrites (if it ran)
    // We expect at least NUM_CONCURRENT rows
    assert(dataRows >= NUM_CONCURRENT, `Sheets has >= ${NUM_CONCURRENT} data rows (actual: ${dataRows})`);

    console.log(`\n  ╔══════════════════════════════════════════════╗`);
    console.log(`  ║  SQLite rows: ${String(sqliteTokens.length).padEnd(5)} | Sheets rows: ${String(dataRows).padEnd(5)}  ║`);
    console.log(`  ╚══════════════════════════════════════════════╝`);
  } catch (err) {
    console.log(`  ⚠️ Could not read Sheets for comparison (${err.message})`);
  }

  // Check sync_failures.json
  const syncPath = path.join(__dirname, 'data', 'sync_failures.json');
  if (fs.existsSync(syncPath)) {
    const failures = JSON.parse(fs.readFileSync(syncPath, 'utf8'));
    console.log(`  sync_failures.json: ${failures.length} entries`);
    assert(failures.length === 0, 'No sync failures remaining');
  } else {
    console.log('  sync_failures.json: does not exist (good)');
  }
}

// ─── MAIN ───────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║     BUG 1-4 VERIFICATION TEST SUITE         ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`Mock time: ${MOCK_TIME.toISOString()}`);
  console.log(`Target date: ${TARGET_DATE}`);

  await testBug1_Tone();
  await testBug2_NameResolution();
  await testBug3_SheetsWrites();
  await testBug3_ConcurrentStress();

  console.log('\n\n═══════════════════════════════════════════════');
  console.log(`  TOTAL: ${testsPassed} passed, ${testsFailed} failed`);
  console.log('═══════════════════════════════════════════════\n');

  if (testsFailed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test suite error:', err);
  process.exit(1);
});
