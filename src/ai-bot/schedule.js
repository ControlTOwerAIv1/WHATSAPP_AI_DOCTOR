/**
 * AI Bot — Schedule Engine & Token Management
 *
 * Responsibilities:
 * 1. Reads clinic schedule settings & one-off overrides from SQLite (via store.js) — no caching.
 * 2. Provides getEffectiveSchedule(date) to resolve date overrides or fall back to Settings.
 * 3. Renders prompt templates with dynamic placeholders from the effective schedule.
 * 4. Provides isBookingWindowOpen() using the centralized clock and effective schedule.
 * 5. Dynamically calculates approximate patient arrival times (computeArrivalTime).
 * 6. Manages durable token allocation (persisted to SQLite).
 */

const fs = require('fs');
const path = require('path');
const { getCurrentTime } = require('./clock');
const store = require('./store');

// ─── Prompt Template Finder ──────────────────────────────────────────

function _findPromptTemplateFile() {
  const candidates = [
    path.join(__dirname, 'prompts', 'appointment-behavior.md'),
    path.join(__dirname, '..', '..', 'ai-bot', 'prompts', 'appointment-behavior.md'),
    path.join(process.cwd(), 'ai-bot', 'prompts', 'appointment-behavior.md'),
    path.join(process.cwd(), 'src', 'ai-bot', 'prompts', 'appointment-behavior.md'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

// ─── Time Parsing & Formatting Helpers ───────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parseTimeToMinutes(timeStr) {
  if (!timeStr) return 0;
  // Handle 12-hour format e.g. "9:00 PM", "9pm"
  const ampmMatch = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (ampmMatch) {
    let h = parseInt(ampmMatch[1], 10);
    const m = parseInt(ampmMatch[2] || '0', 10);
    const ampm = ampmMatch[3].toLowerCase();
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    return h * 60 + m;
  }
  // Handle 24-hour format e.g. "21:00"
  const [h, m] = timeStr.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function formatMinutesTo12Hour(totalMinutes) {
  let h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  const mStr = m.toString().padStart(2, '0');
  return `${h}:${mStr} ${ampm}`;
}

function parseBookingOpenString(str, targetDayName = 'Sunday') {
  if (!str) {
    return {
      day: 'Saturday',
      time: '21:00',
      display: '9:00 PM on Saturday',
    };
  }

  let day = '';
  for (const d of DAY_NAMES) {
    if (new RegExp(`\\b${d}\\b`, 'i').test(str)) {
      day = d;
      break;
    }
  }

  // Extract time pattern (e.g. 9pm, 9:00 PM, 21:00)
  const timeMatch = str.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
  let timeStr = timeMatch ? timeMatch[1].trim() : '21:00';
  const minutes = parseTimeToMinutes(timeStr);
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  const time24 = `${h}:${m}`;
  const displayTime = formatMinutesTo12Hour(minutes);

  if (!day) {
    // Default to day before target day
    const targetIdx = DAY_NAMES.indexOf(targetDayName);
    day = targetIdx >= 0 ? DAY_NAMES[(targetIdx + 6) % 7] : 'Saturday';
  }

  return {
    day,
    time: time24,
    display: `${displayTime} on ${day}`,
  };
}

// ─── Effective Schedule Resolver (Settings + Overrides) ─────────────
// Note: SQLite reads are fast; no TTL cache is needed or used here.

let _lastEffectiveSchedule = null;
let _lastEffectiveScheduleTime = 0;

function _setLastEffectiveSchedule(sched) {
  _lastEffectiveSchedule = sched;
  _lastEffectiveScheduleTime = Date.now();
}

// IST offset in milliseconds (UTC+5:30)
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Convert a Date to an equivalent Date object shifted to IST local time.
 * All subsequent local-time accessors (.getFullYear, .getMonth, .getDate, .getDay, etc.)
 * will return IST values regardless of the server's own timezone.
 */
function _toIST(d) {
  return new Date(d.getTime() + IST_OFFSET_MS);
}

/**
 * Format a Date object into YYYY-MM-DD using IST date parts.
 * Always use this instead of direct getFullYear/getMonth/getDate calls so the
 * result reflects the clinic's India timezone, not the server's UTC clock.
 */
function formatDateToYYYYMMDD(d) {
  const ist = _toIST(d);
  const yyyy = ist.getUTCFullYear();
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Resolve the effective schedule for a specific date (YYYY-MM-DD or Date).
 * Checks the Overrides tab first; falls back to the Settings tab if no override exists.
 *
 * @param {string|Date} [date] - Target date (defaults to upcoming relevant operating date)
 * @returns {Promise<Object>} The resolved effective schedule configuration
 */
async function getEffectiveSchedule(date = null) {
  let targetDateStr = '';
  let targetDateObj = null;

  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    targetDateStr = date;
    const [y, m, d] = date.split('-').map(Number);
    targetDateObj = new Date(y, m - 1, d);
  } else if (date instanceof Date) {
    targetDateObj = date;
    targetDateStr = formatDateToYYYYMMDD(date);
  } else {
    // Determine default operating date for current time
    targetDateStr = await findNextOperatingDate(getCurrentTime());
    const [y, m, d] = targetDateStr.split('-').map(Number);
    targetDateObj = new Date(y, m - 1, d);
  }

  const dayOfWeekIndex = targetDateObj.getDay();
  const dayOfWeekName = DAY_NAMES[dayOfWeekIndex];

  // Fetch Settings and Overrides directly from SQLite (no caching needed)
  const settings = store.getSettings();
  const overrides = store.getOverrides();

  // 1. Check for matching override (use the most recently added override if multiple exist for the same date)
  const matchingOverride = overrides.slice().reverse().find(o => (o.target_date || '').trim() === targetDateStr);

  if (matchingOverride) {
    const type = (matchingOverride.type || '').trim().toLowerCase();

    // Case A: Clinic Closed on this date
    if (type === 'closed') {
      const closedSched = {
        clinic_name: 'Al Ramzan Shifakhana',
        target_date: targetDateStr,
        is_override: true,
        override_type: 'closed',
        is_open: false,
        operating_days: [],
        operating_days_display: 'Closed',
        booking_window: {
          start_day: settings.booking_open_day,
          start_time: settings.booking_open_time,
          start_display: `${formatMinutesTo12Hour(parseTimeToMinutes(settings.booking_open_time))} on ${settings.booking_open_day}`,
          end_day: settings.booking_close_day,
          end_time: settings.booking_close_time,
          end_display: `${formatMinutesTo12Hour(parseTimeToMinutes(settings.booking_close_time))} on ${settings.booking_close_day}`,
          closed_message: matchingOverride.notes || `The clinic is closed on ${dayOfWeekName}, ${targetDateStr}.`,
        },
        max_tokens: 0,
        rounding_interval_minutes: settings.rounding_minutes,
        break_period: {
          start_time: settings.break_start,
          end_time: settings.break_end,
          start_display: formatMinutesTo12Hour(parseTimeToMinutes(settings.break_start)),
          end_display: formatMinutesTo12Hour(parseTimeToMinutes(settings.break_end)),
        },
        slots: {
          morning: { name: 'morning', display_name: 'morning', capitalized_name: 'Morning', token_cap: 0, token_start: 0, token_end: 0 },
          afternoon: { name: 'afternoon', display_name: 'afternoon', capitalized_name: 'Afternoon', token_cap: 0, token_start: 0, token_end: 0 },
        },
        notes: matchingOverride.notes || '',
      };
      _setLastEffectiveSchedule(closedSched);
      return closedSched;
    }

    // Case B: Open extra day or Capacity change
    const totalCap = Number(matchingOverride.token_cap) || settings.max_tokens || 45;
    const morningCap = Math.min(settings.morning_cap, totalCap);
    const afternoonCap = Math.max(0, totalCap - morningCap);

    const consStart = matchingOverride.consultation_start || settings.morning_start || '11:00';
    const consEnd = matchingOverride.consultation_end || settings.afternoon_end || '18:30';
    const breakStart = settings.break_start || '13:30';
    const breakEnd = settings.break_end || '14:30';

    const parsedWindow = parseBookingOpenString(matchingOverride.booking_opens_at, dayOfWeekName);
    const bookingCloseTime = settings.booking_close_time || '18:00';

    const effectiveOverride = {
      clinic_name: 'Al Ramzan Shifakhana',
      target_date: targetDateStr,
      is_override: true,
      override_type: type || 'open_extra_day',
      is_open: true,
      operating_days: [dayOfWeekName],
      operating_days_display: dayOfWeekName + 's',
      booking_window: {
        start_day: parsedWindow.day,
        start_time: parsedWindow.time,
        start_display: parsedWindow.display,
        end_day: dayOfWeekName,
        end_time: bookingCloseTime,
        end_display: `${formatMinutesTo12Hour(parseTimeToMinutes(bookingCloseTime))} on ${dayOfWeekName}`,
        closed_message: `Appointments for ${dayOfWeekName} (${targetDateStr}) will open at ${parsedWindow.display}.`,
      },
      max_tokens: totalCap,
      rounding_interval_minutes: settings.rounding_minutes || 30,
      break_period: {
        start_time: breakStart,
        end_time: breakEnd,
        start_display: formatMinutesTo12Hour(parseTimeToMinutes(breakStart)),
        end_display: formatMinutesTo12Hour(parseTimeToMinutes(breakEnd)),
      },
      slots: {
        morning: {
          name: 'morning',
          display_name: 'morning',
          capitalized_name: 'Morning',
          start_time: consStart,
          end_time: breakStart,
          start_display: formatMinutesTo12Hour(parseTimeToMinutes(consStart)),
          end_display: formatMinutesTo12Hour(parseTimeToMinutes(breakStart)),
          token_cap: morningCap,
          token_start: 1,
          token_end: morningCap,
        },
        afternoon: {
          name: 'afternoon',
          display_name: 'afternoon',
          capitalized_name: 'Afternoon',
          start_time: breakEnd,
          end_time: consEnd,
          start_display: formatMinutesTo12Hour(parseTimeToMinutes(breakEnd)),
          end_display: formatMinutesTo12Hour(parseTimeToMinutes(consEnd)),
          token_cap: afternoonCap,
          token_start: morningCap + 1,
          token_end: totalCap,
        },
      },
      notes: matchingOverride.notes || '',
    };

    _setLastEffectiveSchedule(effectiveOverride);
    return effectiveOverride;
  }

  // 2. Default: standard schedule from Settings
  const primaryOpDay = settings.operating_days[0] || 'Sunday';
  const standardSched = {
    clinic_name: 'Al Ramzan Shifakhana',
    target_date: targetDateStr,
    is_override: false,
    override_type: null,
    is_open: true,
    operating_days: settings.operating_days,
    operating_days_display: settings.operating_days.join(', ') + (settings.operating_days.length === 1 ? 's' : ''),
    booking_window: {
      start_day: settings.booking_open_day,
      start_time: settings.booking_open_time,
      start_display: `${formatMinutesTo12Hour(parseTimeToMinutes(settings.booking_open_time))} on ${settings.booking_open_day}`,
      end_day: settings.booking_close_day,
      end_time: settings.booking_close_time,
      end_display: `${formatMinutesTo12Hour(parseTimeToMinutes(settings.booking_close_time))} on ${settings.booking_close_day}`,
      closed_message: `Appointments for the coming ${primaryOpDay} will open at ${formatMinutesTo12Hour(parseTimeToMinutes(settings.booking_open_time))} on ${settings.booking_open_day}.`,
    },
    max_tokens: settings.max_tokens,
    rounding_interval_minutes: settings.rounding_minutes,
    break_period: {
      start_time: settings.break_start,
      end_time: settings.break_end,
      start_display: formatMinutesTo12Hour(parseTimeToMinutes(settings.break_start)),
      end_display: formatMinutesTo12Hour(parseTimeToMinutes(settings.break_end)),
    },
    slots: {
      morning: {
        name: 'morning',
        display_name: 'morning',
        capitalized_name: 'Morning',
        start_time: settings.morning_start,
        end_time: settings.morning_end,
        start_display: formatMinutesTo12Hour(parseTimeToMinutes(settings.morning_start)),
        end_display: formatMinutesTo12Hour(parseTimeToMinutes(settings.morning_end)),
        token_cap: settings.morning_cap,
        token_start: 1,
        token_end: settings.morning_cap,
      },
      afternoon: {
        name: 'afternoon',
        display_name: 'afternoon',
        capitalized_name: 'Afternoon',
        start_time: settings.afternoon_start,
        end_time: settings.afternoon_end,
        start_display: formatMinutesTo12Hour(parseTimeToMinutes(settings.afternoon_start)),
        end_display: formatMinutesTo12Hour(parseTimeToMinutes(settings.afternoon_end)),
        token_cap: settings.afternoon_cap,
        token_start: settings.morning_cap + 1,
        token_end: settings.max_tokens,
      },
    },
  };

  _setLastEffectiveSchedule(standardSched);
  return standardSched;
}

/**
 * Synchronously get the effective schedule using the last computed value or default settings.
 * The schedule is refreshed on every async call to getEffectiveSchedule(); this sync
 * variant is a prompt-render convenience that reads the most-recently-resolved value.
 */
function getEffectiveScheduleSync(date = null) {
  const isFresh = Boolean(_lastEffectiveSchedule);
  if (isFresh) {
    if (!date || _lastEffectiveSchedule.target_date === (typeof date === 'string' ? date : formatDateToYYYYMMDD(date))) {
      return _lastEffectiveSchedule;
    }
  }
  // Fallback defaults matching settings
  return {
    clinic_name: 'Al Ramzan Shifakhana',
    target_date: getTargetSundayDate(),
    is_override: false,
    is_open: true,
    operating_days: ['Sunday'],
    operating_days_display: 'Sundays',
    booking_window: {
      start_day: 'Saturday',
      start_time: '21:00',
      start_display: '9:00 PM on Saturday',
      end_day: 'Sunday',
      end_time: '18:00',
      end_display: '6:00 PM on Sunday',
      closed_message: 'Appointments for the coming Sunday will open at 9:00 PM on Saturday.',
    },
    max_tokens: 45,
    rounding_interval_minutes: 30,
    break_period: {
      start_time: '13:30',
      end_time: '14:30',
      start_display: '1:30 PM',
      end_display: '2:30 PM',
    },
    slots: {
      morning: {
        name: 'morning',
        display_name: 'morning',
        capitalized_name: 'Morning',
        start_time: '11:00',
        end_time: '13:30',
        start_display: '11:00 AM',
        end_display: '1:30 PM',
        token_cap: 17,
        token_start: 1,
        token_end: 17,
      },
      afternoon: {
        name: 'afternoon',
        display_name: 'afternoon',
        capitalized_name: 'Afternoon',
        start_time: '14:30',
        end_time: '18:30',
        start_display: '2:30 PM',
        end_display: '6:30 PM',
        token_cap: 28,
        token_start: 18,
        token_end: 45,
      },
    },
  };
}

/**
 * Backward compatibility alias for getScheduleConfig.
 */
function getScheduleConfig(date = null) {
  return getEffectiveScheduleSync(date);
}

/**
 * Check if the booking window is open for a given schedule configuration.
 */
function _checkWindowOpenForSchedule(currentTime, config) {
  if (!config || !config.is_open) return false;

  // All day/time comparisons must use IST, not server local time.
  const ist = _toIST(currentTime);
  const currentDayIndex = ist.getUTCDay();
  const currentMinutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();

  const startDay = config.booking_window?.start_day || 'Saturday';
  const startMinutes = parseTimeToMinutes(config.booking_window?.start_time || '21:00');
  const endDay = config.booking_window?.end_day || 'Sunday';
  const endMinutes = parseTimeToMinutes(config.booking_window?.end_time || '18:00');

  const startIdx = DAY_NAMES.findIndex(d => d.toLowerCase() === startDay.toLowerCase());
  const endIdx = DAY_NAMES.findIndex(d => d.toLowerCase() === endDay.toLowerCase());

  if (startIdx === -1 || endIdx === -1) return false;

  if (startIdx === endIdx) {
    // Same day window
    if (currentDayIndex === startIdx) {
      return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    }
    return false;
  }

  // Multi-day span (e.g. Friday 4pm to Monday 6pm, or Saturday 9pm to Sunday 6pm)
  const totalSpanDays = (endIdx - startIdx + 7) % 7;
  const offsetDays = (currentDayIndex - startIdx + 7) % 7;

  if (offsetDays === 0) {
    // Start day: open starting from startMinutes
    return currentMinutes >= startMinutes;
  } else if (offsetDays > 0 && offsetDays < totalSpanDays) {
    // Intermediate full days (e.g. Saturday or Sunday between Friday and Monday): open all day
    return true;
  } else if (offsetDays === totalSpanDays) {
    // End day: open until endMinutes
    return currentMinutes <= endMinutes;
  }

  return false;
}

/**
 * Find the next upcoming operating date (checking Overrides for extra days and Settings for regular operating days).
 * Prioritizes dates whose booking window is currently open.
 */
async function findNextOperatingDate(currentTime = getCurrentTime()) {
  const currentYYYYMMDD = formatDateToYYYYMMDD(currentTime);
  const overrides = store.getOverrides();

  // Deduplicate overrides by target_date (last row in sheet takes precedence)
  const latestOverridesByDate = new Map();
  for (const o of overrides) {
    if (o.target_date) {
      latestOverridesByDate.set(o.target_date.trim(), o);
    }
  }

  const candidateDates = [];
  for (const [dateStr, o] of latestOverridesByDate.entries()) {
    if (dateStr >= currentYYYYMMDD && (o.type || '').toLowerCase() !== 'closed') {
      candidateDates.push(dateStr);
    }
  }

  const upcomingSunday = getTargetSundayDate(currentTime);
  if (!candidateDates.includes(upcomingSunday)) {
    candidateDates.push(upcomingSunday);
  }

  candidateDates.sort();

  // 1. First priority: Is there any candidate date whose booking window is ACTIVE & OPEN right now?
  for (const dateStr of candidateDates) {
    const sched = await getEffectiveSchedule(dateStr);
    if (_checkWindowOpenForSchedule(currentTime, sched)) {
      return dateStr;
    }
  }

  // 2. Second priority: If no booking window is open right now, pick the nearest upcoming operating date
  const istNow = _toIST(currentTime);
  const istCurrentMinutes = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
  for (const dateStr of candidateDates) {
    if (dateStr > currentYYYYMMDD) {
      return dateStr;
    }
    // If dateStr === currentYYYYMMDD (today in IST), check if consultation hours have already finished
    const todaySched = await getEffectiveSchedule(dateStr);
    const endMinutes = parseTimeToMinutes(todaySched.slots?.afternoon?.end_time || '18:30');
    if (istCurrentMinutes < endMinutes) {
      return dateStr;
    }
  }

  return candidateDates[0] || upcomingSunday;
}

// ─── Single Owner for Prompt Template Rendering ─────────────────────

/**
 * Render the appointment prompt template by interpolating placeholders from the effective schedule.
 * @param {string|Date} [targetDate] - Target date for the schedule
 * @returns {string} The fully rendered system prompt
 */
function renderPromptTemplate(targetDate = null) {
  const config = getEffectiveScheduleSync(targetDate);
  const templatePath = _findPromptTemplateFile();

  let template = '';
  try {
    template = fs.readFileSync(templatePath, 'utf8');
  } catch (err) {
    console.error('[AI-Bot] Failed to read appointment-behavior.md:', err.message);
    return `You are the medical receptionist for ${config.clinic_name}. Appointments open ${config.booking_window.start_display}.`;
  }

  const morning = config.slots?.morning || {};
  const afternoon = config.slots?.afternoon || {};
  const breakPeriod = config.break_period || {};
  const bookingWindow = config.booking_window || {};

  const replacements = {
    '{{clinic_name}}': config.clinic_name || 'Al Ramzan Shifakhana',
    '{{operating_days}}': (config.operating_days || ['Sunday']).join(', '),
    '{{operating_days_display}}': config.operating_days_display || 'Sundays',
    '{{booking_window_start}}': bookingWindow.start_display || 'Saturday 9:00 PM',
    '{{booking_window_end}}': bookingWindow.end_display || 'Sunday 6:00 PM',
    '{{booking_window_closed_message}}': bookingWindow.closed_message || 'Appointments for the coming Sunday will open at 9:00 PM on Saturday.',
    '{{max_tokens}}': String(config.max_tokens || 45),
    '{{max_tokens_plus_one}}': String((config.max_tokens || 45) + 1),
    '{{rounding_interval_minutes}}': String(config.rounding_interval_minutes || 30),
    '{{break_period_start}}': breakPeriod.start_display || '1:30 PM',
    '{{break_period_end}}': breakPeriod.end_display || '2:30 PM',
    '{{morning_slot_name}}': morning.display_name || 'morning',
    '{{morning_slot_capitalized}}': morning.capitalized_name || 'Morning',
    '{{morning_slot_start}}': morning.start_display || '11:00 AM',
    '{{morning_slot_end}}': morning.end_display || '1:30 PM',
    '{{morning_slot_cap}}': String(morning.token_cap || 17),
    '{{morning_token_start}}': String(morning.token_start || 1),
    '{{morning_token_end}}': String(morning.token_end || 17),
    '{{afternoon_slot_name}}': afternoon.display_name || 'afternoon',
    '{{afternoon_slot_capitalized}}': afternoon.capitalized_name || 'Afternoon',
    '{{afternoon_slot_start}}': afternoon.start_display || '2:30 PM',
    '{{afternoon_slot_end}}': afternoon.end_display || '6:30 PM',
    '{{afternoon_slot_cap}}': String(afternoon.token_cap || 28),
    '{{afternoon_token_start}}': String(afternoon.token_start || 18),
    '{{afternoon_token_end}}': String(afternoon.token_end || 45),
  };

  let rendered = template;
  for (const [key, val] of Object.entries(replacements)) {
    rendered = rendered.split(key).join(val);
  }

  return rendered;
}

// ─── Arrival Time Math ───────────────────────────────────────────────

/**
 * Compute the estimated arrival time for a token within a slot.
 *
 * @param {number} tokenNumberInSlot - 1-based index of token within this slot (e.g. 1..17 or 1..28)
 * @param {object} slot - { start_time, end_time, token_cap }
 * @param {number} [roundingMinutes=30] - Rounding interval in minutes
 * @returns {string} Formatted arrival time, e.g. "11:00 AM", "3:30 PM"
 */
function computeArrivalTime(tokenNumberInSlot, slot, roundingMinutes = 30) {
  const config = getScheduleConfig();
  const rounding = roundingMinutes || config.rounding_interval_minutes || 30;

  const startMinutes = parseTimeToMinutes(slot.start_time || slot.startTime);
  const endMinutes = parseTimeToMinutes(slot.end_time || slot.endTime);
  const duration = endMinutes - startMinutes;
  const tokenCap = slot.token_cap || slot.cap || slot.capacity || slot.maxTokens || 1;

  if (tokenCap <= 1 || tokenNumberInSlot <= 1) {
    return formatMinutesTo12Hour(startMinutes);
  }

  // Patients arrive between start and (end - roundingMinutes)
  const arrivalSpan = Math.max(0, duration - rounding);
  const rawOffset = ((tokenNumberInSlot - 1) / (tokenCap - 1)) * arrivalSpan;
  const roundedOffset = Math.round(rawOffset / rounding) * rounding;
  const arrivalMinutes = startMinutes + roundedOffset;

  return formatMinutesTo12Hour(arrivalMinutes);
}

/**
 * Get natural wording for estimated arrival time, e.g. "around 3:30 PM".
 */
function getApproximateArrivalText(tokenNumberInSlot, slot, roundingMinutes = 30) {
  const time = computeArrivalTime(tokenNumberInSlot, slot, roundingMinutes);
  return `around ${time}`;
}

// ─── Booking Window Logic ───────────────────────────────────────────

/**
 * Check if the clinic booking window is currently open for the given date/time.
 *
 * @param {Date} [currentTime] - Defaults to centralized getCurrentTime()
 * @param {string|Date} [targetDate] - Optional specific date to check
 * @returns {Promise<{ open: boolean, message: string, targetSundayDate: string, currentDay: number, currentHour: number }>}
 */
async function isBookingWindowOpen(currentTime = getCurrentTime(), targetDate = null) {
  const effectiveTargetDate = targetDate || await findNextOperatingDate(currentTime);
  const config = await getEffectiveSchedule(effectiveTargetDate);

  const istNow = _toIST(currentTime);
  const istDay = istNow.getUTCDay();
  const istHour = istNow.getUTCHours();

  if (!config.is_open) {
    return {
      open: false,
      message: config.booking_window?.closed_message || 'The clinic is closed on this date.',
      targetSundayDate: effectiveTargetDate,
      currentDay: istDay,
      currentHour: istHour,
    };
  }

  const open = _checkWindowOpenForSchedule(currentTime, config);

  const closedMessage = config.booking_window?.closed_message ||
    `Appointments for ${config.operating_days[0] || 'the coming clinic date'} (${effectiveTargetDate}) will open at ${config.booking_window?.start_display}.`;

  return {
    open,
    message: open ? 'Booking window is OPEN' : closedMessage,
    targetSundayDate: effectiveTargetDate,
    currentDay: istDay,
    currentHour: istHour,
  };
}


/**
 * Determine the date (YYYY-MM-DD) of the Sunday relevant to the current time.
 */
function getTargetSundayDate(currentTime = getCurrentTime()) {
  // Use IST day-of-week so that e.g. Saturday evening in IST isn't treated as Sunday in UTC.
  const ist = _toIST(currentTime);
  const day = ist.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat in IST
  const diffDays = (7 - day) % 7; // 0 if already Sunday, otherwise days until next Sunday
  // Build a new UTC instant that is `diffDays` ahead in IST calendar
  const targetIST = new Date(ist.getTime() + diffDays * 24 * 60 * 60 * 1000);
  const yyyy = targetIST.getUTCFullYear();
  const mm = String(targetIST.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(targetIST.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ─── Durable Token Storage (SQLite + JSON Fallback) ─────────────────
// NOTE: Uses store.getDb() — the single shared connection that runs all migrations.
// This guarantees agent_id, status, created_at columns exist before first use.

const TOKENS_JSON_PATH = path.join(process.cwd(), 'data', 'tokens.json');

function _getDatabase() {
  try {
    return store.getDb();
  } catch (err) {
    console.warn('[AI-Bot] SQLite init warning for tokens table, using JSON fallback:', err.message);
    return null;
  }
}

function _loadTokensFromDisk() {
  try {
    const db = _getDatabase();
    if (db) {
      const rows = db.prepare('SELECT * FROM appointments_tokens ORDER BY token_number ASC').all();
      return rows;
    }
  } catch (e) {
    // fallback to JSON
  }

  try {
    if (fs.existsSync(TOKENS_JSON_PATH)) {
      return JSON.parse(fs.readFileSync(TOKENS_JSON_PATH, 'utf8')) || [];
    }
  } catch (e) {
    // ignore
  }
  return [];
}

function _saveTokenToDisk(record) {
  try {
    const db = _getDatabase();
    if (db) {
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO appointments_tokens
        (sunday_date, token_number, slot_name, token_in_slot, patient_phone, patient_name, arrival_time, condition, booked_at)
        VALUES (@sunday_date, @token_number, @slot_name, @token_in_slot, @patient_phone, @patient_name, @arrival_time, @condition, @booked_at)
      `);
      stmt.run({
        sunday_date: record.sunday_date,
        token_number: record.token_number,
        slot_name: record.slot_name,
        token_in_slot: record.token_in_slot,
        patient_phone: record.patient_phone,
        patient_name: record.patient_name,
        arrival_time: record.arrival_time,
        condition: record.condition || '',
        booked_at: record.booked_at,
      });
    }
  } catch (err) {
    console.warn('[AI-Bot] SQLite token save error:', err.message);
  }

  // Backup to JSON file
  try {
    const dir = path.dirname(TOKENS_JSON_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const existing = _loadTokensFromDisk();
    const updated = existing.filter(r => !(r.sunday_date === record.sunday_date && r.token_number === record.token_number));
    updated.push(record);
    fs.writeFileSync(TOKENS_JSON_PATH, JSON.stringify(updated, null, 2), 'utf8');
  } catch (err) {
    console.warn('[AI-Bot] JSON token save error:', err.message);
  }
}

/**
 * Get all tokens for a given date (YYYY-MM-DD).
 */
function getTokensForSunday(sundayDate) {
  try {
    const db = _getDatabase();
    if (db) {
      return db.prepare('SELECT * FROM appointments_tokens WHERE sunday_date = ? ORDER BY token_number ASC').all(sundayDate);
    }
  } catch (e) {
    // fallback
  }
  const all = _loadTokensFromDisk();
  return all.filter(t => t.sunday_date === sundayDate).sort((a, b) => a.token_number - b.token_number);
}

/**
 * Get all booking records for a given date from SQLite (generalizing for doctor queries).
 * Returns array of token records with patient names, token numbers, slot, arrival times, conditions, and phones.
 */
function getBookingsForDate(targetDateStr) {
  return getTokensForSunday(targetDateStr);
}

/**
 * Find existing token for a phone on a given date (duplicate detection).
 */
function getTokenByPhone(phone, sundayDate) {
  const normalized = (phone || '').replace(/[^0-9]/g, '');
  const tokens = getTokensForSunday(sundayDate);
  return tokens.find(t => (t.patient_phone || '').replace(/[^0-9]/g, '') === normalized) || null;
}

/**
 * Check slot availability for a given date.
 */
async function getSlotAvailability(targetDate = null) {
  const effectiveTargetDate = targetDate || await findNextOperatingDate(getCurrentTime());
  const config = await getEffectiveSchedule(effectiveTargetDate);
  const tokens = getTokensForSunday(effectiveTargetDate);

  const morningTokens = tokens.filter(t => t.slot_name === 'morning');
  const afternoonTokens = tokens.filter(t => t.slot_name === 'afternoon');

  const morningCap = config.slots.morning.token_cap;
  const afternoonCap = config.slots.afternoon.token_cap;
  const maxTokens = config.max_tokens;

  return {
    targetDate: effectiveTargetDate,
    totalBooked: tokens.length,
    maxTokens,
    allFull: tokens.length >= maxTokens,
    morning: {
      booked: morningTokens.length,
      cap: morningCap,
      available: Math.max(0, morningCap - morningTokens.length),
      isFull: morningTokens.length >= morningCap,
      nextInSlot: morningTokens.length + 1,
      nextTokenNumber: morningTokens.length + 1,
    },
    afternoon: {
      booked: afternoonTokens.length,
      cap: afternoonCap,
      available: Math.max(0, afternoonCap - afternoonTokens.length),
      isFull: afternoonTokens.length >= afternoonCap,
      nextInSlot: afternoonTokens.length + 1,
      nextTokenNumber: morningCap + afternoonTokens.length + 1,
    },
  };
}

/**
 * Allocate a token durably for the patient using an atomic SQLite transaction (BEGIN IMMEDIATE).
 * Eliminates race conditions across concurrent booking requests. (Step 1)
 * Synced asynchronously to Google Sheets bookings tab (Step 3).
 */
async function allocateToken({ phone, name, slotPreference = 'morning', condition = '', currentTime = getCurrentTime(), targetDate = null }) {
  const effectiveTargetDate = targetDate || await findNextOperatingDate(currentTime);
  const config = await getEffectiveSchedule(effectiveTargetDate);
  const normalizedPhone = (phone || '').replace(/[^0-9]/g, '');

  const db = _getDatabase();
  let allocationResult = null;

  if (db) {
    const executeAllocation = db.transaction(() => {
      // 1. Duplicate check within transaction
      const existing = db.prepare('SELECT * FROM appointments_tokens WHERE sunday_date = ? AND patient_phone = ?').get(effectiveTargetDate, normalizedPhone);
      if (existing) {
        return {
          success: true,
          isDuplicate: true,
          token: existing,
        };
      }

      // 2. Query existing tokens atomically
      const tokens = db.prepare('SELECT * FROM appointments_tokens WHERE sunday_date = ? ORDER BY token_number ASC').all(effectiveTargetDate);
      const morningTokens = tokens.filter(t => t.slot_name === 'morning');
      const afternoonTokens = tokens.filter(t => t.slot_name === 'afternoon');

      const morningCap = config.slots.morning.token_cap;
      const afternoonCap = config.slots.afternoon.token_cap;
      const maxTokens = config.max_tokens;

      if (tokens.length >= maxTokens) {
        return {
          success: false,
          reason: 'all_full',
        };
      }

      const pref = (slotPreference || 'morning').toLowerCase();
      const targetSlotName = pref.includes('afternoon') ? 'afternoon' : 'morning';
      const targetSlotConfig = config.slots[targetSlotName];
      const targetTokens = targetSlotName === 'morning' ? morningTokens : afternoonTokens;
      const targetCap = targetSlotName === 'morning' ? morningCap : afternoonCap;

      if (targetTokens.length >= targetCap) {
        const alternativeSlot = targetSlotName === 'morning' ? 'afternoon' : 'morning';
        const altTokens = alternativeSlot === 'morning' ? morningTokens : afternoonTokens;
        const altCap = alternativeSlot === 'morning' ? morningCap : afternoonCap;
        if (altTokens.length < altCap) {
          return {
            success: false,
            reason: `${targetSlotName}_full`,
            offeredSlot: alternativeSlot,
          };
        } else {
          return {
            success: false,
            reason: 'all_full',
          };
        }
      }

      const tokenInSlot = targetTokens.length + 1;
      const overallTokenNumber = targetSlotName === 'morning'
        ? (morningTokens.length + 1)
        : (morningCap + afternoonTokens.length + 1);

      const arrivalTime = computeArrivalTime(
        tokenInSlot,
        targetSlotConfig,
        config.rounding_interval_minutes
      );

      const bookedAtStr = new Date(currentTime.getTime()).toISOString().replace('T', ' ').substring(0, 19);

      const record = {
        sunday_date: effectiveTargetDate,
        token_number: overallTokenNumber,
        slot_name: targetSlotName,
        token_in_slot: tokenInSlot,
        patient_phone: normalizedPhone,
        patient_name: name || 'Patient',
        arrival_time: arrivalTime,
        condition: condition || '',
        booked_at: bookedAtStr,
      };

      db.prepare(`
        INSERT INTO appointments_tokens
        (sunday_date, token_number, slot_name, token_in_slot, patient_phone, patient_name, arrival_time, condition, booked_at)
        VALUES (@sunday_date, @token_number, @slot_name, @token_in_slot, @patient_phone, @patient_name, @arrival_time, @condition, @booked_at)
      `).run(record);

      return {
        success: true,
        token: record,
      };
    });

    allocationResult = executeAllocation.immediate();
  } else {
    // Fallback if SQLite driver is unavailable
    const existing = getTokenByPhone(normalizedPhone, effectiveTargetDate);
    if (existing) {
      return { success: true, isDuplicate: true, token: existing };
    }
    const availability = await getSlotAvailability(effectiveTargetDate);
    if (availability.allFull) {
      return { success: false, reason: 'all_full' };
    }
    const pref = (slotPreference || 'morning').toLowerCase();
    const targetSlotName = pref.includes('afternoon') ? 'afternoon' : 'morning';
    const targetSlotConfig = config.slots[targetSlotName];
    const targetSlotAvail = availability[targetSlotName];

    if (targetSlotAvail.isFull) {
      const alternativeSlot = targetSlotName === 'morning' ? 'afternoon' : 'morning';
      const altAvail = availability[alternativeSlot];
      if (!altAvail.isFull) {
        return { success: false, reason: `${targetSlotName}_full`, offeredSlot: alternativeSlot };
      }
      return { success: false, reason: 'all_full' };
    }

    const tokenInSlot = targetSlotAvail.nextInSlot;
    const overallTokenNumber = targetSlotAvail.nextTokenNumber;
    const arrivalTime = computeArrivalTime(tokenInSlot, targetSlotConfig, config.rounding_interval_minutes);

    const record = {
      sunday_date: effectiveTargetDate,
      token_number: overallTokenNumber,
      slot_name: targetSlotName,
      token_in_slot: tokenInSlot,
      patient_phone: normalizedPhone,
      patient_name: name || 'Patient',
      arrival_time: arrivalTime,
      condition: condition || '',
      booked_at: new Date(currentTime.getTime()).toISOString().replace('T', ' ').substring(0, 19),
    };
    _saveTokenToDisk(record);
    allocationResult = { success: true, token: record };
  }

  // Log on success
  if (allocationResult.success && !allocationResult.isDuplicate && allocationResult.token) {
    const record = allocationResult.token;
    console.log(`[AI-Bot] ✅ Token allocated: #${record.token_number} (${record.slot_name}) for ${record.patient_name} (${record.patient_phone}) on ${effectiveTargetDate} — Arrival: around ${record.arrival_time}`);
  }

  return allocationResult;
}

/**
 * Reset tokens for a date (useful for automated testing).
 */
function resetTokensForTesting(sundayDate) {
  try {
    const db = _getDatabase();
    if (db) {
      db.prepare('DELETE FROM appointments_tokens WHERE sunday_date = ?').run(sundayDate);
    }
  } catch (e) {
    // ignore
  }
  try {
    if (fs.existsSync(TOKENS_JSON_PATH)) {
      const all = JSON.parse(fs.readFileSync(TOKENS_JSON_PATH, 'utf8')) || [];
      const filtered = all.filter(t => t.sunday_date !== sundayDate);
      fs.writeFileSync(TOKENS_JSON_PATH, JSON.stringify(filtered, null, 2), 'utf8');
    }
  } catch (e) {
    // ignore
  }
}

/**
 * Invalidate in-memory schedule cache.
 * SQLite is always current so only the in-process _lastEffectiveSchedule needs clearing.
 */
function invalidateCache() {
  _lastEffectiveSchedule = null;
  _lastEffectiveScheduleTime = 0;
  console.log('[AI-Bot] Schedule cache invalidated');
}

module.exports = {
  getEffectiveSchedule,
  getEffectiveScheduleSync,
  getScheduleConfig,
  renderPromptTemplate,
  computeArrivalTime,
  getApproximateArrivalText,
  isBookingWindowOpen,
  getTargetSundayDate,
  findNextOperatingDate,
  getTokensForSunday,
  getTokensForDate: getTokensForSunday,
  getBookingsForDate,
  getTokenByPhone,
  getSlotAvailability,
  allocateToken,
  resetTokensForTesting,
  invalidateCache,
  parseTimeToMinutes,
  formatMinutesTo12Hour,
  formatDateToYYYYMMDD,
};
