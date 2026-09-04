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
2. "appointment": EXPLICIT or IMPLICIT booking requests (e.g., "book this slot", "schedule an appointment", "token chahiye", "ek token de do", "Sunday ka token", "appointment chahiye", "naam likh do", "morning token", "afternoon token", "subah ka token", "I want to see Dr. Sarah", "Yes, I'd like to proceed", "Sounds good", "I'll take the morning slot", "Book it").
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
- "other": The admin sent something unrelated, a new question, or a completely different command (e.g., "what time is Sunday", "change tokens to 50", "who is Dr. Sarah", "hello").

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
 * Classify admin message intent as QUERY or COMMAND.
 * @param {string} message
 * @returns {Promise<'QUERY'|'COMMAND'>}
 */
async function classifyAdminIntent(message) {
  const prompt = `You are an AI assistant evaluating a WhatsApp message from the Clinic Admin.

Classify if this message is a QUERY (asking for information about schedule, timings, doctors, or tokens without changing anything) or a COMMAND (asking to change, add, override, or update schedule, timings, open days, capacity, or tokens).

Examples of QUERY:
- "what time do we open Sunday"
- "what are Sunday's timings"
- "how many tokens are configured"
- "are we open this week"
- "kya timings hain Sunday ki"

Examples of COMMAND:
- "we're open next Wednesday instead, tokens from Tuesday 9pm"
- "change max tokens to 50 permanently"
- "close the clinic on Sunday August 30"
- "open tomorrow with 30 tokens"
- "increase morning cap to 20 permanently"

Message: "${message}"

CRITICAL: Output ONLY the single word: QUERY or COMMAND.`;

  const result = await chat('', prompt, { temperature: 0, maxTokens: 20 });
  if (!result) return 'QUERY';

  const cleaned = result.toUpperCase().replace(/[^A-Z]/g, '');
  return cleaned === 'COMMAND' ? 'COMMAND' : 'QUERY';
}

/**
 * Parse an admin COMMAND into structured mutation details.
 * Determines if it's PERMANENT (Settings tab) or ONE-OFF (Overrides tab, default).
 *
 * @param {string} message
 * @param {Object} currentSettings
 * @param {string} currentDateTimeISO - e.g. "2026-08-26T16:00:00"
 * @returns {Promise<Object>}
 */
async function parseAdminCommand(message, currentSettings, currentDateTimeISO) {
  const prompt = `You are a clinical administrative AI parsing a schedule change command from the clinic admin.

Current Reference Date/Time: ${currentDateTimeISO}
Current Settings in Settings Tab:
${JSON.stringify(currentSettings, null, 2)}

Instructions:
1. Determine whether the command represents a PERMANENT change or a ONE-OFF exception.
   - DEFAULT to ONE-OFF (Overrides tab) unless the admin explicitly says "permanently", "every week now", "from now on", "all future", or similar permanent wording.
2. If ONE-OFF:
   - target_tab: "Overrides"
   - target_date: Calculate target date in YYYY-MM-DD format based on reference date. (e.g. "next Wednesday" relative to reference date ${currentDateTimeISO}).
   - type: "open_extra_day", "closed", or "capacity_change"
   - booking_opens_at: e.g. "Tuesday 9:00 PM" or "Tuesday 21:00" or as specified.
   - consultation_start: e.g. "11:00" or as specified.
   - consultation_end: e.g. "18:30" or as specified.
   - token_cap: Number or null
   - notes: Short description of the override.
   - confirmation_prompt: Plain-language summary explaining what will change, specifying that it will write a row to the **Overrides** tab, and asking "Should I proceed? Reply 'yes' to confirm."
3. If PERMANENT:
   - target_tab: "Settings"
   - updates: Object containing updated fields (e.g. max_tokens, morning_cap, afternoon_cap, operating_days, etc.)
   - confirmation_prompt: Plain-language summary explaining what will change, specifying that it will update the **Settings** tab, and asking "Should I proceed? Reply 'yes' to confirm."

Admin command: "${message}"

Return ONLY valid JSON matching this schema:
{
  "is_permanent": false,
  "target_tab": "Overrides" | "Settings",
  "override_data": {
    "target_date": "YYYY-MM-DD",
    "type": "open_extra_day" | "closed" | "capacity_change",
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
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[AI-Bot] Failed to parse admin command JSON:', err.message);
    return null;
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
  const systemPrompt = `You are an AI assistant for the clinic administrator at Dr. AI Clinic.
You answer administrative schedule and operating queries clearly and accurately based on the clinic's current effective schedule.

Current Effective Schedule Context:
${JSON.stringify(scheduleContext, null, 2)}

Rules:
- Answer the admin's question directly, concisely, and warmly.
- State relevant opening days, booking window hours, consultation timings, and token caps accurately.
- Keep response under 100 words.`;

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
  classifyAdminConfirmation,
  parseAdminCommand,
  answerAdminQuery,
  validateName,
  validateCondition,
  getAppointmentSystemPrompt,
};

