"""
Google Sheets Storage — Availability & Bookings backed by Google Sheets.

Reads doctor availability from an "availability" worksheet and writes
bookings to a "bookings" worksheet.  Uses gspread + service-account auth.

Cache behaviour:
  - ``get_available_slots()`` results are cached for 30 seconds.
  - After every successful ``book_slot()`` the cache is **invalidated** so
    subsequent callers never see a just-booked slot.

Sheet structure (create two worksheets):
  availability: slot_id | doctor_name | specialty | date | start_time | end_time | status
  bookings:     booking_ref | slot_id | patient_name | patient_phone | condition | booked_at
"""

from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone
from typing import Optional

import gspread
from google.oauth2.service_account import Credentials

from core.config import get_settings
from core.logging import get_logger

logger = get_logger(__name__)

# ---------------------------------------------------------------------------
# Google Sheets client (lazy singleton)
# ---------------------------------------------------------------------------

_gc: Optional[gspread.Client] = None
_spreadsheet: Optional[gspread.Spreadsheet] = None

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]


def _get_spreadsheet() -> gspread.Spreadsheet:
    """Return (and cache) the configured Google Spreadsheet."""
    global _gc, _spreadsheet
    if _spreadsheet is None:
        settings = get_settings()
        creds = Credentials.from_service_account_file(
            settings.google_credentials_file, scopes=SCOPES
        )
        _gc = gspread.authorize(creds)
        _spreadsheet = _gc.open_by_key(settings.google_sheet_id)
        logger.info("sheets_connected", sheet_id=settings.google_sheet_id)
    return _spreadsheet


# ---------------------------------------------------------------------------
# Availability cache (30-second TTL, invalidated on booking)
# ---------------------------------------------------------------------------

_slots_cache: list[dict] | None = None
_slots_cache_ts: float = 0.0
_CACHE_TTL = 30.0  # seconds


def _invalidate_cache() -> None:
    """Force the next ``get_available_slots()`` to re-read the sheet."""
    global _slots_cache, _slots_cache_ts
    _slots_cache = None
    _slots_cache_ts = 0.0


def get_available_slots() -> list[dict]:
    """Return rows from the *availability* worksheet where status == 'open'.

    Results are cached for 30 seconds to keep response times fast.
    """
    global _slots_cache, _slots_cache_ts

    now = time.time()
    if _slots_cache is not None and (now - _slots_cache_ts) < _CACHE_TTL:
        logger.debug("slots_cache_hit")
        return _slots_cache

    try:
        sheet = _get_spreadsheet()
        ws = sheet.worksheet("availability")
        all_rows = ws.get_all_records()

        # Filter to open slots whose date is today or in the future
        today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        open_slots = [
            row for row in all_rows
            if str(row.get("status", "")).strip().lower() == "open"
            and str(row.get("date", "")) >= today_str
        ]

        _slots_cache = open_slots
        _slots_cache_ts = time.time()

        logger.info("slots_fetched", total=len(all_rows), open=len(open_slots))
        return open_slots

    except Exception as exc:
        logger.error("slots_fetch_failed", error=str(exc))
        return []


def book_slot(
    slot_id: str,
    patient_name: str,
    patient_phone: str,
    condition: str,
) -> dict | None:
    """Book a slot by ID.  Returns booking dict on success, None if taken.

    Steps:
      1. Re-read the exact row from the sheet (never trust the cache).
      2. If status is still 'open', update to 'booked'.
      3. Append a record to the 'bookings' worksheet.
      4. Invalidate the availability cache.
    """
    try:
        sheet = _get_spreadsheet()
        avail_ws = sheet.worksheet("availability")
        all_rows = avail_ws.get_all_records()

        # Find the row (1-indexed, +2 for header + 0-index offset)
        target_row_idx = None
        target_row = None
        for i, row in enumerate(all_rows):
            if str(row.get("slot_id", "")).strip() == str(slot_id).strip():
                target_row_idx = i + 2  # +1 header, +1 for 1-index
                target_row = row
                break

        if target_row is None:
            logger.warning("book_slot_not_found", slot_id=slot_id)
            return None

        # Double-booking check — live read
        if str(target_row.get("status", "")).strip().lower() != "open":
            logger.info("book_slot_already_taken", slot_id=slot_id)
            return None

        # Update status to 'booked'
        status_col = _col_index(avail_ws, "status")
        avail_ws.update_cell(target_row_idx, status_col, "booked")

        # Write to bookings worksheet
        booking_ref = str(uuid.uuid4())[:8].upper()
        booked_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

        bookings_ws = sheet.worksheet("bookings")
        bookings_ws.append_row(
            [booking_ref, slot_id, patient_name, patient_phone, condition, booked_at],
            value_input_option="USER_ENTERED",
        )

        # Invalidate cache so next caller sees updated state
        _invalidate_cache()

        booking = {
            "booking_ref": booking_ref,
            "slot_id": slot_id,
            "doctor_name": target_row.get("doctor_name", ""),
            "specialty": target_row.get("specialty", ""),
            "date": target_row.get("date", ""),
            "start_time": target_row.get("start_time", ""),
            "end_time": target_row.get("end_time", ""),
            "patient_name": patient_name,
            "patient_phone": patient_phone,
            "condition": condition,
            "booked_at": booked_at,
        }

        logger.info(
            "slot_booked",
            booking_ref=booking_ref,
            slot_id=slot_id,
            doctor=booking["doctor_name"],
        )
        return booking

    except Exception as exc:
        logger.error("book_slot_failed", slot_id=slot_id, error=str(exc))
        return None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _col_index(ws: gspread.Worksheet, header_name: str) -> int:
    """Return the 1-based column index for *header_name* in the first row."""
    headers = ws.row_values(1)
    for i, h in enumerate(headers, 1):
        if h.strip().lower() == header_name.strip().lower():
            return i
    raise ValueError(f"Column '{header_name}' not found in worksheet headers: {headers}")
