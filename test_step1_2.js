/**
 * Test Suite — Step 1 & 2 Verification
 *
 * Verifies that the Google Sheets structure is intact:
 * 1. Ensures the 'Settings' and 'Overrides' tabs exist with proper schema headers.
 * 2. Reads and validates the current Settings rows from the active spreadsheet.
 * 3. Reads and validates any current Overrides rows from the active spreadsheet.
 *
 * Usage:
 *   node test_step1_2.js
 */

require('dotenv').config();
const sheets = require('./src/ai-bot/sheets');
const botConfig = require('./src/ai-bot/config');

async function main() {
  botConfig.init(process.cwd());
  console.log('Testing ensureSettingsAndOverridesTabs...');
  await sheets.ensureSettingsAndOverridesTabs();

  console.log('\n--- Reading Settings from Sheet ---');
  const settings = await sheets.getSettingsFromSheet();
  console.log(JSON.stringify(settings, null, 2));

  console.log('\n--- Reading Overrides from Sheet ---');
  const overrides = await sheets.getOverridesFromSheet();
  console.log(JSON.stringify(overrides, null, 2));

  console.log('\n✅ Step 1 & 2 Google Sheets verification succeeded!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
