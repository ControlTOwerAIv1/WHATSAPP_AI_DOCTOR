/**
 * Bug 4a/b: Reset Google Sheets — clear bookings and availability tabs (keep headers).
 * Verify Settings and Overrides tabs are untouched.
 * Also clears sync_failures.json.
 */

require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const CREDENTIALS_FILE = path.join(__dirname, process.env.GOOGLE_CREDENTIALS_FILE || 'credentials.json');

async function main() {
  console.log('=== Sheets Reset Script ===');
  console.log(`Spreadsheet ID: ${SPREADSHEET_ID}`);

  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });

  // 1. List all tabs
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetList = meta.data.sheets || [];
  const tabNames = sheetList.map(s => s.properties?.title);
  console.log(`\nTabs found: ${tabNames.join(', ')}`);

  // 2. Clear bookings tab (keep header row)
  if (tabNames.includes('bookings')) {
    const bookingsData = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'bookings',
    });
    const bookingsRows = bookingsData.data.values || [];
    console.log(`\nbookings tab: ${bookingsRows.length} total rows (including header)`);
    if (bookingsRows.length > 1) {
      console.log(`  Header: ${bookingsRows[0].join(' | ')}`);
      console.log(`  Clearing ${bookingsRows.length - 1} data rows...`);
      await sheets.spreadsheets.values.clear({
        spreadsheetId: SPREADSHEET_ID,
        range: `bookings!A2:Z${bookingsRows.length + 100}`,
      });
      console.log('  ✅ bookings data rows cleared (header preserved)');
    } else {
      console.log('  Already empty (only header or no data)');
    }
  } else {
    console.log('\n⚠️ bookings tab not found');
  }

  // 3. Clear availability tab (dead code, keep header for now)
  if (tabNames.includes('availability')) {
    const availData = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'availability',
    });
    const availRows = availData.data.values || [];
    console.log(`\navailability tab: ${availRows.length} total rows (including header)`);
    if (availRows.length > 1) {
      console.log(`  Clearing ${availRows.length - 1} data rows...`);
      await sheets.spreadsheets.values.clear({
        spreadsheetId: SPREADSHEET_ID,
        range: `availability!A2:Z${availRows.length + 100}`,
      });
      console.log('  ✅ availability data rows cleared');
    } else {
      console.log('  Already empty');
    }
    console.log('  ⚠️ NOTE: availability tab is @deprecated dead code — candidate for full deletion');
  } else {
    console.log('\navailability tab not found (already removed or never created)');
  }

  // 4. Verify Settings and Overrides are untouched
  for (const tab of ['Settings', 'Overrides']) {
    if (tabNames.includes(tab)) {
      const data = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: tab,
      });
      const rows = data.data.values || [];
      console.log(`\n${tab} tab: ${rows.length} rows — UNTOUCHED ✅`);
      if (rows.length > 0) {
        console.log(`  Headers: ${rows[0].join(' | ')}`);
      }
      if (rows.length > 1) {
        console.log(`  First data row: ${rows[1].join(' | ')}`);
      }
    } else {
      console.log(`\n${tab} tab not found`);
    }
  }

  // 5. Clear sync_failures.json
  const syncPath = path.join(__dirname, 'data', 'sync_failures.json');
  if (fs.existsSync(syncPath)) {
    const existing = JSON.parse(fs.readFileSync(syncPath, 'utf8'));
    console.log(`\nsync_failures.json: ${existing.length} entries — clearing...`);
    fs.writeFileSync(syncPath, '[]', 'utf8');
    console.log('  ✅ sync_failures.json cleared');
  } else {
    console.log('\nsync_failures.json not found (nothing to clear)');
  }

  console.log('\n=== Reset Complete ===');
}

main().catch(err => {
  console.error('Reset script failed:', err.message);
  process.exit(1);
});
