/**
 * In-memory chat/message/contact state, JID<->LID resolution, and chat
 * assignment (locking) logic.
 *
 * `database`, `io`, and `sock` are injected via setters rather than
 * required directly, since this module is constructed before the
 * WhatsApp socket exists and would otherwise form a require() cycle
 * with db.js (db.js needs normalizeChat/normalizeMessageRecord from here).
 */

const fs = require('fs');
const path = require('path');

let ROOT_DIR = null;
let CONFIG = null;
let io = null;
let database = null;
let sock = null;

const messageStore = {};
const groupStore = {};
const contactStore = {};
const chatStore = {};
const operatorReads = {};
const flaggedMessages = {};
// Maps @lid JIDs to their corresponding @s.whatsapp.net JID and vice-versa.
// WhatsApp's multi-device protocol uses opaque @lid identifiers internally;
// we track both directions so resolveContactName() works regardless of format.
const lidToJid = {};  // "hex123@lid" -> "91987...@s.whatsapp.net"
const jidToLid = {};  // "91987...@s.whatsapp.net" -> "hex123@lid"

let connectorOperatorId = null;
let connectorOperatorName = null;
let linkingOperator = null;

let saveTimer = null;
const pendingResolutions = new Set();
// Guards normalizeChat()'s catch-up merge (below) from re-scheduling a merge
// for the same @lid while one is already queued — without this, every
// broadcastChats() -> sortedChats() -> normalizeChat() pass would re-queue
// another merge + broadcast for any @lid chat still present, and each of
// those broadcasts triggers the same pass again, fanning out without bound.
const pendingLidMerges = new Set();
// LIDs that returned null from getPNForLID — maps lid -> timestamp of last failed attempt.
// Persisted to disk so restarts don't re-flood with retries for already-failed LIDs.
// In-memory: skipped for LID_RETRY_COOLDOWN_MS to avoid flooding on every render.
// On disk: all failures are kept permanently until the LID actually resolves.
const failedResolutions = new Map();
const LID_RETRY_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour between render-time retries
const LID_FAILED_CACHE_FILE = () => ROOT_DIR ? path.join(ROOT_DIR, 'data', 'failed_lids.json') : null;

function loadFailedResolutions() {
  const file = LID_FAILED_CACHE_FILE();
  if (!file) return;
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Load ALL past failures — don't filter by age.
      // This prevents flooding on restart. The background resolver will retry
      // them slowly over time; render-time retries are throttled by LID_RETRY_COOLDOWN_MS.
      let count = 0;
      for (const [lid, ts] of Object.entries(raw)) {
        failedResolutions.set(lid, ts);
        count++;
      }
      if (count > 0) {
        console.log(`[Bridge] Loaded ${count} previously-failed LID resolutions from disk (will retry slowly in background).`);
      }
    }
  } catch (e) {
    // Non-critical — ignore errors reading cache
  }
}

// Debounced + async: a burst of failing resolutions (all 145 unresolvable LIDs
// fail together during a sweep or a broadcast-triggered render pass) used to do
// one synchronous writeFileSync per failure. On a OneDrive-synced folder each
// write can block for a long time while the sync client holds the file, and the
// accumulated blocking starved the event loop - frozen dashboard, and Baileys'
// keepalive missed its window ("Connection was lost"). One deferred async write
// per burst instead.
let failedResolutionsSaveTimer = null;
function saveFailedResolutions() {
  if (failedResolutionsSaveTimer) return;
  failedResolutionsSaveTimer = setTimeout(() => {
    failedResolutionsSaveTimer = null;
    const file = LID_FAILED_CACHE_FILE();
    if (!file) return;
    try {
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const obj = {};
      for (const [lid, ts] of failedResolutions) obj[lid] = ts;
      fs.writeFile(file, JSON.stringify(obj), 'utf8', () => {});
    } catch (e) {
      // Non-critical
    }
  }, 2000);
}

function clearFailedResolutions() {
  failedResolutions.clear();
  saveFailedResolutions();
  console.log('[Bridge] Cleared failed LID resolutions cache.');
}
const DEFAULT_EDIT_WINDOW_SECONDS = 15 * 60;
const DEFAULT_DELETE_FOR_EVERYONE_WINDOW_SECONDS = 60 * 60 * 60;

const syncState = {
  syncingHistory: false,
  resolvingLids: false
};

function getSyncState() {
  return syncState;
}

function updateSyncState(updates) {
  Object.assign(syncState, updates);
  if (io) {
    io.emit('sync_status', syncState);
  }
}

function init({ rootDir, config }) {
  ROOT_DIR = rootDir;
  CONFIG = config;
  loadFailedResolutions();
}

function setIo(ioInstance) { io = ioInstance; }
function setDatabase(db) { database = db; }
function setSock(sockInstance) { sock = sockInstance; }
function getSock() { return sock; }

function getConnectorOperator() {
  return { id: connectorOperatorId, name: connectorOperatorName };
}
function setConnectorOperator(id, name) {
  connectorOperatorId = id;
  connectorOperatorName = name;
}
function getLinkingOperator() { return linkingOperator; }
function setLinkingOperator(operator) { linkingOperator = operator; }

function clearInMemoryStores() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  for (const key of Object.keys(messageStore)) delete messageStore[key];
  for (const key of Object.keys(groupStore)) delete groupStore[key];
  for (const key of Object.keys(contactStore)) delete contactStore[key];
  for (const key of Object.keys(chatStore)) delete chatStore[key];
  for (const key of Object.keys(lidToJid)) delete lidToJid[key];
  for (const key of Object.keys(jidToLid)) delete jidToLid[key];
}

function jidNormalizedUser(jid) {
  if (!jid) return jid;
  if (jid.includes('@')) {
    const [user, domain] = jid.split('@');
    const cleanUser = user.split(':')[0];
    return `${cleanUser}@${domain}`;
  }
  return jid.split(':')[0];
}

function addLidMapping(contact) {
  if (!contact) return;
  const id = contact.id;
  if (id) {
    let lid = null;
    let pn = null;
    if (id.endsWith('@lid') && contact.phoneNumber) {
      lid = id;
      pn = jidNormalizedUser(contact.phoneNumber);
    } else if (!id.endsWith('@lid') && contact.lid) {
      lid = contact.lid;
      pn = jidNormalizedUser(id);
    }

    if (lid && pn) {
      const isNewMapping = !lidToJid[lid];
      lidToJid[lid] = pn;
      jidToLid[pn] = lid;

      if (isNewMapping) {
        console.log(`[Bridge] Discovered mapping during session: ${lid} -> ${pn}`);
        // Merge chat/messages dynamically!
        setImmediate(() => {
          mergeLidChatToPhone(lid, pn);
          if (io) io.emit('chat_merged', { lid, jid: pn });
          broadcastChats();
        });
      }
    }
  }
}

function cleanJidToPhone(jid) {
  if (!jid) return '';
  if (jid.includes('@')) {
    const parts = jid.split('@');
    const domain = parts[1];
    if (domain === 's.whatsapp.net' || domain === 'lid') {
      const num = parts[0].split(':')[0];
      return num.startsWith('+') ? num : '+' + num;
    }
    return parts[0];
  }
  if (jid.includes(':')) {
    const num = jid.split(':')[0];
    return num.startsWith('+') ? num : '+' + num;
  }
  return jid.startsWith('+') ? jid : '+' + jid;
}

function toTimestamp(ts) {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string' && ts.trim()) return Number(ts) || 0;
  if (typeof ts === 'object' && 'low' in ts) return ts.low + ts.high * 4294967296;
  return 0;
}

async function resolveLidToPhoneAsync(lid, options = {}) {
  const { silent = false, deferSave = false } = options;
  if (!lid || !lid.endsWith('@lid')) return null;
  if (lidToJid[lid]) return lidToJid[lid];
  if (!sock || !sock.user) return null;
  if (pendingResolutions.has(lid)) return null;

  // Skip LIDs that recently failed to avoid flooding on every render
  const lastFailed = failedResolutions.get(lid);
  if (lastFailed && (Date.now() - lastFailed) < LID_RETRY_COOLDOWN_MS) return null;

  pendingResolutions.add(lid);
  console.log(`[Bridge] Starting resolution for LID: ${lid}`);

  const markFailed = () => {
    failedResolutions.set(lid, Date.now());
    if (!deferSave) saveFailedResolutions();
  };

  try {
    if (!sock.signalRepository) {
      console.log(`[Bridge] Cannot resolve LID ${lid}: sock.signalRepository is undefined.`);
      markFailed();
      return null;
    }
    if (!sock.signalRepository.lidMapping) {
      console.log(`[Bridge] Cannot resolve LID ${lid}: sock.signalRepository.lidMapping is undefined.`);
      markFailed();
      return null;
    }

    const pnRaw = await sock.signalRepository.lidMapping.getPNForLID(lid);
    if (pnRaw) {
      const pn = jidNormalizedUser(pnRaw);
      console.log(`[Bridge] Resolved LID ${lid} -> PN ${pn}`);
      lidToJid[lid] = pn;
      jidToLid[pn] = lid;
      failedResolutions.delete(lid); // clear any previous failure record

      // Persist to contacts
      const existing = contactStore[lid] || { id: lid };
      existing.phoneNumber = pn;
      contactStore[lid] = existing;
      database.upsertContact(existing);

      const existingPn = contactStore[pn] || { id: pn };
      existingPn.lid = lid;
      contactStore[pn] = existingPn;
      database.upsertContact(existingPn);

      // Merge LID chat and messages into PN chat
      mergeLidChatToPhone(lid, pn);

      // A bulk sweep (resolveAllLidsFromStore) resolves many LIDs back to
      // back - broadcasting the full chat list (every chat, every connected
      // socket) after each individual one made the server unresponsive for
      // the whole duration of the sweep. Callers doing bulk work pass
      // silent:true and broadcast once themselves when the sweep finishes.
      if (!silent) {
        if (io) io.emit('chat_merged', { lid, jid: pn });
        broadcastChats();
      }

      return pn;
    } else {
      // Cache the failure so we don't retry for LID_RETRY_COOLDOWN_MS
      markFailed();
    }
  } catch (e) {
    console.warn(`[Bridge] Error resolving LID ${lid}:`, e.message);
    markFailed();
  } finally {
    pendingResolutions.delete(lid);
  }

  return null;
}

function mergeLidChatToPhone(lid, pn) {
  if (!lid || !pn) return;
  console.log(`[Bridge] Merging LID chat ${lid} into phone chat ${pn}`);

  // 1. Merge chats in memory & database
  if (chatStore[lid]) {
    const lidChat = chatStore[lid];
    if (chatStore[pn]) {
      // Merge unread count and keep the more recent timestamp
      chatStore[pn].unreadCount += lidChat.unreadCount;
      if (lidChat.timestamp > chatStore[pn].timestamp) {
        chatStore[pn].timestamp = lidChat.timestamp;
        chatStore[pn].lastMsg = lidChat.lastMsg;
      }
      database.upsertChat(chatStore[pn]);
    } else {
      // Rename chat
      lidChat.id = pn;
      lidChat.phone = pn.split('@')[0].split(':')[0];
      chatStore[pn] = lidChat;
      database.upsertChat(lidChat);
    }
    delete chatStore[lid];
    try {
      database.db.prepare('DELETE FROM chats WHERE id = ?').run(lid);
    } catch (err) {
      console.warn('[Bridge] Error deleting chat from database:', err.message);
    }
  }

  // 2. Merge messages in memory
  if (messageStore[lid]) {
    if (!messageStore[pn]) messageStore[pn] = [];
    const combined = [...messageStore[pn], ...messageStore[lid]];
    const unique = [];
    const seen = new Set();
    for (const msg of combined) {
      if (!seen.has(msg.id)) {
        seen.add(msg.id);
        msg.jid = pn;
        if (msg.from === lid) msg.from = pn;
        unique.push(msg);
      }
    }
    messageStore[pn] = unique.sort((a, b) => toTimestamp(a.timestamp) - toTimestamp(b.timestamp));
    delete messageStore[lid];
  }

  // 3. Update database messages
  try {
    const sql = `
      UPDATE messages 
      SET jid = ?, 
          payload = json_set(
            json_set(payload, '$.jid', ?),
            '$.from', 
            CASE WHEN json_extract(payload, '$.from') = ? THEN ? ELSE json_extract(payload, '$.from') END
          )
      WHERE jid = ?
    `;
    database.db.prepare(sql).run(pn, pn, lid, pn, lid);
  } catch (err) {
    console.warn('[Bridge] Error migrating database messages:', err.message);
  }
}

async function resolveAllLidsFromStore() {
  if (!sock || !sock.user) return;
  // Reconnect and history-sync-completion can both trigger this close
  // together; without this guard they'd run two full sweeps over the same
  // backlog concurrently.
  if (syncState.resolvingLids) return;
  updateSyncState({ resolvingLids: true });
  try {
    const now = Date.now();
    const lidsToTry = new Set();

    for (const jid of Object.keys(chatStore)) {
      if (jid.endsWith('@lid') && !lidToJid[jid]) lidsToTry.add(jid);
    }
    for (const jid of Object.keys(contactStore)) {
      if (jid.endsWith('@lid') && !lidToJid[jid]) lidsToTry.add(jid);
    }

    // Separate into: never tried vs recently failed (skip) vs old failures (retry quietly)
    const fresh = [];
    const stale = [];
    for (const jid of lidsToTry) {
      const lastFailed = failedResolutions.get(jid);
      if (!lastFailed) {
        fresh.push(jid); // never tried
      } else if (now - lastFailed > LID_RETRY_COOLDOWN_MS) {
        stale.push(jid); // failed before but worth a quiet retry
      }
      // else: failed recently, skip entirely
    }

    const skipped = lidsToTry.size - fresh.length - stale.length;
    console.log(`[Bridge] Background LID resolution: ${fresh.length} new, ${stale.length} retry, ${skipped} skipped (recently failed)`);

    let resolvedCount = 0;
    for (const jid of [...fresh, ...stale]) {
      if (!sock || !sock.user) break;
      // getPNForLID is a local lookup against Baileys' own auth-state cache,
      // not a network call - there's no rate limit to respect here. silent
      // skips the per-item full chat-list broadcast (see resolveLidToPhoneAsync)
      // and deferSave skips the per-item disk write; both are done once below
      // instead. The 500ms-per-item delay this used to have meant a backlog of
      // ~100+ LIDs made the server unresponsive for over a minute on every
      // reconnect. setImmediate (unlike await Promise.resolve(), which only
      // drains microtasks) genuinely yields to pending IO/timers between
      // iterations, so cache-hit runs can't starve the event loop.
      const pn = await resolveLidToPhoneAsync(jid, { silent: true, deferSave: true });
      if (pn) resolvedCount++;
      await new Promise((resolve) => setImmediate(resolve));
    }
    saveFailedResolutions();
    if (resolvedCount > 0) broadcastChats();

    if (resolvedCount > 0) {
      console.log(`[Bridge] Background resolution finished. Resolved ${resolvedCount} LIDs to phone numbers.`);
      backfillContactNames();
    } else if (fresh.length + stale.length > 0) {
      console.log('[Bridge] Background LID resolution finished. No new LIDs resolved.');
    }
  } finally {
    updateSyncState({ resolvingLids: false });
  }
}

function normalizeChat(chat = {}, operatorId = null) {
  let phone = null;
  const id = chat.id;
  if (id) {
    if (id.endsWith('@s.whatsapp.net')) {
      phone = id.split('@')[0].split(':')[0];
    } else if (id.endsWith('@lid')) {
      const phoneJid = lidToJid[id];
      if (phoneJid) {
        phone = phoneJid.split('@')[0].split(':')[0];
        // Catch-up merge: a mapping exists but this chat is still stored under
        // the LID (e.g. loaded from disk before the mapping was learned).
        // Guarded so repeated normalizeChat() calls for the same @lid (which
        // happen constantly via sortedChats/broadcastChats) don't each queue
        // their own merge+broadcast.
        if (chatStore[id] && !pendingLidMerges.has(id)) {
          pendingLidMerges.add(id);
          setImmediate(() => {
            pendingLidMerges.delete(id);
            if (chatStore[id]) {
              mergeLidChatToPhone(id, phoneJid);
              if (io) io.emit('chat_merged', { lid: id, jid: phoneJid });
              broadcastChats();
            }
          });
        }
      } else {
        // Trigger background resolution!
        resolveLidToPhoneAsync(id).then((pn) => {
          if (pn) backfillContactNames();
        });
      }
    }
  }

  // Resolve verifiedName from contactStore if not already set on chat
  let verifiedName = chat.verifiedName || null;
  if (id && !verifiedName) {
    const contact = contactStore[id];
    if (contact?.verifiedName) {
      verifiedName = contact.verifiedName;
    }
  }

  // Refresh name if it's currently numeric/ambiguous or missing
  let currentName = chat.name;
  const isAmbiguous = !currentName || /^\+?\d+$/.test(currentName) || currentName.includes('@');
  if (isAmbiguous && id) {
    currentName = chatDisplayName(id);
  }

  const isGroup = chat.type === 'group' || chat.type === 'community' || (id && id.endsWith('@g.us'));
  let participants = chat.participants || [];
  if (isGroup && id && groupStore[id]) {
    participants = (groupStore[id].participants || []).map(p => {
      let resolvedId = p.id;
      if (p.id && p.id.endsWith('@lid')) {
        const phoneJid = lidToJid[p.id];
        if (phoneJid) {
          resolvedId = phoneJid;
        } else {
          resolveLidToPhoneAsync(p.id);
        }
      }
      return {
        ...p,
        id: resolvedId
      };
    });
  }

  const finalUnreadCount = operatorId && id ? getUnreadCountForOperator(id, operatorId) : Number(chat.unreadCount || 0);

  return {
    ...chat,
    phone: phone || chat.phone || null,
    unreadCount: finalUnreadCount,
    timestamp: toTimestamp(chat.timestamp),
    lastMsg: chat.lastMsg || '',
    name: currentName,
    verifiedName: verifiedName,
    assignedOperatorId: chat.assignedOperatorId || null,
    assignedOperatorName: chat.assignedOperatorName || null,
    assignedAt: chat.assignedAt || null,
    participants: participants,
  };
}

function normalizeMessageRecord(msg = {}) {
  const participantJid = msg.participant || msg.sender;
  let resolvedSender = msg.sender;
  if (participantJid) {
    resolvedSender = resolveContactName(participantJid) || msg.sender;
    if (!resolvedSender || resolvedSender === participantJid || resolvedSender.endsWith('@lid') || resolvedSender.endsWith('@s.whatsapp.net') || resolvedSender.includes(':')) {
      if (participantJid.endsWith('@lid')) {
        const phoneJid = lidToJid[participantJid];
        if (phoneJid) {
          resolvedSender = resolveContactName(phoneJid) || cleanJidToPhone(phoneJid);
        } else {
          // Trigger background resolution!
          resolveLidToPhoneAsync(participantJid);
        }
      } else if (participantJid.endsWith('@s.whatsapp.net')) {
        const lidJid = jidToLid[participantJid];
        if (lidJid) {
          resolvedSender = resolveContactName(lidJid);
        }
        if (!resolvedSender) {
          resolvedSender = cleanJidToPhone(participantJid);
        }
      }
    }
  }
  if (resolvedSender && (resolvedSender.endsWith('@lid') || resolvedSender.endsWith('@s.whatsapp.net') || resolvedSender.includes(':') || /^\+?\d+$/.test(resolvedSender))) {
    resolvedSender = cleanJidToPhone(resolvedSender);
  }

  const flag = flaggedMessages[msg.id];
  return {
    ...msg,
    id: msg.id,
    from: msg.from || msg.jid,
    jid: msg.from || msg.jid,
    fromMe: Boolean(msg.fromMe),
    participant: msg.participant || null,
    sender: resolvedSender || msg.sender || null,
    operatorId: msg.operatorId || null,
    operatorName: msg.operatorName || null,
    content: msg.content || '',
    mediaType: msg.mediaType || 'text',
    mediaUrl: msg.mediaUrl || null,
    fileName: msg.fileName || null,
    mimetype: msg.mimetype || null,
    timestamp: toTimestamp(msg.timestamp),
    isGroup: Boolean(msg.isGroup),
    editedAt: msg.editedAt ? toTimestamp(msg.editedAt) : null,
    deleted: Boolean(msg.deleted),
    clientTempId: msg.clientTempId || null,
    quotedMessageId: msg.quotedMessageId || null,
    quotedContent: msg.quotedContent || null,
    quotedSender: msg.quotedSender || null,
    quotedMediaType: msg.quotedMediaType || null,
    status: msg.status !== undefined ? msg.status : null,
    edits: msg.edits ? [...msg.edits] : [],
    raw: msg.raw || null,
    isFlagged: Boolean(flag),
    flaggedByOperatorId: flag ? flag.flaggedByOperatorId : null,
    flaggedByOperatorName: flag ? flag.flaggedByOperatorName : null,
    flaggedNote: flag ? flag.note : null,
    flaggedAt: flag ? flag.flaggedAt : null,
  };
}

function unwrapMessage(message) {
  if (!message) return null;
  if (message.ephemeralMessage?.message) {
    return unwrapMessage(message.ephemeralMessage.message);
  }
  if (message.viewOnceMessage?.message) {
    return unwrapMessage(message.viewOnceMessage.message);
  }
  if (message.viewOnceMessageV2?.message) {
    return unwrapMessage(message.viewOnceMessageV2.message);
  }
  if (message.viewOnceMessageV2Extension?.message) {
    return unwrapMessage(message.viewOnceMessageV2Extension.message);
  }
  if (message.documentWithCaptionMessage?.message) {
    return unwrapMessage(message.documentWithCaptionMessage.message);
  }
  return message;
}

function parseInteractiveMessageText(m) {
  if (!m) return '';

  if (m.buttonsMessage) {
    let txt = m.buttonsMessage.contentText || '';
    const btns = (m.buttonsMessage.buttons || []).map(b => `[${b.buttonText?.displayText || ''}]`).join(' ');
    if (btns) txt += `\n\n${btns}`;
    return txt;
  }

  if (m.templateMessage) {
    let txt = m.templateMessage.hydratedTemplate?.hydratedContentText || '';
    const btns = (m.templateMessage.hydratedTemplate?.hydratedButtons || []).map(b => {
      const t = b.quickReplyButton?.displayText || b.urlButton?.displayText || b.callButton?.displayText || '';
      return t ? `[${t}]` : '';
    }).filter(Boolean).join(' ');
    if (btns) txt += `\n\n${btns}`;
    return txt;
  }

  if (m.interactiveMessage) {
    let txt = m.interactiveMessage.body?.text || '';
    let btnList = [];
    if (m.interactiveMessage.nativeFlowMessage?.buttons) {
      for (const btn of m.interactiveMessage.nativeFlowMessage.buttons) {
        try {
          const params = typeof btn.buttonParamsJson === 'string' ? JSON.parse(btn.buttonParamsJson) : btn.buttonParamsJson;
          const label = params?.display_text || btn.name;
          if (label) btnList.push(`[${label}]`);
        } catch {}
      }
    }
    if (btnList.length > 0) txt += `\n\n${btnList.join(' ')}`;
    return txt;
  }

  if (m.listMessage) {
    let txt = m.listMessage.description || m.listMessage.title || '';
    if (m.listMessage.buttonText) {
      txt += `\n\n[Menu: ${m.listMessage.buttonText}]`;
    }
    return txt;
  }

  if (m.highlyStructuredMessage) {
    // hydratedHsm carries the same shape as templateMessage.
    return parseInteractiveMessageText({ templateMessage: m.highlyStructuredMessage.hydratedHsm });
  }

  if (m.templateButtonReplyMessage) {
    return m.templateButtonReplyMessage.selectedDisplayText || m.templateButtonReplyMessage.selectedId || '';
  }

  return '';
}

function loadStore() {
  try {
    const STORE_FILE = path.join(ROOT_DIR, 'store.json');
    const counts = database.counts();
    if (!counts.contacts && !counts.chats && !counts.messages && fs.existsSync(STORE_FILE)) {
      database.importLegacyStore(STORE_FILE);
      console.log('[Bridge] Migrated legacy store.json into SQLite');
    }

    // Load operator reads
    try {
      const reads = database.getAllOperatorReadPointers();
      for (const row of reads) {
        if (!operatorReads[row.operator_id]) {
          operatorReads[row.operator_id] = {};
        }
        operatorReads[row.operator_id][row.chat_id] = {
          messageId: row.last_read_message_id,
          timestamp: row.last_read_timestamp
        };
      }
    } catch (e) {
      console.error('[Bridge] Failed to load operator reads:', e.message);
    }

    // Load flagged messages
    try {
      const flags = database.getAllFlaggedMessages();
      for (const row of flags) {
        flaggedMessages[row.message_id] = {
          messageId: row.message_id,
          jid: row.jid,
          flaggedByOperatorId: row.flagged_by_operator_id,
          flaggedByOperatorName: row.flagged_by_operator_name,
          note: row.note,
          flaggedAt: row.flagged_at
        };
      }
    } catch (e) {
      console.error('[Bridge] Failed to load flagged messages:', e.message);
    }

    const state = database.loadState();
    for (const contact of state.contacts) {
      if (contact?.id) {
        contactStore[contact.id] = contact;
        // Rebuild @lid <-> phone JID cross-reference from persisted contacts.
        addLidMapping(contact);
      }
    }
    for (const chat of state.chats) {
      if (chat?.id) chatStore[chat.id] = normalizeChat(chat);
    }
    for (const msg of state.messages) {
      if (!msg?.jid) continue;
      if (!messageStore[msg.jid]) messageStore[msg.jid] = [];
      // Same reasoning as addMessageToStore: raw stays in SQLite, not resident
      // in memory for every message across every chat loaded at boot.
      msg.raw = null;
      messageStore[msg.jid].push(msg);
    }
    // Baileys' chat-metadata sync never carries message text, so a chat's
    // lastMsg is otherwise only set when a *new* message event touches it
    // this session. Chats with plenty of history already in messageStore
    // (loaded just above) but no new activity since boot would otherwise
    // show a blank preview forever. allMessagesStmt orders by jid, timestamp,
    // so each messageStore[jid] here is already ascending - last entry is the
    // true latest.
    for (const jid of Object.keys(messageStore)) {
      syncChatPreviewFromLastMessage(jid);
    }
    connectorOperatorId = database.getMetadata('connector_operator_id');
    connectorOperatorName = database.getMetadata('connector_operator_name');
    migrateChatTypes();

    const storedOwnJid = database.getMetadata('current_logged_jid');
    if (storedOwnJid) {
      cleanupOwnNameFromContacts(storedOwnJid, 'Jafar Beldar');
    }

    // Merge any existing LID chats/messages that already have resolved PNs
    for (const lid of Object.keys(lidToJid)) {
      const pn = lidToJid[lid];
      if (pn && (chatStore[lid] || messageStore[lid])) {
        mergeLidChatToPhone(lid, pn);
      }
    }

    console.log(
      `[Bridge] Loaded SQLite store: ${Object.keys(chatStore).length} chats, ${Object.keys(contactStore).length} contacts, ${Object.keys(messageStore).length} message threads, ${Object.keys(lidToJid).length} lid mappings`
    );
    if (connectorOperatorId) {
      console.log(`[Bridge] Loaded connector operator: ${connectorOperatorName} (${connectorOperatorId})`);
    }
  } catch (e) {
    console.error('[Bridge] Failed to load store:', e.message);
  }
}

function sortedChats(operatorId = null) {
  const chats = Object.values(chatStore).map(chat => normalizeChat(chat, operatorId));
  const filtered = [];
  const seenPhoneJids = new Set();

  for (const chat of chats) {
    if (chat.id && !chat.id.endsWith('@lid')) {
      filtered.push(chat);
      if (chat.id.endsWith('@s.whatsapp.net')) {
        seenPhoneJids.add(chat.id);
      }
    }
  }

  for (const chat of chats) {
    if (chat.id && chat.id.endsWith('@lid')) {
      const phoneJid = lidToJid[chat.id];
      if (!phoneJid || !seenPhoneJids.has(phoneJid)) {
        filtered.push(chat);
      }
    }
  }

  return filtered.sort((a, b) => toTimestamp(b.timestamp) - toTimestamp(a.timestamp));
}

function resolveContactName(jid) {
  // Direct lookup first.
  let contact = contactStore[jid];
  if (contact?.name || contact?.verifiedName || contact?.notify) {
    return contact.name || contact.verifiedName || contact.notify;
  }
  // Cross-reference: if jid is a @lid, look up the mapped phone JID.
  const mappedJid = lidToJid[jid];
  if (mappedJid) {
    contact = contactStore[mappedJid];
    if (contact?.name || contact?.verifiedName || contact?.notify) {
      return contact.name || contact.verifiedName || contact.notify;
    }
  }
  // Cross-reference: if jid is a phone JID, check if the @lid alias has a name.
  const mappedLid = jidToLid[jid];
  if (mappedLid) {
    contact = contactStore[mappedLid];
    if (contact?.name || contact?.verifiedName || contact?.notify) {
      return contact.name || contact.verifiedName || contact.notify;
    }
  }
  return null;
}

function cleanupOwnNameFromContacts(ownPhone, ownName) {
  const ownPhoneClean = ownPhone ? cleanJidToPhone(ownPhone).replace(/^\+/, '') : '917262067842';
  const ownNames = new Set([ownName, 'Jafar Beldar'].filter(Boolean));
  console.log(`[Bridge] Cleaning up incorrect notify/name entries matching:`, Array.from(ownNames), `(ownPhone: ${ownPhoneClean})`);
  let updated = false;

  for (const [jid, contact] of Object.entries(contactStore)) {
    const contactPhoneClean = cleanJidToPhone(jid).replace(/^\+/, '');
    const isSelf = contactPhoneClean === ownPhoneClean;
    
    if (!isSelf) {
      let contactUpdated = false;
      if (ownNames.has(contact.notify)) {
        delete contact.notify;
        contactUpdated = true;
      }
      if (ownNames.has(contact.name)) {
        delete contact.name;
        contactUpdated = true;
      }
      if (contactUpdated) {
        database.upsertContact(contact);
        updated = true;
      }
    }
  }

  for (const [jid, chat] of Object.entries(chatStore)) {
    const chatPhoneClean = cleanJidToPhone(jid).replace(/^\+/, '');
    const isSelf = chatPhoneClean === ownPhoneClean;
    
    if (!isSelf && ownNames.has(chat.name)) {
      chat.name = null;
      const correctName = resolveContactName(jid) || chatDisplayName(jid);
      chat.name = correctName;
      database.upsertChat(chat);
      updated = true;
    }
  }

  if (updated) {
    console.log('[Bridge] Finished cleaning up incorrect names. Broadcasting updated chats.');
    broadcastChats();
    saveStore();
  }
}

// One-directional version of getPreferredJid for writing incoming chat data:
// redirects an already-resolved @lid to its phone JID, but never redirects a
// phone JID back to a @lid (unlike getPreferredJid, which does that for
// message-routing purposes). Using getPreferredJid here would let a stale
// @lid-keyed chatStore entry hijack a fresh phone-JID chat update, since
// getPreferredJid returns the @lid whenever chatStore[lidJid] exists and
// chatStore[phoneJid] hasn't been created yet.
function resolveChatStorageId(jid) {
  if (!jid) return jid;
  if (jid.endsWith('@lid')) {
    const phoneJid = lidToJid[jid];
    if (phoneJid) return phoneJid;
    resolveLidToPhoneAsync(jid);
  }
  return jid;
}

function getPreferredJid(jid) {
  if (!jid) return jid;
  if (jid.endsWith('@lid')) {
    const phoneJid = lidToJid[jid];
    if (phoneJid) return phoneJid;
    else {
      // Trigger background resolution!
      resolveLidToPhoneAsync(jid);
    }
  } else {
    const lidJid = jidToLid[jid];
    if (lidJid && chatStore[lidJid] && !chatStore[jid]) {
      return lidJid;
    }
  }
  return jid;
}

function getChatType(jid) {
  if (!jid) return 'personal';
  if (jid.endsWith('@g.us')) {
    const groupMeta = groupStore[jid];
    if (groupMeta?.isCommunity || groupMeta?.isCommunityAnnounce) {
      return 'community';
    }
    return 'group';
  }
  if (jid.endsWith('@newsletter')) return 'channel';
  if (jid.endsWith('@broadcast')) return 'status';
  return 'personal';
}

function migrateChatTypes() {
  let updated = false;
  for (const [jid, chat] of Object.entries(chatStore)) {
    const correctType = getChatType(jid);
    if (chat.type !== correctType) {
      chat.type = correctType;
      database.upsertChat(chat);
      updated = true;
    }
  }
  if (updated) {
    console.log('[Bridge] Migrated/corrected types for some chats');
    broadcastChats();
  }
}

function getMessagesForJid(jid) {
  const altJid = jid.endsWith('@lid') ? lidToJid[jid] : jidToLid[jid];
  let msgs = messageStore[jid] || [];
  if (altJid && messageStore[altJid]) {
    const combined = [...msgs, ...messageStore[altJid]];
    const unique = [];
    const seen = new Set();
    for (const msg of combined) {
      if (!seen.has(msg.id)) {
        seen.add(msg.id);
        unique.push(msg);
      }
    }
    msgs = unique.sort((a, b) => toTimestamp(a.timestamp) - toTimestamp(b.timestamp));
  }
  return msgs;
}

function toUnixSeconds(ts) {
  const normalized = toTimestamp(ts);
  if (!normalized) return 0;
  // Defensive normalization: some producers may emit milliseconds.
  if (normalized > 100000000000) return Math.floor(normalized / 1000);
  return normalized;
}

function getThreadJids(jid) {
  if (!jid) return [];
  const preferred = getPreferredJid(jid) || jid;
  const altJid = preferred.endsWith('@lid') ? lidToJid[preferred] : jidToLid[preferred];
  return altJid ? [preferred, altJid] : [preferred];
}

function findMessageInThread(jid, messageId) {
  if (!jid || !messageId) return null;
  const threadJids = getThreadJids(jid);
  for (const threadJid of threadJids) {
    const msgs = messageStore[threadJid];
    if (!msgs) continue;
    const found = msgs.find((msg) => msg.id === messageId);
    if (found) return found;
  }
  return null;
}

function canEditMessage(jid, messageId, options = {}) {
  const msg = findMessageInThread(jid, messageId);
  const windowSeconds = Number(options.windowSeconds) || DEFAULT_EDIT_WINDOW_SECONDS;
  const nowSeconds = toUnixSeconds(options.nowSeconds || Math.floor(Date.now() / 1000));

  if (!msg) {
    return {
      ok: false,
      status: 404,
      code: 'MESSAGE_NOT_FOUND',
      message: 'Message not found',
      windowSeconds,
      remainingSeconds: 0,
    };
  }

  if (!msg.fromMe) {
    return {
      ok: false,
      status: 403,
      code: 'ONLY_SENT_MESSAGES_EDITABLE',
      message: 'Only your sent messages can be edited',
      windowSeconds,
      remainingSeconds: 0,
    };
  }

  if (msg.deleted) {
    return {
      ok: false,
      status: 409,
      code: 'MESSAGE_ALREADY_DELETED',
      message: 'Cannot edit a deleted message',
      windowSeconds,
      remainingSeconds: 0,
    };
  }

  if ((msg.mediaType || 'text') !== 'text') {
    return {
      ok: false,
      status: 400,
      code: 'ONLY_TEXT_MESSAGES_EDITABLE',
      message: 'Only text messages can be edited',
      windowSeconds,
      remainingSeconds: 0,
    };
  }

  const msgSeconds = toUnixSeconds(msg.timestamp);
  const ageSeconds = Math.max(0, nowSeconds - msgSeconds);
  const remainingSeconds = Math.max(0, windowSeconds - ageSeconds);
  if (!msgSeconds || ageSeconds > windowSeconds) {
    return {
      ok: false,
      status: 410,
      code: 'EDIT_WINDOW_EXPIRED',
      message: 'Edit window expired (15 minutes)',
      windowSeconds,
      remainingSeconds,
    };
  }

  return { ok: true, message: msg, windowSeconds, remainingSeconds };
}

function canDeleteForEveryone(jid, messageId, options = {}) {
  const msg = findMessageInThread(jid, messageId);
  const windowSeconds = Number(options.windowSeconds) || DEFAULT_DELETE_FOR_EVERYONE_WINDOW_SECONDS;
  const nowSeconds = toUnixSeconds(options.nowSeconds || Math.floor(Date.now() / 1000));

  if (!msg) {
    return {
      ok: false,
      status: 404,
      code: 'MESSAGE_NOT_FOUND',
      message: 'Message not found',
      windowSeconds,
      remainingSeconds: 0,
    };
  }

  if (!msg.fromMe) {
    return {
      ok: false,
      status: 403,
      code: 'ONLY_SENT_MESSAGES_DELETABLE',
      message: 'Only your sent messages can be deleted for everyone',
      windowSeconds,
      remainingSeconds: 0,
    };
  }

  if (msg.deleted) {
    return {
      ok: false,
      status: 409,
      code: 'MESSAGE_ALREADY_DELETED',
      message: 'Message is already deleted',
      windowSeconds,
      remainingSeconds: 0,
    };
  }

  const msgSeconds = toUnixSeconds(msg.timestamp);
  const ageSeconds = Math.max(0, nowSeconds - msgSeconds);
  const remainingSeconds = Math.max(0, windowSeconds - ageSeconds);
  if (!msgSeconds || ageSeconds > windowSeconds) {
    return {
      ok: false,
      status: 410,
      code: 'DELETE_WINDOW_EXPIRED',
      message: 'Delete for everyone window expired (60 hours)',
      windowSeconds,
      remainingSeconds,
    };
  }

  return { ok: true, message: msg, windowSeconds, remainingSeconds };
}

function backfillContactNames() {
  let updated = false;
  for (const [jid, chat] of Object.entries(chatStore)) {
    if (chat.type !== 'personal') continue;
    const name = resolveContactName(jid);
    if (name) {
      if (chat.name !== name) {
        chat.name = name;
        updated = true;
      }
    } else {
      const normalized = normalizeChat(chat);
      if (chat.name !== normalized.name || chat.phone !== normalized.phone) {
        chat.name = normalized.name;
        chat.phone = normalized.phone;
        updated = true;
      }
    }
  }
  if (updated) {
    io.emit('chats', sortedChats());
    saveStore();
  }
}

function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      for (const chat of Object.values(chatStore)) {
        chat.timestamp = toTimestamp(chat.timestamp);
      }
      for (const jid of Object.keys(messageStore)) {
        if (messageStore[jid].length > CONFIG.MAX_MESSAGES_PER_CHAT) {
          messageStore[jid] = messageStore[jid].slice(-CONFIG.MAX_MESSAGES_PER_CHAT);
        }
      }
      database.saveContacts(Object.values(contactStore).filter((contact) => contact?.id));
      database.saveChats(Object.values(chatStore).filter((chat) => chat?.id).map(normalizeChat));
    } catch (e) {
      console.error('[Bridge] Failed to save store:', e.message);
    }
  }, CONFIG.SAVE_DEBOUNCE_MS);
}

function addMessageToStore(msg, options = {}) {
  const normalized = normalizeMessageRecord(msg);
  const jid = normalized.jid;
  if (!jid || !normalized.id) return normalized;
  if (!messageStore[jid]) messageStore[jid] = [];
  const existingIndex = messageStore[jid].findIndex((item) => item.id === normalized.id);
  let finalMsg = normalized;
  if (existingIndex >= 0) {
    const existing = messageStore[jid][existingIndex];
    finalMsg = {
      ...normalized,
      operatorId: existing.operatorId || normalized.operatorId,
      operatorName: existing.operatorName || normalized.operatorName,
      edits: (existing.edits && existing.edits.length > 0) ? existing.edits : normalized.edits,
      clientTempId: existing.clientTempId || normalized.clientTempId,
    };
  }
  // finalMsg (with raw intact) is what gets persisted to the database, either
  // right here or - when skipDbWrite is set (bulk history sync) - later by
  // the caller collecting return values into its own array and calling
  // database.saveMessages(). Nulling raw on this same object before it was
  // returned meant history-synced messages (skipDbWrite path) never got their
  // raw payload written to the database at all - stripped before it ever
  // reached upsertMessage. The in-memory resident copy (messageStore[jid])
  // needs to stay lean (see reasoning below) but must be a separate object
  // from what's returned/persisted.
  if (!options.skipDbWrite) {
    database.upsertMessage(finalMsg);
  }
  // The full decrypted protobuf (raw) is already durably stored in SQLite
  // (above, or via the caller's deferred saveMessages). Keeping it live in
  // the in-memory messageStore too means every cached message (up to
  // MAX_MESSAGES_PER_CHAT per chat, across every chat ever loaded) carries
  // its full raw payload - thumbnails, media keys, etc. - resident in memory
  // indefinitely. With thousands of chats this was the dominant contributor
  // to multi-GB heap growth. Consumers that need raw (edit/delete-for-
  // everyone, media re-download) fall back to querying it from the database
  // when it's missing here.
  const memoryMsg = finalMsg.raw !== null ? { ...finalMsg, raw: null } : finalMsg;
  if (existingIndex >= 0) {
    messageStore[jid][existingIndex] = memoryMsg;
  } else {
    messageStore[jid].push(memoryMsg);
  }
  messageStore[jid].sort((a, b) => toTimestamp(a.timestamp) - toTimestamp(b.timestamp));
  // Skipped for on-demand history backfill ("load older messages"): trimming
  // to the most recent N here would discard the older messages immediately
  // after fetching them once a thread is already at the cap.
  if (!options.skipTrim && messageStore[jid].length > CONFIG.MAX_MESSAGES_PER_CHAT) {
    messageStore[jid] = messageStore[jid].slice(-CONFIG.MAX_MESSAGES_PER_CHAT);
  }
  return finalMsg;
}

function broadcastChats() {
  if (!io) return;
  for (const socket of io.sockets.sockets.values()) {
    const opId = socket.handshake?.query?.operatorId || 'default';
    socket.emit('chats', sortedChats(opId));
  }
}

function chatDisplayName(jid) {
  let resolvedName = resolveContactName(jid);

  // Format numeric fallback
  let phoneFallback = jid.split('@')[0];
  let isUnresolvedLid = false;
  if (jid.endsWith('@lid')) {
    const phoneJid = lidToJid[jid];
    if (phoneJid) {
      phoneFallback = phoneJid.split('@')[0];
    } else {
      isUnresolvedLid = true;
    }
  }
  const formattedPhone = '+' + phoneFallback.split(':')[0];

  if (resolvedName) {
    const isAmbiguous = !resolvedName || resolvedName.length <= 2 || /^\+?\d+$/.test(resolvedName);
    if (isAmbiguous && jid && !jid.endsWith('@g.us')) {
      if (isUnresolvedLid) {
        return `${resolvedName} (LID: ${phoneFallback})`;
      }
      return `${resolvedName} (${formattedPhone})`;
    }
    return resolvedName;
  }

  if (jid.endsWith('@s.whatsapp.net')) {
    return formattedPhone;
  }

  if (jid.endsWith('@lid')) {
    return `LID: ${phoneFallback}`;
  }

  return jid?.split('@')[0]?.split(':')[0] || jid;
}

function ensureChatExists(jid) {
  if (!chatStore[jid]) {
    chatStore[jid] = normalizeChat({
      id: jid,
      name: chatDisplayName(jid),
      type: getChatType(jid),
      unreadCount: 0,
      timestamp: 0,
      lastMsg: '',
    });
  }
  return chatStore[jid];
}

function isAssignableChat(jid) {
  return Boolean(jid) && !jid.endsWith('@g.us');
}

function assignChat(jid, operator, options = {}) {
  if (!isAssignableChat(jid)) return { ok: true, chat: ensureChatExists(jid) };
  if (!operator?.id) return { ok: false, status: 400, message: 'Operator identity missing' };
  const chat = ensureChatExists(jid);
  const alreadyOwnedByOther = chat.assignedOperatorId && chat.assignedOperatorId !== operator.id;
  if (alreadyOwnedByOther && !options.force) {
    return {
      ok: false,
      status: 409,
      message: `Conversation assigned to ${chat.assignedOperatorName || chat.assignedOperatorId}`,
      chat,
    };
  }
  chat.assignedOperatorId = operator.id;
  chat.assignedOperatorName = operator.name || operator.id;
  chat.assignedAt = new Date().toISOString();
  saveStore();
  broadcastChats();
  io.emit('assignment_updated', { jid, chat, action: 'assigned' });
  return { ok: true, chat };
}

function releaseChat(jid, operator, options = {}) {
  if (!isAssignableChat(jid)) return { ok: true, chat: ensureChatExists(jid) };
  const chat = chatStore[jid];
  if (!chat) return { ok: false, status: 404, message: 'Chat not found' };
  if (
    chat.assignedOperatorId &&
    operator?.id &&
    chat.assignedOperatorId !== operator.id &&
    !options.force
  ) {
    return {
      ok: false,
      status: 409,
      message: `Conversation assigned to ${chat.assignedOperatorName || chat.assignedOperatorId}`,
      chat,
    };
  }
  chat.assignedOperatorId = null;
  chat.assignedOperatorName = null;
  chat.assignedAt = null;
  saveStore();
  broadcastChats();
  io.emit('assignment_updated', { jid, chat, action: 'released' });
  return { ok: true, chat };
}

function ensureChatLockForOperator(jid, operator) {
  if (!isAssignableChat(jid)) return { ok: true, chat: ensureChatExists(jid) };
  const chat = ensureChatExists(jid);
  if (!chat.assignedOperatorId) return assignChat(jid, operator);
  if (chat.assignedOperatorId !== operator?.id) {
    return {
      ok: false,
      status: 409,
      message: `Conversation assigned to ${chat.assignedOperatorName || chat.assignedOperatorId}`,
      chat,
    };
  }
  return { ok: true, chat };
}

function updateChatPreview(jid, lastMsg, timestamp, fromMe = true, status = null) {
  const chat = ensureChatExists(jid);
  const resolved = resolveContactName(jid);
  if (resolved) {
    chat.name = resolved;
  }
  chat.lastMsg = lastMsg || '';
  chat.timestamp = toTimestamp(timestamp);
  chat.unreadCount = 0;
  // WhatsApp only shows delivery/read ticks on the chat-list preview for
  // messages we sent, never for ones we received.
  chat.lastMsgFromMe = Boolean(fromMe);
  chat.lastMsgStatus = fromMe ? (status ?? null) : null;

  // Also clear unread count for alternate LID/JID mapping if it exists
  const altJid = jid.endsWith('@lid') ? lidToJid[jid] : jidToLid[jid];
  if (altJid && chatStore[altJid]) {
    chatStore[altJid].unreadCount = 0;
  }

  return chat;
}

// Refreshes a chat's list-preview fields (text, timestamp, sent/read ticks)
// from the actual latest message in messageStore, rather than leaving them
// however Baileys' bare chat-metadata sync left them (which carries no
// message text at all). messageStore[jid] is kept fully sorted ascending by
// addMessageToStore, so the last entry is always the true latest known
// message for that thread regardless of which sync batch touched it.
function syncChatPreviewFromLastMessage(jid) {
  const msgs = messageStore[jid];
  if (!msgs || msgs.length === 0) return;
  const last = msgs[msgs.length - 1];
  const chat = ensureChatExists(jid);
  chat.lastMsg = last.content || '';
  chat.timestamp = toTimestamp(last.timestamp);
  chat.lastMsgFromMe = Boolean(last.fromMe);
  chat.lastMsgStatus = last.fromMe ? (last.status ?? null) : null;
  database.upsertChat(chat);
}

async function recordOutboundMessage({ jid, operator, result, message }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const sentMsg = addMessageToStore({
    id: result?.key?.id || `sent-${Date.now()}`,
    from: jid,
    jid,
    fromMe: true,
    participant: null,
    sender: operator?.name || operator?.id || 'Unknown',
    operatorId: operator?.id || null,
    operatorName: operator?.name || operator?.id || null,
    content: message.content || '',
    mediaType: message.mediaType || 'text',
    mediaUrl: message.mediaUrl || null,
    fileName: message.fileName || null,
    mimetype: message.mimetype || null,
    timestamp,
    isGroup: jid?.endsWith('@g.us'),
    editedAt: null,
    deleted: false,
    clientTempId: message.clientTempId || null,
    quotedMessageId: message.quotedMessageId || null,
    quotedContent: message.quotedContent || null,
    quotedSender: message.quotedSender || null,
    quotedMediaType: message.quotedMediaType || null,
    status: result?.status !== undefined ? result.status : 1,
    raw: result?.message || null,
  });
  updateChatPreview(jid, sentMsg.content, timestamp, true, sentMsg.status);
  saveStore();
  broadcastChats();
  io.emit('message', sentMsg);
  return sentMsg;
}

function sendLockError(target, result) {
  const payload = {
    message: result.message,
    jid: target?.jid || null,
    assignedOperatorId: result.chat?.assignedOperatorId || null,
    assignedOperatorName: result.chat?.assignedOperatorName || null,
  };
  if (typeof target?.emit === 'function') target.emit('error', payload);
  return payload;
}

// --- Operator Reads ---
function setOperatorReadPointer(operatorId, chatId, messageId, timestamp) {
  if (!operatorId || !chatId) return;
  if (!operatorReads[operatorId]) {
    operatorReads[operatorId] = {};
  }
  operatorReads[operatorId][chatId] = { messageId, timestamp };
  database.setOperatorReadPointer(operatorId, chatId, messageId, timestamp);
}

function getOperatorReadPointer(operatorId, chatId) {
  if (operatorReads[operatorId] && operatorReads[operatorId][chatId]) {
    return operatorReads[operatorId][chatId];
  }
  return null;
}

// --- Message Flagging ---
function flagMessage(messageId, jid, operatorId, operatorName, note, timestamp) {
  flaggedMessages[messageId] = {
    messageId,
    jid,
    flaggedByOperatorId: operatorId,
    flaggedByOperatorName: operatorName,
    note,
    flaggedAt: timestamp
  };
  database.flagMessage(messageId, jid, operatorId, operatorName, note, timestamp);
}

function unflagMessage(messageId) {
  delete flaggedMessages[messageId];
  database.unflagMessage(messageId);
}

function getFlaggedMessages() {
  // The stored flag record only ever held metadata (who flagged it, when,
  // any note) - never the message itself - so the panel had nothing to show
  // but the raw messageId. Look the actual message up for display, falling
  // back to the database in case it's aged out of the in-memory cache.
  return Object.values(flaggedMessages)
    .sort((a, b) => b.flaggedAt - a.flaggedAt)
    .map((flag) => {
      let msg = findMessageInThread(flag.jid, flag.messageId);
      if (!msg) {
        try {
          const row = database.db.prepare('SELECT payload FROM messages WHERE id = ?').get(flag.messageId);
          if (row) msg = JSON.parse(row.payload);
        } catch (e) {
          // Non-critical - fall through with whatever we have.
        }
      }
      return {
        ...flag,
        content: msg?.content || null,
        mediaType: msg?.mediaType || null,
        sender: msg?.sender || null,
        deleted: Boolean(msg?.deleted),
      };
    });
}

function getMessageFlag(messageId) {
  return flaggedMessages[messageId] || null;
}

function getUnreadCountForOperator(chatId, operatorId) {
  const chat = chatStore[chatId];
  if (!chat) return 0;

  const preferredJid = getPreferredJid(chatId) || chatId;
  const threadJids = getThreadJids(preferredJid);

  let lastReadTimestamp = -1;
  let hasPointer = false;

  for (const jid of threadJids) {
    if (operatorReads[operatorId] && operatorReads[operatorId][jid]) {
      const ptr = operatorReads[operatorId][jid];
      if (ptr.timestamp > lastReadTimestamp) {
        lastReadTimestamp = ptr.timestamp;
        hasPointer = true;
      }
    }
  }

  if (!hasPointer) {
    return Number(chat.unreadCount || 0);
  }

  // Query database for the exact count
  let totalUnread = 0;
  for (const jid of threadJids) {
    totalUnread += database.getUnreadCountForOperator(jid, lastReadTimestamp);
  }
  return totalUnread;
}

module.exports = {
  setOperatorReadPointer,
  getOperatorReadPointer,
  flagMessage,
  unflagMessage,
  getFlaggedMessages,
  getMessageFlag,
  getUnreadCountForOperator,
  init,
  setIo,
  setDatabase,
  setSock,
  getSock,
  getConnectorOperator,
  setConnectorOperator,
  getLinkingOperator,
  setLinkingOperator,

  messageStore,
  groupStore,
  contactStore,
  chatStore,
  lidToJid,
  jidToLid,
  operatorReads,

  clearInMemoryStores,
  addLidMapping,
  cleanJidToPhone,
  toTimestamp,
  resolveLidToPhoneAsync,
  resolveAllLidsFromStore,
  clearFailedResolutions,
  canEditMessage,
  canDeleteForEveryone,
  findMessageInThread,
  normalizeChat,
  normalizeMessageRecord,
  unwrapMessage,
  parseInteractiveMessageText,
  loadStore,
  sortedChats,
  resolveContactName,
  cleanupOwnNameFromContacts,
  getPreferredJid,
  resolveChatStorageId,
  getChatType,
  migrateChatTypes,
  getMessagesForJid,
  backfillContactNames,
  saveStore,
  addMessageToStore,
  broadcastChats,
  chatDisplayName,
  ensureChatExists,
  isAssignableChat,
  assignChat,
  releaseChat,
  ensureChatLockForOperator,
  updateChatPreview,
  syncChatPreviewFromLastMessage,
  recordOutboundMessage,
  sendLockError,
  getSyncState,
  updateSyncState,
  getThreadJids,
};
