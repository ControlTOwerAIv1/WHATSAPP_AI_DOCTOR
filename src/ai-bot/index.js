/**
 * AI Bot — Main Entry Point
 *
 * Initializes the AI bot module and provides the message handler
 * that hooks into the Meta WhatsApp Cloud API incoming message pipeline.
 *
 * Routing logic:
 *   1. Skip group messages, own messages, and non-text messages
 *   2. Check if sender is admin (ADMIN_PHONE_NUMBER) → admin-agent
 *   3. Check if sender is a registered doctor → doctor-agent
 *   4. Otherwise → patient-agent
 *   5. Send reply via Meta Cloud API socket adapter (sock.sendMessage)
 *
 * The bot runs as a fire-and-forget async call — it never blocks
 * the existing message processing pipeline.
 */

const botConfig = require('./config');
const patientAgent = require('./patient-agent');
const doctorAgent = require('./doctor-agent');
const adminAgent = require('./admin-agent');
const sessionStore = require('./session');
const store = require('./store');

let _sock = null;
let _stores = null;
let _initialized = false;

// Debounce: track recently processed message IDs to avoid double-processing
const _recentlyProcessed = new Set();
const MAX_RECENT = 500;

/**
 * Initialize the AI bot.
 * @param {{ rootDir: string }} deps
 */
function init({ rootDir }) {
  botConfig.init(rootDir);
  const config = botConfig.getConfig();

  if (!config.enabled) {
    console.log('[AI-Bot] AI bot is disabled (AI_BOT_ENABLED=false)');
    return;
  }

  if (!config.anthropicApiKey) {
    console.warn('[AI-Bot] Cannot start — ANTHROPIC_API_KEY not set');
    return;
  }

  _initialized = true;

  // Initialize SQLite store (runs migrations, seeds default settings row)
  store.getDb();

  // Periodic session cleanup (every 10 minutes)
  setInterval(() => sessionStore.cleanupExpiredSessions(), 10 * 60 * 1000);

  console.log('[AI-Bot] ✅ AI Bot initialized and ready');
}

/**
 * Set the WhatsApp sender interface for sending AI bot replies.
 * Receives the socket adapter from cloudapi.js exposing sendMessage().
 */
function setSock(sock) {
  _sock = sock;
}

/**
 * Set the stores reference (for contact name resolution, etc.)
 */
function setStores(stores) {
  _stores = stores;
}

// Track message IDs and text contents sent by the bot to prevent self-chat loops
const _botSentMessageIds = new Set();
const _botSentContents = new Set();

function _recordBotSent(sentResult, replyText) {
  if (sentResult?.key?.id) {
    _botSentMessageIds.add(sentResult.key.id);
    if (_botSentMessageIds.size > 500) {
      const first = _botSentMessageIds.values().next().value;
      _botSentMessageIds.delete(first);
    }
  }
  if (replyText) {
    _botSentContents.add(replyText.trim());
    if (_botSentContents.size > 200) {
      const first = _botSentContents.values().next().value;
      _botSentContents.delete(first);
    }
  }
}

/**
 * Get a language-aware fallback message for unintelligible input.
 * Checks the patient's session for language preference; defaults to bilingual.
 */
function _getUnintelligibleFallback(phone) {
  try {
    const sess = sessionStore.getSession(phone);
    if (sess && sess.isHindi) {
      return 'Maaf kijiye, samajh nahi aaya. Kripya text mein likhein.';
    }
  } catch (e) {
    // Ignore session lookup errors
  }
  // Default: bilingual (Hindi + English)
  return 'Maaf kijiye, samajh nahi aaya. Kripya text mein likhein.\n\nSorry, I couldn\'t understand that. Please send your message as text.';
}

/**
 * Check if a patient's session indicates Hindi preference.
 */
function _isLikelyHindi(phone) {
  try {
    const sess = sessionStore.getSession(phone);
    return Boolean(sess && sess.isHindi);
  } catch (e) {
    return false;
  }
}

/**
 * Send a fallback/rejection reply and record it in the store.
 * Never throws — all errors are caught and logged.
 */
async function _sendFallbackReply(jid, phone, replyText) {
  if (!jid || !_sock) return;
  try {
    _botSentContents.add(replyText.trim());
    const sent = await _sock.sendMessage(jid, { text: replyText });
    _recordBotSent(sent, replyText);
    console.log(`[AI-Bot] Fallback reply sent to ${phone} (${replyText.length} chars)`);
    if (_stores) {
      try {
        await _stores.recordOutboundMessage({
          jid,
          operator: { id: 'ai-bot', name: 'AI Bot' },
          result: sent,
          message: { content: replyText, mediaType: 'text' },
        });
      } catch (storeErr) {
        console.warn('[AI-Bot] Failed to record outbound fallback:', storeErr.message);
      }
    }
  } catch (err) {
    console.error('[AI-Bot] Failed to send fallback reply:', err.message);
  }
}

/**
 * Handle an incoming parsed message from the Cloud API webhook receiver.
 * Evaluates sender role, enforces rules, and triggers corresponding agent.
 *
 * @param {Object} parsed - Normalized message record from stores.normalizeMessageRecord
 */
async function handleIncomingMessage(parsed) {
  if (!_initialized) {
    console.log('[AI-Bot] Ignored message: AI Bot not initialized.');
    return;
  }
  if (!_sock) {
    console.log('[AI-Bot] Ignored message: Socket not available.');
    return;
  }

  try {
    // ── Guard against responding to our own bot messages ──
    if (parsed.id && _botSentMessageIds.has(parsed.id)) {
      console.log(`[AI-Bot] Skipping message sent by bot itself (ID match): ${parsed.id}`);
      return;
    }

    const rawText = (parsed.content || '').trim();
    if (rawText && _botSentContents.has(rawText)) {
      console.log(`[AI-Bot] Skipping message sent by bot itself (Content match): "${rawText.substring(0, 40)}..."`);
      return;
    }

    // ── Extract sender info ──
    const jid = parsed.jid || parsed.from;
    if (!jid) return;

    const phone = botConfig.jidToPhone(jid);
    const senderName = parsed.sender || phone;

    // Check if this is a self-chat (user testing by texting themselves)
    const myPhone = _sock?.user?.id ? botConfig.jidToPhone(_sock.user.id) : null;
    const isSelfChat = Boolean(myPhone && phone && myPhone === phone);

    // Skip outgoing messages (fromMe) UNLESS it is a self-chat test message
    if (parsed.fromMe && !isSelfChat) {
      console.log(`[AI-Bot] Skipping outgoing message to external contact ${phone}`);
      return;
    }

    // Skip group messages
    if (parsed.isGroup) return;

    // Deduplicate (prevent processing the same message twice)
    if (_recentlyProcessed.has(parsed.id)) {
      console.log(`[AI-Bot] Duplicate message ignored: ${parsed.id}`);
      return;
    }
    _recentlyProcessed.add(parsed.id);
    if (_recentlyProcessed.size > MAX_RECENT) {
      const first = _recentlyProcessed.values().next().value;
      _recentlyProcessed.delete(first);
    }

    // ── Handle non-text messages ──
    const mediaType = parsed.mediaType;
    const isAudioOrVoice = mediaType === 'audio' || mediaType === 'voice';
    const isNonTextMedia = mediaType && mediaType !== 'text';

    if (isNonTextMedia && !isAudioOrVoice) {
      // Unsupported media (sticker, image without caption, video, document, location, contacts, etc.)
      // Never go silent — send a fallback asking for text
      console.log(`[AI-Bot] Unsupported media type received: ${mediaType}`);
      await _sendFallbackReply(jid, phone, _getUnintelligibleFallback(phone));
      return;
    }

    // ── Handle audio/voice messages — transcription ──
    let messageText = (parsed.content || '').trim();

    if (isAudioOrVoice) {
      // ── Duration Guard: reject voice notes >15 seconds ──
      const audioDuration = parsed.mediaDuration || 0; // seconds, from WhatsApp metadata
      const MAX_AUDIO_SECONDS = 15;

      if (audioDuration > MAX_AUDIO_SECONDS) {
        console.log(`[AI-Bot] Voice note too long (${audioDuration}s > ${MAX_AUDIO_SECONDS}s), rejecting`);
        const isHindi = _isLikelyHindi(phone);
        const tooLongReply = isHindi
          ? 'Voice note bahut lamba hai, kripya chhota bhejein ya text mein likhein.'
          : 'That voice note is too long — please send a shorter one or use text.';
        await _sendFallbackReply(jid, phone, tooLongReply);
        return;
      }

      // ── Attempt transcription ──
      const transcriber = require('./transcriber');
      const fs = require('fs');
      const path = require('path');

      // Resolve local file path
      let localPath = null;
      if (parsed.mediaUrl) {
        localPath = path.join(process.cwd(), parsed.mediaUrl.replace(/^\//, ''));
        if (!fs.existsSync(localPath)) {
          console.warn(`[AI-Bot] Audio file not found at ${localPath}`);
          localPath = null;
        }
      }

      if (!localPath) {
        console.log('[AI-Bot] No audio file available for transcription');
        await _sendFallbackReply(jid, phone, _getUnintelligibleFallback(phone));
        return;
      }

      // ── Send acknowledgment if transcription will take a while ──
      // For clips >3 seconds, send an immediate "one moment..." so the patient isn't staring at silence
      if (audioDuration > 3) {
        const isHindi = _isLikelyHindi(phone);
        const ackMsg = isHindi ? 'Ek minute...' : 'One moment...';
        try {
          const ackSent = await _sock.sendMessage(jid, { text: ackMsg });
          _recordBotSent(ackSent, ackMsg);
          _botSentContents.add(ackMsg.trim());
        } catch (ackErr) {
          console.warn('[AI-Bot] Failed to send ack message:', ackErr.message);
        }
      }

      // ── Call transcription server ──
      const transcript = await transcriber.transcribe(localPath);

      if (transcript && transcript.text && transcript.text.trim()) {
        messageText = transcript.text.trim();
        console.log(`[AI-Bot] 🎤 Transcribed voice note (${transcript.transcription_time || '?'}s): "${messageText.substring(0, 80)}${messageText.length > 80 ? '...' : ''}"`);
      } else {
        // Transcription failed or empty — send fallback
        console.log('[AI-Bot] Voice/audio transcription failed or empty, sending fallback');
        await _sendFallbackReply(jid, phone, _getUnintelligibleFallback(phone));
        return;
      }
    }

    // Skip empty messages (text with no content)
    if (!messageText) return;

    // Skip protocol/system messages
    if (messageText.startsWith('[') && messageText.endsWith(']')) return;

    console.log(`[AI-Bot] 📩 Incoming message from ${phone} (${senderName}): "${messageText}"${isSelfChat ? ' (Self-Chat Test)' : ''}`);

    // ── Route to appropriate agent ──
    let reply;
    const doctorInfo = botConfig.getDoctorInfo(jid);

    if (botConfig.isAdminPhone(phone)) {
      console.log(`[AI-Bot] 👑 Admin identified: ${phone}${doctorInfo ? ` (also Doctor: ${doctorInfo.name})` : ''}`);
      reply = await adminAgent.handleAdminMessage(phone, messageText, senderName, doctorInfo);
    } else if (doctorInfo) {
      console.log(`[AI-Bot] Doctor identified: ${doctorInfo.name}`);
      reply = await doctorAgent.handleDoctorMessage(phone, messageText, doctorInfo);
    } else {
      reply = await patientAgent.handlePatientMessage(phone, messageText, senderName);
    }

    // ── Send reply ──
    if (reply && _sock) {
      // Record reply text immediately so incoming echo of this text is ignored
      _botSentContents.add(reply.trim());

      const sent = await _sock.sendMessage(jid, { text: reply });
      _recordBotSent(sent, reply);

      console.log(`[AI-Bot] Reply sent to ${phone} (${reply.length} chars)`);

      // Record the outbound message in the store so it appears in the dashboard and DB
      if (_stores) {
        try {
          await _stores.recordOutboundMessage({
            jid,
            operator: { id: 'ai-bot', name: 'AI Bot' },
            result: sent,
            message: {
              content: reply,
              mediaType: 'text',
            },
          });
        } catch (storeErr) {
          console.warn('[AI-Bot] Failed to record outbound message:', storeErr.message);
        }
      }
    }
  } catch (err) {
    console.error('[AI-Bot] Error handling message:', err.message);
    // Best-effort: send an error reply
    try {
      const jid = parsed.jid || parsed.from;
      if (jid && _sock) {
        const errorText = 'I\'m sorry, I\'m experiencing a technical issue. Please try again in a moment.';
        const fallbackSent = await _sock.sendMessage(jid, {
          text: errorText,
        });
        if (_stores) {
          await _stores.recordOutboundMessage({
            jid,
            operator: { id: 'ai-bot', name: 'AI Bot' },
            result: fallbackSent,
            message: {
              content: errorText,
              mediaType: 'text',
            },
          });
        }
      }
    } catch (fallbackErr) {
      console.error('[AI-Bot] Fallback message also failed:', fallbackErr.message);
    }
  }
}

/**
 * Check if the bot is initialized and ready.
 */
function isReady() {
  return _initialized && _sock !== null;
}

module.exports = {
  init,
  setSock,
  setStores,
  handleIncomingMessage,
  isReady,
};
