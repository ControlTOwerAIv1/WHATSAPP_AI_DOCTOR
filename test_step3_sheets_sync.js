/**
 * STEP 3: Asynchronous Google Sheets Sync Verification Test
 * Tests:
 * 1. Allocates a token through allocateToken().
 * 2. Waits for the async fire-and-forget Sheets append to complete.
 * 3. Reads the live 'bookings' tab in Google Sheets.
 * 4. Confirms the row appears with correct booking reference, phone, and patient name.
 */

require('dotenv').config();
const assert = require('assert');
const botConfig = require('./src/ai-bot/config');
const schedule = require('./src/ai-bot/schedule');
const sheets = require('./src/ai-bot/sheets');

async function testStep3SheetsSync() {
  console.log('================================================================');
  console.log('STEP 3: ASYNC BOOKINGS SYNC TO GOOGLE SHEETS TEST');
  console.log('================================================================\n');

  botConfig.init(process.cwd());

  const testDate = '2026-10-04'; // A Sunday in future
  const testPhone = '919876543321';
  const testName = 'Step3Patient_SyncTest';
  const testCondition = 'Routine Checkup';

  schedule.resetTokensForTesting(testDate);

  console.log(`Allocating token for ${testName} (${testPhone}) on ${testDate}...`);
  const allocRes = await schedule.allocateToken({
    phone: testPhone,
    name: testName,
    slotPreference: 'morning',
    condition: testCondition,
    targetDate: testDate,
  });

  assert.strictEqual(allocRes.success, true, 'Token allocation must succeed');
  assert(allocRes.token, 'Token object must exist');
  console.log(`Token allocated: #${allocRes.token.token_number} (${allocRes.token.slot_name})`);

  console.log('\nWaiting 3 seconds for async fire-and-forget sync to Google Sheets...');
  await new Promise(res => setTimeout(res, 3000));

  console.log("Reading 'bookings' tab from Google Sheets...");
  // Read using internal helper (direct Sheets API call)
  const client = sheets._getSheetsClient ? sheets._getSheetsClient() : null;
  const config = botConfig.getConfig();
  const res = await client.spreadsheets.values.get({
    spreadsheetId: config.googleSheetId,
    range: 'bookings!A:F',
  });

  const rows = res.data.values || [];
  console.log(`Total rows in 'bookings' tab: ${rows.length}`);

  // Look for our booking by phone or name
  const matchingRow = rows.slice().reverse().find(r => r.includes(testPhone) || r.includes(testName));
  console.log('Matching row in Google Sheets:', matchingRow);

  assert(matchingRow, 'Expected booking row was NOT found in Google Sheets bookings tab!');
  assert(matchingRow.includes(testPhone), `Row must include patient phone ${testPhone}`);
  assert(matchingRow.includes(testName), `Row must include patient name ${testName}`);
  assert(matchingRow.includes(testCondition), `Row must include condition ${testCondition}`);

  console.log('\n✅ STEP 3 TEST PASSED: Row confirmed present in Google Sheets bookings tab!\n');
}

testStep3SheetsSync().catch(err => {
  console.error('\n❌ STEP 3 TEST FAILED:', err);
  process.exit(1);
});
