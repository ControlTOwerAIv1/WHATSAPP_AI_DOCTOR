/**
 * Utility Script — Google Sheets Connectivity Check
 *
 * Verifies Google Service Account credentials and Spreadsheet metadata:
 * 1. Loads credentials.json and authenticates with Google Sheets API v4.
 * 2. Fetches and prints spreadsheet title and all sheet/tab names.
 *
 * Usage:
 *   node test_sheets_check.js
 */

require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

async function test() {
  const credPath = path.resolve(__dirname, process.env.GOOGLE_CREDENTIALS_FILE || 'credentials.json');
  const sheetId = process.env.GOOGLE_SHEET_ID;
  console.log('Cred path:', credPath, 'Exists:', fs.existsSync(credPath));
  console.log('Sheet ID:', sheetId);

  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });

  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  console.log('Spreadsheet Title:', meta.data.properties.title);
  console.log('Sheets/Tabs:');
  for (const s of meta.data.sheets) {
    console.log(' -', s.properties.title);
  }
}

test().catch(err => console.error('Error:', err));
