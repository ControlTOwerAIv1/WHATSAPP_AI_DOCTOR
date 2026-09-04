/**
 * Utility Script — Dump Google Sheets Contents
 *
 * Reads and prints current data from the configured Google Spreadsheet,
 * specifically inspecting the 'Settings' and 'Overrides' tabs.
 * Useful for debugging, verification, and manual inspection.
 *
 * Usage:
 *   node dump_sheets.js
 */

require('dotenv').config();
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

async function dumpSheets() {
  const credPath = path.resolve(__dirname, process.env.GOOGLE_CREDENTIALS_FILE || 'credentials.json');
  const sheetId = process.env.GOOGLE_SHEET_ID;

  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });

  const sheets = google.sheets({ version: 'v4', auth });

  console.log('================================================================');
  console.log('GOOGLE SHEETS CURRENT CONTENTS');
  console.log('================================================================\n');

  // Settings Tab
  const settingsRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Settings!A1:O10',
  });
  console.log('--- [TAB: Settings] ---');
  if (settingsRes.data.values) {
    for (let i = 0; i < settingsRes.data.values.length; i++) {
      console.log(`Row ${i + 1}:`, settingsRes.data.values[i].join(' | '));
    }
  } else {
    console.log('Empty');
  }

  // Overrides Tab
  const overridesRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Overrides!A1:I10',
  });
  console.log('\n--- [TAB: Overrides] ---');
  if (overridesRes.data.values) {
    for (let i = 0; i < overridesRes.data.values.length; i++) {
      console.log(`Row ${i + 1}:`, overridesRes.data.values[i].join(' | '));
    }
  } else {
    console.log('Empty');
  }
  console.log('\n================================================================');
}

dumpSheets().catch(err => console.error('Error:', err));
