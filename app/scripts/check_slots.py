"""Quick diagnostic: dump availability sheet data to see why 0 slots are open."""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from datetime import datetime, timezone
import gspread
from google.oauth2.service_account import Credentials
from core.config import get_settings

settings = get_settings()
creds = Credentials.from_service_account_file(
    settings.google_credentials_file,
    scopes=[
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive",
    ],
)
gc = gspread.authorize(creds)
spreadsheet = gc.open_by_key(settings.google_sheet_id)

ws = spreadsheet.worksheet("availability")
all_rows = ws.get_all_records()

today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
print(f"Today (UTC): {today_str}")
print(f"Total rows: {len(all_rows)}")
print()

# Show unique statuses
statuses = set(str(row.get("status", "")).strip().lower() for row in all_rows)
print(f"Unique statuses found: {statuses}")

# Show unique dates
dates = sorted(set(str(row.get("date", "")) for row in all_rows))
print(f"Unique dates found: {dates}")
print()

# Count by status
from collections import Counter
status_counts = Counter(str(row.get("status", "")).strip().lower() for row in all_rows)
print(f"Status breakdown: {dict(status_counts)}")

# Show first 5 rows as sample
print("\nSample rows (first 5):")
for row in all_rows[:5]:
    print(f"  slot_id={row.get('slot_id')}, doctor={row.get('doctor_name')}, "
          f"date={row.get('date')}, time={row.get('start_time')}-{row.get('end_time')}, "
          f"status={row.get('status')}")
