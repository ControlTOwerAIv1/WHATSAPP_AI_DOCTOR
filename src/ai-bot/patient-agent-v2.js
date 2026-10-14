const { getCurrentTime } = require('./clock');
const session = require('./session');
const schedule = require('./schedule');
const guards = require('./guards');
const claude = require('./claude');
const patientAgent = require('./patient-agent');

const _phoneQueues = new Map();
const _handledMessageIds = new Set();
const _handledMessageIdsList = [];

function _formatNowIST(d) {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const dayName = dayNames[ist.getUTCDay()];
  const dateNum = ist.getUTCDate();
  const monthName = monthNames[ist.getUTCMonth()];
  const year = ist.getUTCFullYear();
  const h24 = ist.getUTCHours();
  const m = String(ist.getUTCMinutes()).padStart(2, '0');
  const meridiem = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 || 12;
  return `${dayName}, ${dateNum} ${monthName} ${year}, ${h12}:${m} ${meridiem}`;
}

function _getFallbackApology(lang = 'hinglish') {
  if (lang === 'en') {
    return "I'm sorry, I'm having a bit of trouble right now. Please send your name or message again.";
  } else if (lang === 'hindi_deva') {
    return "माफ़ कीजिए, मुझे थोड़ी परेशानी हो रही है। कृपया अपना नाम या संदेश फिर से भेजें।";
  } else if (lang === 'urdu') {
    return "معذرت، کچھ مسئلہ ہو رہا ہے۔ برائے مہربانی اپنا نام یا میسج دوبارہ بھیجیں۔";
  }
  return "Maaf kijiye, mujhe thodi pareshani ho rahi hai. Kripya apna naam ya request dubara bhejiye.";
}

/**
 * Internal processor for patient messages.
 */
async function _processMessage(phone, text, options = {}) {
  let userLang = 'hinglish';
  try {
    // 1. Get history and append patient message
    const history = session.getHistory(phone, 10);
    session.appendHistory(phone, 'user', text);

    // 2. Determine current time, booking window, existing token, capacity
    const now = getCurrentTime();
    const windowInfo = schedule.describeBookingWindow(now);

    let existing = schedule.getTokenByPhone(phone, windowInfo.target_date);
    const todayISTStr = schedule.formatDateToYYYYMMDD(now);
    if (!existing && todayISTStr !== windowInfo.target_date) {
      existing = schedule.getTokenByPhone(phone, todayISTStr);
    }

    const availability = await schedule.getSlotAvailability(windowInfo.target_date);
    const capacityFull = Boolean(availability && availability.morning?.isFull && availability.afternoon?.isFull);

    let existingTokenCtx = null;
    if (existing) {
      existingTokenCtx = {
        token_number: existing.token_number,
        name: existing.patient_name,
        date: existing.sunday_date,
        time: existing.arrival_time,
      };
    }

    const context = {
      now_ist: _formatNowIST(now),
      clinic_name: 'Al Ramzan Shifakhana',
      consultation_hours: '11:00 AM to 6:30 PM',
      window: windowInfo,
      existing_token: existingTokenCtx,
      capacity: { full: capacityFull },
      is_voice_transcript: Boolean(options.isVoice),
      attempt_result: null,
    };

    // 3. Interpret message
    const result = await claude.interpretPatientMessage({ message: text, history, context });
    userLang = result.language || 'hinglish';

    let reply = null;

    // 4. Handle action
    switch (result.action) {
      case 'BOOK': {
        const v = guards.validatePatientName(result.name);
        if (!v.ok) {
          const retry = await claude.interpretPatientMessage({
            message: text,
            history,
            context: {
              ...context,
              attempt_result: { action: 'BOOK', error: 'invalid_name', details: v.reason },
            },
          });
          reply = retry.reply_text;
          break;
        }

        const tokenAlreadyExists = Boolean(schedule.getTokenByPhone(phone, windowInfo.target_date));
        if (windowInfo.state === 'closed' || capacityFull || tokenAlreadyExists) {
          let errCode = 'window_closed';
          let details = windowInfo;
          if (tokenAlreadyExists) {
            errCode = 'already_booked';
            details = existingTokenCtx;
          } else if (capacityFull) {
            errCode = 'full';
            details = null;
          }

          const retry = await claude.interpretPatientMessage({
            message: text,
            history,
            context: {
              ...context,
              attempt_result: { action: 'BOOK', error: errCode, details },
            },
          });
          reply = retry.reply_text;
          break;
        }

        // Allocate slot
        const avail = await schedule.getSlotAvailability(windowInfo.target_date);
        let slotPreference = 'morning';
        if (!avail.morning.isFull) {
          slotPreference = 'morning';
        } else if (!avail.afternoon.isFull) {
          slotPreference = 'afternoon';
        }

        const allocRes = await schedule.allocateToken({
          phone,
          name: v.name,
          slotPreference,
          currentTime: now,
          targetDate: windowInfo.target_date,
        });

        if (allocRes.success && allocRes.token) {
          const isHindi = userLang !== 'en';
          reply = patientAgent._formatBookingConfirmation(allocRes.token, isHindi);
        } else {
          const retry = await claude.interpretPatientMessage({
            message: text,
            history,
            context: {
              ...context,
              attempt_result: { action: 'BOOK', error: allocRes.reason || 'allocation_failed', details: allocRes },
            },
          });
          reply = retry.reply_text;
        }
        break;
      }

      case 'CORRECT_NAME': {
        const dateToCorrect = existingTokenCtx ? existingTokenCtx.date : windowInfo.target_date;
        const correctRes = guards.correctTokenName(phone, dateToCorrect, result.name);
        if (correctRes.success && correctRes.token) {
          const isHindi = userLang !== 'en';
          reply = patientAgent._formatBookingConfirmation(correctRes.token, isHindi);
        } else {
          const retry = await claude.interpretPatientMessage({
            message: text,
            history,
            context: {
              ...context,
              attempt_result: { action: 'CORRECT_NAME', error: correctRes.error || 'correction_failed', details: correctRes },
            },
          });
          reply = retry.reply_text;
        }
        break;
      }

      case 'REPLY':
      default: {
        reply = result.reply_text;
        break;
      }
    }

    if (!reply) {
      reply = _getFallbackApology(userLang);
    }

    // 5. Repeat guard
    const fullHistory = session.getHistory(phone, 20) || [];
    const last3Assistant = fullHistory.filter(h => h.role === 'assistant').slice(-3);

    if (guards.isRepeat(reply, last3Assistant)) {
      const repeatRetry = await claude.interpretPatientMessage({
        message: text,
        history,
        context: {
          ...context,
          attempt_result: {
            action: 'REPLY',
            error: 'repeat',
            details: 'do not repeat; move forward or state current status',
          },
        },
      });

      if (repeatRetry && repeatRetry.reply_text && !guards.isRepeat(repeatRetry.reply_text, last3Assistant)) {
        reply = repeatRetry.reply_text;
      } else {
        // Return short status line
        if (existingTokenCtx) {
          const isHindi = userLang !== 'en';
          if (isHindi) {
            reply = `Aapka token #${existingTokenCtx.token_number} (${existingTokenCtx.name}) confirm hai. Samay: ${existingTokenCtx.time}.`;
          } else {
            reply = `Your token #${existingTokenCtx.token_number} for ${existingTokenCtx.name} is confirmed. Time: ${existingTokenCtx.time}.`;
          }
        } else {
          if (windowInfo.state === 'open') {
            reply = `Booking window is open until ${windowInfo.closes_at_text || 'closing time'}. Send your name to book a token.`;
          } else {
            reply = `Booking is currently closed. It opens ${windowInfo.next_open_text || 'soon'}.`;
          }
        }
      }
    }

    // 8. Append bot reply to history
    session.appendHistory(phone, 'assistant', reply);
    return reply;

  } catch (err) {
    const last4 = (phone || '').slice(-4);
    console.error(`[PatientAgentV2] Error for ...${last4}:`, err.message);
    const apology = _getFallbackApology(userLang);
    session.appendHistory(phone, 'assistant', apology);
    return apology;
  }
}

/**
 * Handle incoming message for patient agent V2.
 * Serialized per phone; never returns empty or silent.
 *
 * @param {string} phone
 * @param {string} text
 * @param {object} [options]
 * @param {boolean} [options.isVoice]
 * @param {string} [options.messageId]
 * @returns {Promise<string>}
 */
async function handlePatientMessageV2(phone, text, options = {}) {
  // Deduplicate message ID (keep last 500)
  if (options.messageId) {
    if (_handledMessageIds.has(options.messageId)) {
      return '';
    }
    _handledMessageIds.add(options.messageId);
    _handledMessageIdsList.push(options.messageId);
    if (_handledMessageIdsList.length > 500) {
      const oldest = _handledMessageIdsList.shift();
      _handledMessageIds.delete(oldest);
    }
  }

  // Per-phone sequential promise queue
  const prevPromise = _phoneQueues.get(phone) || Promise.resolve();
  const nextPromise = prevPromise
    .then(() => _processMessage(phone, text, options))
    .catch(() => _processMessage(phone, text, options));

  _phoneQueues.set(phone, nextPromise);

  // Clean up queue entry when done if it hasn't changed
  nextPromise.finally(() => {
    if (_phoneQueues.get(phone) === nextPromise) {
      _phoneQueues.delete(phone);
    }
  });

  return nextPromise;
}

module.exports = {
  handlePatientMessageV2,
};
