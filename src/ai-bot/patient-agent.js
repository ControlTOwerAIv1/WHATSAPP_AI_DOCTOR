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
    // Quick regex heuristic for common appointment / token phrases (Latin and Devanagari)
    const tokenRegex = /\b(token|appointment|slot|subah|morning|afternoon|shaam|naam likh|book)\b/i;
    const hindiUrduToken = lower.includes('token') || lower.includes('chahiye') || lower.includes('de do') || lower.includes('milega') ||
      lower.includes('तोकन') || lower.includes('टोकन') || lower.includes('चाहिए') || lower.includes('चाही') || lower.includes('जाही') ||
      lower.includes('अपॉइंटमेंट') || lower.includes('अपोइंटमेंट') || lower.includes('स्लॉट');

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
    // Non-appointment flow — check if patient has an existing booking
    const targetDate = await schedule.findNextOperatingDate(currentTime);
    const existingToken = schedule.getTokenByPhone(phone, targetDate);

    if (existingToken) {
      // Patient has a booking — only answer from real booking data
      reply = _handlePostBookingQuestion(phone, message, existingToken);
    } else {
      const intent = await claude.classifyIntent(message, stage);
      if (intent === 'clinical_question') {
        reply = await _handleClinicalQuestion(phone, message);
      } else if (intent === 'medicine') {
        reply = await _handleMedicineQuery(phone, message);
      } else {
        reply = await _handleGeneralChat(phone, message);
      }
    }
  }

  if (!reply) {
    reply = "I'm sorry, I'm having a bit of trouble right now. Could you try sending your message again?";
  }

  session.appendHistory(phone, 'assistant', reply);
  return reply;
}

// ─── Appointment Booking Flow ───────────────────────────────────────

function _detectHindi(text) {
  if (!text) return false;
  if (/[\u0900-\u097F]/.test(text)) return true;
  const lower = text.toLowerCase();
  const hindiWords = [
    // Verbs
    'dena', 'dijiye', 'dijiyega', 'de do', 'de', 'do', 'doge', 'dona',
    'lena', 'lijiye', 'le do', 'le', 'lo', 'chahiye', 'chahie', 'chahye', 'mangta',
    'karna', 'karo', 'kariye', 'kar', 'kardo', 'kar do', 'karein',
    'hoga', 'hogi', 'honge', 'milega', 'milegi', 'milenge',
    'batana', 'batao', 'bataiye', 'bata', 'aana', 'aao', 'aaiye',
    'pahunch', 'chalega', 'rakhna', 'rakh',
    // Pronouns & Possessives
    'mera', 'meri', 'mere', 'mujhe', 'mujhko', 'humko', 'humein',
    'apna', 'apni', 'apne', 'aapka', 'aapki', 'aapke',
    'tera', 'teri', 'tere', 'tujhe', 'kiska', 'kisko',
    // Time, Day & Numbers
    'aaj', 'kal', 'parson', 'tarikh', 'tareekh', 'samay', 'waqt', 'baje',
    'kitne', 'subah', 'subha', 'dopahar', 'shaam', 'sham', 'raat',
    'ek', 'pehla',
    // Nouns & Greetings
    'naam', 'bimari', 'tabiyat', 'dawa', 'dawai', 'dost', 'bhai', 'bhaiya',
    'ji', 'sahab', 'shukriya', 'shukria', 'dhanyawad', 'namaste', 'salaam',
    'kripya', 'theek', 'haan', 'ha', 'nahi', 'nhi', 'mat',
    'kyun', 'kya', 'kaise', 'kahan', 'kidhar', 'kab', 'pehle', 'baad',
    'samajh', 'samaj', 'hai', 'hain', 'hu', 'hoon', 'tha', 'thi', 'the'
  ];
  return hindiWords.some(w => new RegExp(`\\b${w}\\b`, 'i').test(lower));
}

/**
 * Format a YYYY-MM-DD date string into human-readable "14th September" style.
 */
function _formatHumanDate(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1; // JS months are 0-indexed
  const day = parseInt(parts[2], 10);
  const d = new Date(year, month, day);
  if (isNaN(d.getTime())) return dateStr;

  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const dayNum = d.getDate();
  let suffix = 'th';
  if (dayNum === 1 || dayNum === 21 || dayNum === 31) suffix = 'st';
  else if (dayNum === 2 || dayNum === 22) suffix = 'nd';
  else if (dayNum === 3 || dayNum === 23) suffix = 'rd';

  return `${dayNum}${suffix} ${months[d.getMonth()]}`;
}

function _formatBookingConfirmation(token, isHindi) {
  const dateDisplay = _formatHumanDate(token.sunday_date);

  if (isHindi) {
    return `Date: ${dateDisplay}
Naam: ${token.patient_name}
Token: #${token.token_number}
Samay: ${token.arrival_time}`;
  }

  return `Date: ${dateDisplay}
Name: ${token.patient_name}
Token: #${token.token_number}
Time: ${token.arrival_time}`;
}

function _formatDuplicateNotice(token, isHindi) {
  const dateDisplay = _formatHumanDate(token.sunday_date);

  if (isHindi) {
    return `Date: ${dateDisplay}
Naam: ${token.patient_name}
Token: #${token.token_number}
Samay: ${token.arrival_time}`;
  }

  return `Date: ${dateDisplay}
Name: ${token.patient_name}
Token: #${token.token_number}
Time: ${token.arrival_time}`;
}

async function _handleAppointmentBookingFlow(phone, message, sess, senderName, currentTime) {
  const targetOperatingDate = await schedule.findNextOperatingDate(currentTime);
  const existingToken = schedule.getTokenByPhone(phone, targetOperatingDate);
  const isHindi = Boolean(sess.isHindi || _detectHindi(message));
  if (isHindi && !sess.isHindi) {
    session.updateSession(phone, { isHindi: true });
  }

  // 1. Duplicate Request Check
  if (existingToken) {
    session.clearSession(phone);
    return _formatDuplicateNotice(existingToken, isHindi);
  }

  // 2. Extract name if available in message or session only.
  //    senderName (WhatsApp push name) is intentionally NOT used — the user
  //    may be booking for a family member, so the display name is unreliable
  //    for medical records. We always ask if no name was explicitly typed.
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
      const lowerMsg = (message || '').toLowerCase().trim();
      const nonNameWords = [
        'samajh', 'samaj', 'nhi', 'nahi', 'kya', 'kyun', 'kaise', 'kab', 'kidhar',
        'kaha', 'kahan', 'hello', 'hi', 'hey', 'ok', 'okay', 'thanks', 'shukriya',
        'token', 'appointment', 'slot', 'subah', 'shaam', 'dopahar', 'time', 'date',
        'yes', 'no', 'haan', 'ha', 'na', 'please', 'kripya', 'batao', 'batayein'
      ];
      const hasNonName = nonNameWords.some(w => new RegExp(`\\b${w}\\b`, 'i').test(lowerMsg));

      if (!hasNonName) {
        // Validate with Claude if plain text name was sent
        const val = await claude.validateName(message);
        if (val && val.valid && val.name) {
          name = val.name;
        } else if (!val || val.reason === 'Validation service error') {
          if (/^[a-zA-Z\u0900-\u097F\s.'-]+$/.test(message.trim()) && message.trim().split(/\s+/).length <= 4) {
            name = message.trim();
          }
        }
      }
    }

    if (!name) {
      return isHindi
        ? 'Token reserve karne ke liye, kripya apna pura naam batayein.'
        : 'To reserve your token, may I please have your full name?';
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
      return isHindi
        ? 'Theek hai. Agar aap kisi aur din ke liye token book karna chahein toh batayein.'
        : 'Understood. Please let us know if you would like to book for another clinic day.';
    }
  }

  // Step A: Do we have the name? If genuinely missing, ask ONLY for name (never slot preference).
  if (!name) {
    session.updateSession(phone, {
      stage: 'booking_waiting_for_name',
      slotPreference: preference,
    });
    return isHindi
      ? 'Token reserve karne ke liye, kripya apna pura naam batayein.'
      : 'To reserve your token, may I please have your full name?';
  }

  // Step B: Slot preference - auto-allocate morning first, then afternoon based on availability.
  // Never ask "would you prefer morning or afternoon".
  const availability = await schedule.getSlotAvailability(targetOperatingDate);
  if (!preference) {
    if (!availability.morning.isFull) {
      preference = 'morning';
    } else if (!availability.afternoon.isFull) {
      preference = 'afternoon';
    } else {
      session.clearSession(phone);
      return isHindi
        ? `Is tareekh ke sabhi ${availability.maxTokens} tokens pehle hi diye ja chuke hain.`
        : `All ${availability.maxTokens} tokens for this date have already been given out.`;
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
    return _formatDuplicateNotice(allocation.token, isHindi);
  }

  if (!allocation.success) {
    if (allocation.reason === 'morning_full') {
      session.updateSession(phone, {
        stage: 'booking_offering_alternative',
        name,
        offeredSlot: 'afternoon',
      });
      return isHindi
        ? 'Subah ke sabhi tokens full ho chuke hain. Kya aapko dopahar (afternoon) ka token chahiye?'
        : 'The morning tokens are currently full. Would you like an afternoon token instead?';
    }
    if (allocation.reason === 'afternoon_full') {
      session.updateSession(phone, {
        stage: 'booking_offering_alternative',
        name,
        offeredSlot: 'morning',
      });
      return isHindi
        ? 'Dopahar ke sabhi tokens full ho chuke hain. Kya aapko subah (morning) ka token chahiye?'
        : 'The afternoon tokens are currently full. Would you like a morning token instead?';
    }
    if (allocation.reason === 'all_full') {
      session.clearSession(phone);
      return isHindi
        ? `Is tareekh ke sabhi tokens pehle hi diye ja chuke hain.`
        : `All tokens for this date have already been given out.`;
    }
  }

  // Booking confirmed successfully!
  const token = allocation.token;
  session.clearSession(phone);

  return _formatBookingConfirmation(token, isHindi);
}

// ─── Natural Language Extraction Helpers ────────────────────────────

function _extractNameFromText(text) {
  if (!text) return null;
  const match = text.match(/(?:my name is|mera naam|naam|name is|i am|this is|मेरा\s+नाम|नाम|मैं)\s+([A-Za-z\u0900-\u097F\s]+?)(?:[.,!?।|]|$|\s+and|\s+aur|\s+और|\s+i\s|\s+mujhe|\s+मुझे|\s+token|\s+तोकन|\s+टोकन|\s+chahiye|\s+चाहिए|\s+चाही|\s+जाही|\s+hai|\s+है|\s+hu|\s+hoon|\s+हूँ|\s+हु)/i);
  if (match && match[1].trim()) {
    let name = match[1].trim();
    name = name.replace(/\b(hai|hu|hoon|he|here|pls|please)\b/gi, '').replace(/(?:है|हूँ|हु|कृपया|प्लीज)/g, '').trim();
    return name || null;
  }
  return null;
}

function _extractSlotPreference(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  if (lower.includes('morning') || lower.includes('subah') || lower.includes('subha') || lower.includes('before lunch') || lower.includes('11:00') || lower.includes('11 am') || lower.includes('सुबह')) {
    return 'morning';
  }
  if (lower.includes('afternoon') || lower.includes('lunch ke baad') || lower.includes('after lunch') || lower.includes('shaam') || lower.includes('sham') || lower.includes('after 3') || lower.includes('evening') || lower.includes('pm') || lower.includes('दोपहर') || lower.includes('शाम')) {
    return 'afternoon';
  }
  return null;
}

function _isAffirmative(text) {
  const lower = (text || '').toLowerCase().trim();
  return ['yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'ha', 'haan', 'chalega', 'fine', 'proceed', '1', 'yes please'].some(w => lower.startsWith(w) || lower === w);
}

// ─── Post-Booking Question Handler ──────────────────────────────────

/**
 * Handle questions from a patient who already has a booking.
 * Only answers from real booking data; deflects everything else.
 */
function _handlePostBookingQuestion(phone, message, token) {
  const isHindi = _detectHindi(message);
  const lower = (message || '').toLowerCase();

  // Check if the question is about their booking data
  const bookingDataKeywords = [
    'token', 'number', 'naam', 'name', 'time', 'samay', 'waqt',
    'date', 'tareekh', 'tarikh', 'kab', 'kitne baje',
    'mera', 'my', 'appointment', 'booking',
  ];

  const isBookingQuery = bookingDataKeywords.some(kw => lower.includes(kw));

  if (isBookingQuery) {
    // Answer from real booking data
    const dateDisplay = _formatHumanDate(token.sunday_date);

    if (isHindi) {
      return `Date: ${dateDisplay}
Naam: ${token.patient_name}
Token: #${token.token_number}
Samay: ${token.arrival_time}`;
    }

    return `Date: ${dateDisplay}
Name: ${token.patient_name}
Token: #${token.token_number}
Time: ${token.arrival_time}`;
  }

  // Deflect — do not answer from general knowledge
  if (isHindi) {
    return 'Iske liye kripya clinic se sampark karein.';
  }
  return 'Please contact the clinic directly about this.';
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
  const systemPrompt = `You are a medical AI assistant at Al Ramzan Shifakhana. The patient has a medical question.

Rules:
- Provide helpful, accurate medical information.
- Always add a disclaimer that this is informational only and they should consult a doctor for proper diagnosis.
- Keep responses under 100 words.
- Never diagnose — only inform.`;

  return await claude.chat(systemPrompt, `Patient's question: ${message}`);
}

async function _handleMedicineQuery(phone, message) {
  const systemPrompt = `You are a medical AI assistant at Al Ramzan Shifakhana. The patient has a question about medicine.

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
