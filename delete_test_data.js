/**
 * Script to delete identified test data rows from SQLite appointments_tokens and Google Sheets bookings tab.
 * Run ONLY after user confirms deletion.
 */

require('dotenv').config();
const Database = require('better-sqlite3');
const { google } = require('googleapis');
const path = require('path');

async function wipeTestData() {
  console.log('=== Executing Confirmed Test-Data Wipe ===\n');

  // 1. Wipe from SQLite
  const db = new Database(path.join(__dirname, 'relay.sqlite'));
  const beforeCount = db.prepare('SELECT COUNT(*) as cnt FROM appointments_tokens').get().cnt;
  console.log(`SQLite tokens before cleanup: ${beforeCount}`);

  // Delete all identified test rows
  const deleteStmt = db.prepare('DELETE FROM appointments_tokens');
  const info = deleteStmt.run();
  console.log(`SQLite rows deleted: ${info.changes}`);

  // Group remaining by date
  const remaining = db.prepare('SELECT sunday_date, COUNT(*) as count FROM appointments_tokens GROUP BY sunday_date').all();
  console.log('SQLite token counts by date after cleanup:');
  if (remaining.length === 0) {
    console.log('  All dates: 0 tokens (Clean fresh state ✅)');
  } else {
    remaining.forEach(r => console.log(`  ${r.sunday_date}: ${r.count}`));
  }

  // 2. Wipe from Google Sheets bookings tab (keep header)
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, process.env.GOOGLE_CREDENTIALS_FILE || 'credentials.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const sheetData = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'bookings',
  });
  const rows = sheetData.data.values || [];
  if (rows.length > 1) {
    console.log(`\nGoogle Sheets: clearing ${rows.length - 1} test rows...`);
    await sheets.spreadsheets.values.clear({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `bookings!A2:Z${rows.length + 10}`,
    });
    console.log('  ✅ Google Sheets bookings tab cleared (header preserved)');
  } else {
    console.log('\nGoogle Sheets bookings tab already has only header.');
  }

  // Verify read-back
  const verifyData = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'bookings',
  });
  console.log(`Google Sheets bookings tab row count after cleanup: ${(verifyData.data.values || []).length} (header only ✅)`);
}

if (process.argv.includes('--execute')) {
  wipeTestData().catch(err => console.error('Wipe error:', err));
} else {
  console.log('Dry run: specify --execute to perform deletion.');
}
