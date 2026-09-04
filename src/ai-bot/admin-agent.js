/**
 * AI Bot — Admin Agent
 *
 * Handles incoming messages from ADMIN_PHONE_NUMBER.
 * Capabilities:
 *   - Classifies messages as QUERY or COMMAND using Claude.
 *   - For QUERY: Answers using current effective schedule, never writes to Sheets.
 *   - For COMMAND: Determines PERMANENT (Settings tab) vs ONE-OFF (Overrides tab, default).
 *   - Confirm-before-mutate workflow:
 *     - Summarizes exact changes and target tab in plain language.
 *     - Waits for explicit confirmation (supports English, Hindi, Urdu, Hinglish).
 *     - Expire pending confirmations after 10 minutes.
 *     - Unrelated messages drop pending state and are processed fresh.
 *     - Enforces slot capacity rule (morning_cap + afternoon_cap <= max_tokens).
 *     - On confirmation, writes to Google Sheets and immediately force-invalidates the 60s cache.
 */

const claude = require('./claude');
const session = require('./session');
const schedule = require('./schedule');
const sheets = require('./sheets');
const doctorAgent = require('./doctor-agent');
const { getCurrentTime } = require('./clock');

/**
 * Check if a query is specific to a doctor's personal schedule, appointments, or patient list.
 */
function _isDoctorSpecificQuery(msg) {
  const l = msg.toLowerCase().trim();
  return (
    l.includes('my schedule') ||
    l.includes('my appointment') ||
    l.includes('my patient') ||
    l.includes('my slot') ||
    l.includes("today's appointment") ||
    l.includes("today's patient") ||
    l.includes("today's slot") ||
    l.includes('who is booked') ||
    l.includes('patient list') ||
    l.includes('patient details') ||
    (l.includes('today') && (l.includes('appointment') || l.includes('patient') || l.includes('slot'))) ||
    (l.includes('tomorrow') && (l.includes('appointment') || l.includes('patient') || l.includes('slot')))
  );
}

/**
 * Handle an incoming message from the clinic admin (who may also be a doctor).
 * @param {string} phone - Normalized admin phone number
 * @param {string} message - Message text
 * @param {string} [senderName] - WhatsApp sender name
 * @param {Object} [doctorInfo] - Doctor info if admin is also a registered doctor
 * @returns {Promise<string>} Reply text
 */
async function handleAdminMessage(phone, message, senderName, doctorInfo = null) {
  const currentTime = getCurrentTime();
  session.appendHistory(phone, 'user', message);

  try {
    // ── 1. Check for Pending Confirmation ───────────────────────────
    const pending = session.getAdminPending(phone);
    if (pending) {
      const confClassification = await claude.classifyAdminConfirmation(message);

      if (confClassification === 'confirm') {
        // Execute the pending mutation!
        if (pending.target_tab === 'Overrides') {
          const overrideRecord = {
            target_date: pending.data?.target_date,
            type: pending.data?.type || 'open_extra_day',
            booking_opens_at: pending.data?.booking_opens_at || '',
            consultation_start: pending.data?.consultation_start || '',
            consultation_end: pending.data?.consultation_end || '',
            token_cap: pending.data?.token_cap || '',
            created_by: `Admin (${senderName || phone})`,
            created_at: currentTime.toISOString().replace('T', ' ').substring(0, 19),
            notes: pending.data?.notes || 'Admin one-off schedule override',
          };

          const res = await sheets.addOverrideToSheet(overrideRecord);
          schedule.invalidateCache();
          session.clearAdminPending(phone);

          if (!res.success) {
            const errReply = `❌ Failed to write override to Google Sheets: ${res.error}`;
            session.appendHistory(phone, 'assistant', errReply);
            return errReply;
          }

          const reply = `✅ Confirmed! A one-off override has been written to the **Overrides** tab for **${overrideRecord.target_date}** (${overrideRecord.type}). The change is now live and in effect.`;
          session.appendHistory(phone, 'assistant', reply);
          return reply;
        } else if (pending.target_tab === 'Settings') {
          const res = await sheets.updateSettingsInSheet(pending.updates || {});
          schedule.invalidateCache();
          session.clearAdminPending(phone);

          if (!res.success) {
            const errReply = `❌ ${res.error}`;
            session.appendHistory(phone, 'assistant', errReply);
            return errReply;
          }

          const reply = `✅ Confirmed! Permanent clinic schedule settings have been updated in the **Settings** tab. The change is now live.`;
          session.appendHistory(phone, 'assistant', reply);
          return reply;
        }
      } else if (confClassification === 'cancel') {
        session.clearAdminPending(phone);
        const reply = "❌ Action cancelled. No changes were made to the clinic schedule.";
        session.appendHistory(phone, 'assistant', reply);
        return reply;
      } else {
        // Unrelated message: drop pending state and fall through to process fresh
        console.log(`[AI-Bot] Admin sent unrelated message during pending confirmation; dropping pending state.`);
        session.clearAdminPending(phone);
      }
    }

    // ── 2. Classify Admin Intent: QUERY vs COMMAND ──────────────────
    const intent = await claude.classifyAdminIntent(message);

    if (intent === 'QUERY') {
      // If admin is also a registered doctor and this is a doctor-specific inquiry:
      if (doctorInfo && _isDoctorSpecificQuery(message)) {
        console.log(`[AI-Bot] Delegating doctor query to doctor-agent for Dr. ${doctorInfo.name}`);
        return await doctorAgent.handleDoctorMessage(phone, message, doctorInfo);
      }

      // Fetch current effective schedule and context
      const effectiveSchedule = await schedule.getEffectiveSchedule();
      const settings = await sheets.getSettingsFromSheet();
      const overrides = await sheets.getOverridesFromSheet();

      const context = {
        current_time: currentTime.toString(),
        effective_schedule: effectiveSchedule,
        settings_tab: settings,
        overrides_tab: overrides,
      };

      if (doctorInfo) {
        context.doctor = {
          name: doctorInfo.name,
          specialty: doctorInfo.specialty,
        };
      }

      const reply = await claude.answerAdminQuery(message, context);
      session.appendHistory(phone, 'assistant', reply);
      return reply;
    }

    // ── 3. Handle COMMAND (Confirm-Before-Mutate) ────────────────────
    const currentSettings = await sheets.getSettingsFromSheet();
    const currentDateTimeISO = currentTime.toISOString().substring(0, 19);
    const parsed = await claude.parseAdminCommand(message, currentSettings, currentDateTimeISO);

    if (!parsed) {
      // If parsing as command failed and user is also a doctor, fall back to doctor agent
      if (doctorInfo) {
        return await doctorAgent.handleDoctorMessage(phone, message, doctorInfo);
      }
      const reply = "I couldn't quite understand that schedule change request. Could you please rephrase the date, timings, or token capacity you'd like to update?";
      session.appendHistory(phone, 'assistant', reply);
      return reply;
    }

    // Pre-validate slot capacity constraint if permanent settings change
    if (parsed.target_tab === 'Settings') {
      const merged = { ...currentSettings, ...(parsed.settings_updates || {}) };
      const mCap = Number(merged.morning_cap);
      const aCap = Number(merged.afternoon_cap);
      const maxT = Number(merged.max_tokens);

      if (mCap + aCap > maxT) {
        const reply = `Cannot update settings: Morning cap (${mCap}) + Afternoon cap (${aCap}) = ${mCap + aCap}, which exceeds max tokens (${maxT}). Please specify caps that fit within max tokens.`;
        session.appendHistory(phone, 'assistant', reply);
        return reply;
      }
    }

    // Save pending action in session (with 10-minute auto-expiry)
    session.setAdminPending(phone, {
      is_permanent: parsed.is_permanent,
      target_tab: parsed.target_tab,
      data: parsed.override_data,
      updates: parsed.settings_updates,
      confirmation_prompt: parsed.confirmation_prompt,
    });

    const reply = parsed.confirmation_prompt || `I will write these changes to the **${parsed.target_tab}** tab. Should I proceed? Reply 'yes' to confirm.`;
    session.appendHistory(phone, 'assistant', reply);
    return reply;

  } catch (err) {
    console.error('[AI-Bot] Admin agent error:', err.message);
    const errReply = "I encountered an error processing your administrative request. Please try again.";
    session.appendHistory(phone, 'assistant', errReply);
    return errReply;
  }
}

module.exports = {
  handleAdminMessage,
};
