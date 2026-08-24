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
2. "appointment": EXPLICIT or IMPLICIT booking requests (e.g., "book this slot", "schedule an appointment", "I want to see Dr. Sarah", "Yes, I'd like to proceed", "Sounds good", "I'll take the 4 PM one", "Perfect", "Book it"). Do not use this for just asking what doctors are available.
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
  validateName,
  validateCondition,
};
