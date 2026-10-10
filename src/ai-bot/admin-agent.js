/**
 * AI Bot — Admin Agent
 *
 * Handles incoming messages from ADMIN_PHONE_NUMBER.
 * Capabilities:
 *   - Classifies messages as QUERY or COMMAND using Claude.
 *   - For QUERY: Answers using current effective schedule, never writes data.
 *   - Supports chat-based data export (CSV or inline table).
 *   - For COMMAND: Determines PERMANENT (Settings) vs ONE-OFF (Overrides, default).
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
const store = require('./store');
const doctorAgent = require('./doctor-agent');
const exportChat = require('./export-chat');
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
 * Find an existing patient contact by name from stores.contactStore or relay.sqlite.
 * Allows admin to book by name (e.g. "hi book an appointment molly") without having to re-type the phone.
 * @param {string} name
 * @returns {{ name: string, phone: string } | null}
 */
function _findContactByName(name) {
  if (!name || typeof name !== 'string' || name.trim().length < 2) return null;
  const search = name.trim().toLowerCase();

  // 1. Check in-memory stores.contactStore
  try {
    const stores = require('../stores');
    if (stores && stores.contactStore) {
      for (const [jid, c] of Object.entries(stores.contactStore)) {
        const contactName = (c?.notify || c?.name || '').toLowerCase();
        if (contactName && (contactName === search || contactName.includes(search) || search.includes(contactName))) {
          const cleanPhone = jid.replace(/[^0-9]/g, '');
          if (cleanPhone.length >= 8) {
            return {
              name: c.notify || c.name,
              phone: cleanPhone,
            };
          }
        }
      }
    }
  } catch (_) {}

  // 2. Fallback to relay.sqlite contacts table
  try {
    const Database = require('better-sqlite3');
    const path = require('path');
    const dbPath = path.resolve(__dirname, '../../relay.sqlite');
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT id, payload FROM contacts').all();
    db.close();

    for (const row of rows) {
      try {
        const p = JSON.parse(row.payload);
        const contactName = (p.notify || p.name || '').toLowerCase();
        if (contactName && (contactName === search || contactName.includes(search) || search.includes(contactName))) {
          const cleanPhone = row.id.replace(/[^0-9]/g, '');
          if (cleanPhone.length >= 8) {
            return {
              name: p.notify || p.name,
              phone: cleanPhone,
            };
          }
        }
      } catch (_) {}
    }
  } catch (_) {}

  return null;
}

/**
 * Detect if admin is trying to book a token ON BEHALF OF a patient.
 * Triggers before the normal QUERY/COMMAND path so admins can give out
 * tokens whenever they want, bypassing all patient booking windows.
 */
function _isAdminBookRequest(msg) {
  const l = msg.toLowerCase().trim();

  // Negative guard 1: Questions, inquiries about booking or clinic state
  const isQuestionOrInquiry =
    /^(why|how|can patients|are we|is it|is booking|what|who)\b/i.test(l) ||
    l.includes('why can') ||
    l.includes('why is') ||
    l.includes('why are') ||
    l.includes('how come') ||
    l.includes('even though') ||
    l.includes('cancel all') ||
    l.includes('cancel given') ||
    l.includes('delete all') ||
    l.includes('delete token') ||
    l.includes('delte all') ||
    l.includes('cancel appointment') ||
    l.includes('cancel booking');

  if (isQuestionOrInquiry) return false;

  // Negative guard 2: Explicit schedule configuration / booking window commands
  const isScheduleOrWindowCommand =
    l.includes('booking window') ||
    l.includes('booking open day') ||
    l.includes('booking open time') ||
    l.includes('booking close day') ||
    l.includes('booking close time') ||
    l.includes('start taking appointment') ||
    l.includes('start accepting appointment') ||
    l.includes('open booking') ||
    l.includes('bookings open') ||
    l.includes('booking open from') ||
    l.includes('bookings open from') ||
    l.includes('close booking') ||
    l.includes('change booking window');

  if (isScheduleOrWindowCommand) return false;

  // Positive intent 1: Imperative booking phrases anywhere in message (e.g. "hi book an appointment molly", "book an appointment")
  if (/\bb[o]{1,4}k\s+(a\s+|an\s+|one\s+|\d+\s+)?(token|appointment|slot)s?\b/i.test(l)) {
    return true;
  }

  // Positive intent 2: "give/allocate/issue token/appointment/slot"
  if (/\b(give|allocate|issue)\s+(a\s+|an\s+|one\s+|\d+\s+)?(token|appointment|slot)s?\b/i.test(l)) {
    return true;
  }

  // Positive intent 3: "appointment for", "token for", "slot for"
  if (/\b(appointment|token|slot)\s+for\b/i.test(l)) {
    return true;
  }

  // Positive intent 4: Booking with a target name, word, or phone number
  const hasBookWord = /\bb[o]{1,4}k\b/i.test(l) || l.includes('reserve') || l.includes('register');
  if (hasBookWord) {
    if (
      l.includes('for ') ||
      l.includes('patient') ||
      l.includes('phone') ||
      l.includes('number') ||
      l.includes('naam') ||
      l.includes('name') ||
      /\d{8,}/.test(l)
    ) {
      return true;
    }

    // Direct "book <name>" e.g. "book molly", "book ramesh"
    const bookNameMatch = l.match(/\bb[o]{1,4}k\s+([a-z]+)\b/i);
    if (bookNameMatch && !['the', 'a', 'an', 'this', 'that', 'tomorrow', 'today', 'sunday', 'now', 'open', 'early'].includes(bookNameMatch[1])) {
      return true;
    }
  }

  // Positive intent 5: Hindi / Hinglish phrases
  if (
    l.includes('token chahiye') ||
    l.includes('token de do') ||
    l.includes('appointment chahiye') ||
    l.includes('naam likh do') ||
    l.includes('appointment book') ||
    l.includes('token book')
  ) {
    return true;
  }

  return false;
}

/**
 * Build the patient confirmation message for admin-initiated bookings.
 */
function _formatPatientConfirmationBilingual(token) {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const dateParts = (token.sunday_date || '').split('-');
  let dateDisplay = token.sunday_date;
  if (dateParts.length === 3) {
    const d = parseInt(dateParts[2], 10);
    const m = parseInt(dateParts[1], 10) - 1;
    let suffix = 'th';
    if (d === 1 || d === 21 || d === 31) suffix = 'st';
    else if (d === 2 || d === 22) suffix = 'nd';
    else if (d === 3 || d === 23) suffix = 'rd';
    dateDisplay = `${d}${suffix} ${months[m]}`;
  }

  return `Date: ${dateDisplay}
Name: ${token.patient_name}
Token: #${token.token_number}
Time: ${token.arrival_time}`;
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
 * Records the outbound message in Echo store so it shows up on the Echo dashboard in real-time.
 */
async function _sendPatientNotification(phone, text) {
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  let result;
  if (typeof _notificationSender === 'function') {
    result = await _notificationSender(cleanPhone, text);
  } else {
    try {
      const cloudapi = require('../cloudapi');
      result = await cloudapi.sendText(cleanPhone, text);
    } catch (err) {
      console.warn(`[AI-Bot] WhatsApp notification warning for ${phone}:`, err.message);
      throw err;
    }
  }

  // Record outbound message in Echo dashboard store so it appears in the Echo page
  try {
    const stores = require('../stores');
    if (stores && typeof stores.recordOutboundMessage === 'function') {
      const jid = `${cleanPhone}@s.whatsapp.net`;
      await stores.recordOutboundMessage({
        jid,
        operator: { id: 'ai-bot', name: 'AI Bot' },
        result: result || { key: { id: `outbound-${Date.now()}` } },
        message: {
          content: text,
          mediaType: 'text',
        },
      });
      console.log(`[AI-Bot] Outbound patient notification recorded in Echo dashboard for ${cleanPhone}`);
    }
  } catch (storeErr) {
    console.warn(`[AI-Bot] Failed to record notification in Echo store for ${cleanPhone}:`, storeErr.message);
  }

  return result;
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
    // ── 0. Export request (highest priority — no confirmation needed) ──
    if (exportChat.isExportRequest(message)) {
      const sendText = async (p, text) => {
        try {
          const cloudapi = require('../cloudapi');
          await cloudapi.sendText(p, text);
        } catch (_) {}
        return text;
      };
      const reply = await exportChat.handleExportRequest(message, phone, sendText, null);
      session.appendHistory(phone, 'assistant', reply);
      return reply;
    }

    // ── 0b. Admin-initiated patient booking (ADMIN_BOOK) ──────────────
    // Detected before QUERY/COMMAND to avoid misclassification of
    // "book for Ramesh, phone 9876543210, tomorrow" as a COMMAND.
    if (_isAdminBookRequest(message)) {
      const currentDateTimeISO = currentTime.toISOString().substring(0, 19);
      const nextOperatingDate = await schedule.findNextOperatingDate(currentTime);

      const parsed = await claude.parseAdminBookCommand(message, currentDateTimeISO, nextOperatingDate);

      let extractedName = parsed?.patient_name || null;
      let extractedPhone = parsed?.patient_phone || null;

      // Auto-resolve phone number if patient name was provided but phone was omitted
      if (extractedName && !extractedPhone) {
        const contactMatch = _findContactByName(extractedName);
        if (contactMatch) {
          extractedName = contactMatch.name || extractedName;
          extractedPhone = contactMatch.phone;
          console.log(`[AI-Bot] Auto-resolved patient "${extractedName}" -> ${extractedPhone} from contacts`);
        }
      }

      if (extractedName && extractedPhone) {
        // Resolve target date
        const targetDate = parsed?.target_date || nextOperatingDate;

        // Validate that targetDate is an actual operating day
        const effectiveSchedule = await schedule.getEffectiveSchedule(targetDate);
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const targetDateObj = new Date(targetDate + 'T12:00:00Z');
        const targetDayName = dayNames[targetDateObj.getUTCDay()];
        const isOverrideOpen = effectiveSchedule.is_override && effectiveSchedule.override_type === 'open_extra_day';
        const isRegularDay = Array.isArray(effectiveSchedule.operating_days) &&
          effectiveSchedule.operating_days.includes(targetDayName);
        const isClosed = effectiveSchedule.is_override && effectiveSchedule.override_type === 'closed';
        const isOperatingDay = !isClosed && (isOverrideOpen || isRegularDay);

        if (!isOperatingDay || effectiveSchedule.max_tokens === 0) {
          const reply = `❌ Cannot book: ${targetDate} (${targetDayName}) is not an operating day. Operating days: ${(effectiveSchedule.operating_days || []).join(', ')}. Please specify a valid clinic date.`;
          session.appendHistory(phone, 'assistant', reply);
          return reply;
        }

        // Check for duplicate before showing confirmation
        const existingToken = schedule.getTokenByPhone(extractedPhone, targetDate);
        if (existingToken) {
          const reply = `❌ ${extractedName} (${extractedPhone}) already has Token #${existingToken.token_number} for ${targetDate}. No new booking was made.`;
          session.appendHistory(phone, 'assistant', reply);
          return reply;
        }

        // Determine which slot would be assigned (for summary)
        const avail = await schedule.getSlotAvailability(targetDate);
        const resolvedSlot = parsed?.slot_preference ||
          (!avail.morning.isFull ? 'morning' : !avail.afternoon.isFull ? 'afternoon' : null);

        if (!resolvedSlot) {
          const reply = `❌ Cannot book — all tokens for ${targetDate} are already full.`;
          session.appendHistory(phone, 'assistant', reply);
          return reply;
        }

        const slotDetail = avail[resolvedSlot];
        const estimatedToken = resolvedSlot === 'morning'
          ? avail.morning.booked + 1
          : (effectiveSchedule.slots?.morning?.token_cap || 0) + avail.afternoon.booked + 1;

        const confirmPrompt = `Admin booking summary:\n• Patient: ${extractedName}\n• Phone: ${extractedPhone}\n• Date: ${targetDate}\n• Slot: ${resolvedSlot} (Token ~#${estimatedToken})\n\nReply 'yes' to confirm, 'no' to cancel, or send a correction (e.g. "wrong number, use 919876500000").`;

        session.setAdminPending(phone, {
          type: 'ADMIN_BOOK',
          data: {
            patient_name: extractedName,
            patient_phone: extractedPhone.replace(/[^0-9]/g, ''),
            target_date: targetDate,
            slot_preference: resolvedSlot,
          },
          confirmation_prompt: confirmPrompt,
        });

        session.appendHistory(phone, 'assistant', confirmPrompt);
        return confirmPrompt;

      } else {
        // Parsing succeeded partially (name without phone, or nothing) — ask admin for missing details
        let askMsg;
        if (!extractedName && !extractedPhone) {
          askMsg = `Sure, I can book an appointment for a patient. Please provide:\n• Patient full name\n• Patient WhatsApp phone number (with country code, e.g. 919876543210)`;
        } else if (extractedName && !extractedPhone) {
          askMsg = `Got the name: *${extractedName}*. Please also provide the patient's WhatsApp phone number (with country code, e.g. 919876543210).`;
        } else {
          askMsg = `Got the phone number. Please also provide the patient's full name.`;
        }

        // Store partial info in session (with 10-min expiry via setAdminPending) so next reply can complete it
        session.setAdminPending(phone, {
          type: 'ADMIN_BOOK_PARTIAL',
          data: {
            patient_name: extractedName,
            patient_phone: extractedPhone ? extractedPhone.replace(/[^0-9]/g, '') : null,
            target_date: parsed?.target_date || nextOperatingDate,
            slot_preference: parsed?.slot_preference || null,
          },
          confirmation_prompt: askMsg,
        });

        session.appendHistory(phone, 'assistant', askMsg);
        return askMsg;
      }
    }


    // ── 0c. Complete a partial admin booking (phone or name was missing) ─
    const partialPending = session.getAdminPending(phone);
    if (partialPending && partialPending.type === 'ADMIN_BOOK_PARTIAL') {
      const lowerMsg = message.toLowerCase().trim();
      const isExitOrCommand =
        ['cancel', 'no', 'stop', 'abort', 'never mind', 'nhi', 'nahi', 'mat karo'].includes(lowerMsg) ||
        lowerMsg.startsWith('cancel all') || lowerMsg.startsWith('delete') || lowerMsg.startsWith('delte') ||
        lowerMsg.startsWith('why') || lowerMsg.startsWith('what') || lowerMsg.startsWith('how') ||
        lowerMsg.includes('change') || lowerMsg.includes('update') || lowerMsg.includes('set ') ||
        lowerMsg.includes('booking window') || lowerMsg.includes('give me') || lowerMsg.includes('list');

      if (isExitOrCommand) {
        console.log(`[AI-Bot] Admin dropped partial booking draft with message: "${message}"`);
        session.clearAdminPending(phone);
        if (['cancel', 'no', 'stop', 'abort', 'never mind', 'nhi', 'nahi', 'mat karo'].includes(lowerMsg)) {
          const reply = "❌ Patient booking cancelled.";
          session.appendHistory(phone, 'assistant', reply);
          return reply;
        }
        // Fall through to process message fresh as a command or query!
      } else {
        const currentDateTimeISO = currentTime.toISOString().substring(0, 19);
        const nextOperatingDate = await schedule.findNextOperatingDate(currentTime);

        // First: check if this is a correction to the partial draft
        const correctionCheck = await claude.classifyAdminBookCorrection(message, partialPending.data);
      if (correctionCheck.is_correction && correctionCheck.field && correctionCheck.new_value) {
        const updatedData = { ...partialPending.data };
        if (correctionCheck.field === 'name') updatedData.patient_name = correctionCheck.new_value;
        if (correctionCheck.field === 'phone') updatedData.patient_phone = correctionCheck.new_value.replace(/[^0-9]/g, '');
        if (correctionCheck.field === 'date') updatedData.target_date = correctionCheck.new_value;
        session.setAdminPending(phone, { ...partialPending, data: updatedData });

        if (updatedData.patient_name && updatedData.patient_phone) {
          // Now complete — fall through to full booking below by re-running the merge logic
        } else {
          const missingPhone = !updatedData.patient_phone;
          const askMsg = missingPhone
            ? `Updated. Got name: *${updatedData.patient_name || '(none)'}*. Please provide the patient's WhatsApp phone number.`
            : `Updated. Please also provide the patient's full name.`;
          session.appendHistory(phone, 'assistant', askMsg);
          return askMsg;
        }
      }

      // Try to extract the missing info from this new message
      // Use validateName for bare name replies (no book keyword) to avoid null from parseAdminBookCommand
      const freshParsed = await claude.parseAdminBookCommand(message, currentDateTimeISO, nextOperatingDate);

      // Also try raw name validation if freshParsed gave no name
      let resolvedName = freshParsed?.patient_name || null;
      if (!resolvedName && !partialPending.data.patient_name) {
        // Message might be a bare name reply — validate it as a name
        const nameValidation = await claude.validateName(message);
        if (nameValidation.valid && nameValidation.name) {
          resolvedName = nameValidation.name;
        }
      } else if (!resolvedName && partialPending.data.patient_name) {
        // Keep existing name from partial store
        resolvedName = partialPending.data.patient_name;
      }

      // For phone: if message is purely numeric-ish, treat it as phone
      let resolvedPhone = freshParsed?.patient_phone || null;
      if (!resolvedPhone && !partialPending.data.patient_phone) {
        const digitsOnly = message.replace(/[^0-9]/g, '');
        if (digitsOnly.length >= 8) resolvedPhone = digitsOnly;
      } else if (!resolvedPhone) {
        resolvedPhone = partialPending.data.patient_phone;
      }

      const merged = {
        patient_name: resolvedName,
        patient_phone: resolvedPhone,
        target_date: freshParsed?.target_date || partialPending.data.target_date || nextOperatingDate,
        slot_preference: freshParsed?.slot_preference || partialPending.data.slot_preference,
      };

      if (merged.patient_name && merged.patient_phone) {
        // We now have enough — clear partial state and run full booking flow
        session.clearAdminPending(phone);

        const targetDate = merged.target_date;
        const effectiveSchedule = await schedule.getEffectiveSchedule(targetDate);
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const targetDateObj = new Date(targetDate + 'T12:00:00Z');
        const targetDayName = dayNames[targetDateObj.getUTCDay()];
        const isOverrideOpen = effectiveSchedule.is_override && effectiveSchedule.override_type === 'open_extra_day';
        const isRegularDay = Array.isArray(effectiveSchedule.operating_days) &&
          effectiveSchedule.operating_days.includes(targetDayName);
        const isClosed = effectiveSchedule.is_override && effectiveSchedule.override_type === 'closed';
        const isOperatingDay = !isClosed && (isOverrideOpen || isRegularDay);

        if (!isOperatingDay || effectiveSchedule.max_tokens === 0) {
          const reply = `❌ Cannot book: ${targetDate} (${targetDayName}) is not an operating day.`;
          session.appendHistory(phone, 'assistant', reply);
          return reply;
        }

        const avail = await schedule.getSlotAvailability(targetDate);
        const resolvedSlot = merged.slot_preference ||
          (!avail.morning.isFull ? 'morning' : !avail.afternoon.isFull ? 'afternoon' : null);

        if (!resolvedSlot) {
          const reply = `❌ Cannot book — all tokens for ${targetDate} are already full.`;
          session.appendHistory(phone, 'assistant', reply);
          return reply;
        }

        const estimatedToken = resolvedSlot === 'morning'
          ? avail.morning.booked + 1
          : effectiveSchedule.slots.morning.token_cap + avail.afternoon.booked + 1;

        const confirmPrompt = `Admin booking summary:\n• Patient: ${merged.patient_name}\n• Phone: ${merged.patient_phone}\n• Date: ${targetDate}\n• Slot: ${resolvedSlot} (Token ~#${estimatedToken})\n\nReply 'yes' to confirm, 'no' to cancel, or send a correction (e.g. "wrong number, use 919876500000").`;

        session.setAdminPending(phone, {
          type: 'ADMIN_BOOK',
          data: {
            patient_name: merged.patient_name,
            patient_phone: merged.patient_phone.replace(/[^0-9]/g, ''),
            target_date: targetDate,
            slot_preference: resolvedSlot,
          },
          confirmation_prompt: confirmPrompt,
        });

        session.appendHistory(phone, 'assistant', confirmPrompt);
        return confirmPrompt;
      } else {
        // Still missing something — re-prompt
        const missingPhone = !merged.patient_phone;
        const askMsg = missingPhone
          ? `Got the name: *${merged.patient_name || '(unknown)'}*. Please provide the patient's WhatsApp phone number (with country code, e.g. 919876543210).`
          : `Please provide the patient's full name.`;
        // Update partial state with whatever we gathered
        session.setAdminPending(phone, { ...partialPending, data: { ...partialPending.data, ...merged } });
        session.appendHistory(phone, 'assistant', askMsg);
        return askMsg;
      }
    }
  }

    // ── 1. Check for Pending Confirmation ───────────────────────────
    const pending = session.getAdminPending(phone);
    if (pending) {
      // ── 1a. Check for correction FIRST (before confirm/cancel), applies to both ADMIN_BOOK and ADMIN_BOOK_PARTIAL ──
      if (pending.type === 'ADMIN_BOOK') {
        const correctionCheck = await claude.classifyAdminBookCorrection(message, pending.data);
        if (correctionCheck.is_correction && correctionCheck.field && correctionCheck.new_value) {
          const updatedData = { ...pending.data };
          if (correctionCheck.field === 'name') updatedData.patient_name = correctionCheck.new_value;
          if (correctionCheck.field === 'phone') updatedData.patient_phone = correctionCheck.new_value.replace(/[^0-9]/g, '');
          if (correctionCheck.field === 'date') updatedData.target_date = correctionCheck.new_value;

          // Recompute estimated token if we have enough data
          const targetDate = updatedData.target_date;
          const avail = await schedule.getSlotAvailability(targetDate);
          const resolvedSlot = updatedData.slot_preference ||
            (!avail.morning.isFull ? 'morning' : !avail.afternoon.isFull ? 'afternoon' : null);
          const effectiveSchedule = await schedule.getEffectiveSchedule(targetDate);
          const estimatedToken = resolvedSlot === 'morning'
            ? avail.morning.booked + 1
            : (effectiveSchedule.slots?.morning?.token_cap || 0) + avail.afternoon.booked + 1;

          const updatedPrompt = `Updated. Booking summary:\n• Patient: ${updatedData.patient_name}\n• Phone: ${updatedData.patient_phone}\n• Date: ${targetDate}\n• Slot: ${resolvedSlot || 'TBD'} (Token ~#${estimatedToken})\n\nReply 'yes' to confirm, 'no' to cancel, or send another correction.`;
          session.setAdminPending(phone, { ...pending, data: updatedData, confirmation_prompt: updatedPrompt });
          session.appendHistory(phone, 'assistant', updatedPrompt);
          return updatedPrompt;
        }
      }

      const confClassification = await claude.classifyAdminConfirmation(message);


      if (confClassification === 'confirm') {
        // ── ADMIN_BOOK confirmation path ──────────────────────────────────
        if (pending.type === 'ADMIN_BOOK') {
          const { patient_name, patient_phone, target_date, slot_preference } = pending.data;

          const allocation = await schedule.allocateToken({
            phone: patient_phone,
            name: patient_name,
            slotPreference: slot_preference || 'morning',
            currentTime,
            targetDate: target_date,
          });

          session.clearAdminPending(phone);

          if (allocation.isDuplicate && allocation.token) {
            const reply = `❌ A token already exists for ${patient_name} (${patient_phone}) on ${target_date}. No new booking was made.`;
            session.appendHistory(phone, 'assistant', reply);
            return reply;
          }

          if (!allocation.success) {
            const reasonMsg = allocation.reason === 'all_full'
              ? 'all tokens for that date are full'
              : `the ${allocation.reason?.replace('_full', '')} slot is full`;
            const reply = `❌ Could not book — ${reasonMsg}. No token was allocated.`;
            session.appendHistory(phone, 'assistant', reply);
            return reply;
          }

          const token = allocation.token;

          // Build the bilingual patient confirmation message (same format as self-service bookings)
          const patientMsg = _formatPatientConfirmationBilingual(token);
          let patientNotified = false;
          let notifyError = null;
          try {
            await _sendPatientNotification(patient_phone, patientMsg);
            // If sendText didn't throw, the Cloud API returned a valid message ID — delivery confirmed.
            patientNotified = true;
            console.log(`[AI-Bot] ✅ Admin-booked patient notified: ${patient_phone}`);
          } catch (notifyErr) {
            notifyError = notifyErr.message;
            console.warn(`[AI-Bot] ⚠️ Could not send patient confirmation to ${patient_phone}:`, notifyErr.message);
          }

          // Admin confirmation — show bilingual format of what was (or would have been) sent
          const adminReply = `✅ Token #${token.token_number} (${token.slot_name}) booked for ${patient_name} on ${target_date}. Arrival: ${token.arrival_time}.\n${patientNotified
            ? `Patient notified via WhatsApp ✅\n\nMessage sent:\n${patientMsg}`
            : `⚠️ Patient notification FAILED — ${notifyError || 'unknown error'}. Please contact them manually at ${patient_phone}.`}`;
          session.appendHistory(phone, 'assistant', adminReply);
          return adminReply;
        }

        // Execute the pending mutation!
        if (pending.action === 'CANCEL_ALL_BOOKINGS' || pending.cancel_tokens || pending.target_tab === 'CancelBookings') {
          const targetDate = pending.target_date || (await schedule.findNextOperatingDate(currentTime));
          const affectedTokens = pending.affected_tokens || schedule.getTokensForSunday(targetDate);
          let notifiedCount = 0;

          if (affectedTokens.length > 0) {
            for (const patient of affectedTokens) {
              try {
                const cancellationMsg = `Hi ${patient.patient_name}, your appointment (Token #${patient.token_number}) for ${targetDate} at Al Ramzan Shifakhana has been cancelled by the clinic administration. We apologize for the inconvenience.`;
                console.log(`[AI-Bot] 📢 Auto-notifying patient ${patient.patient_phone} (${patient.patient_name}): "${cancellationMsg}"`);
                await _sendPatientNotification(patient.patient_phone, cancellationMsg);
                notifiedCount++;
              } catch (notifyErr) {
                console.error(`[AI-Bot] ❌ Failed to notify patient ${patient.patient_phone}:`, notifyErr.message);
              }
            }
          }

          // Delete tokens from SQLite
          store.deleteTokensForDate(targetDate);
          schedule.resetTokensForTesting(targetDate);

          // If there were also settings updates (e.g. combined command)
          if (pending.updates && Object.keys(pending.updates).length > 0) {
            store.updateSettings(pending.updates);
            store.clearFutureBookingWindowOverrides(currentTime.toISOString().split('T')[0]);
          }

          schedule.invalidateCache();
          session.clearAdminPending(phone);

          const isToday = targetDate === currentTime.toISOString().split('T')[0];
          const dateLabel = isToday ? "today" : targetDate;
          const reply = affectedTokens.length > 0
            ? `✅ Cancelled all ${affectedTokens.length} appointment(s) for ${dateLabel}. All ${notifiedCount} patient(s) have been notified automatically via WhatsApp.${pending.updates ? '\nPermanent clinic schedule settings have also been updated.' : ''}`
            : `✅ Cancelled appointments for ${dateLabel}. There were no active bookings to notify.${pending.updates ? '\nPermanent clinic schedule settings have also been updated.' : ''}`;

          session.appendHistory(phone, 'assistant', reply);
          return reply;
        }

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

          const res = await store.addOverride(overrideRecord);
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

            // If clinic was closed, also delete the tokens from SQLite
            if (overrideRecord.type === 'closed') {
              store.deleteTokensForDate(overrideRecord.target_date);
              schedule.resetTokensForTesting(overrideRecord.target_date);
            }
          }

          session.clearAdminPending(phone);

          if (!res.success) {
            const errReply = `❌ Failed to save override: ${res.error}`;
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
            reply = `✅ Confirmed! A one-off override has been saved for **${overrideRecord.target_date}** (${overrideRecord.type}). The change is now live and in effect.`;
          }

          session.appendHistory(phone, 'assistant', reply);
          return reply;
        } else if (pending.target_tab === 'Settings') {
          const res = store.updateSettings(pending.updates || {});
          // If booking window was updated, clear any future one-off booking window overrides
          // so the new Settings take effect immediately without being blocked by stale overrides
          if (pending.updates && (pending.updates.booking_open_day || pending.updates.booking_open_time)) {
            const todayStr = currentTime.toISOString().split('T')[0];
            store.clearFutureBookingWindowOverrides(todayStr);
          }
          schedule.invalidateCache();
          session.clearAdminPending(phone);

          if (!res.success) {
            const errReply = `❌ ${res.error}`;
            session.appendHistory(phone, 'assistant', errReply);
            return errReply;
          }

          const reply = `✅ Confirmed! Permanent clinic schedule settings have been updated. The change is now live.`;
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
      // Semantic classification: DOCTOR_BOOKINGS vs CLINIC_CONFIG vs CLINIC_CAPACITY
      const queryType = await claude.classifyAdminQueryType(message);
      console.log(`[AI-Bot] Admin query semantic classification: ${queryType} for message: "${message}"`);

      // If query is asking about booked tokens, patient names, appointments, or roster:
      // Even if doctorInfo is null, the ADMIN has full authority to see the patient bookings!
      if (queryType === 'DOCTOR_BOOKINGS' || _isDoctorSpecificQuery(message)) {
        console.log(`[AI-Bot] Delegating booking/roster query for admin: "${message}"`);
        const targetDoctor = doctorInfo || { name: 'Admin', specialty: 'Administration' };
        return await doctorAgent.handleDoctorMessage(phone, message, targetDoctor);
      }

      // Fetch current effective schedule and context
      const effectiveSchedule = await schedule.getEffectiveSchedule();
      const settings = store.getSettings();
      const overrides = store.getOverrides();

      // Include macro capacity metrics and active booked tokens
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
        booked_tokens: existingTokens.map(t => ({
          token_number: t.token_number,
          slot: t.slot_name,
          patient_name: t.patient_name,
          patient_phone: t.patient_phone,
          arrival_time: t.arrival_time,
          condition: t.condition || 'General consultation',
        })),
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
    const currentSettings = store.getSettings();
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
        lowerMsg.includes('opening for today') ||
        lowerMsg.includes('opening today') ||
        lowerMsg.includes('one of opening') ||
        lowerMsg.includes('one-of opening') ||
        lowerMsg.includes('one off opening') ||
        lowerMsg.includes('one-off opening') ||
        lowerMsg.includes('extra day') ||
        lowerMsg.includes('open wednesday') ||
        lowerMsg.includes('open thursday') ||
        lowerMsg.includes('open friday') ||
        lowerMsg.includes('open saturday');

      const isOpeningExtraDay = overrideData.type === 'open_extra_day' || isExplicitClinicOpening;

      if ((hasBookingOpenChange || isBookingWindowIntent) && !isOpeningExtraDay && overrideData.type !== 'closed') {
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

    // Handle CANCEL_ALL_BOOKINGS or cancel_tokens
    if (parsed.action === 'CANCEL_ALL_BOOKINGS' || parsed.cancel_tokens || parsed.target_tab === 'CancelBookings') {
      const targetDate = parsed.target_date || (await schedule.findNextOperatingDate(currentTime));
      parsed.target_date = targetDate;
      affectedTokens = schedule.getTokensForSunday(targetDate);
      const count = affectedTokens.length;

      const isToday = targetDate === currentTime.toISOString().split('T')[0];
      const dateLabel = isToday ? 'today' : targetDate;
      const patientSummary = count > 0
        ? `Confirming this cancellation will delete all ${count} token(s) and automatically notify ${count === 1 ? 'the patient' : 'all patients'} via WhatsApp.`
        : `There are currently no tokens booked for ${dateLabel}.`;

      if (parsed.settings_updates && Object.keys(parsed.settings_updates).length > 0) {
        parsed.confirmation_prompt = `I understand you want to:\n1. Cancel all existing tokens for ${dateLabel} (${count} booked). ${patientSummary}\n2. Permanently update the Settings tab with the new booking window.\n\nShould I proceed? Reply 'yes' to confirm.`;
      } else {
        parsed.confirmation_prompt = `${count} ${count === 1 ? 'patient holds a token' : 'patients hold tokens'} for ${dateLabel}. ${patientSummary}\n\nReply 'yes' to proceed.`;
      }
    } else if (parsed.target_tab === 'Overrides' && parsed.override_data) {
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
      action: parsed.action,
      cancel_tokens: parsed.cancel_tokens,
      is_permanent: parsed.is_permanent,
      target_tab: parsed.target_tab,
      target_date: parsed.target_date,
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
