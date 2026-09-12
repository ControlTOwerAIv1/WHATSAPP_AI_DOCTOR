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

let _notificationSender = null;

/**
 * Configure a custom notification sender (e.g. for testing / mocking).
 * @param {Function} fn - async (phone, text) => {}
 */
function setNotificationSender(fn) {
  _notificationSender = fn;
}

/**
 * Send an individual WhatsApp cancellation message to an affected patient (Step 10b).
 */
async function _sendPatientNotification(phone, text) {
  if (typeof _notificationSender === 'function') {
    return await _notificationSender(phone, text);
  }
  try {
    const cloudapi = require('../cloudapi');
    return await cloudapi.sendText(phone, text);
  } catch (err) {
    console.warn(`[AI-Bot] WhatsApp notification warning for ${phone}:`, err.message);
    throw err;
  }
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
            token_cap: pending.data?.token_cap !== undefined ? pending.data?.token_cap : '',
            created_by: `Admin (${senderName || phone})`,
            created_at: currentTime.toISOString().replace('T', ' ').substring(0, 19),
            notes: pending.data?.notes || 'Admin one-off schedule override',
          };

          const res = await sheets.addOverrideToSheet(overrideRecord);
          schedule.invalidateCache();

          // Step 10b, c, e: Notify affected patients if clinic closed or capacity reduced
          const affectedTokens = pending.affected_tokens || [];
          let notifiedCount = 0;

          if (affectedTokens.length > 0) {
            const isClosure = overrideRecord.type === 'closed';
            for (const patient of affectedTokens) {
              try {
                const cancellationMsg = isClosure
                  ? `Hi ${patient.patient_name}, unfortunately the clinic is closed today and your token #${patient.token_number} for ${overrideRecord.target_date} is cancelled. We're sorry for the inconvenience — please check back for the next available date.`
                  : `Hi ${patient.patient_name}, unfortunately the clinic capacity for ${overrideRecord.target_date} has been reduced and your token #${patient.token_number} is cancelled. We're sorry for the inconvenience — please check back for the next available date.`;

                console.log(`[AI-Bot] 📢 Auto-notifying patient ${patient.patient_phone} (${patient.patient_name}): "${cancellationMsg}"`);
                await _sendPatientNotification(patient.patient_phone, cancellationMsg);
                notifiedCount++;
              } catch (notifyErr) {
                console.error(`[AI-Bot] ❌ Failed to notify patient ${patient.patient_phone}:`, notifyErr.message);
                // Continue notifying remaining patients (Step 10e)
              }
            }
          }

          session.clearAdminPending(phone);

          if (!res.success) {
            const errReply = `❌ Failed to write override to Google Sheets: ${res.error}`;
            session.appendHistory(phone, 'assistant', errReply);
            return errReply;
          }

          // Step 10d: Reply with summary to doctor/admin
          let reply;
          if (overrideRecord.type === 'closed') {
            const isToday = overrideRecord.target_date === currentTime.toISOString().split('T')[0];
            const clinicLabel = isToday ? "today's clinic" : `clinic for ${overrideRecord.target_date}`;
            if (notifiedCount > 0) {
              reply = `Closed ${clinicLabel}. Notified ${notifiedCount} patients automatically.`;
            } else {
              reply = `Closed ${clinicLabel}.`;
            }
          } else if (overrideRecord.type === 'capacity_change' && notifiedCount > 0) {
            reply = `Reduced clinic capacity for ${overrideRecord.target_date}. Notified ${notifiedCount} patients automatically.`;
          } else {
            reply = `✅ Confirmed! A one-off override has been written to the **Overrides** tab for **${overrideRecord.target_date}** (${overrideRecord.type}). The change is now live and in effect.`;
          }

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
      if (doctorInfo) {
        // Semantic classification: DOCTOR_BOOKINGS vs CLINIC_CONFIG vs CLINIC_CAPACITY
        const queryType = await claude.classifyAdminQueryType(message);
        console.log(`[AI-Bot] Doctor query semantic classification: ${queryType} for message: "${message}"`);

        if (queryType === 'DOCTOR_BOOKINGS') {
          console.log(`[AI-Bot] Delegating doctor booking query to doctor-agent for ${doctorInfo.name}`);
          return await doctorAgent.handleDoctorMessage(phone, message, doctorInfo);
        }
      }

      // Fetch current effective schedule and context
      const effectiveSchedule = await schedule.getEffectiveSchedule();
      const settings = await sheets.getSettingsFromSheet();
      const overrides = await sheets.getOverridesFromSheet();

      // Include macro capacity metrics for CLINIC_CAPACITY questions
      const targetDate = await schedule.findNextOperatingDate(currentTime);
      const existingTokens = schedule.getTokensForSunday(targetDate);
      const bookedCount = existingTokens.length;
      const maxCap = effectiveSchedule.max_tokens || 45;
      const availableTokens = Math.max(0, maxCap - bookedCount);

      const context = {
        current_time: currentTime.toString(),
        effective_schedule: effectiveSchedule,
        settings_tab: settings,
        overrides_tab: overrides,
        clinic_capacity_summary: {
          target_date: targetDate,
          total_capacity: maxCap,
          booked_count: bookedCount,
          available_tokens: availableTokens,
        },
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

    // Safety Net: Ensure booking window changes are attached to the clinic consultation day
    if (parsed.target_tab === 'Overrides' && parsed.override_data) {
      const overrideData = parsed.override_data;
      const lowerMsg = message.toLowerCase();
      const hasBookingOpenChange = Boolean(overrideData.booking_opens_at);
      const isBookingWindowIntent =
        lowerMsg.includes('start taking appointment') ||
        lowerMsg.includes('booking open') ||
        lowerMsg.includes('bookings open') ||
        lowerMsg.includes('open booking') ||
        lowerMsg.includes('start booking') ||
        lowerMsg.includes('taking appointment') ||
        lowerMsg.includes('accept appointment') ||
        lowerMsg.includes('accepting appointment');

      const isExplicitClinicOpening =
        lowerMsg.includes('open clinic') ||
        lowerMsg.includes('extra clinic') ||
        lowerMsg.includes('clinic open') ||
        lowerMsg.includes('consultation') ||
        lowerMsg.includes('open tomorrow') ||
        lowerMsg.includes('open today') ||
        lowerMsg.includes('open wednesday') ||
        lowerMsg.includes('open thursday') ||
        lowerMsg.includes('open friday') ||
        lowerMsg.includes('open saturday');

      if ((hasBookingOpenChange || isBookingWindowIntent) && !isExplicitClinicOpening && overrideData.type !== 'closed') {
        const opDays = currentSettings?.operating_days || ['Sunday'];
        let targetDayName = '';
        if (overrideData.target_date && /^\d{4}-\d{2}-\d{2}$/.test(overrideData.target_date)) {
          const [ty, tm, td] = overrideData.target_date.split('-').map(Number);
          const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
          targetDayName = dayNames[new Date(ty, tm - 1, td).getDay()];
        }

        if (!opDays.includes(targetDayName)) {
          const targetClinicDate = schedule.getTargetSundayDate(currentTime);
          console.log(`[AI-Bot] 🛡️ Safety net: Re-targeting booking window override from ${overrideData.target_date} (${targetDayName}) to clinic date ${targetClinicDate}`);
          overrideData.target_date = targetClinicDate;
          if (overrideData.type === 'open_extra_day') {
            overrideData.type = 'capacity_change';
          }
          parsed.confirmation_prompt = `I will update the booking window for the clinic on **${targetClinicDate}** in the **Overrides** tab so that appointments open ${overrideData.booking_opens_at || 'early'}. Should I proceed? Reply 'yes' to confirm.`;
        }
      }
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

    // Step 10a: Look up how many tokens are already issued in SQLite for target date
    let affectedTokens = [];
    if (parsed.target_tab === 'Overrides' && parsed.override_data) {
      const overrideType = (parsed.override_data.type || '').toLowerCase();
      const targetDate = parsed.override_data.target_date;

      if (targetDate && (overrideType === 'closed' || overrideType === 'capacity_change')) {
        const existingTokens = schedule.getTokensForSunday(targetDate);
        if (overrideType === 'closed') {
          affectedTokens = existingTokens;
        } else if (overrideType === 'capacity_change') {
          const newCap = Number(parsed.override_data.token_cap);
          if (!isNaN(newCap)) {
            affectedTokens = existingTokens.filter(t => t.token_number > newCap);
          }
        }

        if (affectedTokens.length > 0) {
          const count = affectedTokens.length;
          const isToday = targetDate === currentTime.toISOString().split('T')[0];
          const dateLabel = isToday ? 'today' : targetDate;
          const patientLabel = count === 1 ? '1 patient already holds a token' : `${count} patients already hold tokens`;
          const closureLabel = overrideType === 'closed' ? 'closure' : 'capacity reduction';

          // As specified in Step 10a:
          // "5 patients already hold tokens for today. Confirming this closure will notify all 5 automatically. Reply 'yes' to proceed."
          parsed.confirmation_prompt = `${count} ${count === 1 ? 'patient' : 'patients'} already hold tokens for ${dateLabel}. Confirming this ${closureLabel} will notify all ${count} automatically. Reply 'yes' to proceed.`;
        }
      }
    }

    // Save pending action in session (with 10-minute auto-expiry)
    session.setAdminPending(phone, {
      is_permanent: parsed.is_permanent,
      target_tab: parsed.target_tab,
      data: parsed.override_data,
      updates: parsed.settings_updates,
      confirmation_prompt: parsed.confirmation_prompt,
      affected_tokens: affectedTokens,
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
  setNotificationSender,
};
