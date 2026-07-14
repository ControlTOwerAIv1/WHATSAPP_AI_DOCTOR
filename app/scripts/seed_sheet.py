"""
Seed Google Sheet — Populates the availability worksheet with demo data.

Creates 3 doctors with different specialties, working hours, lunch breaks,
and days off.  Also pre-books 2 slots to demonstrate conflict handling.

Usage:
    cd app
    python -m scripts.seed_sheet

Requires:
    APP_GOOGLE_CREDENTIALS_FILE and APP_GOOGLE_SHEET_ID in .env
"""

from __future__ import annotations

import sys
import os
from datetime import datetime, timedelta, timezone

# Add the app directory to the path so we can import our modules
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import gspread
from google.oauth2.service_account import Credentials
from dotenv import load_dotenv

# Load .env from the project root
load_dotenv(os.path.join(os.path.dirname(__file__), "..", "..", ".env"))

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]


def main() -> None:
    creds_file = os.getenv("APP_GOOGLE_CREDENTIALS_FILE", "credentials.json")
    sheet_id = os.getenv("APP_GOOGLE_SHEET_ID", "")

    if not sheet_id:
        print("ERROR: APP_GOOGLE_SHEET_ID not set in .env")
        sys.exit(1)

    print(f"Connecting to Google Sheets (ID: {sheet_id})...")
    creds = Credentials.from_service_account_file(creds_file, scopes=SCOPES)
    gc = gspread.authorize(creds)
    spreadsheet = gc.open_by_key(sheet_id)

    # ── Create or get the "availability" worksheet ────────────────
    try:
        avail_ws = spreadsheet.worksheet("availability")
        avail_ws.clear()
        print("Cleared existing 'availability' worksheet.")
    except gspread.exceptions.WorksheetNotFound:
        avail_ws = spreadsheet.add_worksheet(title="availability", rows=200, cols=10)
        print("Created 'availability' worksheet.")

    # ── Create or get the "bookings" worksheet ────────────────────
    try:
        bookings_ws = spreadsheet.worksheet("bookings")
        bookings_ws.clear()
        print("Cleared existing 'bookings' worksheet.")
    except gspread.exceptions.WorksheetNotFound:
        bookings_ws = spreadsheet.add_worksheet(title="bookings", rows=200, cols=10)
        print("Created 'bookings' worksheet.")

    # ── Write headers ─────────────────────────────────────────────
    avail_headers = ["slot_id", "doctor_name", "specialty", "date", "start_time", "end_time", "status"]
    avail_ws.update("A1:G1", [avail_headers])

    bookings_headers = ["booking_ref", "slot_id", "patient_name", "patient_phone", "condition", "booked_at"]
    bookings_ws.update("A1:F1", [bookings_headers])

    # ── Define doctors ────────────────────────────────────────────
    doctors = [
        {
            "name": "Sarah Chen",
            "specialty": "General Practice",
            "day_off": 2,  # Wednesday (0=Mon)
            "morning_hours": (9, 12),    # 9 AM – 12 PM
            "afternoon_hours": (14, 17),  # 2 PM – 5 PM
        },
        {
            "name": "James Patel",
            "specialty": "Cardiology",
            "day_off": 4,  # Friday
            "morning_hours": (10, 13),    # 10 AM – 1 PM
            "afternoon_hours": (15, 18),  # 3 PM – 6 PM
        },
        {
            "name": "Amira Hassan",
            "specialty": "Pediatrics",
            "day_off": 1,  # Tuesday
            "morning_hours": (8, 11),     # 8 AM – 11 AM
            "afternoon_hours": (13, 16),  # 1 PM – 4 PM
        },
    ]

    # ── Generate slots for the next 5 working days ────────────────
    now = datetime.now(timezone.utc)
    # Start from tomorrow
    base_date = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)

    rows = []
    slot_counter = 1
    days_generated = 0
    day_offset = 0

    while days_generated < 5:
        current_date = base_date + timedelta(days=day_offset)
        day_offset += 1

        # Skip weekends
        if current_date.weekday() in (5, 6):
            continue

        days_generated += 1
        date_str = current_date.strftime("%Y-%m-%d")

        for doc in doctors:
            # Skip this doctor's day off
            if current_date.weekday() == doc["day_off"]:
                continue

            # Morning slots (30-min each)
            for hour in range(doc["morning_hours"][0], doc["morning_hours"][1]):
                for minute in (0, 30):
                    slot_id = f"S{slot_counter:03d}"
                    start_time = f"{hour:02d}:{minute:02d}"
                    end_hour = hour if minute == 0 else hour + 1
                    end_minute = 30 if minute == 0 else 0
                    end_time = f"{end_hour:02d}:{end_minute:02d}"

                    rows.append([
                        slot_id,
                        doc["name"],
                        doc["specialty"],
                        date_str,
                        start_time,
                        end_time,
                        "open",
                    ])
                    slot_counter += 1

            # Afternoon slots (30-min each)
            for hour in range(doc["afternoon_hours"][0], doc["afternoon_hours"][1]):
                for minute in (0, 30):
                    slot_id = f"S{slot_counter:03d}"
                    start_time = f"{hour:02d}:{minute:02d}"
                    end_hour = hour if minute == 0 else hour + 1
                    end_minute = 30 if minute == 0 else 0
                    end_time = f"{end_hour:02d}:{end_minute:02d}"

                    rows.append([
                        slot_id,
                        doc["name"],
                        doc["specialty"],
                        date_str,
                        start_time,
                        end_time,
                        "open",
                    ])
                    slot_counter += 1

    # ── Pre-book 2 slots for conflict demo ────────────────────────
    # Book the first slot of Dr. Chen and Dr. Patel
    prebooked_count = 0
    for row in rows:
        if prebooked_count >= 2:
            break
        if row[1] == "Sarah Chen" and prebooked_count == 0:
            row[6] = "booked"
            prebooked_count += 1
        elif row[1] == "James Patel" and prebooked_count == 1:
            row[6] = "booked"
            prebooked_count += 1

    # ── Write all rows to the sheet ───────────────────────────────
    if rows:
        cell_range = f"A2:G{len(rows) + 1}"
        avail_ws.update(cell_range, rows, value_input_option="USER_ENTERED")

    print(f"\n✅ Seeded {len(rows)} slots across {days_generated} working days.")
    print(f"   Doctors: {', '.join(d['name'] for d in doctors)}")
    print(f"   Pre-booked: 2 slots (for conflict demo)")
    print(f"\n📋 Sheet URL: https://docs.google.com/spreadsheets/d/{sheet_id}")
    print("\nDone! Your Google Sheet is ready for the demo.")


if __name__ == "__main__":
    main()
