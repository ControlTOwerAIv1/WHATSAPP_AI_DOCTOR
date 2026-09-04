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
const sheets = require('./sheets');
const session = require('./session');
const { getCurrentTime } = require('./clock');

const DOCTOR_SYSTEM = `You are an AI assistant for doctors at Dr. AI Clinic. You are speaking with a registered doctor.

Your capabilities:
- You have live access to the clinic's Google Sheet schedule and appointments.
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

  try {
    let reply;

    // Direct appointment/schedule command matching
    if (lower.includes('today') && (lower.includes('appointment') || lower.includes('schedule') || lower.includes('patient') || lower.includes('slot'))) {
      reply = await _showTodayAppointments(doctorInfo);
    } else if (lower.includes('schedule') || lower.includes('upcoming') || lower.includes('this week') || lower.includes('tomorrow')) {
      reply = await _showUpcomingSchedule(doctorInfo);
    } else if (lower.includes('appointment') || lower.includes('patient') || lower.includes('slot') || lower.includes('booking')) {
      // General appointment query: check today first, if none check upcoming
      const todayReply = await _showTodayAppointments(doctorInfo);
      if (todayReply.includes('schedule for today')) {
        reply = todayReply;
      } else {
        reply = await _showUpcomingSchedule(doctorInfo);
      }
    } else {
      // General doctor chat with context
      reply = await _handleDoctorChat(phone, message, doctorInfo);
    }

    if (!reply) {
      reply = `Hello Dr. ${doctorInfo.name}! You currently have no appointments scheduled. Let me know if you need anything else!`;
    }

    session.appendHistory(phone, 'assistant', reply);
    return reply;
  } catch (err) {
    console.error('[AI-Bot] Doctor agent error:', err.message);
    return `Hello Dr. ${doctorInfo.name}, I'm experiencing a technical issue. Please try again shortly. 🙏`;
  }
}

async function _showTodayAppointments(doctorInfo) {
  const bookings = await sheets.getDoctorBookings(doctorInfo.name);
  const schedule = await sheets.getDoctorSchedule(doctorInfo.name);
  const todayStr = getCurrentTime().toISOString().split('T')[0];
  const todaySlots = schedule.filter(s => s.date === todayStr);

  if (todaySlots.length === 0) {
    return `Good day, Dr. ${doctorInfo.name}! 👋\n\nYou don't have any scheduled slots for today.`;
  }

  let reply = `Good day, Dr. ${doctorInfo.name}! 👋\n\nHere's your schedule for today:\n\n`;

  for (const slot of todaySlots) {
    const status = (slot.status || '').toLowerCase();
    const booking = bookings.find(b => b.slot_id === slot.slot_id);

    if (status === 'booked' && booking) {
      reply += `🕐 ${slot.start_time} – ${slot.end_time}: ${booking.patient_name}\n`;
      reply += `   📋 Condition: ${booking.condition}\n`;
      reply += `   📞 Phone: ${booking.patient_phone}\n\n`;
    } else if (status === 'open') {
      reply += `🕐 ${slot.start_time} – ${slot.end_time}: ✅ Available\n\n`;
    } else {
      reply += `🕐 ${slot.start_time} – ${slot.end_time}: ${status}\n\n`;
    }
  }

  const bookedCount = todaySlots.filter(s => (s.status || '').toLowerCase() === 'booked').length;
  const openCount = todaySlots.filter(s => (s.status || '').toLowerCase() === 'open').length;
  reply += `📊 Summary: ${bookedCount} booked, ${openCount} available`;

  return reply;
}

async function _showUpcomingSchedule(doctorInfo) {
  const schedule = await sheets.getDoctorSchedule(doctorInfo.name);

  if (schedule.length === 0) {
    return `Dr. ${doctorInfo.name}, you don't have any upcoming scheduled slots.`;
  }

  let reply = `Dr. ${doctorInfo.name}, here's your upcoming schedule:\n\n`;

  // Group by date
  const byDate = {};
  for (const slot of schedule) {
    const date = slot.date || 'Unknown';
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(slot);
  }

  for (const [date, slots] of Object.entries(byDate)) {
    const booked = slots.filter(s => (s.status || '').toLowerCase() === 'booked').length;
    const open = slots.filter(s => (s.status || '').toLowerCase() === 'open').length;
    reply += `📅 ${date}: ${slots.length} slots (${booked} booked, ${open} available)\n`;
  }

  return reply;
}

async function _handleDoctorChat(phone, message, doctorInfo) {
  // Fetch schedule data for context
  let scheduleContext = '';
  try {
    const schedule = await sheets.getDoctorSchedule(doctorInfo.name);
    const bookings = await sheets.getDoctorBookings(doctorInfo.name);

    if (schedule.length > 0) {
      scheduleContext = '\nYour upcoming slots:\n' +
        schedule.slice(0, 10).map(s =>
          `- ${s.date} ${s.start_time}-${s.end_time}: ${s.status}`
        ).join('\n');
    }
    if (bookings.length > 0) {
      scheduleContext += '\n\nToday\'s bookings:\n' +
        bookings.map(b =>
          `- ${b.patient_name} (${b.condition}) - Ref: ${b.booking_ref}`
        ).join('\n');
    }
  } catch (e) {
    // ignore
  }

  const history = session.getHistory(phone, 6);
  const historyText = history.length > 0
    ? history.map(m => `${m.role === 'user' ? 'Doctor' : 'Assistant'}: ${m.content}`).join('\n')
    : '';

  const systemPrompt = DOCTOR_SYSTEM
    .replace('{doctor_name}', doctorInfo.name)
    .replace('{specialty}', doctorInfo.specialty);

  const userPrompt = `${historyText ? `Recent conversation:\n${historyText}\n\n` : ''}${scheduleContext ? `Schedule context:${scheduleContext}\n\n` : ''}Doctor's message: ${message}`;

  return await claude.chat(systemPrompt, userPrompt);
}

module.exports = {
  handleDoctorMessage,
};
