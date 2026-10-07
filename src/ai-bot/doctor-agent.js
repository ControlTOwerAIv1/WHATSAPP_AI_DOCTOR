/**
 * AI Bot — Doctor Agent
 *
 * Handles messages from registered doctor phone numbers.
 * Provides doctor-specific capabilities:
 *   - View today's appointments
 *   - View upcoming schedule
 *   - Query patient details for upcoming appointments
 *   - General Q&A about their schedule
 */

const claude = require('./claude');
const session = require('./session');
const schedule = require('./schedule');
const { getCurrentTime } = require('./clock');

const DOCTOR_SYSTEM = `You are an AI assistant for doctors at Al Ramzan Shifakhana. You are speaking with a registered doctor.

Your capabilities:
- You have live access to the clinic's appointment schedule and bookings database.
- Show the doctor their today's appointments and upcoming schedule.
- Provide patient details for upcoming appointments.
- Answer questions about their schedule.
- Be professional, warm, and concise.

Important instructions:
- If the schedule or bookings context below is empty or shows no appointments, state clearly to the doctor that they currently have no appointments scheduled.
- Never say you don't have access to the system or database, because you are connected to the live clinic schedule.
- Keep responses under 100 words unless listing multiple appointments.
- Never share other doctors' patient information.
- The doctor's name is: {doctor_name}
- The doctor's specialty is: {specialty}`;

function _formatDoctorTitle(name) {
  const clean = (name || '').trim();
  if (!clean || clean.toLowerCase() === 'admin') {
    return 'Admin';
  }
  if (/^dr\.?\s+/i.test(clean)) {
    return clean;
  }
  return `Dr. ${clean}`;
}

/**
 * Handle an incoming message from a doctor.
 * @param {string} phone - Normalized phone number
 * @param {string} message - Message text
 * @param {{ name: string, specialty: string }} doctorInfo
 * @returns {string} Reply text
 */
async function handleDoctorMessage(phone, message, doctorInfo) {
  session.appendHistory(phone, 'user', message);

  const lower = message.toLowerCase().trim();
  const currentTime = getCurrentTime();
  const currentDateTimeISO = currentTime.toISOString().substring(0, 19);

  try {
    let reply;

    // 1. Check relative date resolution (Step 8 resolver)
    const resolvedDate = claude.resolveRelativeDate(message, currentDateTimeISO);

    // 2. Check if asking for upcoming schedule multi-day overview
    const isUpcomingOverview = (lower.includes('upcoming') || lower.includes('this week') || lower.includes('next week') || lower.includes('overview') || lower.includes('sessions')) && !resolvedDate && !lower.includes('token') && !lower.includes('patient') && !lower.includes('detail') && !lower.includes('name');

    if (isUpcomingOverview) {
      reply = await _showUpcomingSchedule(doctorInfo);
    } else if (resolvedDate) {
      // Specific date requested ("this Sunday", "tomorrow", "today", or explicit date).
      // If the resolved date is today (a non-clinic day), fall back to the next operating date
      // so the doctor sees the actual upcoming bookings, not an empty non-clinic day.
      const sched = await schedule.getEffectiveSchedule(resolvedDate);
      const effectiveDate = sched.is_open ? resolvedDate : await schedule.findNextOperatingDate(currentTime);
      reply = await getBookingsForDate(effectiveDate, doctorInfo);

    } else if (lower.includes('token') || lower.includes('appointment') || lower.includes('patient') || lower.includes('slot') || lower.includes('booking') || lower.includes('detail') || lower.includes('name') || lower.includes('booked') || lower.includes('schedule') || lower.includes('who is') || lower.includes('list')) {
      // General booking/token query without a specific date:
      // Default to next operating date (or today if open)
      const targetDate = await schedule.findNextOperatingDate(currentTime);
      reply = await getBookingsForDate(targetDate, doctorInfo);
    } else {
      // Ambiguous query from doctor: default to real booking data rather than claiming no access!
      const targetDate = await schedule.findNextOperatingDate(currentTime);
      reply = await getBookingsForDate(targetDate, doctorInfo);
    }

    if (!reply) {
      reply = `Good day, ${_formatDoctorTitle(doctorInfo.name)}. You currently have no appointments scheduled.`;
    }

    session.appendHistory(phone, 'assistant', reply);
    return reply;
  } catch (err) {
    console.error('[AI-Bot] Doctor agent error:', err.message);
    return `Hello ${_formatDoctorTitle(doctorInfo.name)}, I'm experiencing a technical issue. Please try again shortly.`;
  }
}

/**
 * Show appointments for a specified date (or today) for the doctor using authoritative SQLite tokens.
 * Generalizes _showTodayAppointments to accept any resolved date.
 * Returns patient names, tokens, phone numbers, conditions, and arrival times for that date.
 *
 * @param {string} targetDate - Date in YYYY-MM-DD
 * @param {{ name: string, specialty: string }} doctorInfo
 * @returns {Promise<string>}
 */
async function getBookingsForDate(targetDate, doctorInfo) {
  const currentTime = getCurrentTime();
  // formatDateToYYYYMMDD is already IST-aware (fixed in schedule.js)
  const todayStr = schedule.formatDateToYYYYMMDD(currentTime);
  const nextOpDate = await schedule.findNextOperatingDate(currentTime);
  const dateStr = targetDate || nextOpDate;
  const effectiveSchedule = await schedule.getEffectiveSchedule(dateStr);

  // Label "today" when the date is the IST calendar date; label "next clinic day" when
  // it's the upcoming operating date but not literally today's calendar date.
  const isCalendarToday = (dateStr === todayStr);
  const isNextOpDate = (dateStr === nextOpDate);

  const d = new Date(`${dateStr}T12:00:00Z`);
  const dayName = isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'Asia/Kolkata' });
  let dateLabel;
  if (isCalendarToday) {
    dateLabel = `today (${dateStr})`;
  } else if (isNextOpDate) {
    dateLabel = `${dayName ? `${dayName}, ` : ''}${dateStr} (next clinic day)`;
  } else {
    dateLabel = `${dayName ? `${dayName}, ` : ''}${dateStr}`;
  }

  if (!effectiveSchedule.is_open) {
    return `Good day, ${_formatDoctorTitle(doctorInfo.name)}.\n\nThe clinic is closed on ${dateLabel}.`;
  }

  // Authoritative tokens from SQLite
  const tokens = schedule.getBookingsForDate(dateStr);

  if (tokens.length === 0) {
    return `Good day, ${_formatDoctorTitle(doctorInfo.name)}.\n\nSchedule for ${dateLabel}:\n\nNo patient appointments booked for this date.\nTotal capacity: ${effectiveSchedule.max_tokens} tokens available.`;
  }

  let reply = `Good day, ${_formatDoctorTitle(doctorInfo.name)}.\n\nSchedule for ${dateLabel}:\n\n`;

  for (const t of tokens) {
    reply += `Token #${t.token_number} (${(t.slot_name || 'morning').toUpperCase()}): ${t.patient_name}\n`;
    reply += `   Arrival: around ${t.arrival_time}\n`;
    if (t.condition) reply += `   Condition: ${t.condition}\n`;
    reply += `   Phone: ${t.patient_phone}\n\n`;
  }

  const bookedCount = tokens.length;
  const availableCount = Math.max(0, effectiveSchedule.max_tokens - bookedCount);
  reply += `Summary: ${bookedCount} booked, ${availableCount} available.`;

  return reply;
}

// Backwards-compatible alias for today's appointments
const _showTodayAppointments = (doctorInfo) => getBookingsForDate(null, doctorInfo);

/**
 * Show upcoming schedule using effective schedule & SQLite token counts (Step 4).
 */
async function _showUpcomingSchedule(doctorInfo) {
  const currentTime = getCurrentTime();
  const upcomingSessions = [];

  // Inspect next 14 calendar days
  for (let i = 0; i < 14; i++) {
    const d = new Date(currentTime.getTime() + i * 24 * 60 * 60 * 1000);
    const dateStr = schedule.formatDateToYYYYMMDD(d);
    const config = await schedule.getEffectiveSchedule(dateStr);

    if (config.is_open) {
      const tokens = schedule.getTokensForSunday(dateStr);
      const dayName = d.toLocaleDateString('en-US', { weekday: 'long' });
      upcomingSessions.push({
        date: dateStr,
        dayName,
        maxTokens: config.max_tokens,
        booked: tokens.length,
        available: Math.max(0, config.max_tokens - tokens.length),
      });

      if (upcomingSessions.length >= 4) break;
    }
  }

  if (upcomingSessions.length === 0) {
    return `${_formatDoctorTitle(doctorInfo.name)}, you don't have any upcoming scheduled sessions.`;
  }

  let reply = `${_formatDoctorTitle(doctorInfo.name)}, here's your upcoming schedule:\n\n`;
  for (const s of upcomingSessions) {
    reply += `${s.date} (${s.dayName}): ${s.maxTokens} capacity (${s.booked} booked, ${s.available} available)\n`;
  }

  return reply;
}

module.exports = {
  handleDoctorMessage,
  getBookingsForDate,
};
