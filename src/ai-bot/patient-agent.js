/**
 * AI Bot — Patient Agent
 *
 * Handles patient interactions in accordance with clinic schedule and guidelines:
 *   - Enforces booking window (Saturday 9:00 PM – Sunday 6:00 PM).
 *   - Directs closed-window messages appropriately without collecting details.
 *   - Manages token allocation with preference handling (Morning / Afternoon / No Preference).
 *   - Calculates arrival times dynamically using computeArrivalTime().
 *   - Reuses patient name if previously provided without re-asking.
 *   - Handles full-slot alternatives and hard capacity limits.
 *   - Prevents duplicate bookings in the same conversation.
 */

const claude = require('./claude');
const session = require('./session');
const schedule = require('./schedule');
const { getCurrentTime } = require('./clock');

// ─── Main Entry Point ───────────────────────────────────────────────

/**
 * Handle an incoming patient message.
 * @param {string} phone - Normalized phone number
 * @param {string} message - Message text
 * @param {string} senderName - WhatsApp push name (if available)
 * @returns {string} Reply text
 */
async function handlePatientMessage(phone, message, senderName) {
  const sess = session.getSession(phone);
  const currentTime = getCurrentTime();

  // Record user message in history
  session.appendHistory(phone, 'user', message);

  // ── Global escape hatch ──
  const lower = message.toLowerCase().trim();
  if (['cancel', 'restart', 'start over', 'new appointment', 'never mind'].includes(lower)) {
    session.clearSession(phone);
    const reply = "No problem. I've reset the conversation. How can I help you today?";
    session.appendHistory(phone, 'assistant', reply);
    return reply;
  }

  // Check intent and current FSM stage
  const stage = sess.stage;
  let isAppointmentIntent = false;

  if (stage && stage.startsWith('booking_')) {
    isAppointmentIntent = true;
  } else {
    // Quick regex heuristic for common appointment / token phrases
    const tokenRegex = /\b(token|appointment|slot|subah|morning|afternoon|shaam|naam likh|book)\b/i;
    const hindiUrduToken = lower.includes('token') || lower.includes('chahiye') || lower.includes('de do') || lower.includes('milega');

    if (tokenRegex.test(message) || hindiUrduToken) {
      isAppointmentIntent = true;
    } else {
      const intent = await claude.classifyIntent(message, stage);
      isAppointmentIntent = (intent === 'appointment');
    }
  }

  let reply;

  if (isAppointmentIntent) {
    // ── Check Booking Window ──
    const windowStatus = await schedule.isBookingWindowOpen(currentTime);
    if (!windowStatus.open) {
      // Outside booking window: do not collect details or issue tokens
      session.clearSession(phone);
      reply = windowStatus.message;
      session.appendHistory(phone, 'assistant', reply);
      return reply;
    }

    // Booking window is OPEN
    reply = await _handleAppointmentBookingFlow(phone, message, sess, senderName, currentTime);
  } else {
    // Non-appointment flow
    const intent = await claude.classifyIntent(message, stage);
    if (intent === 'clinical_question') {
      reply = await _handleClinicalQuestion(phone, message);
    } else if (intent === 'medicine') {
      reply = await _handleMedicineQuery(phone, message);
    } else {
      reply = await _handleGeneralChat(phone, message);
    }
  }

  if (!reply) {
    reply = "I'm sorry, I'm having a bit of trouble right now. Could you try sending your message again? 🙏";
  }

  session.appendHistory(phone, 'assistant', reply);
  return reply;
}

// ─── Appointment Booking Flow ───────────────────────────────────────

async function _handleAppointmentBookingFlow(phone, message, sess, senderName, currentTime) {
  const targetOperatingDate = await schedule.findNextOperatingDate(currentTime);
  const existingToken = schedule.getTokenByPhone(phone, targetOperatingDate);

  // 1. Duplicate Request Check
  if (existingToken) {
    session.clearSession(phone);
    return `${existingToken.patient_name}, you already have an appointment. Your ${existingToken.slot_name} token is #${existingToken.token_number}. Please try to reach the clinic around ${existingToken.arrival_time}. This is an approximate time.`;
  }

  // 2. Extract name if available in message or session
  let name = sess.name;
  if (!name) {
    name = _extractNameFromText(message);
  }

  // 3. Extract slot preference from message or session
  let preference = sess.slotPreference;
  const detectedPref = _extractSlotPreference(message);
  if (detectedPref) {
    preference = detectedPref;
    session.updateSession(phone, { slotPreference: preference });
  }

  // If in waiting_for_name stage
  if (sess.stage === 'booking_waiting_for_name') {
    if (!name) {
      // Validate with Claude if plain text name was sent
      const val = await claude.validateName(message);
      if (val && val.valid && val.name) {
        name = val.name;
      } else if (message.trim().length > 1 && message.trim().split(' ').length <= 4) {
        name = message.trim();
      }
    }

    if (!name) {
      return 'May I please have your full name to proceed with booking your appointment?';
    }

    session.updateSession(phone, { name });
  }

  // If in offering_alternative_slot stage (e.g. morning was full, asked if afternoon is okay)
  if (sess.stage === 'booking_offering_alternative') {
    const isAffirmative = _isAffirmative(message);
    if (isAffirmative && sess.offeredSlot) {
      preference = sess.offeredSlot;
      session.updateSession(phone, { slotPreference: preference });
    } else {
      session.clearSession(phone);
      return 'Understood. Please let us know if you would like to book for another clinic day.';
    }
  }

  // If in waiting_for_preference stage
  if (sess.stage === 'booking_waiting_for_preference') {
    if (!preference) {
      preference = _extractSlotPreference(message);
    }
    if (!preference) {
      // Default to morning if user just confirms
      if (_isAffirmative(message)) {
        preference = 'morning';
      } else {
        return 'Sure. Would you prefer a morning or afternoon token?';
      }
    }
    session.updateSession(phone, { slotPreference: preference });
  }

  // Step A: Do we have the name?
  if (!name) {
    session.updateSession(phone, {
      stage: 'booking_waiting_for_name',
      slotPreference: preference,
    });
    return 'Sure! Before I reserve that token, may I have your full name?';
  }

  // Step B: Do we have the time preference?
  // If no preference stated and both slots available -> ask
  const availability = await schedule.getSlotAvailability(targetOperatingDate);
  if (!preference) {
    if (!availability.morning.isFull && !availability.afternoon.isFull) {
      session.updateSession(phone, {
        stage: 'booking_waiting_for_preference',
        name,
      });
      return 'Sure. Would you prefer a morning or afternoon token?';
    } else if (!availability.morning.isFull) {
      preference = 'morning';
    } else if (!availability.afternoon.isFull) {
      preference = 'afternoon';
    } else {
      session.clearSession(phone);
      return `All ${availability.maxTokens} tokens for this date have already been given out.`;
    }
  }

  // Step C: Allocate Token
  const allocation = await schedule.allocateToken({
    phone,
    name,
    slotPreference: preference,
    currentTime,
    targetDate: targetOperatingDate,
  });

  if (allocation.isDuplicate && allocation.token) {
    session.clearSession(phone);
    const t = allocation.token;
    return `${t.patient_name}, you already have a ${t.slot_name} token #${t.token_number}. Please try to reach the clinic around ${t.arrival_time}. This is an approximate time.`;
  }

  if (!allocation.success) {
    if (allocation.reason === 'morning_full') {
      session.updateSession(phone, {
        stage: 'booking_offering_alternative',
        name,
        offeredSlot: 'afternoon',
      });
      return 'The morning tokens are currently full. Would you like an afternoon token instead?';
    }
    if (allocation.reason === 'afternoon_full') {
      session.updateSession(phone, {
        stage: 'booking_offering_alternative',
        name,
        offeredSlot: 'morning',
      });
      return 'The afternoon tokens are currently full. Would you like a morning token instead?';
    }
    if (allocation.reason === 'all_full') {
      session.clearSession(phone);
      return `All tokens for this date have already been given out.`;
    }
  }

  // Booking confirmed successfully!
  const token = allocation.token;
  session.clearSession(phone);

  const slotDisplay = token.slot_name.toLowerCase();
  return `${token.patient_name}, your ${slotDisplay} token is #${token.token_number}. Please try to reach the clinic around ${token.arrival_time}. This is an approximate time.`;
}

// ─── Natural Language Extraction Helpers ────────────────────────────

function _extractNameFromText(text) {
  if (!text) return null;
  const match = text.match(/(?:my name is|mera naam|naam|name is|i am|this is)\s+([A-Za-z\s]+?)(?:[.,!?]|$|\s+and|\s+i\s|\s+mujhe|\s+token|\s+chahiye|\s+hai|\s+hu|\s+hoon)/i);
  if (match && match[1].trim()) {
    let name = match[1].trim();
    name = name.replace(/\b(hai|hu|hoon|he|here|pls|please)\b/gi, '').trim();
    return name || null;
  }
  return null;
}

function _extractSlotPreference(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  if (lower.includes('morning') || lower.includes('subah') || lower.includes('subha') || lower.includes('before lunch') || lower.includes('11:00') || lower.includes('11 am')) {
    return 'morning';
  }
  if (lower.includes('afternoon') || lower.includes('lunch ke baad') || lower.includes('after lunch') || lower.includes('shaam') || lower.includes('sham') || lower.includes('after 3') || lower.includes('evening') || lower.includes('pm')) {
    return 'afternoon';
  }
  return null;
}

function _isAffirmative(text) {
  const lower = (text || '').toLowerCase().trim();
  return ['yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'ha', 'haan', 'chalega', 'fine', 'proceed', '1', 'yes please'].some(w => lower.startsWith(w) || lower === w);
}

// ─── Non-Appointment General Chat & Inquiries ────────────────────────

async function _handleGeneralChat(phone, message) {
  const effectiveTargetDate = await schedule.findNextOperatingDate(getCurrentTime());
  const systemPrompt = claude.getAppointmentSystemPrompt(effectiveTargetDate);
  const history = session.getHistory(phone, 6);
  const historyText = history.length > 0
    ? history.map(m => `${m.role === 'user' ? 'Patient' : 'Receptionist'}: ${m.content}`).join('\n')
    : 'No previous history.';

  const userPrompt = `Conversation history:\n${historyText}\n\nPatient's message: ${message}`;
  return await claude.chat(systemPrompt, userPrompt);
}

async function _handleClinicalQuestion(phone, message) {
  const systemPrompt = `You are a medical AI assistant at Dr. AI Clinic. The patient has a medical question.

Rules:
- Provide helpful, accurate medical information.
- Always add a disclaimer that this is informational only and they should consult a doctor for proper diagnosis.
- Keep responses under 100 words.
- Never diagnose — only inform.`;

  return await claude.chat(systemPrompt, `Patient's question: ${message}`);
}

async function _handleMedicineQuery(phone, message) {
  const systemPrompt = `You are a medical AI assistant at Dr. AI Clinic. The patient has a question about medicine.

Rules:
- Provide general information about medications.
- Always recommend consulting with their doctor before starting, stopping, or changing medication.
- Never prescribe — only inform.
- Keep responses under 100 words.`;

  return await claude.chat(systemPrompt, `Patient's question: ${message}`);
}

module.exports = {
  handlePatientMessage,
};
