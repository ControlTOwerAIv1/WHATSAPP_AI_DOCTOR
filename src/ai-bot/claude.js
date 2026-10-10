/**
 * AI Bot — Claude API Wrapper
 *
 * Thin wrapper around the Anthropic Claude SDK. Provides helpers for:
 *   - Intent classification (deterministic, temperature 0)
 *   - Conversational replies (temperature 0.3)
 *   - Structured JSON validation (name, condition)
 */

const Anthropic = require('@anthropic-ai/sdk');
const { getConfig } = require('./config');
const schedule = require('./schedule');

let _client = null;

const MODEL = 'claude-sonnet-4-5';

function _getClient() {
  if (!_client) {
    const config = getConfig();
    if (!config.anthropicApiKey) {
      throw new Error('ANTHROPIC_API_KEY not configured');
    }
    _client = new Anthropic({ apiKey: config.anthropicApiKey });
    console.log(`[AI-Bot] Claude client initialized (model: ${MODEL})`);
  }
  return _client;
}

/**
 * Get the fully rendered appointment receptionist system prompt.
 * Loads appointment-behavior.md and interpolates placeholders from the effective schedule.
 * @param {string|Date} [targetDate]
 * @returns {string} Rendered system prompt
 */
function getAppointmentSystemPrompt(targetDate = null) {
  return schedule.renderPromptTemplate(targetDate);
}

/**
 * Low-level message call to Claude.
 * @param {string} systemPrompt - System instructions
 * @param {string} userMessage - User's message
 * @param {object} options - { temperature, maxTokens }
 * @returns {string} Claude's text response
 */
async function chat(systemPrompt, userMessage, options = {}) {
  const { temperature = 0.3, maxTokens = 600 } = options;
  try {
    const client = _getClient();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });
    return response.content[0].text.trim();
  } catch (err) {
    console.error('[AI-Bot] Claude API error:', err.message);
    return null;
  }
}

/**
 * Multi-turn conversation with Claude (includes history).
 * @param {string} systemPrompt
 * @param {Array<{role: string, content: string}>} messages - Anthropic-format messages
 * @param {object} options
 * @returns {string}
 */
async function chatWithHistory(systemPrompt, messages, options = {}) {
  const { temperature = 0.3, maxTokens = 600 } = options;
  try {
    const client = _getClient();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
      messages,
    });
    return response.content[0].text.trim();
  } catch (err) {
    console.error('[AI-Bot] Claude API error:', err.message);
    return null;
  }
}

/**
 * Classify user intent. Uses temperature=0 for deterministic output.
 * @param {string} message - User's message text
 * @param {string} [appointmentStage] - Current appointment stage (if any)
 * @returns {string} One of: general, appointment, medicine, clinical_question
 */
async function classifyIntent(message, appointmentStage) {
  // If user is mid-flow in the appointment FSM, lock them in
  if (appointmentStage && appointmentStage !== 'start') {
    return 'appointment';
  }

  const prompt = `You are an intent classifier for a medical AI assistant.

Classify the input message into exactly one of these labels:
1. "general": Greetings, small talk, asking about doctor availability, asking about clinic timings, or general inquiries (where the user has NOT explicitly asked to book).
2. "appointment": EXPLICIT or IMPLICIT booking requests (e.g., "book this slot", "schedule an appointment", "token chahiye", "ek token de do", "Sunday ka token", "appointment chahiye", "naam likh do", "morning token", "afternoon token", "subah ka token", "I want to see the doctor", "Yes, I'd like to proceed", "Sounds good", "I'll take the morning slot", "Book it").
3. "medicine": Medications, dosage, prescriptions, or refills.
4. "clinical_question": General medical questions or asking for medical advice WITHOUT asking for an appointment.

CRITICAL: Output ONLY the single word label. No whitespace, punctuation, quotes, or filler.

Message: ${message}`;

  const result = await chat('', prompt, { temperature: 0, maxTokens: 20 });
  if (!result) return 'general';

  const cleaned = result.toLowerCase().replace(/[^a-z_]/g, '');
  const valid = new Set(['general', 'appointment', 'medicine', 'clinical_question']);
  return valid.has(cleaned) ? cleaned : 'general';
}

/**
 * Classify an admin confirmation response (multilingual: English, Hindi, Urdu, Hinglish).
 * Returns 'confirm', 'cancel', or 'other'.
 * @param {string} message
 * @returns {Promise<'confirm'|'cancel'|'other'>}
 */
async function classifyAdminConfirmation(message) {
  const prompt = `You are evaluating an admin user's response to a pending confirmation request.
The admin was previously asked to confirm or cancel a change to clinic settings/overrides.

Admin message: "${message}"

Classify into exactly one of these labels:
- "confirm": The admin is agreeing, confirming, or authorizing the change in English, Hindi, Urdu, or Hinglish (e.g., "yes", "yeah", "yep", "sure", "proceed", "haan", "ha", "theek hai", "sahi hai", "bilkul", "kar do", "ok", "okay", "confirm", "proceed please", "chalega", "yes do it").
- "cancel": The admin is rejecting, cancelling, or telling not to proceed in English, Hindi, Urdu, or Hinglish (e.g., "no", "cancel", "stop", "abort", "nahi", "mat karo", "nah", "never mind", "cancel karo", "rehney do").
- "other": The admin sent something unrelated, a new question, or a completely different command (e.g., "what time is Sunday", "change tokens to 50", "who is on duty", "hello").

CRITICAL: Output ONLY the single word: confirm, cancel, or other.`;

  const result = await chat('', prompt, { temperature: 0, maxTokens: 20 });
  if (!result) return 'other';

  const cleaned = result.toLowerCase().replace(/[^a-z]/g, '');
  if (['confirm', 'cancel', 'other'].includes(cleaned)) {
    return cleaned;
  }
  return 'other';
}

/**
 * Helper to deterministically resolve relative date phrases against a reference date. (Step 8)
 *
 * @param {string} phrase - e.g. "today", "tomorrow", "this Sunday", "next Wednesday", "this weekend"
 * @param {string} refDateISO - e.g. "2026-08-26T12:00:00"
 * @returns {string|null} - YYYY-MM-DD
 */
function resolveRelativeDate(phrase, refDateISO) {
  if (!phrase) return null;
  const ref = new Date(refDateISO);
  if (isNaN(ref.getTime())) return null;

  const lower = phrase.toLowerCase().trim();

  // If already a valid YYYY-MM-DD, return it directly
  const directIso = lower.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (directIso) return directIso[1];

  // All date arithmetic must be done in IST (UTC+5:30) so that "today"
  // for an Indian user at 11 PM IST isn't treated as the previous UTC day.
  const IST_MS = 5.5 * 60 * 60 * 1000;

  // Shift ref into IST by adding the offset, then use UTC accessors.
  const refIST = new Date(ref.getTime() + IST_MS);

  const format = (istDate) => {
    const yyyy = istDate.getUTCFullYear();
    const mm = String(istDate.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(istDate.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };

  const dayOfWeek = refIST.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat (in IST)

  if (lower.includes('today')) {
    return format(refIST);
  }
  if (lower.includes('tomorrow')) {
    const d = new Date(refIST.getTime() + 24 * 60 * 60 * 1000);
    return format(d);
  }
  if (lower.includes('this weekend')) {
    // Upcoming weekend day (defaulting to Sunday)
    const daysUntilSunday = (7 - dayOfWeek) % 7 || 7;
    const d = new Date(refIST.getTime() + daysUntilSunday * 24 * 60 * 60 * 1000);
    return format(d);
  }

  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let targetDayIdx = 0; targetDayIdx < 7; targetDayIdx++) {
    const dayName = days[targetDayIdx];
    if (lower.includes(dayName)) {
      const isNext = lower.includes(`next ${dayName}`);
      let diff = (targetDayIdx - dayOfWeek + 7) % 7;
      if (diff === 0 && isNext) {
        diff = 7;
      } else if (diff === 0 && !lower.includes(`this ${dayName}`)) {
        // e.g. "Wednesday" said on Wednesday could refer to next week if afternoon/past
        diff = 7;
      }
      const d = new Date(refIST.getTime() + diff * 24 * 60 * 60 * 1000);
      return format(d);
    }
  }

  return null;
}


/**
 * Classify admin message intent as QUERY or COMMAND using semantic tone understanding (Step 9).
 * Does NOT rely on specific trigger words.
 * @param {string} message
 * @returns {Promise<'QUERY'|'COMMAND'>}
 */
async function classifyAdminIntent(message) {
  const prompt = `You are an expert AI assistant evaluating a WhatsApp message from a Doctor or Clinic Administrator.

Classify if this message is a QUERY (asking for information about schedule, timings, workload, or tokens without changing anything) or a COMMAND (giving an instruction, stating absence, closing clinic, adjusting capacity, or updating schedule).

CRITICAL: Rely on the semantic meaning and intent, NOT on specific trigger keywords.
- A doctor saying "what's left for today", "hey how many people am I seeing", or "any slots open right now" is asking for status -> QUERY.
- A doctor saying "not going to be in today", "skip today, I'm out", or "let's not take anyone this afternoon" is giving an operational instruction / stating absence -> COMMAND.

Examples of QUERY:
- "what time do we open Sunday"
- "what's left for today"
- "hey how many people am I seeing"
- "any slots open right now"
- "how many tokens are configured"
- "are we open this week"

Examples of COMMAND:
- "not going to be in today"
- "skip today, I'm out"
- "let's not take anyone this afternoon"
- "we're open next Wednesday instead, tokens from Tuesday 9pm"
- "close the clinic on Sunday August 30"
- "change max tokens to 50 permanently"

Message: "${message}"

CRITICAL: Output ONLY the single word: QUERY or COMMAND.`;

  const result = await chat('', prompt, { temperature: 0, maxTokens: 20 });
  if (!result) return 'QUERY';

  const cleaned = result.toUpperCase().replace(/[^A-Z]/g, '');
  return cleaned === 'COMMAND' ? 'COMMAND' : 'QUERY';
}

/**
 * Semantically classify an admin/doctor query into one of three categories:
 * - DOCTOR_BOOKINGS: Queries about patient appointments, tokens issued, names, details, conditions, who is booked, or patient schedule for a date.
 * - CLINIC_CONFIG: Queries about operational rules, operating hours, break times, booking window hours, or clinic policies.
 * - CLINIC_CAPACITY: Queries about macro capacity, remaining token counts, or clinic-wide numbers (admin metrics, not patient details).
 *
 * @param {string} message
 * @returns {Promise<'DOCTOR_BOOKINGS'|'CLINIC_CONFIG'|'CLINIC_CAPACITY'>}
 */
async function classifyAdminQueryType(message) {
  const prompt = `You are an expert AI assistant evaluating a query sent by a Doctor or Clinic Administrator.

Classify this query into EXACTLY ONE of three categories based on the user's semantic intent:

1. DOCTOR_BOOKINGS:
The user is asking about patient appointments, tokens issued, names, medical details/conditions, patient arrival times, who is booked, or patient schedule for a particular day.
Examples:
- "Gimme the list of all the token given for this Sunday along with the names and details"
- "who is booked to see me today"
- "list all the patients coming tomorrow"
- "how many patients do I have and what are their names"
- "give me the token details for Sunday"
- "show my patient roster"
- "pull up patient files for today"

2. CLINIC_CONFIG:
The user is asking about the clinic's operating policies, configuration, operating hours, consultation start/end times, lunch break timings, booking window start/end time, or general settings rules.
Examples:
- "what are our operating hours"
- "what time does the clinic open"
- "when is the lunch break scheduled"
- "when does the booking window open for patients"
- "what are the configured clinic timings"

3. CLINIC_CAPACITY:
The user is asking for aggregate/macro token numbers, capacity limits, or remaining slot counts across the clinic without requesting individual patient names or details.
Examples:
- "how many tokens left this week"
- "what is our total token capacity"
- "is the morning session completely full"
- "how many tokens are still available for Sunday"
- "what's our overall remaining capacity"

Message: "${message}"

CRITICAL: Output ONLY the category name: DOCTOR_BOOKINGS, CLINIC_CONFIG, or CLINIC_CAPACITY.`;

  const result = await chat('', prompt, { temperature: 0, maxTokens: 25 });
  if (!result) return 'DOCTOR_BOOKINGS';

  const cleaned = result.toUpperCase().trim();
  if (cleaned.includes('CLINIC_CONFIG')) return 'CLINIC_CONFIG';
  if (cleaned.includes('CLINIC_CAPACITY')) return 'CLINIC_CAPACITY';
  return 'DOCTOR_BOOKINGS';
}

/**
 * Parse an admin COMMAND into structured mutation details.
 * Determines if it's PERMANENT (Settings tab) or ONE-OFF (Overrides tab, default).
 * Resolves relative date phrases against the current reference date/time. (Step 8)
 *
 * @param {string} message
 * @param {Object} currentSettings
 * @param {string} currentDateTimeISO - e.g. "2026-08-26T12:00:00"
 * @returns {Promise<Object>}
 */
async function parseAdminCommand(message, currentSettings, currentDateTimeISO) {
  const refDate = new Date(currentDateTimeISO);
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const refDayName = dayNames[refDate.getDay()] || '';

  const format = (d) => {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };

  const todayStr = format(refDate);
  const tomorrowObj = new Date(refDate);
  tomorrowObj.setDate(tomorrowObj.getDate() + 1);
  const tomorrowStr = format(tomorrowObj);
  const upcomingSundayStr = schedule.getTargetSundayDate(refDate);

  // Next regular operating clinic date (default Sunday)
  let nextOperatingDateStr = upcomingSundayStr;
  try {
    const candidate = await schedule.findNextOperatingDate(refDate);
    if (candidate && candidate >= todayStr) {
      nextOperatingDateStr = candidate;
    }
  } catch (err) {
    // fallback to upcomingSundayStr
  }

  // Pre-resolve any relative date phrase mentioned in message (e.g. "next Wednesday", "tomorrow")
  const relativeDateMentioned = resolveRelativeDate(message, currentDateTimeISO);

  const prompt = `You are a clinical administrative AI parsing a schedule change command from the clinic admin or doctor.

Current Reference Date/Time: ${currentDateTimeISO} (${refDayName})
Reference Date (Today) is: ${todayStr}
Tomorrow is: ${tomorrowStr}
Upcoming Sunday (Primary Clinic Day) is: ${upcomingSundayStr}
Next Scheduled Operating Clinic Date is: ${nextOperatingDateStr}
${relativeDateMentioned ? `Calendar-accurate resolved date for mentioned day is: ${relativeDateMentioned}\n` : ''}
Current Settings in Settings Tab:
${JSON.stringify(currentSettings, null, 2)}

Instructions:
1. Determine whether the command represents a PERMANENT change or a ONE-OFF exception.
   - DEFAULT to ONE-OFF (Overrides tab) unless the admin explicitly says "permanently", "every week now", "from now on", "all future", or similar permanent wording.
2. If ONE-OFF:
   - target_tab: "Overrides"
   
   CRITICAL SEMANTIC RULE FOR target_date:
   - The "target_date" is ALWAYS the date of the CLINIC CONSULTATION (the date patients visit the clinic and see the doctor), NEVER the date or time when bookings open.
   - The "booking_opens_at" field specifies WHEN patients can start booking (e.g. "Saturday 20:30", "Tuesday 21:00", etc.).
   
   CRITICAL DISTINCTION — PATIENT BOOKINGS VS SCHEDULE COMMANDS:
   - Commands requesting to book an appointment or token for a patient (e.g. "hi book an appointment molly", "book token for David", "book appointment", "give token to X") are PATIENT BOOKINGS, NOT clinic schedule commands.
   - NEVER create an override, change capacity, or propose writing to the Overrides tab for individual patient booking requests!
   - If the admin message is asking to book an individual appointment/token for a patient, return NULL.

   A. Booking Window / Booking Opening Commands (WITHOUT opening clinic on that day):
   If the admin/doctor ONLY wants to change when bookings open for the regular clinic:
   - "Start taking appointments from 12th 20:30 pm"
   - "Start taking appointments from 8:30 PM today"
   - "Open booking early at 20:30"
   - "Start accepting bookings from today at 20:30"
   - "Open bookings from 12th at 8:30 PM"
   In these cases, the clinic remains on its regular day (${nextOperatingDateStr}) and ONLY the booking opening time changes:
   - target_date: MUST be "${nextOperatingDateStr}" (the upcoming clinic consultation day, e.g. Sunday), NOT the booking day (${todayStr})!
   - booking_opens_at: "${refDayName} 20:30" (or the specified day and time).
   - type: "capacity_change" (or "open_extra_day" if that clinic day wasn't previously open).
   - confirmation_prompt: Clearly explain that bookings for ${nextOperatingDateStr} (upcoming clinic) will open at the specified time, specifying that it will write a row to the **Overrides** tab, and asking "Should I proceed? Reply 'yes' to confirm."

   NOTE ON CLINIC OPENINGS:
   If the user asks to OPEN THE CLINIC on a specific day (e.g. "create a one off opening for today and open bookings from 10 am", "open clinic today", "extra clinic opening today"), this is an EXTRA CLINIC OPENING for that day:
   - target_date: "${todayStr}" (or the mentioned day)
   - type: "open_extra_day"
   - booking_opens_at: as specified (e.g. "${refDayName} 10:00")
   - consultation_start: "11:00"
   - consultation_end: "18:30"
   - token_cap: 50
   - confirmation_prompt: Summarize that the clinic will be open on that date for consultations with bookings open at the specified time.

   B. Clinic Operating / Closure / Capacity Commands:
   Calculate target_date based on the consultation day mentioned:
   - "today" -> "${todayStr}" (ONLY if doctor is closing today or opening clinic today)
   - "tomorrow" -> "${tomorrowStr}"
   - "this Sunday" -> "${upcomingSundayStr}"
   - "this weekend" -> "${upcomingSundayStr}"
   - "next Wednesday" -> "${relativeDateMentioned || 'calculate upcoming Wednesday'}"
   - type: "open_extra_day", "closed", or "capacity_change"
   - If the doctor says they are not coming in ("not going to be in today", "skip today, I'm out", "close today"), type is "closed".
   - If the doctor or admin says not to take anyone in afternoon or change tokens, type is "capacity_change" or "closed".
   - booking_opens_at: e.g. "Tuesday 9:00 PM" or "Tuesday 21:00" or as specified.
   - consultation_start: e.g. "11:00" or as specified.
   - consultation_end: e.g. "18:30" or as specified.
   - token_cap: Number or null
   - notes: Short description of the override (e.g. "Doctor unavailable", "Clinic closed", "Early booking opening", etc.)
   - confirmation_prompt: Plain-language summary explaining what will change, specifying that it will write a row to the **Overrides** tab, and asking "Should I proceed? Reply 'yes' to confirm.4. BULK CANCELLATION / TOKEN DELETION (CANCEL_ALL_BOOKINGS):
If the admin or doctor wants to cancel existing appointments or delete issued tokens:
- "cancel all given appointments for today"
- "delte all the tokens that have been given out for today and change the booking window to sunday 8am to 9 am only for the coming weeks"
- "delete all tokens that have been given out"
- "cancel all bookings"
- "delete all appointments for Sunday"
- "cancel all tokens for tomorrow"
- "cancel all appointments"

Rules for cancellation commands:
- action: "CANCEL_ALL_BOOKINGS"
- cancel_tokens: true
- target_date: The date of the clinic session whose appointments are being cancelled.
  CRITICAL: If the user says "today" (${todayStr}), but today has NO clinic scheduled or 0 bookings, and the upcoming clinic date is ${nextOperatingDateStr} (e.g. tomorrow Sunday), resolve target_date to "${nextOperatingDateStr}".
- If the message ALSO requests a permanent settings change (e.g. changing the booking window to Sunday 8am to 9am for future weeks):
  - is_permanent: true
  - target_tab: "Settings"
  - settings_updates: { "booking_open_day": "Sunday", "booking_open_time": "08:00", "booking_close_day": "Sunday", "booking_close_time": "09:00" }
  - confirmation_prompt: "I will cancel all existing appointments for ${nextOperatingDateStr}, delete their tokens, automatically notify each patient via WhatsApp, and permanently update the booking window in Settings to Sunday 8:00 AM – 9:00 AM. Should I proceed? Reply 'yes' to confirm."
  - NEVER say that deleting tokens requires manual cancellation! The bot handles token cancellation and WhatsApp patient notifications automatically without manual effort.
- If it is ONLY a cancellation command:
  - is_permanent: false
  - target_tab: "CancelBookings"
  - confirmation_prompt: "I will cancel all appointments for ${nextOperatingDateStr}, delete their tokens, and automatically notify each patient via WhatsApp. Should I proceed? Reply 'yes' to confirm."

Admin command: "${message}"

Return ONLY valid JSON matching this schema:
{
  "action": "CANCEL_ALL_BOOKINGS | MUTATE_SCHEDULE",
  "cancel_tokens": false,
  "is_permanent": false,
  "target_tab": "Overrides | Settings | CancelBookings",
  "target_date": "YYYY-MM-DD",
  "override_data": {
    "target_date": "YYYY-MM-DD",
    "type": "open_extra_day | closed | capacity_change",
    "booking_opens_at": "...",
    "consultation_start": "11:00",
    "consultation_end": "18:30",
    "token_cap": 45,
    "notes": "..."
  },
  "settings_updates": {
    "field": "value"
  },
  "confirmation_prompt": "Plain language confirmation message..."
}`;

  const result = await chat('', prompt, { temperature: 0, maxTokens: 500 });
  if (!result) return null;

  try {
    const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);

    // Fallback: If cancel_tokens or CANCEL_ALL_BOOKINGS, ensure target_date is set
    if (parsed.action === 'CANCEL_ALL_BOOKINGS' || parsed.cancel_tokens) {
      if (!parsed.target_date || parsed.target_date === todayStr) {
        // If today has no clinic scheduled, target the upcoming clinic date
        parsed.target_date = nextOperatingDateStr;
      }
    }

    // Fallback validation: ensure target_date is formatted YYYY-MM-DD and matches calendar
    if (parsed.target_tab === 'Overrides' && parsed.override_data) {
      const lowerMsg = message.toLowerCase();
      const isExplicitClinicOpening =
        lowerMsg.includes('open clinic') ||
        lowerMsg.includes('extra clinic') ||
        lowerMsg.includes('clinic open') ||
        lowerMsg.includes('consultation') ||
        lowerMsg.includes('open tomorrow') ||
        lowerMsg.includes('open today') ||
        lowerMsg.includes('opening for today') ||
        lowerMsg.includes('opening today') ||
        lowerMsg.includes('one of opening') ||
        lowerMsg.includes('one-of opening') ||
        lowerMsg.includes('one off opening') ||
        lowerMsg.includes('one-off opening') ||
        lowerMsg.includes('extra day');

      const isBookingWindowCmd =
        (lowerMsg.includes('start taking appointment') ||
        lowerMsg.includes('open booking') ||
        lowerMsg.includes('bookings open') ||
        lowerMsg.includes('booking opens') ||
        lowerMsg.includes('start booking') ||
        lowerMsg.includes('accept appointment') ||
        lowerMsg.includes('accepting appointment')) &&
        parsed.override_data.type !== 'open_extra_day' &&
        !isExplicitClinicOpening;

      if (!isBookingWindowCmd && relativeDateMentioned) {
        parsed.override_data.target_date = relativeDateMentioned;
      } else {
        const rawTarget = parsed.override_data.target_date;
        if (!rawTarget || !/^\d{4}-\d{2}-\d{2}$/.test(rawTarget)) {
          const resolved = resolveRelativeDate(rawTarget || message, currentDateTimeISO);
          if (resolved) {
            parsed.override_data.target_date = resolved;
          }
        }
      }
    }

    return parsed;
  } catch (err) {
    console.error('[AI-Bot] Failed to parse admin command JSON:', err.message);
    return null;
  }
}

/**
 * Parse an ADMIN_BOOK command — "book a token for <name>, phone <number>, for <date>".
 * Returns structured patient booking intent. Returns a partial object (with null fields)
 * if only some info is present. Returns null only if Claude completely fails to respond.
 *
 * @param {string} message
 * @param {string} currentDateTimeISO - e.g. "2026-09-29T16:00:00"
 * @param {string} nextOperatingDateStr - YYYY-MM-DD of next operating day
 * @returns {Promise<{ patient_name: string|null, patient_phone: string|null, target_date: string|null, slot_preference: string|null }|null>}
 */
async function parseAdminBookCommand(message, currentDateTimeISO, nextOperatingDateStr) {
  const prompt = `You are a clinical AI parsing an admin request to manually book an appointment on behalf of a patient.

Current date/time: ${currentDateTimeISO}
Next scheduled operating clinic date: ${nextOperatingDateStr}

Admin's message: "${message}"

Extract the following fields from the message using semantic understanding — the admin may phrase things naturally (e.g. "book for david", "his number is 919876543210", "it's david kumar"):
- patient_name: The patient's full name if mentioned anywhere in the message, or null if not present at all.
  IMPORTANT: Extract ANY human name mentioned, even if embedded in a sentence (e.g. "book for david" -> "david", "it's david kumar" -> "david kumar").
- patient_phone: The patient's phone number, digits only, or null if not present (e.g. "919876543210").
  Strip all spaces, dashes, plus signs, and parentheses. Include country code if present.
- target_date: The requested appointment date in YYYY-MM-DD format, or null if not specified.
- slot_preference: "morning", "afternoon", or null.

Return ONLY valid JSON:
{
  "patient_name": "Full Name or null",
  "patient_phone": "919876543210 or null",
  "target_date": "YYYY-MM-DD or null",
  "slot_preference": "morning|afternoon|null"
}

Rules:
- If the admin says "tomorrow", resolve relative to ${currentDateTimeISO}.
- If no date is mentioned, set target_date to null.
- If no slot is mentioned, set slot_preference to null.
- Strip all non-digit characters from phone numbers.
- Return null (JSON null, not the string "null") for any field that cannot be determined from the message.
- NEVER return the string "null" for a field — use JSON null.`;

  const result = await chat('', prompt, { temperature: 0, maxTokens: 200 });
  if (!result) return null;

  try {
    const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    // Normalise: treat string "null" as actual null
    const norm = (v) => (v === 'null' || v === '' ? null : v || null);
    return {
      patient_name: norm(parsed.patient_name),
      patient_phone: norm(parsed.patient_phone),
      target_date: norm(parsed.target_date),
      slot_preference: norm(parsed.slot_preference),
    };
  } catch (err) {
    console.error('[AI-Bot] Failed to parse admin book command JSON:', err.message);
    return null;
  }
}

/**
 * Classify whether an admin message is a correction to a pending ADMIN_BOOK draft.
 * Detects messages like "wrong number", "change the phone to X", "that's not david, it's david kumar".
 *
 * @param {string} message
 * @param {Object} draftData - Current draft: { patient_name, patient_phone, target_date, slot_preference }
 * @returns {Promise<{ is_correction: boolean, field: 'name'|'phone'|'date'|null, new_value: string|null }>}
 */
async function classifyAdminBookCorrection(message, draftData) {
  const prompt = `You are evaluating a WhatsApp message from a clinic admin who is in the middle of creating a patient booking draft.

Current booking draft:
- Patient name: ${draftData.patient_name || '(none)'}
- Patient phone: ${draftData.patient_phone || '(none)'}
- Date: ${draftData.target_date || '(none)'}

Admin's new message: "${message}"

Is this message a CORRECTION to the booking draft? Corrections include:
- Correcting the phone number (e.g. "wrong number", "change phone to 919876500000", "the number is actually...", "that's the wrong number, use X")
- Correcting the patient name (e.g. "that's not david, it's david kumar", "wrong name, it's X", "the name is X not Y", "change name to X")
- Correcting the date (e.g. "change date to Sunday", "make it next week instead")

NOT a correction:
- Confirming the booking ("yes", "proceed", "ok")
- Cancelling ("no", "cancel")
- Unrelated admin commands about clinic schedule/overrides

Return ONLY valid JSON:
{
  "is_correction": true/false,
  "field": "name" | "phone" | "date" | null,
  "new_value": "the corrected value as a clean string, digits only for phone" | null
}`;

  const result = await chat('', prompt, { temperature: 0, maxTokens: 150 });
  if (!result) return { is_correction: false, field: null, new_value: null };

  try {
    const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      is_correction: !!parsed.is_correction,
      field: parsed.field || null,
      new_value: parsed.new_value || null,
    };
  } catch (err) {
    console.error('[AI-Bot] Failed to parse admin book correction JSON:', err.message);
    return { is_correction: false, field: null, new_value: null };
  }
}

/**
 * Answer an admin QUERY based on the effective schedule context.
 * Never writes anything.
 *
 * @param {string} message
 * @param {Object} scheduleContext
 * @returns {Promise<string>}
 */
async function answerAdminQuery(message, scheduleContext) {
  const systemPrompt = `You are an AI assistant for the clinic administrator at Al Ramzan Shifakhana.
You answer administrative schedule and operating queries clearly and accurately based on the clinic's current effective schedule.

Current Effective Schedule Context:
${JSON.stringify(scheduleContext, null, 2)}

Rules:
- Address the user as "Admin" if addressing them. Never use any personal names or placeholder names.
- Answer the admin's question directly, concisely, and warmly.
- State relevant opening days, booking window hours, consultation timings, and token caps accurately.
- If the Admin asks for specific token numbers, patient names, who has booked, or booking details, list them clearly from "booked_tokens" in the context (Token #, slot, patient name, arrival time, and phone number). If booked_tokens is empty, state clearly that no appointments/tokens are currently booked for that date.
- NEVER say you don't have access to token numbers or patient names when they are present in booked_tokens in the context.
- Keep response under 150 words.`;

  return await chat(systemPrompt, `Admin question: ${message}`);
}

/**
 * Validate a patient name using Claude.
 * @returns {{ valid: boolean, name: string|null, reason: string|null }}
 */
async function validateName(message) {
  const prompt = `You are a medical receptionist validating patient input.
The patient was asked for their full name.

Patient's response: "${message}"

Does this string look like a plausible human name?
Return ONLY valid JSON in the following format:
{
  "valid": true/false,
  "name": "Extracted name (if valid) or null",
  "reason": "Brief reason if invalid, or null"
}`;

  const result = await chat('', prompt, { temperature: 0, maxTokens: 100 });
  if (!result) return { valid: false, reason: 'Validation service error' };

  try {
    const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { valid: false, reason: 'Parse error' };
  }
}

/**
 * Validate a medical condition/symptom description using Claude.
 * @returns {{ valid: boolean, condition: string|null, reason: string|null }}
 */
async function validateCondition(message) {
  const prompt = `You are a medical receptionist validating patient input.
The patient was asked to briefly describe their symptoms or reason for visit.

Patient's response: "${message}"

Does this string describe a plausible medical condition, symptom, or reason for a doctor's visit?
Return ONLY valid JSON in the following format:
{
  "valid": true/false,
  "condition": "Extracted condition (if valid) or null",
  "reason": "Brief reason if invalid, or null"
}`;

  const result = await chat('', prompt, { temperature: 0, maxTokens: 100 });
  if (!result) return { valid: false, reason: 'Validation service error' };

  try {
    const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { valid: false, reason: 'Parse error' };
  }
}

module.exports = {
  chat,
  chatWithHistory,
  classifyIntent,
  classifyAdminIntent,
  classifyAdminQueryType,
  classifyAdminConfirmation,
  parseAdminCommand,
  parseAdminBookCommand,
  classifyAdminBookCorrection,
  answerAdminQuery,
  resolveRelativeDate,
  validateName,
  validateCondition,
  getAppointmentSystemPrompt,
};

