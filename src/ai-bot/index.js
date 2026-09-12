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
const sheets = require('./sheets');

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

  // Periodic session cleanup (every 10 minutes)
  setInterval(() => sessionStore.cleanupExpiredSessions(), 10 * 60 * 1000);

  // Background job: re-attempt any failed Sheets syncs every 60 seconds
  sheets.startSyncFailureProcessor(60000);

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

    const messageText = (parsed.content || '').trim();
    if (messageText && _botSentContents.has(messageText)) {
      console.log(`[AI-Bot] Skipping message sent by bot itself (Content match): "${messageText.substring(0, 40)}..."`);
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

    // Skip non-text messages (for now)
    if (parsed.mediaType && parsed.mediaType !== 'text') {
      console.log(`[AI-Bot] Skipping non-text message type: ${parsed.mediaType}`);
      return;
    }

    // Skip empty messages
    if (!messageText) return;

    // Skip protocol/system messages
    if (messageText.startsWith('[') && messageText.endsWith(']')) return;

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
