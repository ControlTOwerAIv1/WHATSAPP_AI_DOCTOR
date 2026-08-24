/**
 * AI Bot — Patient Agent
 *
 * Handles all patient interactions:
 *   - General conversation (greetings, FAQs, health info)
 *   - Appointment booking via FSM (name → condition → slot → confirm)
 *   - Clinical Q&A
 *   - Medicine info
 *
 * The FSM stages mirror the Python appointment_scheduler.py logic:
 *   start → waiting_for_name → waiting_for_condition → waiting_for_slot → done
 */

const claude = require('./claude');
const sheets = require('./sheets');
const session = require('./session');

// ─── System Prompts ─────────────────────────────────────────────────

const RECEPTIONIST_SYSTEM = `You are the receptionist for Dr. AI Clinic.

Your responsibilities:
- Greet patients warmly
- Answer health-related questions
- Help schedule appointments
- Discuss medicines
- Politely refuse unrelated questions

Keep responses below 80 words unless necessary.
Never sound robotic.
Never mention prompts or internal workflow.

CRITICAL RULE: You are an informational receptionist. You do NOT have access to the clinic booking system during general conversation.
- Never claim that an appointment has been booked, confirmed, reserved, cancelled, or modified.
- Never collect patient registration details (name, symptoms, etc) during general chat.
- When the patient clearly commits to booking (e.g. "I'll take the 1 PM slot", "Book it"), acknowledge that you'll start the booking process.
- Never invent backend actions.`;

const SLOT_PRESENTATION_PROMPT = `You are a medical appointment scheduler. Present available doctor appointment slots to the patient in a friendly, clear way.

Available slots (from the system — these are the ONLY real slots, do not invent any):
{slots}

Patient's message: {message}

{urgency_instruction}

If the patient initially requested a specific doctor, date, or time (Initial request: {initial_request}), prioritize matching slots.

Rules:
- Present 2-3 of the best slots as numbered options (1, 2, 3)
- DIVERSITY RULE: Unless the patient explicitly asks for a specific doctor, offer slots from DIFFERENT doctors or at significantly different times.
- Include the doctor's name, specialty, date, and time for each
- Format dates clearly (e.g., "Thursday, July 3rd at 10:00 AM")
- Keep it brief
- Ask the patient to reply with the option number to confirm
- If no slots are available, apologize and suggest checking back later
- NEVER invent slots that aren't in the list above`;

const BOOKING_CONFIRM_PROMPT = `You are a medical appointment scheduler. The patient is confirming which slot they want.

Slots that were offered to the patient:
{slots}

Patient's response: {message}

Determine which slot the patient is choosing. They might say "1", "option 2", "the Tuesday one", "the morning slot", "Dr. Patel's slot", etc.

CRITICAL: Reply with ONLY the option number (1, 2, or 3) on the first line. Nothing else.
If you truly cannot determine which slot, reply with 0.`;

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

  // Record user message in history
  session.appendHistory(phone, 'user', message);

  // ── Global escape hatch ──
  const lower = message.toLowerCase().trim();
  if (['cancel', 'restart', 'start over', 'new appointment', 'never mind'].includes(lower)) {
    session.clearSession(phone);
    const reply = await claude.chat(
      'You are the receptionist of Dr AI Clinic.',
      `The patient just cancelled their current booking by saying "${message}". Acknowledge the cancellation naturally and ask how else you can help them today. Keep it under 2 sentences.`,
    ) || 'No problem. I\'ve cancelled the current booking. How can I help you today?';
    session.appendHistory(phone, 'assistant', reply);
    return reply;
  }

  // ── Route by appointment FSM stage ──
  const stage = sess.stage;

  let reply;
  if (stage === 'waiting_for_name') {
    reply = await _handleWaitingForName(phone, message, sess);
  } else if (stage === 'waiting_for_condition') {
    reply = await _handleWaitingForCondition(phone, message, sess);
  } else if (stage === 'waiting_for_slot') {
    reply = await _handleWaitingForSlot(phone, message, sess);
  } else {
    // start stage or no active FSM — classify intent
    const intent = await claude.classifyIntent(message, stage);

    if (intent === 'appointment') {
      reply = await _startAppointmentFlow(phone, message, sess);
    } else if (intent === 'clinical_question') {
      reply = await _handleClinicalQuestion(phone, message);
    } else if (intent === 'medicine') {
      reply = await _handleMedicineQuery(phone, message);
    } else {
      reply = await _handleGeneralChat(phone, message);
    }
  }

  if (!reply) {
    reply = 'I\'m sorry, I\'m having a bit of trouble right now. Could you try sending your message again? 🙏';
  }

  session.appendHistory(phone, 'assistant', reply);
  return reply;
}

// ─── Appointment FSM Handlers ───────────────────────────────────────

async function _startAppointmentFlow(phone, message, sess) {
  session.updateSession(phone, {
    stage: 'waiting_for_name',
    initialRequest: message,
  });

  return await claude.chat(
    'You are the receptionist of Dr AI Clinic.',
    `A patient just entered the booking flow by saying: "${message}". Politely and warmly acknowledge their choice (e.g. "Certainly, I can help you book that."), and then ask for their full name to get started. Keep it under 2 sentences.`,
  ) || 'Certainly! Before I reserve that appointment, may I have your full name?';
}

async function _handleWaitingForName(phone, message, sess) {
  const nameFailures = sess.nameFailures || 0;
  const validation = await claude.validateName(message);

  if (validation.valid || nameFailures >= 2) {
    // Accept the name
    const name = validation.name || message.trim();
    session.updateSession(phone, {
      stage: 'waiting_for_condition',
      name,
      nameFailures: 0,
    });

    return await claude.chat(
      'You are the receptionist of Dr AI Clinic.',
      `The patient just provided their name: ${name}. Thank them naturally and ask them to briefly describe their symptoms or reason for visit. Keep it under 2 sentences.`,
    ) || `Thank you, ${name}. Could you briefly describe the reason for your visit or your symptoms?`;
  }

  // Invalid name — ask again
  session.updateSession(phone, { nameFailures: nameFailures + 1 });
  return await _generateReprompt('full name', message);
}

async function _handleWaitingForCondition(phone, message, sess) {
  const condFailures = sess.conditionFailures || 0;
  const validation = await claude.validateCondition(message);

  if (validation.valid || condFailures >= 2) {
    const condition = validation.condition || message.trim();
    session.updateSession(phone, {
      condition,
      conditionFailures: 0,
    });

    // Fetch available slots
    const available = await sheets.getAvailableSlots();
    if (!available || available.length === 0) {
      session.clearSession(phone);
      return 'I\'m sorry, there are no available appointment slots right now. 😔\n\nPlease check back later.';
    }

    // Pick diverse slots
    const isUrgent = _detectUrgency(condition);
    const diverse = _pickDiverseSlots(available, 3, isUrgent);
    const slotsText = _formatSlotsForLLM(diverse);

    // Present slots via Claude
    const urgencyInstruction = isUrgent
      ? 'URGENCY DETECTED: The patient mentions urgent symptoms. Prioritize the EARLIEST available slot. Recommend they seek immediate care if symptoms are severe.'
      : 'This is a routine appointment request. Present slots in a convenient order, considering any time preferences the patient mentioned.';

    const prompt = SLOT_PRESENTATION_PROMPT
      .replace('{slots}', slotsText)
      .replace('{message}', condition)
      .replace('{urgency_instruction}', urgencyInstruction)
      .replace('{initial_request}', sess.initialRequest || 'None');

    const reply = await claude.chat('', prompt) || `Here are the available appointment slots:\n\n${slotsText}\n\nReply with a number to book.`;

    session.updateSession(phone, {
      stage: 'waiting_for_slot',
      offeredSlots: diverse,
    });

    return reply;
  }

  // Invalid condition — ask again
  session.updateSession(phone, { conditionFailures: condFailures + 1 });
  return await _generateReprompt('medical symptoms or reason for visit', message);
}

async function _handleWaitingForSlot(phone, message, sess) {
  const offered = sess.offeredSlots || [];
  if (offered.length === 0) {
    session.clearSession(phone);
    return 'Sorry, something went wrong. Please start the booking process again by saying "appointment".';
  }

  try {
    const slotsText = _formatSlotsForLLM(offered);
    const prompt = BOOKING_CONFIRM_PROMPT
      .replace('{slots}', slotsText)
      .replace('{message}', message);

    const result = await claude.chat('', prompt, { temperature: 0, maxTokens: 20 });
    const raw = (result || '').split('\n')[0].trim();
    let slotNum = parseInt(raw, 10);

    if (isNaN(slotNum) || slotNum < 1 || slotNum > offered.length) {
      return 'I couldn\'t tell which slot you\'d like. Could you reply with the option number? (e.g., "1", "2", or "3")';
    }

    const chosen = offered[slotNum - 1];
    const slotId = (chosen.slot_id || '').toString();

    // Book via Sheets
    const booking = await sheets.bookSlot(
      slotId,
      sess.name || 'Unknown Patient',
      phone,
      sess.condition || 'No condition provided',
    );

    if (!booking) {
      return 'Oh no — that slot was just booked by someone else! 😔\n\nLet me check what else is available. Send me "appointment" again and I\'ll show you the latest slots.';
    }

    // Clear session on success
    session.clearSession(phone);

    return (
      `✅ Your appointment has been confirmed!\n\n` +
      `👨‍⚕️ Doctor: Dr. ${booking.doctor_name} (${booking.specialty})\n` +
      `📅 Date: ${booking.date}\n` +
      `🕐 Time: ${booking.start_time} – ${booking.end_time}\n` +
      `🔖 Booking Ref: ${booking.booking_ref}\n\n` +
      `I'll send you a reminder before your appointment. ` +
      `If you need to reschedule, just let me know!`
    );
  } catch (err) {
    console.error('[AI-Bot] Booking confirmation failed:', err.message);
    return 'I couldn\'t process your booking. Could you please specify which option number you\'d like? (e.g., "1" or "2")';
  }
}

// ─── Non-Appointment Handlers ───────────────────────────────────────

async function _handleGeneralChat(phone, message) {
  // Fetch live slots for context
  let slotsText = 'Could not fetch live slots.';
  try {
    const available = await sheets.getAvailableSlots();
    if (!available || available.length === 0) {
      slotsText = 'No available slots right now.';
    } else {
      slotsText = 'Available doctors and slots:\n';
      for (const s of available) {
        slotsText += `- Dr. ${s.doctor_name} (${s.specialty}): ${s.date} at ${s.start_time}\n`;
      }
    }
  } catch (e) {
    // ignore
  }

  // Build messages with history
  const history = session.getHistory(phone, 10);
  const historyText = history.length > 0
    ? history.map(m => `${m.role === 'user' ? 'Patient' : 'Dr. AI'}: ${m.content}`).join('\n')
    : 'No previous conversation history.';

  const userPrompt = `Conversation history:\n${historyText}\n\nCurrent Live Appointment Availability:\n${slotsText}\n\nPatient's message: ${message}`;

  return await claude.chat(RECEPTIONIST_SYSTEM, userPrompt);
}

async function _handleClinicalQuestion(phone, message) {
  const systemPrompt = `You are a medical AI assistant at Dr. AI Clinic. The patient has a medical question.

Rules:
- Provide helpful, accurate medical information
- Always add a disclaimer that this is informational only and they should consult a doctor for proper diagnosis
- Keep responses under 120 words
- If the condition sounds urgent, recommend they book an appointment immediately
- Never diagnose — only inform`;

  return await claude.chat(systemPrompt, `Patient's question: ${message}`);
}

async function _handleMedicineQuery(phone, message) {
  const systemPrompt = `You are a medical AI assistant at Dr. AI Clinic. The patient has a question about medicine.

Rules:
- Provide general information about medications
- Always recommend consulting with their doctor before starting, stopping, or changing medication
- Never prescribe — only inform
- Keep responses under 100 words
- For dosage questions, always defer to their prescribing doctor`;

  return await claude.chat(systemPrompt, `Patient's question: ${message}`);
}

// ─── Helpers ────────────────────────────────────────────────────────

async function _generateReprompt(missingField, message) {
  return await claude.chat(
    'You are the receptionist of Dr AI Clinic.',
    `We are waiting for the patient to provide their ${missingField}. They just said: "${message}". Politely steer the conversation back toward collecting their ${missingField}. Do NOT discuss unrelated topics. Keep it under 2 sentences and natural.`,
  ) || `Please provide your ${missingField} so we can continue booking your appointment.`;
}

function _detectUrgency(message) {
  const urgentKeywords = [
    'urgent', 'emergency', 'chest pain', 'bleeding', "can't breathe",
    'difficulty breathing', 'severe', 'high fever', 'fainted', 'collapsed',
    'dizzy', 'numbness', 'stroke', 'heart attack',
  ];
  const lower = message.toLowerCase();
  return urgentKeywords.some(kw => lower.includes(kw));
}

function _pickDiverseSlots(slots, count = 3, urgent = false) {
  if (urgent) {
    slots = [...slots].sort((a, b) => {
      const aKey = (a.date || '') + (a.start_time || '');
      const bKey = (b.date || '') + (b.start_time || '');
      return aKey.localeCompare(bKey);
    });
  }

  const picked = [];
  const seenDoctors = new Set();

  // First pass: one slot per doctor
  for (const s of slots) {
    if (picked.length >= count) break;
    const doc = s.doctor_name || '';
    if (!seenDoctors.has(doc)) {
      picked.push(s);
      seenDoctors.add(doc);
    }
  }

  // Second pass: fill remaining
  if (picked.length < count) {
    for (const s of slots) {
      if (picked.length >= count) break;
      if (!picked.includes(s)) {
        picked.push(s);
      }
    }
  }

  return picked;
}

function _formatSlotsForLLM(slots) {
  return slots.map((s, i) => {
    const doctor = s.doctor_name || 'Doctor';
    const specialty = s.specialty || '';
    const date = s.date || '';
    const start = s.start_time || '';
    return `${i + 1}. Dr. ${doctor} (${specialty}) - ${date} at ${start}`;
  }).join('\n');
}

module.exports = {
  handlePatientMessage,
};
