/**
 * SQLite persistence layer for the relay (contacts, chats, messages, metadata).
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

class RelayDatabase {
  // `normalizers` is injected (not required directly) to avoid a require() cycle
  // with stores.js, which itself depends on the database instance.
  constructor(dbPath, rootDir, config, normalizers) {
    this.rootDir = rootDir;
    this.config = config;
    this.normalizeChat = normalizers.normalizeChat;
    this.normalizeMessageRecord = normalizers.normalizeMessageRecord;
    this.toTimestamp = normalizers.toTimestamp;

    this.dbPath = dbPath;
    const absolute = path.isAbsolute(dbPath) ? dbPath : path.join(rootDir, dbPath);
    const dir = path.dirname(absolute);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(absolute);
    console.log(`[Bridge] Using SQLite database: ${absolute}`);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.init();
    this.prepare();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        name TEXT,
        type TEXT,
        unread_count INTEGER NOT NULL DEFAULT 0,
        last_msg TEXT,
        timestamp INTEGER NOT NULL DEFAULT 0,
        assigned_operator_id TEXT,
        assigned_operator_name TEXT,
        assigned_at TEXT,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        jid TEXT NOT NULL,
        timestamp INTEGER NOT NULL DEFAULT 0,
        from_me INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bridge_metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS operator_chat_reads (
        operator_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        last_read_message_id TEXT,
        last_read_timestamp INTEGER DEFAULT 0,
        PRIMARY KEY (operator_id, chat_id)
      );
      CREATE TABLE IF NOT EXISTS flagged_messages (
        message_id TEXT PRIMARY KEY,
        jid TEXT NOT NULL,
        flagged_by_operator_id TEXT NOT NULL,
        flagged_by_operator_name TEXT NOT NULL,
        note TEXT,
        flagged_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_jid_timestamp
      ON messages(jid, timestamp, id);
    `);
  }

  clearAllData() {
    try {
      this.db.exec(`
        DELETE FROM contacts;
        DELETE FROM chats;
        DELETE FROM messages;
        DELETE FROM bridge_metadata;
      `);
      console.log('[Database] All data tables cleared successfully.');
    } catch (e) {
      console.error('[Database] Failed to clear tables:', e.message);
    }
  }

  prepare() {
    this.upsertContactStmt = this.db.prepare(`
      INSERT INTO contacts (id, payload, updated_at)
      VALUES (@id, @payload, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `);
    this.upsertChatStmt = this.db.prepare(`
      INSERT INTO chats (
        id, name, type, unread_count, last_msg, timestamp,
        assigned_operator_id, assigned_operator_name, assigned_at,
        payload, updated_at
      ) VALUES (
        @id, @name, @type, @unread_count, @last_msg, @timestamp,
        @assigned_operator_id, @assigned_operator_name, @assigned_at,
        @payload, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        unread_count = excluded.unread_count,
        last_msg = excluded.last_msg,
        timestamp = excluded.timestamp,
        assigned_operator_id = excluded.assigned_operator_id,
        assigned_operator_name = excluded.assigned_operator_name,
        assigned_at = excluded.assigned_at,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `);
    this.upsertMessageStmt = this.db.prepare(`
      INSERT INTO messages (id, jid, timestamp, from_me, deleted, payload, updated_at)
      VALUES (@id, @jid, @timestamp, @from_me, @deleted, @payload, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        jid = excluded.jid,
        timestamp = excluded.timestamp,
        from_me = excluded.from_me,
        deleted = excluded.deleted,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `);
    this.deleteMessagesStmt = this.db.prepare(`
      DELETE FROM messages
      WHERE jid = ? AND id IN (
        SELECT id FROM messages
        WHERE jid = ?
        ORDER BY timestamp DESC, id DESC
        LIMIT -1 OFFSET ?
      )
    `);
    this.contactCountStmt = this.db.prepare('SELECT COUNT(*) AS count FROM contacts');
    this.chatCountStmt = this.db.prepare('SELECT COUNT(*) AS count FROM chats');
    this.messageCountStmt = this.db.prepare('SELECT COUNT(*) AS count FROM messages');
    this.allContactsStmt = this.db.prepare('SELECT payload FROM contacts');
    this.allChatsStmt = this.db.prepare('SELECT payload FROM chats ORDER BY timestamp DESC, id DESC');
    this.allMessagesStmt = this.db.prepare('SELECT payload FROM messages ORDER BY jid ASC, timestamp ASC, id ASC');
    this.getMetadataStmt = this.db.prepare('SELECT value FROM bridge_metadata WHERE key = ?');
    this.setMetadataStmt = this.db.prepare(`
      INSERT INTO bridge_metadata (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this.inTransaction = this.db.transaction((contacts, chats, messages) => {
      for (const contact of contacts) this.upsertContact(contact);
      for (const chat of chats) this.upsertChat(chat);
      for (const msg of messages) this.upsertMessage(msg);
    });
  }

  counts() {
    return {
      contacts: this.contactCountStmt.get().count,
      chats: this.chatCountStmt.get().count,
      messages: this.messageCountStmt.get().count,
    };
  }

  loadState() {
    const contacts = this.allContactsStmt.all().map((row) => JSON.parse(row.payload));
    const chats = this.allChatsStmt.all().map((row) => this.normalizeChat(JSON.parse(row.payload)));
    const messages = this.allMessagesStmt.all().map((row) => this.normalizeMessageRecord(JSON.parse(row.payload)));
    return { contacts, chats, messages };
  }

  getMetadata(key) {
    try {
      const row = this.getMetadataStmt.get(key);
      return row ? row.value : null;
    } catch (e) {
      console.error('[Database] getMetadata error:', e.message);
      return null;
    }
  }

  setMetadata(key, value) {
    try {
      this.setMetadataStmt.run(key, value);
    } catch (e) {
      console.error('[Database] setMetadata error:', e.message);
    }
  }

  upsertContact(contact) {
    const payload = { ...contact };
    this.upsertContactStmt.run({
      id: payload.id,
      payload: JSON.stringify(payload),
      updated_at: Date.now(),
    });
  }

  upsertChat(chat) {
    const payload = this.normalizeChat(chat);
    this.upsertChatStmt.run({
      id: payload.id,
      name: payload.name || null,
      type: payload.type || null,
      unread_count: Number(payload.unreadCount || 0),
      last_msg: payload.lastMsg || '',
      timestamp: this.toTimestamp(payload.timestamp),
      assigned_operator_id: payload.assignedOperatorId || null,
      assigned_operator_name: payload.assignedOperatorName || null,
      assigned_at: payload.assignedAt || null,
      payload: JSON.stringify(payload),
      updated_at: Date.now(),
    });
  }

  upsertMessage(message) {
    const payload = this.normalizeMessageRecord(message);
    this.upsertMessageStmt.run({
      id: payload.id,
      jid: payload.jid,
      timestamp: this.toTimestamp(payload.timestamp),
      from_me: payload.fromMe ? 1 : 0,
      deleted: payload.deleted ? 1 : 0,
      payload: JSON.stringify(payload),
      updated_at: Date.now(),
    });
    this.trimMessages(payload.jid);
  }

  trimMessages(jid) {
    this.deleteMessagesStmt.run(jid, jid, this.config.MAX_MESSAGES_PER_CHAT);
  }

  saveContacts(contacts) {
    const tx = this.db.transaction((items) => {
      for (const item of items) this.upsertContact(item);
    });
    tx(contacts);
  }

  saveChats(chats) {
    const tx = this.db.transaction((items) => {
      for (const item of items) this.upsertChat(item);
    });
    tx(chats);
  }

  saveMessages(messages) {
    const tx = this.db.transaction((items) => {
      for (const item of items) this.upsertMessage(item);
    });
    tx(messages);
  }

  importLegacyStore(filePath) {
    if (!fs.existsSync(filePath)) return false;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const contacts = Object.values(data.contacts || {});
    const chats = Object.values(data.chats || {}).map((c) => this.normalizeChat(c));
    const messages = Object.values(data.messages || {})
      .flat()
      .map((m) => this.normalizeMessageRecord(m))
      .filter((msg) => msg.id && msg.jid);
    this.inTransaction(contacts, chats, messages);
    return true;
  }

  // --- Operator Chat Reads ---
  setOperatorReadPointer(operatorId, chatId, messageId, timestamp) {
    try {
      this.db.prepare(`
        INSERT INTO operator_chat_reads (operator_id, chat_id, last_read_message_id, last_read_timestamp)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(operator_id, chat_id) DO UPDATE SET
          last_read_message_id = excluded.last_read_message_id,
          last_read_timestamp = excluded.last_read_timestamp
      `).run(operatorId, chatId, messageId, timestamp);
    } catch (e) {
      console.error('[Database] setOperatorReadPointer error:', e.message);
    }
  }

  getOperatorReadPointer(operatorId, chatId) {
    try {
      const row = this.db.prepare('SELECT last_read_message_id, last_read_timestamp FROM operator_chat_reads WHERE operator_id = ? AND chat_id = ?').get(operatorId, chatId);
      return row ? { messageId: row.last_read_message_id, timestamp: row.last_read_timestamp } : null;
    } catch (e) {
      console.error('[Database] getOperatorReadPointer error:', e.message);
      return null;
    }
  }

  getUnreadCountForOperator(jid, lastReadTimestamp) {
    try {
      const row = this.db.prepare(`
        SELECT COUNT(*) AS count FROM messages 
        WHERE jid = ? AND from_me = 0 AND deleted = 0 AND timestamp > ?
      `).get(jid, lastReadTimestamp);
      return row ? row.count : 0;
    } catch (e) {
      console.error('[Database] getUnreadCountForOperator error:', e.message);
      return 0;
    }
  }

  getAllOperatorReadPointers() {
    try {
      return this.db.prepare('SELECT operator_id, chat_id, last_read_message_id, last_read_timestamp FROM operator_chat_reads').all();
    } catch (e) {
      console.error('[Database] getAllOperatorReadPointers error:', e.message);
      return [];
    }
  }

  // --- Flagged Messages ---
  flagMessage(messageId, jid, operatorId, operatorName, note, timestamp) {
    try {
      this.db.prepare(`
        INSERT INTO flagged_messages (message_id, jid, flagged_by_operator_id, flagged_by_operator_name, note, flagged_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
          note = excluded.note
      `).run(messageId, jid, operatorId, operatorName, note || null, timestamp);
    } catch (e) {
      console.error('[Database] flagMessage error:', e.message);
    }
  }

  unflagMessage(messageId) {
    try {
      this.db.prepare('DELETE FROM flagged_messages WHERE message_id = ?').run(messageId);
    } catch (e) {
      console.error('[Database] unflagMessage error:', e.message);
    }
  }

  getAllFlaggedMessages() {
    try {
      return this.db.prepare('SELECT message_id, jid, flagged_by_operator_id, flagged_by_operator_name, note, flagged_at FROM flagged_messages ORDER BY flagged_at DESC').all();
    } catch (e) {
      console.error('[Database] getAllFlaggedMessages error:', e.message);
      return [];
    }
  }
}

module.exports = { RelayDatabase };
