    // ─── State ───────────────────────────────────────────────────────────────────
    let socket = null;
    let bridgeUrl = 'http://localhost:3001';
    let activeChat = null;         // { id, name, type, ... }
    let myJid = null;
    let currentTab = 'operators';
    let operatorId = localStorage.getItem('whatsapp_echo_operator_id') || '';
    let operatorName = localStorage.getItem('whatsapp_echo_operator_name') || '';
    let flaggedList = [];
    let unreadObserver = null;
    let pendingScrollToMessageId = null;
    let pendingScrollToMessageTimestamp = null;
    let connectorOperatorId = null;
    let connectorOperatorName = null;
    let pendingMediaList = [];
    let allChats = [];
    let allContacts = [];
    let searchTimer = null;
    let editingMessageId = null;
    let editingMessageJid = null;
    let replyingToMessage = null; // { id, content, sender, fromMe, mediaType }
    let confirmCallback = null;
    let chatMessageCounts = {};    // jid -> total message count
    let chatHasMore = {};          // jid -> boolean
    let sentTempIds = new Set();   // track locally-sent message IDs to avoid dupes
    const EDIT_WINDOW_SECONDS = 15 * 60;
    const DELETE_FOR_EVERYONE_WINDOW_SECONDS = 60 * 60 * 60;
    let isInternetOnline = true;
    let lastStatusClass = 'disconnected';
    let lastStatusText = 'Offline';

    // ─── WhatsApp-style Text Formatting ─────────────────────────────────────────────
    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    // Converts WhatsApp markup (*bold*, _italic_, ~strike~, ```mono```) in plain
    // text into safe HTML. Input is HTML-escaped first, so this is the only place
    // message text should be turned into innerHTML.
    function formatWhatsAppText(text) {
      let escaped = escapeHtml(text == null ? '' : text);
      // Marker must hug non-whitespace on its inner edge (WhatsApp's own rule) so
      // stray characters like "5 * 3" or "a_b" don't get treated as formatting.
      escaped = escaped.replace(/```([^\s`][\s\S]*?[^\s`]|[^\s`])```/g, '<span class="fmt-mono">$1</span>');
      escaped = escaped.replace(/\*([^\s*][^*]*?[^\s*]|[^\s*])\*/g, '<b>$1</b>');
      escaped = escaped.replace(/_([^\s_][^_]*?[^\s_]|[^\s_])_/g, '<i>$1</i>');
      escaped = escaped.replace(/~([^\s~][^~]*?[^\s~]|[^\s~])~/g, '<s>$1</s>');
      return escaped.replace(/\n/g, '<br>');
    }

    function currentOperator() {
      return { id: operatorId, name: operatorName || operatorId || 'Unknown' };
    }

    function operatorHeaders() {
      return {
        'x-operator-id': operatorId,
        'x-operator-name': operatorName || operatorId,
      };
    }

    function isAssignedChat(chat) {
      return Boolean(chat?.assignedOperatorId);
    }

    function isAssignedToMe(chat) {
      return Boolean(chat?.assignedOperatorId && chat.assignedOperatorId === operatorId);
    }

    function isAssignedToOther(chat) {
      return Boolean(chat?.assignedOperatorId && chat.assignedOperatorId !== operatorId);
    }

    function assignmentText(chat) {
      if (!chat || chat.type === 'group') return 'Shared';
      if (!chat.assignedOperatorId) return 'Unassigned';
      return isAssignedToMe(chat) ? `Mine · ${chat.assignedOperatorName || chat.assignedOperatorId}` : `Locked · ${chat.assignedOperatorName || chat.assignedOperatorId}`;
    }

    function upsertChatRecord(chat) {
      if (!chat?.id) return;
      const idx = allChats.findIndex(c => c.id === chat.id);
      if (idx >= 0) allChats[idx] = { ...allChats[idx], ...chat };
      else allChats.push(chat);
      allChats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }

    function syncActiveChat() {
      if (!activeChat?.id) return;
      const latest = allChats.find(c => c.id === activeChat.id);
      if (latest) activeChat = { ...activeChat, ...latest };
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────────
    function updateStatus(status, text) {
      if (status !== undefined) lastStatusClass = status;
      if (text !== undefined) lastStatusText = text;

      const pill = document.getElementById('statusPill');
      if (!pill) return;

      if (!isInternetOnline) {
        pill.className = 'status-pill disconnected';
        document.getElementById('statusText').textContent = 'Device Offline';
      } else {
        pill.className = 'status-pill ' + lastStatusClass;
        document.getElementById('statusText').textContent = lastStatusText;
      }
    }

    function showToast(msg, type = 'success') {
      const t = document.createElement('div');
      t.className = 'toast ' + type;
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 3000);
    }

    function updateDocumentTitle() {
      const totalUnread = allChats.reduce((sum, chat) => sum + (chat.unreadCount || 0), 0);
      if (totalUnread > 0) {
        document.title = `(${totalUnread}) ECHO — Operator Dashboard`;
      } else {
        document.title = 'ECHO — Operator Dashboard';
      }
    }

    function normalizeBridgeUrl(input) {
      const raw = String(input || '').trim();
      if (!raw) return null;
      const candidate = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
      try {
        const parsed = new URL(candidate);
        return parsed.origin;
      } catch {
        return null;
      }
    }

    async function parseJsonResponse(res) {
      const text = await res.text();
      const contentType = (res.headers.get('content-type') || '').toLowerCase();

      if (contentType.includes('application/json')) {
        try {
          return text ? JSON.parse(text) : {};
        } catch {
          throw new Error('Invalid JSON response from bridge');
        }
      }

      const snippet = text.trim().slice(0, 80).replace(/\s+/g, ' ');
      throw new Error(`Bridge returned non-JSON response (${res.status}): ${snippet || 'empty body'}`);
    }

    // ─── Composer (contenteditable messageInput) ────────────────────────────────────
    // Reads plain text back out of the composer div, treating <br> as '\n' (matches
    // how formatWhatsAppText() turns '\n' into <br> when rendering).
    // Reads the composer's plain text by walking the DOM (same traversal as the
    // caret helpers), so <br> handling is deterministic across browsers. The
    // trailing sentinel <br> is presentational only and excluded.
    function getComposerText(el) {
      let text = '';
      (function walk(node) {
        if (node.nodeType === Node.TEXT_NODE) { text += node.nodeValue; return; }
        if (node.nodeName === 'BR') {
          if (!isSentinelBr(node)) text += '\n';
          return;
        }
        for (const child of node.childNodes) walk(child);
      })(el);
      return text.replace(/\r\n/g, '\n');
    }

    function isSentinelBr(node) {
      return node.nodeName === 'BR' && node.dataset && node.dataset.composerSentinel === '1';
    }

    // A lone trailing <br> doesn't render as a visible empty line, so when the
    // text ends with a newline we append a sentinel <br> that exists only for
    // rendering — every text/caret walker skips it.
    function renderComposerHtml(text) {
      return formatWhatsAppText(text) + (/\n$/.test(text || '') ? '<br data-composer-sentinel="1">' : '');
    }

    function clearComposer(el) {
      el.innerHTML = '';
    }

    // Full programmatic replace (edit-mode load, etc.) - caret goes to the end,
    // matching the old textarea's behavior when .value was assigned.
    function setComposerText(el, text) {
      el.innerHTML = renderComposerHtml(text || '');
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    // Walks the composer's DOM to find the plain-text caret offset (treating <br> as
    // one character, matching getComposerText). Returns null if there's no selection
    // inside the element (e.g. a programmatic call while unfocused).
    function getComposerCaretOffset(el) {
      const sel = window.getSelection();
      if (!sel.rangeCount || !el.contains(sel.focusNode)) return null;
      const range = sel.getRangeAt(0);
      let text = '';
      let caret = null;

      function walk(node) {
        if (caret !== null) return;
        if (node.nodeType === Node.TEXT_NODE) {
          if (node === range.endContainer) caret = text.length + range.endOffset;
          text += node.nodeValue;
          return;
        }
        if (node.nodeName === 'BR') {
          if (node === range.endContainer) caret = text.length;
          if (!isSentinelBr(node)) text += '\n';
          return;
        }
        const children = node.childNodes;
        for (let i = 0; i < children.length; i++) {
          if (node === range.endContainer && range.endOffset === i) caret = text.length;
          walk(children[i]);
          if (caret !== null) return;
        }
        if (node === range.endContainer && range.endOffset === children.length) caret = text.length;
      }
      walk(el);
      return caret === null ? text.length : caret;
    }

    // Inverse of getComposerCaretOffset: places the caret at a plain-text character offset.
    function setComposerCaretOffset(el, offset) {
      let remaining = offset;
      let target = null;

      function walk(node) {
        if (target) return;
        if (node.nodeType === Node.TEXT_NODE) {
          if (remaining <= node.nodeValue.length) {
            target = { node, offset: remaining };
          } else {
            remaining -= node.nodeValue.length;
          }
          return;
        }
        if (node.nodeName === 'BR') {
          if (!isSentinelBr(node)) remaining -= 1;
          return;
        }
        for (const child of node.childNodes) {
          walk(child);
          if (target) return;
        }
      }
      walk(el);

      const range = document.createRange();
      if (target) {
        range.setStart(target.node, Math.max(0, Math.min(target.offset, target.node.nodeValue.length)));
        range.collapse(true);
      } else {
        // Offset lies past the last text node (e.g. right after a trailing line
        // break) — put the caret at the very end, never back at the start.
        range.selectNodeContents(el);
        range.collapse(false);
      }
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    // Re-renders the composer's markup live as the operator types, preserving caret position.
    function handleComposerInput(el) {
      if (el.dataset.composing === '1') return; // wait for IME composition to finish
      const caret = getComposerCaretOffset(el);
      const text = getComposerText(el);
      el.innerHTML = renderComposerHtml(text);
      if (caret !== null) setComposerCaretOffset(el, caret);
    }

    function handleComposerCompositionEnd(el) {
      el.dataset.composing = '0';
      handleComposerInput(el);
    }

    function handleKey(e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (e.shiftKey) {
        // Insert the newline in the text model and re-render, instead of
        // execCommand('insertLineBreak') — the browser's <br> insertion didn't
        // survive the composer's input re-render round-trip.
        const el = (e.target.closest && e.target.closest('[contenteditable]')) || document.getElementById('messageInput');
        const text = getComposerText(el);
        const caret = getComposerCaretOffset(el) ?? text.length;
        el.innerHTML = renderComposerHtml(text.slice(0, caret) + '\n' + text.slice(caret));
        setComposerCaretOffset(el, caret + 1);
      } else {
        sendMessage();
      }
    }

    // --- Paste handling: images become pending attachments (Bug 21), everything
    // else is inserted as plain text so rich HTML from other apps can't inject
    // stray markup into the composer.
    function handleComposerPaste(e) {
      // Copied/cut files (any type — images, videos, documents) become pending
      // attachments through the same pipeline as the attach menu.
      const files = [];
      if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
        for (let i = 0; i < e.clipboardData.files.length; i++) {
          files.push(e.clipboardData.files[i]);
        }
      }
      if (files.length === 0 && e.clipboardData && e.clipboardData.items) {
        const items = e.clipboardData.items;
        for (let i = 0; i < items.length; i++) {
          if (items[i].kind === 'file') {
            const file = items[i].getAsFile();
            if (file) files.push(file);
          }
        }
      }

      if (files.length > 0) {
        e.preventDefault();
        addFilesToPending(files);
        return;
      }

      e.preventDefault();
      const pastedText = (e.clipboardData || window.clipboardData).getData('text/plain');
      if (!pastedText) return;
      document.execCommand('insertText', false, pastedText);
    }

    function formatTime(d) {
      if (!d) return '';
      const dt = d instanceof Date ? d : new Date(d);
      return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function unixSeconds(ts) {
      const n = Number(ts) || 0;
      if (!n) return 0;
      return n > 100000000000 ? Math.floor(n / 1000) : n;
    }

    function dateKeyForTimestamp(ts) {
      const seconds = unixSeconds(ts);
      if (!seconds) return '';
      const d = new Date(seconds * 1000);
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    }

    function formatDateSeparatorLabel(ts) {
      const seconds = unixSeconds(ts);
      if (!seconds) return '';
      const d = new Date(seconds * 1000);
      const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const diffDays = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
      if (diffDays === 0) return 'Today';
      if (diffDays === 1) return 'Yesterday';
      return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    }

    function formatFullDateTime(ts) {
      const seconds = unixSeconds(ts);
      if (!seconds) return '';
      return new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    }

    // Rebuilt fresh on every message-list change (initial open, load-older,
    // live message) rather than tracked incrementally through each insertion
    // path (append/prepend both mutate the DOM directly) - a full rescan over
    // .message-row is cheap at the message counts this app renders and avoids
    // subtly wrong separator placement when prepending older batches.
    function refreshDateSeparators() {
      const area = document.getElementById('messagesArea');
      if (!area) return;
      area.querySelectorAll('.date-separator').forEach(el => el.remove());
      let lastDateKey = null;
      area.querySelectorAll('.message-row').forEach(row => {
        const dateKey = dateKeyForTimestamp(row.dataset.timestamp);
        if (!dateKey || dateKey === lastDateKey) return;
        lastDateKey = dateKey;
        const sep = document.createElement('div');
        sep.className = 'date-separator';
        sep.innerHTML = `<span class="date-separator-text">${formatDateSeparatorLabel(row.dataset.timestamp)}</span>`;
        area.insertBefore(sep, row);
      });
    }

    function canEditMessage(msg) {
      if (!msg || !msg.fromMe || msg.deleted) return false;
      if ((msg.mediaType || 'text') !== 'text') return false;
      const ts = unixSeconds(msg.timestamp);
      if (!ts) return false;
      return (Math.floor(Date.now() / 1000) - ts) <= EDIT_WINDOW_SECONDS;
    }

    function canDeleteForEveryone(msg) {
      if (!msg || !msg.fromMe || msg.deleted) return false;
      const ts = unixSeconds(msg.timestamp);
      if (!ts) return false;
      return (Math.floor(Date.now() / 1000) - ts) <= DELETE_FOR_EVERYONE_WINDOW_SECONDS;
    }

    function getRenderedMessage(messageId) {
      const row = document.getElementById('msg-' + messageId);
      if (!row) return null;
      return {
        id: messageId,
        fromMe: row.dataset.fromMe === '1',
        mediaType: row.dataset.mediaType || 'text',
        deleted: row.dataset.deleted === '1',
        timestamp: unixSeconds(row.dataset.timestamp),
        content: row.dataset.content || '',
      };
    }

    function formatDate(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + formatTime(d);
    }

    function fmtPhone(str) {
      const m = str.match(/^\+(\d+)$/);
      if (!m) return str;
      const d = m[1];
      if (d.length <= 2) return str;
      const cc3 = new Set([
        '212','213','216','218','220','221','222','223','224','225','226','227','228','229',
        '230','231','232','233','234','235','236','237','238','239','240','241','242','243',
        '244','245','246','247','248','249','250','251','252','253','254','255','256','257',
        '258','260','261','262','263','264','265','266','267','268','269','290','291','297',
        '298','299','350','351','352','353','354','355','356','357','358','359',
        '370','371','372','373','374','375','376','377','378','379','380','381','382','383',
        '385','386','387','389','420','421','423','500','501','502','503','504','505','506',
        '507','508','509','590','591','592','593','594','595','596','597','598','599',
        '670','672','673','674','675','676','677','678','679','680','681','682','683','685',
        '686','687','688','689','690','691','692','808','850','852','853','855','856','870',
        '878','880','881','882','883','886','960','961','962','963','964','965','966','967',
        '968','970','971','972','973','974','975','976','977','992','993','994','995','996',
        '997','998'
      ]);
      if ((d[0] === '1' || d[0] === '7') && d.length >= 2)
        return '+'+d[0]+' '+d.slice(1);
      if (d.length >= 4 && cc3.has(d.slice(0,3)))
        return '+'+d.slice(0,3)+' '+d.slice(3);
      if (d.length >= 3)
        return '+'+d.slice(0,2)+' '+d.slice(2);
      return str;
    }

    function cleanJid(val) {
      if (!val) return '';
      val = String(val).trim();
      if (val.startsWith('LID: ')) return val;
      if (val.includes('@')) {
        const parts = val.split('@');
        const domain = parts[1];
        if (domain === 's.whatsapp.net') {
          const num = parts[0].split(':')[0];
          return fmtPhone(num.startsWith('+') ? num : '+' + num);
        }
        if (domain === 'lid') {
          return 'LID: ' + parts[0];
        }
        return parts[0];
      }
      if (val.includes(':')) {
        if (/^[a-zA-Z]/.test(val)) return val;
        const num = val.split(':')[0];
        if (/^\d{8,}$/.test(num)) {
          return fmtPhone('+' + num);
        }
        return num;
      }
      if (/^\d{8,}$/.test(val)) {
        return fmtPhone('+' + val);
      }
      return val;
    }

    function isActiveChatJid(jid) {
      if (!activeChat || !jid) return false;
      if (activeChat.id === jid) return true;
      const cleanA = cleanJid(activeChat.id).replace(/\D/g, '');
      const cleanB = cleanJid(jid).replace(/\D/g, '');
      if (cleanA && cleanA === cleanB) return true;
      if (activeChat.phone) {
        const cleanPhone = String(activeChat.phone).replace(/\D/g, '');
        if (cleanPhone && cleanPhone === cleanB) return true;
      }
      return false;
    }

    function getAvatarContent(avatarType, initial) {
      if (avatarType === 'group') {
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`;
      } else if (avatarType === 'community') {
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>`;
      } else if (avatarType === 'channel') {
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;
      } else if (avatarType === 'status') {
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a7 7 0 0 1 7 7M5 12a7 7 0 0 1 7-7"></path></svg>`;
      }
      return initial;
    }

    function renderChatHeader() {
      const assignmentPill = document.getElementById('assignmentPill');
      const claimBtn = document.getElementById('claimChatBtn');
      const releaseBtn = document.getElementById('releaseChatBtn');
      const lockNote = document.getElementById('lockNote');
      const searchBtn = document.getElementById('chatSearchBtn');
      if (!activeChat) {
        assignmentPill.textContent = 'Unassigned';
        assignmentPill.className = 'assignment-pill';
        claimBtn.style.display = 'none';
        releaseBtn.style.display = 'none';
        if (searchBtn) searchBtn.style.display = 'none';
        lockNote.classList.remove('visible');
        lockNote.textContent = '';
        return;
      }
      if (searchBtn) searchBtn.style.display = 'inline-flex';

      let meta = '';
      if (activeChat.type === 'group' || activeChat.type === 'community') {
        const count = Array.isArray(activeChat.participants) ? activeChat.participants.length : (Number(activeChat.participants) || '?');
        meta = `${count} participants`;
      } else {
        meta = cleanJid(activeChat.phone || activeChat.id || '');
      }
      let topDisplayName = cleanJid(activeChat.verifiedName || activeChat.name || activeChat.id);

      if (activeChat.type === 'personal') {
        const cleanId = cleanJid(activeChat.id);
        const cleanPhone = activeChat.phone ? cleanJid(activeChat.phone) : '';
        const isLidOrJidDisplayName = (topDisplayName === cleanId || topDisplayName.startsWith('LID: ') || /^\+?1\d{14}$/.test(topDisplayName.replace(/\s+/g, '')) || /^\+?\d{10,}$/.test(topDisplayName.replace(/\s+/g, '')));
        if (isLidOrJidDisplayName && cleanPhone && cleanPhone !== topDisplayName) {
          const originalDisplayName = topDisplayName;
          topDisplayName = cleanPhone;
          meta = originalDisplayName;
        } else if (topDisplayName === cleanPhone && cleanId && cleanId !== cleanPhone) {
          meta = cleanId;
        }
      }
      const isVerified = Boolean(activeChat.verifiedName);
      const verifiedBadge = isVerified ? `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="#0095f6" viewBox="0 0 16 16" style="margin-left:6px;vertical-align:middle;flex-shrink:0;" title="Verified Business"><path d="M10.067.87a2.89 2.89 0 0 0-4.134 0l-.622.622-2.08-.02a2.89 2.89 0 0 0-2.91 2.91l.02 2.08-.622.622a2.89 2.89 0 0 0 0 4.134l.622.622-.02 2.08a2.89 2.89 0 0 0 2.91 2.91l2.08-.02.622.622a2.89 2.89 0 0 0 4.134 0l.622-.622 2.08.02a2.89 2.89 0 0 0 2.91-2.91l-.02-2.08.622-.622a2.89 2.89 0 0 0 0-4.134l-.622-.622.02-2.08a2.89 2.89 0 0 0-2.91-2.91l-2.08.02-.622-.622zM8.14 10.146a.75.75 0 0 1-1.079-.02L4.697 7.731a.75.75 0 1 1 1.071-1.05l1.829 1.828L11.83 4.5a.75.75 0 1 1 1.06 1.06L8.14 10.147z"/></svg>` : '';

      const isGroupChat = activeChat.type === 'group' || activeChat.type === 'community' || activeChat.id.endsWith('@g.us');

      let avatarType = 'personal';
      if (activeChat.type === 'community') {
        avatarType = 'community';
      } else if (activeChat.type === 'channel' || activeChat.id.endsWith('@newsletter')) {
        avatarType = 'channel';
      } else if (activeChat.type === 'status' || activeChat.id.endsWith('@broadcast')) {
        avatarType = 'status';
      } else if (isGroupChat) {
        avatarType = 'group';
      }

      const topAvatarInitial = (topDisplayName.startsWith('+') ? topDisplayName.slice(1) : topDisplayName || '?')[0].toUpperCase();
      const topAvatarEl = document.getElementById('chatTopAvatar');
      topAvatarEl.innerHTML = getAvatarContent(avatarType, topAvatarInitial);
      topAvatarEl.className = 'chat-topbar-avatar ' + avatarType;
      document.getElementById('chatTopName').innerHTML = `<span style="display:inline-flex;align-items:center;">${topDisplayName}${verifiedBadge}</span>`;
      document.getElementById('chatTopMeta').textContent = meta;

      // Make the topbar clickable for groups
      const isGroup = activeChat.type === 'group' || activeChat.type === 'community' || activeChat.id.endsWith('@g.us');
      const infoEl = document.querySelector('.chat-topbar-info');
      if (infoEl) {
        if (isGroup) {
          infoEl.style.cursor = 'pointer';
          infoEl.onclick = openGroupDetailsModal;
        } else {
          infoEl.style.cursor = 'default';
          infoEl.onclick = null;
        }
      }

      assignmentPill.textContent = assignmentText(activeChat);
      assignmentPill.className = 'assignment-pill';
      if (isAssignedToMe(activeChat)) assignmentPill.classList.add('mine');
      else if (isAssignedToOther(activeChat)) assignmentPill.classList.add('locked');

      if (activeChat.type === 'group' || activeChat.type === 'community') {
        claimBtn.style.display = 'none';
        releaseBtn.style.display = 'none';
        lockNote.classList.remove('visible');
        lockNote.textContent = '';
      } else if (isAssignedToOther(activeChat)) {
        claimBtn.style.display = 'none';
        releaseBtn.style.display = 'none';
        lockNote.textContent = `Replies locked by ${activeChat.assignedOperatorName || activeChat.assignedOperatorId}`;
        lockNote.classList.add('visible');
      } else {
        claimBtn.style.display = isAssignedToMe(activeChat) ? 'none' : 'inline-flex';
        releaseBtn.style.display = isAssignedToMe(activeChat) ? 'inline-flex' : 'none';
        lockNote.classList.remove('visible');
        lockNote.textContent = '';
      }

      refreshComposerState();
    }

    function isChatReadOnly(chat) {
      if (!chat) return false;
      if (chat.readOnly || chat.isReadOnly || chat.left) return true;
      const isGroup = chat.type === 'group' || chat.type === 'community' || (chat.id && chat.id.endsWith('@g.us'));
      if (isGroup) {
        if (Array.isArray(chat.participants) && chat.participants.length === 0) {
          return true;
        }
        if (chat.participants === 0 || chat.participants === '0') {
          return true;
        }
      }
      return false;
    }

    function refreshComposerState() {
      const readOnlyBanner = document.getElementById('readOnlyBanner');
      const inputRow = document.querySelector('.input-row');
      const replyBar = document.getElementById('replyBar');
      const editingBar = document.getElementById('editingBar');
      const mediaPreviewStrip = document.getElementById('mediaPreviewStrip');

      const isReadOnly = isChatReadOnly(activeChat);

      if (isReadOnly) {
        if (inputRow) inputRow.style.display = 'none';
        if (replyBar) replyBar.classList.remove('visible');
        if (editingBar) editingBar.style.display = 'none';
        if (mediaPreviewStrip) mediaPreviewStrip.style.display = 'none';

        if (readOnlyBanner) {
          const isGroup = activeChat && (activeChat.type === 'group' || activeChat.type === 'community' || activeChat.id.endsWith('@g.us'));
          readOnlyBanner.textContent = isGroup
            ? "You can't send messages to this group because you're no longer a participant."
            : "You can't send messages to this chat.";
          readOnlyBanner.style.display = 'flex';
        }
        return;
      } else {
        if (readOnlyBanner) readOnlyBanner.style.display = 'none';
        if (inputRow) inputRow.style.display = 'flex';
        // Clear the inline display:none set by the read-only branch, otherwise
        // it permanently overrides the .visible class in every other chat.
        if (mediaPreviewStrip) mediaPreviewStrip.style.display = '';
      }

      const isGroup = activeChat && (activeChat.type === 'group' || activeChat.type === 'community');
      const disabled = Boolean(activeChat && !isGroup && isAssignedToOther(activeChat));
      const input = document.getElementById('messageInput');
      const sendBtn = document.getElementById('sendBtn');
      const attachBtn = document.getElementById('attachBtn');
      input.contentEditable = disabled ? 'false' : 'true';
      sendBtn.disabled = disabled;
      attachBtn.disabled = disabled;
      if (disabled) {
        input.dataset.placeholder = `Locked by ${activeChat.assignedOperatorName || activeChat.assignedOperatorId}`;
      } else if (pendingMediaList.length > 0) {
        input.dataset.placeholder = pendingMediaList[0].type === 'document' ? 'Document ready to send…' : 'Add a caption…';
      } else {
        input.dataset.placeholder = 'Type a message… (Enter to send)';
      }
    }

    function getDocIcon(name = '') {
      const ext = (name || '').split('.').pop().toLowerCase();
      if (['pdf'].includes(ext)) return '📕';
      if (['doc', 'docx'].includes(ext)) return '📘';
      if (['xls', 'xlsx'].includes(ext)) return '📗';
      if (['ppt', 'pptx'].includes(ext)) return '📙';
      if (['zip', 'rar', '7z'].includes(ext)) return '🗜️';
      return '📄';
    }

    function genTempId() { return 'temp-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6); }

    // ─── Confirm Dialog ───────────────────────────────────────────────────────────
    function showConfirm(msg, cb) {
      document.getElementById('confirmMsg').textContent = msg;
      document.getElementById('confirmOverlay').classList.remove('hidden');
      confirmCallback = cb;
      document.getElementById('confirmOk').onclick = () => {
        dismissConfirm();
        if (cb) cb();
      };
    }
    function dismissConfirm() {
      document.getElementById('confirmOverlay').classList.add('hidden');
      confirmCallback = null;
    }

    // ─── Operator Name ────────────────────────────────────────────────────────────
    function promptOperatorName() {
      document.getElementById('namePrompt').classList.remove('hidden');
      document.getElementById('operatorNameInput').focus();
    }
    function saveOperatorName() {
      const name = document.getElementById('operatorNameInput').value.trim();
      operatorName = name || operatorId;
      localStorage.setItem('whatsapp_echo_operator_name', operatorName);
      document.getElementById('namePrompt').classList.add('hidden');
      if (socket?.connected) {
        socket.emit('set_operator_name', { name: operatorName });
      }
    }

    // ─── Lightbox ─────────────────────────────────────────────────────────────────
    function openLightbox(src) {
      document.getElementById('lightboxImg').src = src;
      document.getElementById('lightbox').classList.remove('hidden');
    }
    function closeLightbox() { document.getElementById('lightbox').classList.add('hidden'); }

    // ─── On-Demand Media Download ─────────────────────────────────────────────────
    async function downloadMediaOnDemand(jid, msgId, element, type) {
      if (element.classList.contains('loading')) return;
      element.classList.add('loading');

      const textElement = element.querySelector('.placeholder-text') || element.querySelector('.doc-size');
      const originalText = textElement ? textElement.innerText : '';
      if (textElement) {
        textElement.innerText = 'Loading media...';
      }

      try {
        const response = await fetch(`${bridgeUrl}/api/messages/${encodeURIComponent(jid)}/${encodeURIComponent(msgId)}/download-media`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          }
        });

        if (response.status === 410) {
          const errData = await response.json().catch(() => ({}));
          if (errData.media_expired) {
            // Replace placeholder with a permanent "unavailable" state
            element.outerHTML = `<div class="msg-media-unavailable">
              <span class="media-unavailable-icon">🚫</span>
              <span>Media no longer available</span>
            </div>`;
            return;
          }
        }

        if (!response.ok) {
          const errData = await response.json();
          throw new Error(errData.error || 'Failed to download media');
        }

        const data = await response.json();
        if (data.success && data.mediaUrl) {
          const absoluteMediaUrl = data.mediaUrl.startsWith('http') ? data.mediaUrl : `${bridgeUrl}${data.mediaUrl}`;
          const fileName = data.fileName || 'Document';
          const content = data.content || '';

          let html = '';
          if (type === 'image') {
            html = `<img class="msg-image" src="${absoluteMediaUrl}" alt="Image" onclick="openLightbox('${absoluteMediaUrl}')">
                    <div class="msg-text">${formatWhatsAppText(content)}</div>`;
          } else if (type === 'video') {
            html = `<video class="msg-video" controls><source src="${absoluteMediaUrl}"></video>
                    <div class="msg-text">${formatWhatsAppText(content)}</div>`;
          } else if (type === 'audio') {
            html = `<audio class="msg-audio" controls><source src="${absoluteMediaUrl}"></audio>`;
          } else if (type === 'document') {
            html = `<a class="msg-document" href="${absoluteMediaUrl}" target="_blank" download>
              <div class="doc-icon">${getDocIcon(fileName)}</div>
              <div>
                <div class="doc-name">${fileName}</div>
                <div class="doc-size">Tap to download</div>
              </div>
            </a>`;
          } else if (type === 'sticker') {
            html = `<img class="msg-sticker" src="${absoluteMediaUrl}" alt="Sticker">`;
          }

          if (html) {
            element.outerHTML = html;
            if (type === 'document') {
              const link = document.createElement('a');
              link.href = absoluteMediaUrl;
              link.target = '_blank';
              link.download = fileName;
              document.body.appendChild(link);
              link.click();
              document.body.removeChild(link);
            }
          }
        } else {
          throw new Error('No media URL returned');
        }
      } catch (e) {
        console.error(e);
        showToast(e.message, 'error');
        element.classList.remove('loading');
        if (textElement) {
          textElement.innerText = originalText;
        }
      }
    }

    // ─── Chat List ────────────────────────────────────────────────────────────────
    let activeSidebarTab = 'chats';

    function switchSidebarTab(tab) {
      activeSidebarTab = tab;
      document.querySelectorAll('.sidebar-tabs .tab-btn').forEach(btn => {
        btn.classList.remove('active');
      });
      const btnId = 'tab' + tab.charAt(0).toUpperCase() + tab.slice(1);
      const activeBtn = document.getElementById(btnId);
      if (activeBtn) activeBtn.classList.add('active');

      if (tab === 'contacts') {
        renderContactsList();
        loadContacts();
      } else {
        renderChatList(allChats);
      }
    }

    function initSidebarResize() {
      const resizer = document.getElementById('sidebarResizer');
      const main = document.querySelector('.main');
      if (!resizer || !main) return;

      let isResizing = false;

      resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        resizer.classList.add('resizing');
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const mainRect = main.getBoundingClientRect();
        let newWidth = e.clientX - mainRect.left;
        if (newWidth < 180) newWidth = 180;
        if (newWidth > 450) newWidth = 450;
        main.style.gridTemplateColumns = `${newWidth}px 1fr 300px`;
      });

      document.addEventListener('mouseup', () => {
        if (isResizing) {
          isResizing = false;
          resizer.classList.remove('resizing');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }
      });
    }

    // Mirrors the tick logic used for in-conversation messages (see the
    // "Render status ticks for outgoing messages" block below), scaled down
    // for the sidebar preview line. Only shown for messages we sent - WhatsApp
    // never shows ticks on the list preview for messages we received.
    function getChatListTick(chat) {
      if (!chat.lastMsgFromMe) return '';
      const status = chat.lastMsgStatus;
      let icon = '';
      let cls = 'status-sent';
      if (status === 0 || status === 'failed') {
        icon = '<svg class="tick-svg" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="7"/><line x1="8" y1="5" x2="8" y2="9"/><line x1="8" y1="12" x2="8.01" y2="12" stroke-width="2.5"/></svg>';
        cls = 'status-failed';
      } else if (status === 3 || status === 'delivered') {
        icon = '<svg class="tick-svg" viewBox="0 0 19 11" width="13" height="8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 5.5L5 9.5L10 4.5 M8 5.5L11.5 9L18 1.5"/></svg>';
        cls = 'status-delivered';
      } else if (status === 4 || status === 'read' || status === 5 || status === 'played') {
        icon = '<svg class="tick-svg" viewBox="0 0 19 11" width="13" height="8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 5.5L5 9.5L10 4.5 M8 5.5L11.5 9L18 1.5"/></svg>';
        cls = 'status-read';
      } else {
        // status 1/2 (pending/sent) and any unrecognized value fall back to a single tick.
        icon = '<svg class="tick-svg" viewBox="0 0 16 11" width="11" height="8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 5.5L5 9.5L15 1.5"/></svg>';
        cls = 'status-sent';
      }
      return `<span class="msg-status-ticks ${cls}" style="display:inline-block;">${icon}</span>`;
    }

    function renderChatList(chats) {
      allChats = chats || [];
      updateDocumentTitle();
      const list = document.getElementById('chatList');
      list.innerHTML = '';

      let filteredChats = allChats;
      if (activeSidebarTab === 'chats') {
        filteredChats = allChats.filter(c => c.type !== 'group' && c.type !== 'community' && !c.id.endsWith('@g.us') && !c.id.endsWith('@newsletter') && !c.id.endsWith('@broadcast'));
      } else if (activeSidebarTab === 'groups') {
        filteredChats = allChats.filter(c => (c.type === 'group' || c.id.endsWith('@g.us')) && c.type !== 'community');
      } else if (activeSidebarTab === 'communities') {
        filteredChats = allChats.filter(c => c.type === 'community');
      } else if (activeSidebarTab === 'channels') {
        filteredChats = allChats.filter(c => c.type === 'channel' || c.id.endsWith('@newsletter'));
      } else if (activeSidebarTab === 'status') {
        filteredChats = allChats.filter(c => c.type === 'status' || c.id.endsWith('@broadcast'));
      }

      document.getElementById('chatCount').textContent = filteredChats.length;
      document.getElementById('statGroups').textContent = allChats.filter(c => (c.type === 'group' || c.id.endsWith('@g.us')) && c.type !== 'community').length;

      filteredChats.forEach(chat => {
        const assigneeClass = isAssignedToMe(chat) ? 'chat-assignee mine' : (isAssignedToOther(chat) ? 'chat-assignee locked' : 'chat-assignee');
        const isGroupChat = chat.type === 'group' || chat.type === 'community' || chat.id.endsWith('@g.us');
        const assigneeLabel = isGroupChat ? '' : `<div class="${assigneeClass}">${!chat.assignedOperatorId ? 'Open' : (isAssignedToMe(chat) ? 'Mine' : (chat.assignedOperatorName || 'Locked'))}</div>`;
        const item = document.createElement('div');
        item.className = 'chat-item' + (activeChat?.id === chat.id ? ' active' : '');
        item.setAttribute('data-jid', chat.id);
        item.onclick = () => openChat(chat, item);

        let displayName = cleanJid(chat.verifiedName || chat.name || chat.id);
        if (chat.id === 'status@broadcast') {
          displayName = 'Status Updates';
        } else if (chat.id.endsWith('@newsletter') && !chat.name) {
          displayName = 'Channel: ' + cleanJid(chat.id);
        } else if (chat.type === 'personal') {
          const cleanId = cleanJid(chat.id);
          const cleanPhone = chat.phone ? cleanJid(chat.phone) : '';
          const isLidOrJidDisplayName = (displayName === cleanId || displayName.startsWith('LID: ') || /^\+?1\d{14}$/.test(displayName.replace(/\s+/g, '')) || /^\+?\d{10,}$/.test(displayName.replace(/\s+/g, '')));
          if (isLidOrJidDisplayName && cleanPhone && cleanPhone !== displayName) {
            displayName = cleanPhone;
          }
        }

        const previewTick = getChatListTick(chat);
        const isVerified = Boolean(chat.verifiedName);
        const verifiedBadge = isVerified ? `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="#0095f6" viewBox="0 0 16 16" style="margin-left:4px;vertical-align:middle;flex-shrink:0;" title="Verified Business"><path d="M10.067.87a2.89 2.89 0 0 0-4.134 0l-.622.622-2.08-.02a2.89 2.89 0 0 0-2.91 2.91l.02 2.08-.622.622a2.89 2.89 0 0 0 0 4.134l.622.622-.02 2.08a2.89 2.89 0 0 0 2.91 2.91l2.08-.02.622.622a2.89 2.89 0 0 0 4.134 0l.622-.622 2.08.02a2.89 2.89 0 0 0 2.91-2.91l-.02-2.08.622-.622a2.89 2.89 0 0 0 0-4.134l-.622-.622.02-2.08a2.89 2.89 0 0 0-2.91-2.91l-2.08.02-.622-.622zM8.14 10.146a.75.75 0 0 1-1.079-.02L4.697 7.731a.75.75 0 1 1 1.071-1.05l1.829 1.828L11.83 4.5a.75.75 0 1 1 1.06 1.06L8.14 10.147z"/></svg>` : '';

        let avatarType = 'personal';
        if (chat.type === 'community') {
          avatarType = 'community';
        } else if (chat.type === 'channel' || chat.id.endsWith('@newsletter')) {
          avatarType = 'channel';
        } else if (chat.type === 'status' || chat.id.endsWith('@broadcast')) {
          avatarType = 'status';
        } else if (isGroupChat) {
          avatarType = 'group';
        }

        const avatarInitial = (displayName.startsWith('+') ? displayName.slice(1) : displayName || '?')[0].toUpperCase();

        item.innerHTML = `
      <div class="chat-avatar ${avatarType}">${getAvatarContent(avatarType, avatarInitial)}</div>
      <div class="chat-info">
        <div class="chat-name-row">
          <div class="chat-name" style="display:flex;align-items:center;min-width:0;width:100%;">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${displayName}</span>
            ${verifiedBadge}
          </div>
          ${assigneeLabel}
        </div>
        <div class="chat-preview">${previewTick}${chat.lastMsg || chat.preview || ''}</div>
      </div>
      ${chat.unreadCount ? `<div class="unread-badge">${chat.unreadCount}</div>` : ''}
    `;
        list.appendChild(item);
      });
    }

    function renderContactsList() {
      const list = document.getElementById('chatList');
      list.innerHTML = '';

      document.getElementById('chatCount').textContent = allContacts.length;

      if (allContacts.length === 0) {
        list.innerHTML = `
      <div style="padding:20px;text-align:center;color:var(--muted);font-size:12px">
        No contacts found.<br>Use "Import Contacts" to add VCF contacts.
      </div>
    `;
        return;
      }

      allContacts.forEach(contact => {
        const item = document.createElement('div');
        item.className = 'chat-item';
        item.onclick = () => openContactChat(contact);

        let cleanName = cleanJid(contact.name);
        const cleanPhone = contact.phone ? cleanJid(contact.phone) : '';
        const isLidOrJidName = (cleanName === cleanJid(contact.id) || cleanName.startsWith('LID: ') || /^\+?1\d{14}$/.test(cleanName.replace(/\s+/g, '')) || /^\+?\d{10,}$/.test(cleanName.replace(/\s+/g, '')));
        if (isLidOrJidName && cleanPhone && cleanPhone !== cleanName) {
          cleanName = cleanPhone;
        }
        const avatarInitial = (cleanName.startsWith('+') ? cleanName.slice(1) : cleanName || '?')[0].toUpperCase();
        item.innerHTML = `
      <div class="chat-avatar personal">${avatarInitial}</div>
      <div class="chat-info">
        <div class="chat-name-row">
          <div class="chat-name">${cleanName}</div>
        </div>
        <div class="chat-preview">${fmtPhone('+' + contact.phone.split(':')[0])}</div>
      </div>
    `;
        list.appendChild(item);
      });
    }

    async function loadContacts() {
      if (!socket) return;
      try {
        const res = await fetch(`${bridgeUrl}/api/contacts`);
        allContacts = await res.json();
        if (activeSidebarTab === 'contacts') {
          renderContactsList();
        }
      } catch (e) {
        console.error('Failed to load contacts:', e);
      }
    }

    function openContactChat(contact) {
      let chat = allChats.find(c => c.id === contact.id);
      if (!chat) {
        chat = {
          id: contact.id,
          name: contact.name,
          type: 'personal',
          lastMsg: '',
          timestamp: Math.floor(Date.now() / 1000),
          unreadCount: 0,
          phone: contact.phone
        };
        allChats.unshift(chat);
      }
      switchSidebarTab('chats');
      openChat(chat, null);
    }

    function triggerImportContacts() {
      document.getElementById('fileInputContacts').click();
    }

    async function handleImportContacts(input) {
      const file = input.files[0];
      if (!file) return;

      const formData = new FormData();
      formData.append('file', file);

      try {
        showToast('Importing contacts...', 'info');
        const res = await fetch(`${bridgeUrl}/api/contacts/import`, {
          method: 'POST',
          body: formData
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || 'Import failed');
        }
        const data = await res.json();
        showToast(`Imported ${data.imported} contacts (skipped ${data.skipped} duplicates).`);
        loadContacts();
      } catch (e) {
        showToast('Import failed: ' + e.message, 'error');
      } finally {
        input.value = '';
      }
    }

    // ─── Search ───────────────────────────────────────────────────────────────────
    function onSearch(q) {
      clearTimeout(searchTimer);
      const resultsEl = document.getElementById('searchResults');
      if (!q.trim()) { resultsEl.classList.remove('visible'); return; }

      const localMatches = allChats.filter(c => (c.name || '').toLowerCase().includes(q.toLowerCase()));
      if (localMatches.length) {
        renderSearchResults(localMatches.map(c => ({ id: c.id, name: c.name, phone: c.id.split('@')[0].split(':')[0] })));
      }

      if (socket) {
        searchTimer = setTimeout(async () => {
          try {
            const res = await fetch(`${bridgeUrl}/api/contacts/search?q=${encodeURIComponent(q)}`);
            const contacts = await res.json();
            if (contacts.length) renderSearchResults(contacts);
          } catch (e) { }
        }, 300);
      }
    }

    function renderSearchResults(results) {
      const el = document.getElementById('searchResults');
      if (!results.length) { el.classList.remove('visible'); return; }
      el.innerHTML = results.map(r => {
        let cleanName = cleanJid(r.name || r.phone);
        const cleanPhone = cleanJid(r.phone);
        const isLidOrJidName = (cleanName === cleanJid(r.id) || /^\+?1\d{14}$/.test(cleanName.replace(/\s+/g, '')) || /^\+?\d{10,}$/.test(cleanName.replace(/\s+/g, '')));
        if (isLidOrJidName && cleanPhone && cleanPhone !== cleanName) {
          cleanName = cleanPhone;
        }
        const isGroup = r.id.endsWith('@g.us') || r.type === 'group';
        const isCommunity = r.type === 'community';
        const isChannel = r.id.endsWith('@newsletter') || r.type === 'channel';
        const isStatus = r.id.endsWith('@broadcast') || r.type === 'status';

        let avatarType = 'personal';
        if (isCommunity) avatarType = 'community';
        else if (isChannel) avatarType = 'channel';
        else if (isStatus) avatarType = 'status';
        else if (isGroup) avatarType = 'group';

        const avatarInitial = (cleanName.startsWith('+') ? cleanName.slice(1) : cleanName || '?')[0].toUpperCase();
        return `
      <div class="search-result-item" onclick="openChatById('${r.id}','${cleanName.replace(/'/g, "\\'")}')">
        <div class="chat-avatar ${avatarType}" style="width:28px;height:28px;font-size:11px;flex-shrink:0">${getAvatarContent(avatarType, avatarInitial)}</div>
        <div>
          <div style="font-weight:600; display:flex; align-items:center;">
            <span>${cleanName}</span>
          </div>
          <div class="search-result-phone">${cleanPhone}</div>
        </div>
      </div>`;
      }).join('');
      el.classList.add('visible');
    }

    function openChatById(id, name) {
      document.getElementById('searchInput').value = '';
      document.getElementById('searchResults').classList.remove('visible');
      const existing = allChats.find(c => c.id === id);
      let type = 'personal';
      if (id.endsWith('@g.us')) type = 'group';
      else if (id.endsWith('@newsletter')) type = 'channel';
      else if (id.endsWith('@broadcast')) type = 'status';

      if (existing && existing.type) {
        type = existing.type;
      }

      if (type === 'community') {
        switchSidebarTab('communities');
      } else if (type === 'group') {
        switchSidebarTab('groups');
      } else if (type === 'channel') {
        switchSidebarTab('channels');
      } else if (type === 'status') {
        switchSidebarTab('status');
      } else {
        switchSidebarTab('chats');
      }

      const chat = existing || { id, name, type, lastMsg: '' };
      openChat(chat, null);
    }

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-wrap') && !e.target.closest('.search-results')) {
        document.getElementById('searchResults').classList.remove('visible');
      }
    });

    function toggleChatSearch(forceState) {
      const panel = document.getElementById('chatSearchPanel');
      if (!panel) return;
      
      const isCurrentlyHidden = panel.classList.contains('hidden');
      const show = (forceState !== undefined) ? forceState : isCurrentlyHidden;
      
      if (show) {
        panel.classList.remove('hidden');
        const input = document.getElementById('chatSearchInput');
        input.value = '';
        input.focus();
        onChatSearchInput('');
      } else {
        panel.classList.add('hidden');
        document.getElementById('chatSearchInput').value = '';
      }
    }

    let chatSearchTimer = null;
    function onChatSearchInput(q) {
      clearTimeout(chatSearchTimer);
      
      const resultsEl = document.getElementById('chatSearchPanelResults');
      if (!resultsEl) return;
      
      const query = q.trim();
      if (!query) {
        resultsEl.innerHTML = '<div class="chat-search-empty">Type to search message history...</div>';
        return;
      }
      
      resultsEl.innerHTML = '<div class="chat-search-empty"><div class="spinner" style="display:inline-block; width: 14px; height: 14px; border-width: 2px; vertical-align: middle; margin-right: 6px;"></div> Searching...</div>';
      
      chatSearchTimer = setTimeout(async () => {
        if (!activeChat) return;
        try {
          const res = await fetch(`${bridgeUrl}/api/messages/search?jid=${encodeURIComponent(activeChat.id)}&q=${encodeURIComponent(query)}`);
          if (!res.ok) throw new Error('Search failed');
          const data = await res.json();
          const matched = data.messages || [];
          
          if (matched.length === 0) {
            resultsEl.innerHTML = '<div class="chat-search-empty">No messages found</div>';
          } else {
            resultsEl.innerHTML = matched.map(m => {
              const dateStr = formatDate(m.timestamp * 1000);
              const sender = m.fromMe ? 'You' : (m.sender || 'Them');
              
              let bodyText = formatWhatsAppText(m.content || '');
              if (m.mediaType && m.mediaType !== 'text') {
                const mediaIcons = { image: '🖼️ Image', video: '🎥 Video', voice: '🎤 Voice', audio: '🎵 Audio', document: '📄 Document', sticker: '😊 Sticker', location: '📍 Location' };
                const label = mediaIcons[m.mediaType] || m.mediaType;
                bodyText = `<span style="opacity:0.7">[${escapeHtml(label)}]</span> ${bodyText}`.trim();
              }

              // Escape quotes in parameters
              const safeMsgId = m.id.replace(/'/g, "\\'");

              return `
                <div class="chat-search-result-item" onclick="scrollToOrLoadMessage('${safeMsgId}', ${m.timestamp})">
                  <div class="chat-search-result-header">
                    <span class="chat-search-result-sender">${escapeHtml(sender)}</span>
                    <span class="chat-search-result-time">${escapeHtml(dateStr)}</span>
                  </div>
                  <div class="chat-search-result-body">${bodyText}</div>
                </div>
              `;
            }).join('');
          }
        } catch (e) {
          resultsEl.innerHTML = `<div class="chat-search-empty" style="color:var(--danger)">Error: ${e.message}</div>`;
        }
      }, 300);
    }

    async function scrollToOrLoadMessage(messageId, timestamp) {
      console.log('[FlagJump] scrollToOrLoadMessage start. messageId=', messageId, 'activeChat?.id=', activeChat?.id, 'rowsInDom=', document.querySelectorAll('.messages-area .message-row').length);
      let el = document.getElementById('msg-' + messageId);
      if (el) {
        const expected = flaggedList.find(i => i.messageId === messageId);
        console.log('[FlagJump] message already in DOM, scrolling directly');
        console.log('[FlagJump] EXPECTED (from flaggedList):', {
          jid: expected?.jid,
          messageId: expected?.messageId,
          note: expected?.note,
          flaggedAt: expected?.flaggedAt,
        });
        console.log('[FlagJump] ACTUAL row found:', {
          id: el.id,
          timestamp: el.dataset.timestamp,
          fromMe: el.dataset.fromMe,
          content: el.dataset.content,
          text: el.querySelector('.msg-text')?.textContent,
          sender: el.querySelector('.msg-sender')?.textContent,
        });
        scrollToMessage(messageId);
        return;
      }

      // Not in DOM. We need to load older messages.
      showToast('Loading older messages to locate match...', 'info');

      let attempts = 0;
      const maxAttempts = 10;
      while (!el && attempts < maxAttempts) {
        const firstMsgRow = document.querySelector('.messages-area .message-row');
        const before = firstMsgRow?.dataset.timestamp || null;
        console.log('[FlagJump] loop attempt', attempts, 'before=', before, 'firstMsgRow exists=', !!firstMsgRow);
        if (!before) {
          console.log('[FlagJump] BREAKING: no "before" cursor available (empty messages area or missing timestamp)');
          break;
        }

        try {
          let url = `${bridgeUrl}/api/messages?jid=${encodeURIComponent(activeChat.id)}&limit=50`;
          if (before) url += `&before=${encodeURIComponent(before)}`;
          console.log('[FlagJump] fetching', url);
          const res = await fetch(url);
          const data = await res.json();
          const msgs = data.messages || data;
          console.log('[FlagJump] fetch result: got', msgs.length, 'messages, hasMore=', data.hasMore);
          if (!msgs.length) {
            chatHasMore[activeChat.id] = false;
            document.getElementById('loadMoreIndicator').style.display = 'none';
            console.log('[FlagJump] BREAKING: server returned 0 older messages');
            break;
          }
          chatHasMore[activeChat.id] = data.hasMore !== false;
          document.getElementById('loadMoreIndicator').style.display = chatHasMore[activeChat.id] ? 'block' : 'none';

          // Prepend messages in reverse order to maintain correct scroll position and sequence
          msgs.reverse().forEach(m => {
            appendMessage(normalizeMessage(m), false, true);
          });
          refreshDateSeparators();

          el = document.getElementById('msg-' + messageId);
          if (el) {
            console.log('[FlagJump] FOUND message after loading older batch');
            break;
          }
        } catch (e) {
          console.error('[FlagJump] fetch error', e);
          break;
        }
        attempts++;
      }

      if (el) {
        scrollToMessage(messageId);
      } else {
        console.log('[FlagJump] GIVING UP after', attempts, 'attempts - message not found');
        showToast('Could not find the message in history', 'error');
      }
    }

    function openChat(chat, itemEl) {
      activeChat = chat;
      toggleChatSearch(false);
      cancelEdit();
      cancelReply();
      updateChatItemHighlight();
      document.getElementById('emptyState').style.display = 'none';
      const cv = document.getElementById('chatView');
      cv.style.display = 'flex';
      renderChatHeader();
      clearMessages();
      document.getElementById('loadMoreIndicator').style.display = 'none';

      // Request messages from server
      if (socket?.connected) {
        socket.emit('open_chat', { jid: chat.id });
      }

      // Transition to chat view on mobile
      const main = document.querySelector('.main');
      if (main) {
        main.classList.remove('view-chats');
        main.classList.remove('view-panel');
        main.classList.add('view-chat');
      }
      closeMobileMenu();
    }

    function updateChatItemHighlight() {
      document.querySelectorAll('.chat-item').forEach(el => {
        if (activeChat && el.getAttribute('data-jid') === activeChat.id) {
          el.classList.add('active');
        } else {
          el.classList.remove('active');
        }
      });
    }

    function clearMessages() {
      const area = document.getElementById('messagesArea');
      area.innerHTML = '';
      // Re-add load-more indicator
      const div = document.createElement('div');
      div.className = 'load-more-indicator';
      div.id = 'loadMoreIndicator';
      div.style.display = 'none';
      div.innerHTML = '<button class="load-more-btn" onclick="loadMoreMessages()">↑ Load older messages</button>';
      area.appendChild(div);
    }

    async function claimActiveChat() {
      if (!activeChat || !socket?.connected) return;
      try {
        const res = await fetch(`${bridgeUrl}/api/chats/${encodeURIComponent(activeChat.id)}/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...operatorHeaders() },
          body: JSON.stringify({ operatorId, operatorName }),
        });
        const data = await parseJsonResponse(res);
        if (!res.ok) throw new Error(data.error || 'Unable to claim conversation');
        upsertChatRecord(data.chat);
        syncActiveChat();
        renderChatHeader();
        renderChatList(allChats);
        showToast('Conversation claimed');
      } catch (e) {
        showToast(e.message, 'error');
      }
    }

    async function releaseActiveChat() {
      if (!activeChat || !socket?.connected) return;
      try {
        const res = await fetch(`${bridgeUrl}/api/chats/${encodeURIComponent(activeChat.id)}/release`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...operatorHeaders() },
          body: JSON.stringify({ operatorId, operatorName }),
        });
        const data = await parseJsonResponse(res);
        if (!res.ok) throw new Error(data.error || 'Unable to release conversation');
        upsertChatRecord(data.chat);
        syncActiveChat();
        renderChatHeader();
        renderChatList(allChats);
        showToast('Conversation released');
      } catch (e) {
        showToast(e.message, 'error');
      }
    }

    // ─── Message Rendering ────────────────────────────────────────────────────────
    function buildMediaContent(msg) {
      const hasMedia = msg.mediaUrl && msg.mediaUrl !== 'null';
      switch (msg.mediaType) {
        case 'image':
          if (!hasMedia) {
            return `<div class="msg-media-placeholder" onclick="downloadMediaOnDemand('${msg.jid}', '${msg.id}', this, 'image')">
              <div class="placeholder-icon">🖼️</div>
              <div class="placeholder-text">Click to load image</div>
            </div>`;
          }
          return `<img class="msg-image" src="${msg.mediaUrl}" alt="Image" onclick="openLightbox('${msg.mediaUrl}')">
              <div class="msg-text">${formatWhatsAppText(msg.content || '')}</div>`;
        case 'video':
          if (!hasMedia) {
            return `<div class="msg-media-placeholder" onclick="downloadMediaOnDemand('${msg.jid}', '${msg.id}', this, 'video')">
              <div class="placeholder-icon">🎥</div>
              <div class="placeholder-text">Click to load video</div>
            </div>`;
          }
          return `<video class="msg-video" controls><source src="${msg.mediaUrl}"></video>
              <div class="msg-text">${formatWhatsAppText(msg.content || '')}</div>`;
        case 'voice':
        case 'audio':
          if (!hasMedia) {
            return `<div style="margin-bottom:4px;font-size:11px;opacity:0.7">${msg.mediaType === 'voice' ? '🎤 Voice Message' : '🎵 Audio'}</div>
            <div class="msg-media-placeholder" onclick="downloadMediaOnDemand('${msg.jid}', '${msg.id}', this, 'audio')">
              <div class="placeholder-text">Click to load audio</div>
            </div>`;
          }
          return `<div style="margin-bottom:4px;font-size:11px;opacity:0.7">${msg.mediaType === 'voice' ? '🎤 Voice Message' : '🎵 Audio'}</div>
              <audio class="msg-audio" controls><source src="${msg.mediaUrl}"></audio>`;
        case 'document':
          if (!hasMedia) {
            return `<div class="msg-document-placeholder" onclick="downloadMediaOnDemand('${msg.jid}', '${msg.id}', this, 'document')">
        <div class="doc-icon">${getDocIcon(msg.fileName || msg.content)}</div>
        <div>
          <div class="doc-name">${msg.fileName || msg.content || 'Document'}</div>
          <div class="doc-size">Click to load document</div>
        </div>
      </div>`;
          }
          return `<a class="msg-document" href="${msg.mediaUrl}" target="_blank" download>
        <div class="doc-icon">${getDocIcon(msg.fileName || msg.content)}</div>
        <div>
          <div class="doc-name">${msg.fileName || msg.content || 'Document'}</div>
          <div class="doc-size">Tap to download</div>
        </div>
      </a>`;
        case 'sticker':
          if (!hasMedia) {
            return `<div class="msg-media-placeholder sticker-placeholder" onclick="downloadMediaOnDemand('${msg.jid}', '${msg.id}', this, 'sticker')">
              <div class="placeholder-text">Click to load sticker</div>
            </div>`;
          }
          return `<img class="msg-sticker" src="${msg.mediaUrl}" alt="Sticker">`;
        case 'location':
          return `<a class="msg-location" href="${msg.mediaUrl}" target="_blank">
        <div style="font-size:24px">📍</div>
        <div><div style="font-size:13px;font-weight:600">${msg.content || 'Location'}</div><div style="font-size:11px;opacity:0.6">Open in Maps</div></div>
      </a>`;
        default:
          return `<div class="msg-text">${formatWhatsAppText(msg.content || '')}</div>`;
      }
    }

    /**
     * Build the quoted-message preview HTML to embed inside a message bubble.
     * Clicking the preview scrolls to the original message if it's loaded.
     */
    function buildQuotedPreviewHtml(msg) {
      if (!msg.quotedMessageId) return '';
      const mediaIcons = {
        image: '🖼️', video: '🎥', voice: '🎤', audio: '🎵',
        document: '📄', sticker: '😊', location: '📍',
      };
      const icon = mediaIcons[msg.quotedMediaType] || '';
      const quotedSenderDisplay = msg.quotedSender ? cleanJid(msg.quotedSender) : (msg.fromMe ? 'You' : 'Them');
      const quotedTextRaw = msg.quotedContent
        ? (msg.quotedContent.length > 80 ? msg.quotedContent.slice(0, 80) + '…' : msg.quotedContent)
        : (msg.quotedMediaType && msg.quotedMediaType !== 'text' ? `${icon} ${msg.quotedMediaType}` : '…');
      const quotedText = formatWhatsAppText(quotedTextRaw);
      const mediaTag = (msg.quotedMediaType && msg.quotedMediaType !== 'text')
        ? `<span class="msg-quoted-media-tag">${icon} ${msg.quotedMediaType.charAt(0).toUpperCase() + msg.quotedMediaType.slice(1)}</span> `
        : '';
      return `
        <div class="msg-quoted" onclick="scrollToMessage('${msg.quotedMessageId}')">
          <div class="msg-quoted-accent"></div>
          <div class="msg-quoted-body">
            <div class="msg-quoted-sender">${escapeHtml(quotedSenderDisplay)}</div>
            <div class="msg-quoted-text">${mediaTag}${quotedText}</div>
          </div>
        </div>`;
    }

    function getSenderColor(name) {
      if (!name) return 'var(--accent)';
      let hash = 0;
      for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
      }
      const hue = Math.abs(hash) % 360;
      return `hsl(${hue}, 85%, 65%)`;
    }

    function appendMessage(msg, scroll = true, prepend = false, isUnreadTarget = false) {
      const area = document.getElementById('messagesArea');
      // Check for duplicate
      if (document.getElementById('msg-' + msg.id)) return;

      // Filter deleted messages
      if (msg.deleted) {
        // Only show deletion placeholder
      }

      const outgoing = msg.fromMe || msg.outgoing || false;
      const row = document.createElement('div');
      row.id = 'msg-' + msg.id;
      row.className = 'message-row ' + (outgoing ? 'outgoing' : 'incoming');
      
      const isGroup = activeChat?.type === 'group' || activeChat?.type === 'community';
      if (isGroup) {
        row.classList.add('group-msg');
      }

      if (isUnreadTarget) {
        row.classList.add('unread-target');
      }
      if (msg.isFlagged) {
        row.classList.add('flagged-msg');
      }

      row.dataset.timestamp = msg.timestamp || '';
      row.dataset.fromMe = outgoing ? '1' : '0';
      row.dataset.mediaType = msg.mediaType || 'text';
      row.dataset.deleted = msg.deleted ? '1' : '0';
      row.dataset.content = msg.content || '';
      row.dataset.status = msg.status !== undefined ? msg.status : '';
      if (msg.quotedMessageId) row.dataset.quotedMessageId = msg.quotedMessageId;
      row.dataset.operatorId = msg.operatorId || '';
      row.dataset.operatorName = msg.operatorName || '';
      row.dataset.edits = JSON.stringify(msg.edits || []);

      let resolvedSender = cleanJid(msg.sender);
      const senderName = outgoing
        ? (msg.operatorName || resolvedSender || 'Unknown')
        : (resolvedSender || (msg.participant ? cleanJid(msg.participant) : 'Unknown'));

      let displaySenderName = senderName;
      let tooltipText = '';
      if (outgoing && msg.operatorName) {
        tooltipText = `Sent by ${msg.operatorName}`;
        if (msg.edits && msg.edits.length > 0) {
          const uniqueEdits = [];
          for (const e of msg.edits) {
            const isDup = uniqueEdits.some(ue => 
              ue.operatorId === e.operatorId && 
              Math.abs(ue.editedAt - e.editedAt) < 3000
            );
            if (!isDup) {
              uniqueEdits.push(e);
            }
          }

          const hasEditByOther = uniqueEdits.some(e => e.operatorId && e.operatorId !== msg.operatorId);
          if (hasEditByOther) {
            const lastEdit = uniqueEdits[uniqueEdits.length - 1];
            displaySenderName = `${senderName} (edited by ${lastEdit.operatorName || lastEdit.operatorId})`;
          }
          const editLines = uniqueEdits.map(e => `edited by ${e.operatorName || e.operatorId || 'Unknown'}`);
          tooltipText += `, ${editLines.join(', ')}`;
        }
      }

      const initialName = outgoing
        ? (msg.operatorName || operatorName || '?')
        : (activeChat && activeChat.type !== 'group' && activeChat.type !== 'community' && activeChat.name
          ? activeChat.name
          : (msg.sender || msg.participant || '?'));
      const cleanInitialName = cleanJid(initialName).replace('+', '');
      const initial = (cleanInitialName || '?')[0].toUpperCase();
      const timeStr = msg.time || (msg.timestamp ? formatTime(new Date(msg.timestamp * 1000)) : '');
      const fullDateTimeStr = msg.timestamp ? formatFullDateTime(msg.timestamp) : '';
      const editedMark = msg.editedAt ? '<div class="msg-edited">(edited)</div>' : '';
      const showSender = (!outgoing && isGroup) || (outgoing && Boolean(msg.operatorName));
      let contentHtml;
      if (msg.deleted) {
        contentHtml = '<div class="msg-deleted">This message was deleted</div>';
      } else {
        let flagBanner = '';
        if (msg.isFlagged) {
          flagBanner = `
            <div class="msg-flag-banner">
              <span>🚩 Flagged by ${msg.flaggedByOperatorName || 'Team'}</span>
              ${msg.flaggedNote ? `<span class="msg-flag-note">("${msg.flaggedNote}")</span>` : ''}
            </div>
          `;
        }
        contentHtml = flagBanner + buildQuotedPreviewHtml(msg) + buildMediaContent(msg);
      }

      const allowReply = !msg.deleted && !isChatReadOnly(activeChat);
      const allowEdit = canEditMessage(msg);
      const allowDelete = canDeleteForEveryone(msg);

      // Render status ticks for outgoing messages
      let statusHtml = '';
      if (outgoing && !msg.deleted) {
        statusHtml = getTickHtml(msg.status, msg.timestamp, msg.id);

      }

      let msgAvatarType = 'personal';
      if (outgoing) {
        msgAvatarType = 'operator';
      } else if (isGroup) {
        msgAvatarType = 'group';
      } else if (activeChat) {
        if (activeChat.type === 'community') msgAvatarType = 'community';
        else if (activeChat.type === 'channel' || activeChat.id.endsWith('@newsletter')) msgAvatarType = 'channel';
      }

      const senderColor = isGroup ? getSenderColor(msg.sender || msg.participant) : 'var(--accent)';

      let msgAvatarContent = initial;
      if (msgAvatarType === 'channel') {
        msgAvatarContent = getAvatarContent('channel', initial);
      } else if (msgAvatarType === 'community') {
        msgAvatarContent = getAvatarContent('community', initial);
      }

      const resolveFlagHtml = msg.isFlagged ? `<button class="btn-ghost-sm btn-resolve-flag" style="color:var(--danger)" onclick="resolveFlagDirect('${msg.id}', '${activeChat?.id}')">🚩 Resolve</button>` : '';

      row.innerHTML = `
    <div class="msg-avatar ${msgAvatarType}">${msgAvatarContent}</div>
    <div class="msg-bubble">
      ${showSender ? `<div class="msg-sender" title="${tooltipText}" style="color: ${senderColor}">${displaySenderName}</div>` : ''}
      ${contentHtml}
      ${msg.deleted ? '' : `<div class="msg-time" title="${fullDateTimeStr}">${timeStr}${editedMark}${statusHtml}</div>`}
      ${!msg.deleted && (allowReply || allowEdit || allowDelete || msg.isFlagged) ? `
        <div class="msg-actions">
          ${allowReply ? `<button class="btn-ghost-sm" onclick="startReply('${msg.id}')">↩ Reply</button>` : ''}
          ${allowEdit ? `<button class="btn-ghost-sm" onclick="startEdit('${msg.id}')">✎ Edit</button>` : ''}
          ${allowDelete ? `<button class="btn-ghost-sm" style="color:var(--danger)" onclick="startDelete('${msg.id}')">🗑 Delete</button>` : ''}
          ${resolveFlagHtml}
        </div>` : ''}
    </div>
  `;

      if (prepend) {
        area.insertBefore(row, area.children[1]); // after load-more indicator
      } else {
        area.appendChild(row);
      }
      if (scroll) area.scrollTop = area.scrollHeight;
    }

    function updateMessageInPlace(messageId, newContent, editedAt, edits) {
      const row = document.getElementById('msg-' + messageId);
      if (!row) return;
      // newContent is null when we know an edit happened but couldn't recover the
      // new text (e.g. undecryptable) - keep showing the existing content in that case.
      const contentKnown = newContent !== null && newContent !== undefined;
      if (contentKnown) {
        row.dataset.content = newContent;
      }
      if (edits) {
        row.dataset.edits = JSON.stringify(edits);
      }
      const bubble = row.querySelector('.msg-bubble');
      if (!bubble) return;
      // Update content
      const contentDiv = bubble.querySelector('.msg-text');
      if (contentDiv && contentKnown) {
        contentDiv.innerHTML = formatWhatsAppText(newContent);
      }
      // Add/update edited mark
      const timeDiv = bubble.querySelector('.msg-time');
      if (timeDiv) {
        const existing = timeDiv.querySelector('.msg-edited');
        if (existing) existing.remove();
        timeDiv.insertAdjacentHTML('beforeend', '<span class="msg-edited"> (edited)</span>');
      }

      // Update sender name & tooltip
      const senderDiv = bubble.querySelector('.msg-sender');
      if (senderDiv) {
        const originalOperatorId = row.dataset.operatorId || '';
        const originalOperatorName = row.dataset.operatorName || '';
        const currentEdits = JSON.parse(row.dataset.edits || '[]');
        
        let displaySenderName = originalOperatorName || 'You';
        let tooltipText = `Sent by ${originalOperatorName || 'You'}`;
        
        if (currentEdits.length > 0) {
          const uniqueEdits = [];
          for (const e of currentEdits) {
            const isDup = uniqueEdits.some(ue => 
              ue.operatorId === e.operatorId && 
              Math.abs(ue.editedAt - e.editedAt) < 3000
            );
            if (!isDup) {
              uniqueEdits.push(e);
            }
          }

          const hasEditByOther = uniqueEdits.some(e => e.operatorId && e.operatorId !== originalOperatorId);
          if (hasEditByOther) {
            const lastEdit = uniqueEdits[uniqueEdits.length - 1];
            displaySenderName = `${originalOperatorName || 'You'} (edited by ${lastEdit.operatorName || lastEdit.operatorId})`;
          }
          
          const editLines = uniqueEdits.map(e => `edited by ${e.operatorName || e.operatorId || 'Unknown'}`);
          tooltipText += `, ${editLines.join(', ')}`;
        }
        
        senderDiv.textContent = displaySenderName;
        senderDiv.setAttribute('title', tooltipText);
      }
    }

    // ─── Shared tick rendering ────────────────────────────────────────────────
    // Single source of truth for status tick icons and classes. Used by both
    // the initial message render and the live updateTickElement() function so
    // they are always visually identical.
    function getTickHtml(status, timestamp, id) {
      const ageSeconds = timestamp ? (Math.floor(Date.now() / 1000) - Number(timestamp)) : 0;
      let tickIcon = '';
      let tickClass = 'status-sent';
      let tooltip = 'Sent';

      if (status === 0 || status === 'failed') {
        tickIcon = `<svg class="tick-svg status-failed-svg" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle;"><circle cx="8" cy="8" r="7"/><line x1="8" y1="5" x2="8" y2="9"/><line x1="8" y1="12" x2="8.01" y2="12" stroke-width="2.5"/></svg>`;
        tickClass = 'status-failed';
        tooltip = 'Failed to send';
      } else if ((status === 1 || status === 'pending') && ageSeconds < 60) {
        tickIcon = '🕒';
        tickClass = 'status-pending';
        tooltip = 'Pending...';
      } else if (status === 2 || status === 'sent') {
        tickIcon = `<svg class="tick-svg" viewBox="0 0 16 11" width="12" height="9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle;"><path d="M1 5.5L5 9.5L15 1.5"/></svg>`;
        tickClass = 'status-sent';
        tooltip = 'Sent';
      } else if (status === 3 || status === 'delivered') {
        tickIcon = `<svg class="tick-svg" viewBox="0 0 19 11" width="15" height="9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle;"><path d="M1 5.5L5 9.5L10 4.5 M8 5.5L11.5 9L18 1.5"/></svg>`;
        tickClass = 'status-delivered';
        tooltip = 'Delivered';
      } else if (status === 4 || status === 'read' || status === 5 || status === 'played') {
        tickIcon = `<svg class="tick-svg" viewBox="0 0 19 11" width="15" height="9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle;"><path d="M1 5.5L5 9.5L10 4.5 M8 5.5L11.5 9L18 1.5"/></svg>`;
        tickClass = 'status-read';
        tooltip = 'Read';
      } else {
        // Stale pending or unrecognized — show single grey tick
        tickIcon = `<svg class="tick-svg" viewBox="0 0 16 11" width="12" height="9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle;"><path d="M1 5.5L5 9.5L15 1.5"/></svg>`;
        tickClass = 'status-sent';
        tooltip = 'Sent';
      }

      const idAttr = id ? ` id="status-tick-${id}"` : '';
      return `<span class="msg-status-ticks ${tickClass}"${idAttr} title="${tooltip}">${tickIcon}</span>`;
    }

    function updateMessageStatusInUI(messageId, status) {
      const row = document.getElementById('msg-' + messageId);
      if (!row) return;

      row.dataset.status = status;

      const tickEl = document.getElementById('status-tick-' + messageId);
      if (!tickEl) {
        const timeDiv = row.querySelector('.msg-time');
        if (timeDiv && row.dataset.fromMe === '1') {
          const span = document.createElement('span');
          span.id = 'status-tick-' + messageId;
          timeDiv.appendChild(span);
          updateTickElement(span, status, row.dataset.timestamp);
        }
      } else {
        updateTickElement(tickEl, status, row.dataset.timestamp);
      }
    }

    function updateTickElement(el, status, timestamp) {
      const html = getTickHtml(status, timestamp);
      // Parse out just the class, innerHTML, and title from the generated HTML
      const tmp = document.createElement('span');
      tmp.innerHTML = html;
      const src = tmp.firstChild;
      if (src) {
        el.className = src.className;
        el.innerHTML = src.innerHTML;
        el.title = src.title;
      }
    }

    function markMessageDeleted(messageId) {
      const row = document.getElementById('msg-' + messageId);
      if (!row) return;
      row.dataset.deleted = '1';
      row.dataset.content = '';
      const bubble = row.querySelector('.msg-bubble');
      if (!bubble) return;
      bubble.innerHTML = '<div class="msg-deleted">This message was deleted</div>';
    }

    // ─── Chat Messages Loaded ────────────────────────────────────────────────────
    function onChatMessagesLoaded(data) {
      console.log('[FlagJump] onChatMessagesLoaded fired. data.jid=', data.jid, 'activeChat?.id=', activeChat?.id, 'pendingScrollToMessageId=', pendingScrollToMessageId);
      if (!activeChat || data.jid !== activeChat.id) {
        console.log('[FlagJump] onChatMessagesLoaded GUARD BLOCKED (jid mismatch or no activeChat) - messages NOT rendered for this response');
        return;
      }
      if (data.chat) {
        upsertChatRecord(data.chat);
        syncActiveChat();
        renderChatHeader();
        renderChatList(allChats);
      }
      chatMessageCounts[data.jid] = data.total;
      chatHasMore[data.jid] = data.hasMore;
      // Note: statMessages reflects the system-wide total (via the 'stats' socket
      // event), not this chat's message count - do not overwrite it with data.total here.

      clearMessages();
      document.getElementById('loadMoreIndicator').style.display = data.hasMore ? 'block' : 'none';

      // Setup unread count logic
      const messages = data.messages || [];
      const incomingIndices = [];
      messages.forEach((m, idx) => {
        if (!m.fromMe && !m.outgoing && !m.deleted) {
          incomingIndices.push(idx);
        }
      });
      
      const unreadCount = Number(data.chat?.unreadCount || 0);
      const unreadMsgIds = new Set();
      let firstUnreadIdx = -1;
      
      if (unreadCount > 0 && incomingIndices.length > 0) {
        const startIndex = Math.max(0, incomingIndices.length - unreadCount);
        const unreadIndices = incomingIndices.slice(startIndex);
        unreadIndices.forEach(idx => {
          unreadMsgIds.add(messages[idx].id);
        });
        if (unreadIndices.length > 0) {
          firstUnreadIdx = unreadIndices[0];
        }
      }

      initScrollObserver();

      messages.forEach((m, idx) => {
        const isUnread = unreadMsgIds.has(m.id);
        
        // Append unread divider before first unread message
        if (idx === firstUnreadIdx) {
          const area = document.getElementById('messagesArea');
          const divider = document.createElement('div');
          divider.className = 'unread-divider';
          divider.innerHTML = `<span class="unread-divider-text">Unread Messages</span>`;
          area.appendChild(divider);
        }

        appendMessage(normalizeMessage(m), false, false, isUnread);

        // Observe the appended row if it is unread
        if (isUnread && unreadObserver) {
          const row = document.getElementById('msg-' + m.id);
          if (row) unreadObserver.observe(row);
        }
      });
      refreshDateSeparators();

      const area = document.getElementById('messagesArea');

      // If there are unread messages, scroll to the unread divider or the first unread message
      if (firstUnreadIdx >= 0 && messages[firstUnreadIdx]) {
        const targetRow = document.getElementById('msg-' + messages[firstUnreadIdx].id);
        if (targetRow) {
          targetRow.scrollIntoView({ behavior: 'auto', block: 'center' });
        } else {
          area.scrollTop = area.scrollHeight;
        }
      } else {
        area.scrollTop = area.scrollHeight;
      }
      
      document.getElementById('statMessages').textContent = data.total;
      // Update chat list preview
      if (data.messages.length) {
        const last = data.messages[data.messages.length - 1];
        const existing = allChats.find(c => c.id === activeChat.id);
        if (existing && last) {
          existing.lastMsg = last.content || '';
          existing.timestamp = last.timestamp;
        }
      }

      // Handle pending scroll-to message (from clicking flagged list)
      if (pendingScrollToMessageId) {
        const targetId = pendingScrollToMessageId;
        const targetTimestamp = pendingScrollToMessageTimestamp;
        pendingScrollToMessageId = null;
        pendingScrollToMessageTimestamp = null;
        setTimeout(() => {
          scrollToOrLoadMessage(targetId, targetTimestamp);
        }, 100);
      }
    }

    function normalizeMessage(m) {
      let sender = cleanJid(m.sender || '');
      if (!sender) {
        const part = m.participant || m.from;
        if (part) {
          sender = cleanJid(part);
        }
      }
      return {
        id: m.id,
        sender: sender || 'Unknown',
        participant: m.participant,
        content: m.content,
        time: m.timestamp ? formatTime(new Date(m.timestamp * 1000)) : '',
        timestamp: m.timestamp,
        outgoing: m.fromMe || false,
        fromMe: m.fromMe || false,
        operatorId: m.operatorId || null,
        operatorName: m.operatorName || null,
        mediaType: m.mediaType || 'text',
        mediaUrl: m.mediaUrl ? (m.mediaUrl.startsWith('http') ? m.mediaUrl : `${bridgeUrl}${m.mediaUrl}`) : null,
        fileName: m.fileName,
        mimetype: m.mimetype,
        editedAt: m.editedAt,
        deleted: m.deleted || false,
        quotedMessageId: m.quotedMessageId || null,
        quotedContent: m.quotedContent || null,
        quotedSender: m.quotedSender || null,
        quotedMediaType: m.quotedMediaType || null,
        status: m.status !== undefined ? m.status : null,
        edits: m.edits || [],
        isFlagged: m.isFlagged || false,
        flaggedByOperatorId: m.flaggedByOperatorId || null,
        flaggedByOperatorName: m.flaggedByOperatorName || null,
        flaggedNote: m.flaggedNote || null,
        flaggedAt: m.flaggedAt || null,
      };
    }

    function loadMoreMessages() {
      if (!activeChat || !socket) return;
      const jid = activeChat.id;
      const area = document.getElementById('messagesArea');
      const firstMsgRow = area.querySelector('.message-row');
      const before = firstMsgRow?.dataset.timestamp || null;

      (async () => {
        try {
          if (chatHasMore[jid] === false) {
            showToast('No more messages to load', 'error');
            return;
          }
          let url = `${bridgeUrl}/api/messages?jid=${encodeURIComponent(jid)}&limit=30`;
          if (before) url += `&before=${encodeURIComponent(before)}`;
          const res = await fetch(url);
          const data = await res.json();
          const msgs = data.messages || data;
          if (!msgs.length) {
            chatHasMore[jid] = false;
            document.getElementById('loadMoreIndicator').style.display = 'none';
            return;
          }
          chatHasMore[jid] = data.hasMore !== false;
          document.getElementById('loadMoreIndicator').style.display = chatHasMore[jid] ? 'block' : 'none';

          // Prepending grows the content above what's currently in view, but
          // scrollTop (a pixel offset) doesn't move with it - the browser
          // ends up showing different messages than before the load, landing
          // near the top of what just got added. Anchor scrollTop by the
          // exact height added above so the messages the user was reading
          // stay in the same visual spot, and they can keep scrolling up
          // into the newly loaded history naturally.
          const prevScrollHeight = area.scrollHeight;
          const prevScrollTop = area.scrollTop;

          // Prepend each message (oldest first in response, prepend to maintain order)
          msgs.reverse().forEach(m => {
            appendMessage(normalizeMessage(m), false, true);
          });
          refreshDateSeparators();

          area.scrollTop = prevScrollTop + (area.scrollHeight - prevScrollHeight);
        } catch (e) { showToast('Failed to load messages', 'error'); }
      })();
    }

    // ─── Message Actions (Edit / Delete / Reply) ──────────────────────────────────
    function startReply(messageId) {
      if (!activeChat) return;
      const row = document.getElementById('msg-' + messageId);
      if (!row) return;
      const fromMe = row.dataset.fromMe === '1';
      const content = row.dataset.content || '';
      // Resolve sender label
      const senderEl = row.querySelector('.msg-sender');
      const senderName = senderEl ? senderEl.textContent : (fromMe ? (operatorName || 'You') : (activeChat?.name || 'Them'));
      const mediaType = row.dataset.mediaType || 'text';

      replyingToMessage = { id: messageId, content, sender: senderName, fromMe, mediaType };

      const replyBar = document.getElementById('replyBar');
      replyBar.classList.add('visible');
      document.getElementById('replyBarSender').textContent = fromMe ? 'You' : senderName;
      const mediaIcons = { image: '🖼️', video: '🎥', voice: '🎤', audio: '🎵', document: '📄', sticker: '😊', location: '📍' };
      const icon = mediaIcons[mediaType] || '';
      const preview = content
        ? (content.length > 60 ? content.slice(0, 60) + '…' : content)
        : (mediaType !== 'text' ? `${icon} ${mediaType}` : '…');
      document.getElementById('replyBarText').innerHTML = (mediaType !== 'text' ? `${icon} ` : '') + formatWhatsAppText(preview);

      document.getElementById('messageInput').focus();
    }

    function cancelReply() {
      replyingToMessage = null;
      document.getElementById('replyBar').classList.remove('visible');
    }

    /**
     * Scroll to a message in the chat area (used when clicking a quoted preview).
     */
    function scrollToMessage(messageId) {
      const el = document.getElementById('msg-' + messageId);
      if (!el) {
        showToast('Original message not loaded', 'info');
        return;
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Flash highlight
      el.classList.add('msg-highlight');
      setTimeout(() => el.classList.remove('msg-highlight'), 1200);
    }

    function startEdit(messageId) {
      if (!activeChat) return;
      const msg = getRenderedMessage(messageId);
      if (!canEditMessage(msg)) {
        showToast('Edit window expired (15 minutes)', 'error');
        return;
      }
      editingMessageId = messageId;
      editingMessageJid = activeChat.id;
      document.getElementById('editingBar').classList.add('visible');
      const currentContent = msg.content || '';
      document.getElementById('editingBarText').textContent = 'Editing: ' + (currentContent.length > 40 ? currentContent.substring(0, 40) + '…' : currentContent);
      setComposerText(document.getElementById('messageInput'), currentContent);
      document.getElementById('sendBtn').querySelector('svg').innerHTML = '<path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/>';
    }

    function cancelEdit() {
      editingMessageId = null;
      editingMessageJid = null;
      document.getElementById('editingBar').classList.remove('visible');
      clearComposer(document.getElementById('messageInput'));
      document.getElementById('sendBtn').querySelector('svg').innerHTML = '<path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>';
    }

    function startDelete(messageId) {
      const msg = getRenderedMessage(messageId);
      if (!canDeleteForEveryone(msg)) {
        showToast('Delete for everyone window expired (60 hours)', 'error');
        return;
      }
      showConfirm('Delete this message for everyone?', () => {
        deleteMessage(messageId);
      });
    }

    function deleteMessage(messageId) {
      if (!socket?.connected || !activeChat) return;
      const msg = getRenderedMessage(messageId);
      if (!canDeleteForEveryone(msg)) {
        showToast('Delete for everyone window expired (60 hours)', 'error');
        return;
      }
      socket.emit('delete_message', { jid: activeChat.id, messageId });
    }

    // ─── Send ─────────────────────────────────────────────────────────────────────
    async function sendMessage() {
      if (!activeChat) return;
      if (isChatReadOnly(activeChat)) {
        showToast("You can't send messages because you're no longer in this group", 'error');
        return;
      }
      if (isAssignedToOther(activeChat)) {
        showToast(`Conversation locked by ${activeChat.assignedOperatorName || activeChat.assignedOperatorId}`, 'error');
        return;
      }

      // If editing
      if (editingMessageId) {
        await sendEdit();
        return;
      }

      // Send media if pending
      if (pendingMediaList.length > 0) {
        await sendMedia();
        return;
      }

      const input = document.getElementById('messageInput');
      const text = getComposerText(input).trim();
      if (!text) return;

      const tempId = genTempId();
      const quotedMessageId = replyingToMessage?.id || null;

      if (socket?.connected) {
        socket.emit('send_message', { jid: activeChat.id, text, clientTempId: tempId, quotedMessageId });
      } else {
        showToast('Not connected to bridge', 'error');
        return;
      }

      // Optimistic local append (will be deduped when server broadcast arrives)
      const now = new Date();
      appendMessage({
        id: tempId,
        sender: operatorName,
        operatorName,
        content: text,
        time: formatTime(now),
        timestamp: Math.floor(now.getTime() / 1000),
        outgoing: true,
        fromMe: true,
        mediaType: 'text',
        deleted: false,
        quotedMessageId: replyingToMessage?.id || null,
        quotedContent: replyingToMessage?.content || null,
        quotedSender: replyingToMessage?.sender || null,
        quotedMediaType: replyingToMessage?.mediaType || null,
        status: 1,
      });
      refreshDateSeparators();
      sentTempIds.add(tempId);

      cancelReply();
      clearComposer(input);
    }

    async function sendEdit() {
      if (!socket?.connected || !editingMessageId || !editingMessageJid) return;
      const text = getComposerText(document.getElementById('messageInput')).trim();
      if (!text) return;

      const msg = getRenderedMessage(editingMessageId);
      if (!canEditMessage(msg)) {
        showToast('Edit window expired (15 minutes)', 'error');
        cancelEdit();
        return;
      }

      socket.emit('edit_message', {
        jid: editingMessageJid,
        messageId: editingMessageId,
        newContent: text,
      });

      // Optimistic update
      updateMessageInPlace(editingMessageId, text, Date.now());
      cancelEdit();
      clearComposer(document.getElementById('messageInput'));
    }

    async function sendMedia() {
      if (isAssignedToOther(activeChat)) {
        showToast(`Conversation locked by ${activeChat.assignedOperatorName || activeChat.assignedOperatorId}`, 'error');
        return;
      }

      const mediaItems = [...pendingMediaList];
      const caption = getComposerText(document.getElementById('messageInput')) || '';

      // Clear media preview and input immediately so UI is responsive
      clearMedia();
      clearComposer(document.getElementById('messageInput'));

      // Loop over and send each media item sequentially
      for (let i = 0; i < mediaItems.length; i++) {
        const item = mediaItems[i];
        const { file, type } = item;
        const itemCaption = (i === 0) ? caption : '';
        const tempId = genTempId();

        const previewMsg = {
          id: tempId,
          sender: operatorName,
          operatorName,
          content: itemCaption,
          time: formatTime(new Date()),
          timestamp: Math.floor(Date.now() / 1000),
          outgoing: true,
          fromMe: true,
          mediaType: type,
          mediaUrl: item.previewUrl || null,
          fileName: file.name,
          status: 1,
        };
        appendMessage(previewMsg);
        sentTempIds.add(tempId);

        if (socket) {
          const formData = new FormData();
          formData.append('file', file);
          formData.append('jid', activeChat.id);
          formData.append('clientTempId', tempId);
          if (itemCaption) formData.append('caption', itemCaption);
          if (type === 'document') formData.append('filename', file.name);

          try {
            const res = await fetch(`${bridgeUrl}/api/send/${type}`, {
              method: 'POST',
              headers: operatorHeaders(),
              body: formData
            });
            const data = await res.json();
            if (data.success) {
              showToast(`${type.charAt(0).toUpperCase() + type.slice(1)} sent!`);
            } else {
              showToast(data.error, 'error');
              updateMessageStatusInUI(tempId, 0);
            }
          } catch (e) {
            showToast('Send failed: ' + e.message, 'error');
            updateMessageStatusInUI(tempId, 0);
          }
        } else {
          showToast(`${type} ready to send (connect bridge first)`);
        }
      }
      refreshDateSeparators();
    }

    // ─── Attach Menu ──────────────────────────────────────────────────────────────
    function toggleAttachMenu() {
      document.getElementById('attachMenu').classList.toggle('open');
    }

    function attachMoreMediaDirectly() {
      if (pendingMediaList.length > 0) {
        const lastType = pendingMediaList[pendingMediaList.length - 1].type;
        triggerFileInput(lastType);
      } else {
        toggleAttachMenu();
      }
    }

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.attach-wrap') && !e.target.closest('.attach-more-btn')) {
        document.getElementById('attachMenu').classList.remove('open');
      }
    });

    function triggerFileInput(type) {
      document.getElementById('attachMenu').classList.remove('open');
      document.getElementById('fileInput' + type.charAt(0).toUpperCase() + type.slice(1)).click();
    }

    function handleFileSelected(type, input) {
      if (!input.files || input.files.length === 0) return;

      if (pendingMediaList.length + input.files.length > 100) {
        showToast('Maximum 100 attachments allowed at a time', 'error');
        return;
      }

      for (let i = 0; i < input.files.length; i++) {
        const file = input.files[i];
        const previewUrl = (type === 'image' || type === 'video') ? URL.createObjectURL(file) : null;
        pendingMediaList.push({
          id: genTempId(),
          file,
          type,
          previewUrl
        });
      }

      input.value = '';
      renderMediaPreview();
    }

    function mediaTypeForFile(file) {
      const mime = file.type || '';
      if (mime.startsWith('image/')) return 'image';
      if (mime.startsWith('video/')) return 'video';
      if (mime.startsWith('audio/')) return 'audio';
      return 'document';
    }

    // Shared entry point for dropped and pasted files — same pipeline as the
    // attach menu: classify by MIME, queue in pendingMediaList, show previews.
    // Returns true if at least one file was queued.
    function addFilesToPending(fileList) {
      const files = Array.from(fileList || []).filter(Boolean);
      if (files.length === 0) return false;

      if (!activeChat) {
        showToast('Open a chat before attaching files', 'error');
        return false;
      }
      if (isChatReadOnly(activeChat)) {
        showToast("You can't send messages in this chat", 'error');
        return false;
      }
      const isGroup = activeChat.type === 'group' || activeChat.type === 'community';
      if (!isGroup && isAssignedToOther(activeChat)) {
        showToast(`Conversation locked by ${activeChat.assignedOperatorName || activeChat.assignedOperatorId}`, 'error');
        return false;
      }
      if (pendingMediaList.length + files.length > 100) {
        showToast('Maximum 100 attachments allowed at a time', 'error');
        return false;
      }

      for (let i = 0; i < files.length; i++) {
        let file = files[i];
        const type = mediaTypeForFile(file);
        // Clipboard screenshots come in unnamed — give them a real filename.
        if (type === 'image' && (!file.name || file.name === 'blob' || file.name.startsWith('image'))) {
          const ext = (file.type.split('/')[1] || 'png').split('+')[0];
          try {
            file = new File([file], `screenshot-${Date.now()}-${i}.${ext}`, { type: file.type });
          } catch (err) {
            console.error('Error renaming pasted image:', err);
          }
        }
        const previewUrl = (type === 'image' || type === 'video') ? URL.createObjectURL(file) : null;
        pendingMediaList.push({
          id: genTempId(),
          file,
          type,
          previewUrl
        });
      }

      renderMediaPreview();
      return true;
    }

    function renderMediaPreview() {
      const strip = document.getElementById('mediaPreviewStrip');
      const thumb = document.getElementById('previewThumb');
      thumb.innerHTML = '';

      if (pendingMediaList.length === 0) {
        strip.classList.remove('visible');
        refreshComposerState();
        return;
      }

      strip.style.display = '';
      pendingMediaList.forEach((item) => {
        const itemEl = document.createElement('div');
        itemEl.className = 'preview-item';

        if (item.type === 'image') {
          itemEl.innerHTML = `<img src="${item.previewUrl}" alt="preview"><button type="button" class="remove-btn" onclick="removePendingMediaItem('${item.id}')">✕</button>`;
        } else if (item.type === 'video') {
          itemEl.innerHTML = `<video src="${item.previewUrl}"></video><button type="button" class="remove-btn" onclick="removePendingMediaItem('${item.id}')">✕</button>`;
        } else {
          itemEl.innerHTML = `<div class="preview-doc-chip">${getDocIcon(item.file.name)} ${item.file.name}</div><button type="button" class="remove-btn" onclick="removePendingMediaItem('${item.id}')">✕</button>`;
        }
        thumb.appendChild(itemEl);
      });

      strip.classList.add('visible');
      refreshComposerState();
    }

    function removePendingMediaItem(id) {
      const idx = pendingMediaList.findIndex(item => item.id === id);
      if (idx >= 0) {
        pendingMediaList.splice(idx, 1);
      }
      renderMediaPreview();
    }

    function clearMedia() {
      pendingMediaList = [];
      renderMediaPreview();
    }

    // ─── Location Dialog ──────────────────────────────────────────────────────────
    function showLocationDialog() {
      document.getElementById('attachMenu').classList.remove('open');
      if (activeChat && isAssignedToOther(activeChat)) {
        showToast(`Conversation locked by ${activeChat.assignedOperatorName || activeChat.assignedOperatorId}`, 'error');
        return;
      }
      const lat = prompt('Latitude (e.g. 19.0760):');
      if (!lat) return;
      const lng = prompt('Longitude (e.g. 72.8777):');
      if (!lng) return;
      const name = prompt('Location name (optional):') || '';

      if (socket) {
        const tempId = genTempId();
        fetch(`${bridgeUrl}/api/send/location`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...operatorHeaders() },
          body: JSON.stringify({ jid: activeChat.id, latitude: lat, longitude: lng, name, clientTempId: tempId, operatorId, operatorName }),
        }).then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.success) {
            showToast('Location sent!');
          } else {
            showToast(data.error || 'Failed to send location', 'error');
            updateMessageStatusInUI(tempId, 0);
          }
        }).catch(e => {
          showToast(e.message, 'error');
          updateMessageStatusInUI(tempId, 0);
        });
        appendMessage({
          id: tempId, sender: operatorName, operatorName, content: name || 'Shared location',
          time: formatTime(new Date()), timestamp: Math.floor(Date.now() / 1000), outgoing: true, fromMe: true,
          mediaType: 'location', mediaUrl: `https://maps.google.com/?q=${lat},${lng}`,
          status: 1,
        });
        refreshDateSeparators();
        sentTempIds.add(tempId);
      }
    }

    // ─── Tabs ─────────────────────────────────────────────────────────────────────
    let liveOperators = [];
    let liveGroups = [];

    function switchTab(tab, el) {
      currentTab = tab;
      document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
      el.classList.add('active');
      renderPanel();

      const main = document.querySelector('.main');
      if (main) {
        main.classList.remove('view-chats');
        main.classList.remove('view-chat');
        main.classList.add('view-panel');
      }
      closeMobileMenu();
    }

    function switchToCreate() {
      currentTab = 'create';
      document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
      document.getElementById('createTab').classList.add('active');
      renderPanel();

      const main = document.querySelector('.main');
      if (main) {
        main.classList.remove('view-chats');
        main.classList.remove('view-chat');
        main.classList.add('view-panel');
      }
      closeMobileMenu();
    }

    function renderPanel() {
      const c = document.getElementById('panelContent');

      if (currentTab === 'operators') {
        c.innerHTML = `
      <div style="margin-bottom:12px"><div class="form-label">Live Operators (${liveOperators.length})</div></div>
      ${liveOperators.map(op => `
        <div class="operator-item">
          <div class="operator-dot"></div>
          <div style="flex:1">
            <div class="operator-name">${op.name || op.id}</div>
            <div class="operator-since">Since ${formatDate(op.connectedAt)}</div>
          </div>
          ${op.id === operatorId ? '<span style="font-size:10px;color:var(--accent);font-family:monospace">YOU</span>' : ''}
        </div>`).join('')}`;
        document.getElementById('statOperators').textContent = liveOperators.length;
      }

      else if (currentTab === 'create') {
        c.innerHTML = `
      <div class="form-label" style="margin-bottom:14px">Create New Group</div>
      <div class="form-group">
        <label class="form-label">Group Name</label>
        <input class="form-input" id="newGroupName" placeholder="e.g. Sales Team Q2">
      </div>
      <div class="form-group">
        <label class="form-label">Participants</label>
        <div id="groupChips" class="group-chips"></div>
        <div style="display:flex;gap:6px;margin-top:6px">
          <input class="form-input" id="newGroupNumber" placeholder="+91 98765 43210" style="flex:1"
                 onkeydown="if(event.key==='Enter'){event.preventDefault();addGroupNumber();}">
          <button class="btn btn-ghost" onclick="addGroupNumber()">Add</button>
        </div>
        <div class="form-hint">Full number starting with + and country code (e.g. +919876543210)</div>
      </div>
      <div class="form-group">
        <label class="form-label">Or pick from saved contacts</label>
        <input class="form-input" id="groupContactSearch" placeholder="Search contacts…" oninput="renderGroupContacts(this.value)">
        <div id="groupContactsList" class="group-contacts-list"></div>
      </div>
      <button class="btn btn-primary" style="width:100%" id="createGroupBtn" onclick="createGroup()">Create Group</button>`;
        renderGroupChips();
        loadGroupContacts();
      }

      else if (currentTab === 'flagged') {
        if (flaggedList.length === 0) {
          c.innerHTML = '<div class="flagged-empty">🚩 No flagged messages for attention</div>';
        } else {
          c.innerHTML = `
            <div style="margin-bottom:12px"><div class="form-label">Flagged Messages (${flaggedList.length})</div></div>
            <div class="flagged-list">
              ${flaggedList.map(item => {
                const dateStr = formatDate(item.flaggedAt * 1000);
                const safeMsgId = item.messageId.replace(/'/g, "\\'");
                const safeJid = item.jid.replace(/'/g, "\\'");
                const noteHtml = item.note ? `<div class="flagged-card-note">"${item.note}"</div>` : '';
                const chatName = cleanJid(item.jid);

                const mediaIcons = { image: '🖼️ Image', video: '🎥 Video', voice: '🎤 Voice', audio: '🎵 Audio', document: '📄 Document', sticker: '😊 Sticker', location: '📍 Location' };
                let bodyText;
                if (item.deleted) {
                  bodyText = '🚫 This message was deleted';
                } else if (item.content) {
                  bodyText = item.content;
                } else if (item.mediaType && item.mediaType !== 'text') {
                  bodyText = mediaIcons[item.mediaType] || item.mediaType;
                } else {
                  bodyText = `Message ID: ${item.messageId.slice(0, 8)}...`; // message no longer available
                }

                return `
                  <div class="flagged-card" onclick="jumpToFlaggedMessage('${safeJid}', '${safeMsgId}', ${item.flaggedAt})">
                    <div class="flagged-card-header">
                      <span class="flagged-card-chat-name">${chatName}</span>
                      <span class="flagged-card-flagged-by">by ${item.flaggedByOperatorName || 'unknown'}</span>
                    </div>
                    <div class="flagged-card-body">${bodyText}</div>
                    ${noteHtml}
                    <button class="flagged-card-resolve-btn" onclick="event.stopPropagation(); resolveFlagDirect('${safeMsgId}', '${safeJid}')">Resolve</button>
                  </div>
                `;
              }).join('')}
            </div>
          `;
        }
      }
    }

    function updateFlaggedBadge() {
      const badge = document.getElementById('flaggedCount');
      if (!badge) return;
      const count = flaggedList.length;
      badge.textContent = count;
      if (count > 0) {
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    }

    function openChatFromPanel(chat) {
      openChat({
        ...chat,
        name: chat.name || chat.subject || chat.id,
        type: 'group',
        participants: chat.participants?.length || chat.participants || 0,
      }, null);
    }

    // ─── Group creation (contact picker + manual numbers) ─────────────────────────
    // Draft participants keyed by bare digits; label is the saved contact name or
    // the formatted +number for manually typed entries.
    const groupDraft = new Map();
    let groupPickerContacts = [];

    async function loadGroupContacts() {
      try {
        const res = await fetch(`${bridgeUrl}/api/contacts`);
        const contacts = await res.json();
        // Only phone-jid contacts can be added by number; @lid-only entries
        // don't expose a real phone number.
        groupPickerContacts = (contacts || []).filter(c => c.id && c.id.endsWith('@s.whatsapp.net'));
      } catch (e) {
        groupPickerContacts = [];
      }
      renderGroupContacts(document.getElementById('groupContactSearch')?.value || '');
    }

    function renderGroupChips() {
      const el = document.getElementById('groupChips');
      if (!el) return;
      if (groupDraft.size === 0) {
        el.innerHTML = '<span class="form-hint">No participants yet</span>';
      } else {
        el.innerHTML = [...groupDraft.values()].map(p => `
          <span class="group-chip">${escapeHtml(p.label)}<button onclick="removeGroupParticipant('${p.digits}')" aria-label="Remove ${escapeHtml(p.label)}">&times;</button></span>
        `).join('');
      }
      const btn = document.getElementById('createGroupBtn');
      if (btn) {
        btn.textContent = groupDraft.size
          ? `Create Group (${groupDraft.size} member${groupDraft.size > 1 ? 's' : ''})`
          : 'Create Group';
      }
    }

    function removeGroupParticipant(digits) {
      groupDraft.delete(digits);
      renderGroupChips();
      renderGroupContacts(document.getElementById('groupContactSearch')?.value || '');
    }

    function addGroupNumber() {
      const input = document.getElementById('newGroupNumber');
      const raw = input.value.trim();
      if (!raw) return;
      if (!raw.startsWith('+')) {
        showToast('Start with + and country code (e.g. +919876543210)', 'error');
        input.focus();
        return;
      }
      const digits = raw.replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) {
        showToast('Enter a valid phone number with country code', 'error');
        input.focus();
        return;
      }
      if (groupDraft.has(digits)) {
        showToast('Already in the list', 'info');
        input.value = '';
        return;
      }
      groupDraft.set(digits, { digits, label: fmtPhone('+' + digits) });
      input.value = '';
      input.focus();
      renderGroupChips();
      renderGroupContacts(document.getElementById('groupContactSearch')?.value || '');
    }

    function toggleGroupContact(digits) {
      if (groupDraft.has(digits)) {
        groupDraft.delete(digits);
      } else {
        const contact = groupPickerContacts.find(c => (c.phone || '').replace(/\D/g, '') === digits);
        const label = (contact && cleanJid(contact.name)) || fmtPhone('+' + digits);
        groupDraft.set(digits, { digits, label });
      }
      renderGroupChips();
      renderGroupContacts(document.getElementById('groupContactSearch')?.value || '');
    }

    function renderGroupContacts(q = '') {
      const list = document.getElementById('groupContactsList');
      if (!list) return;
      const term = q.trim().toLowerCase();
      const filtered = groupPickerContacts.filter(c => {
        if (!term) return true;
        return (c.name || '').toLowerCase().includes(term) || (c.phone || '').includes(term);
      });
      if (!filtered.length) {
        list.innerHTML = '<div style="padding:12px;text-align:center;color:var(--muted);font-size:12px">No contacts found</div>';
        return;
      }
      list.innerHTML = filtered.slice(0, 200).map(c => {
        const digits = (c.phone || '').replace(/\D/g, '');
        if (!digits) return '';
        const name = cleanJid(c.name) || fmtPhone('+' + digits);
        const selected = groupDraft.has(digits);
        return `
          <div class="new-chat-contact-item${selected ? ' group-contact-selected' : ''}"
               onclick="toggleGroupContact('${digits}')">
            <span class="group-contact-check">${selected ? '☑' : '☐'}</span>
            <div style="flex:1;min-width:0">
              <div class="new-chat-contact-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(name)}</div>
              <div class="new-chat-contact-phone">${fmtPhone('+' + digits)}</div>
            </div>
          </div>
        `;
      }).join('');
    }

    async function createGroup() {
      const name = document.getElementById('newGroupName').value.trim();
      if (!name) { showToast('Enter a group name', 'error'); return; }
      if (!groupDraft.size) { showToast('Add at least one participant', 'error'); return; }
      if (!socket) { showToast('Connect bridge first', 'error'); return; }

      const participants = [...groupDraft.keys()].map(d => '+' + d);
      const btn = document.getElementById('createGroupBtn');
      if (btn) btn.disabled = true;
      try {
        const res = await fetch(`${bridgeUrl}/api/groups/create`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, participants }),
        });
        const data = await res.json();
        if (data.id) {
          let msg = `Group "${name}" created with ${data.added || participants.length} member(s)`;
          if (data.skipped && data.skipped.length) {
            msg += ` — skipped ${data.skipped.map(s => `${s.input} (${s.reason})`).join(', ')}`;
          }
          showToast(msg, data.skipped && data.skipped.length ? 'info' : 'success');
          document.getElementById('newGroupName').value = '';
          groupDraft.clear();
          renderGroupChips();
          renderGroupContacts('');
        } else {
          showToast(data.error || 'Failed to create group', 'error');
        }
      } catch (e) {
        showToast(e.message, 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    // ─── Bridge Connection ────────────────────────────────────────────────────────
    let connectionStatus = 'disconnected';
    let latestQrData = null;
    let liveBridgeAddress = '';

    function isLoopbackHost(hostname) {
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0';
    }

    function getFallbackBridgeAddress() {
      try {
        const parsed = new URL(bridgeUrl);
        if (!isLoopbackHost(parsed.hostname)) {
          return parsed.host;
        }
      } catch { }

      const winHost = window.location.host || '';
      if (winHost) {
        const winHostname = window.location.hostname || '';
        if (!isLoopbackHost(winHostname)) {
          return winHost;
        }
      }
      return '';
    }

    async function refreshBridgeLiveAddress() {
      try {
        const res = await fetch(`${bridgeUrl}/api/bridge/live`);
        if (!res.ok) return;
        const data = await res.json();
        const nextAddress = String(data.bridgeLiveAddress || '').trim();
        if (nextAddress && nextAddress !== liveBridgeAddress) {
          liveBridgeAddress = nextAddress;
          updateTopbarButtons();
        }
      } catch (err) {
        console.error('Failed to fetch bridge live address:', err);
      }
    }

    async function copyBridgeAddress() {
      const address = liveBridgeAddress || getFallbackBridgeAddress();
      if (!address) {
        showToast('Bridge IP is not available yet.', 'error');
        return;
      }
      try {
        await navigator.clipboard.writeText(address);
        showToast(`Copied: ${address}`);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = address;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        showToast(`Copied: ${address}`);
      }
    }

    function updateBridgeActionButton() {
      const container = document.getElementById('bridgeActionContainer');
      if (!container) return;

      if (!socket || !socket.connected) {
        container.innerHTML = `<button class="btn btn-ghost" onclick="connectBridge()">Connect Bridge</button>`;
        return;
      }

      if (connectionStatus === 'connected') {
        container.innerHTML = '';
        const btn = document.createElement('button');
        btn.className = 'btn btn-ghost bridge-live-btn';
        btn.onclick = copyBridgeAddress;
        btn.title = 'Click to copy bridge address';
        const displayAddress = liveBridgeAddress || getFallbackBridgeAddress() || 'detecting...';
        btn.textContent = `Bridge Live: ${displayAddress}`;
        container.appendChild(btn);
      } else {
        container.innerHTML = `<button class="btn btn-ghost" onclick="connectBridge()">Connect Bridge</button>`;
      }
    }

    function updateTopbarButtons() {
      const container = document.getElementById('whatsappControlContainer');
      if (!container) return;

      updateBridgeActionButton();

      if (!socket || !socket.connected) {
        container.innerHTML = '';
        return;
      }

      if (connectionStatus === 'connected') {
        const isConnector = !connectorOperatorId || (connectorOperatorId === operatorId);
        if (isConnector) {
          container.innerHTML = `<button class="btn btn-danger" onclick="confirmDisconnectWhatsApp()">Disconnect WA</button>`;
        } else {
          container.innerHTML = `<span style="font-size:12px;color:var(--muted);padding:6px 12px;background:var(--surface2);border-radius:6px;border:1px solid var(--border)">Connected by ${connectorOperatorName || 'another operator'}</span>`;
        }
      } else {
        container.innerHTML = `<button class="btn btn-primary" onclick="linkWhatsApp()">Link WhatsApp</button>`;
      }
    }

    function confirmDisconnectWhatsApp() {
      showConfirm('Are you sure you want to disconnect WhatsApp? This will log you out and require scanning a new QR code to reconnect.', async () => {
        try {
          const res = await fetch(`${bridgeUrl}/api/whatsapp/disconnect`, {
            method: 'POST',
            headers: operatorHeaders()
          });
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || 'Failed to disconnect WhatsApp');
          }
          showToast('Disconnect request sent.');
        } catch (e) {
          showToast(e.message, 'error');
        }
      });
    }

    function linkWhatsApp() {
      document.getElementById('qrOverlay').classList.remove('hidden');
      if (socket?.connected) {
        socket.emit('linking_whatsapp', { operatorId, operatorName });
      }
      if (!latestQrData) {
        showToast('Waiting for QR code to generate...', 'info');
      }
    }

    function hideQrOverlay() {
      document.getElementById('qrOverlay').classList.add('hidden');
    }

    async function connectBridge() {
      const url = prompt('Bridge server URL:', bridgeUrl);
      if (!url) return;
      const normalized = normalizeBridgeUrl(url);
      if (!normalized) {
        showToast('Invalid bridge URL. Example: http://localhost:3001', 'error');
        return;
      }

      const isCurrentWaConnected = (connectionStatus === 'connected');
      let isNewBridgeWaConnected = false;

      try {
        const res = await fetch(`${normalized}/api/status`);
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'connected') {
            isNewBridgeWaConnected = true;
          }
          liveBridgeAddress = String(data.bridgeLiveAddress || '').trim();
        }
      } catch (err) {
        console.error('Error querying status of new bridge:', err);
      }

      if (isCurrentWaConnected && isNewBridgeWaConnected && normalized !== bridgeUrl) {
        try {
          showToast('Disconnecting current WhatsApp login...', 'info');
          const res = await fetch(`${bridgeUrl}/api/whatsapp/disconnect`, {
            method: 'POST',
            headers: operatorHeaders()
          });
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || 'Failed to disconnect WhatsApp');
          }
          showToast('Current WhatsApp login disconnected.');
        } catch (e) {
          console.error('Error disconnecting current WhatsApp:', e);
          showToast('Failed to disconnect current WhatsApp login, connecting to new bridge anyway.', 'warn');
        }
      }

      connectBridgeDirect(normalized);
    }

    function connectBridgeDirect(normalized) {
      bridgeUrl = normalized;
      liveBridgeAddress = '';

      if (socket) { socket.disconnect(); }

      // Load operator info from localStorage if available
      const savedId = localStorage.getItem('whatsapp_echo_operator_id');
      const savedName = localStorage.getItem('whatsapp_echo_operator_name');
      if (savedId) operatorId = savedId;
      if (savedName) operatorName = savedName;

      socket = io(bridgeUrl, {
        transports: ['websocket'],
        query: {
          operatorId: operatorId || '',
          operatorName: operatorName || ''
        }
      });

      socket.on('connect', () => {
        updateStatus('connecting', 'Bridge Connected');
        showToast('Bridge server connected!');
        refreshBridgeLiveAddress();
        if (!operatorName) {
          promptOperatorName();
        } else {
          socket.emit('set_operator_name', { name: operatorName });
        }
        updateTopbarButtons();
      });

      socket.on('operator_id', ({ id }) => {
        operatorId = id;
        localStorage.setItem('whatsapp_echo_operator_id', id);
      });

      socket.on('status', ({ status, connectorOperatorId: connId, connectorOperatorName: connName, myJid: ownJid }) => {
        connectionStatus = status;
        if (ownJid !== undefined) myJid = ownJid;
        if (connId !== undefined) connectorOperatorId = connId;
        if (connName !== undefined) connectorOperatorName = connName;
        if (status === 'connected') {
          updateStatus('connected', 'WhatsApp Live');
          document.getElementById('qrOverlay').classList.add('hidden');
          refreshBridgeLiveAddress();
        }
        else if (status === 'connecting' || status === 'qr_ready') updateStatus('connecting', 'Connecting...');
        else updateStatus('disconnected', 'WA Disconnected');
        updateTopbarButtons();
      });

      socket.on('qr', qrData => {
        latestQrData = qrData;
        document.getElementById('qrImage').src = qrData || '';
      });

      socket.on('operators', (ops) => {
        liveOperators = ops || [];
        document.getElementById('statOperators').textContent = liveOperators.length;
        if (currentTab === 'operators') renderPanel();
      });

      socket.on('stats', (stats) => {
        if (stats && typeof stats.messages === 'number') {
          document.getElementById('statMessages').textContent = stats.messages;
        }
      });

      socket.on('groups', groups => {
        liveGroups = groups || [];
        for (const g of groups) {
          upsertChatRecord({ id: g.id, name: g.subject, type: 'group', lastMsg: '', participants: g.participants?.length || 0, unread: 0, timestamp: 0 });
        }
        renderChatList(allChats);
      });

      socket.on('chats', chats => {
        allChats = chats || [];
        syncActiveChat();
        if (activeChat) renderChatHeader();
        renderChatList(allChats);
      });

      socket.on('message', msg => {
        // Deduplicate: skip if we sent this via temp ID
        if (msg.clientTempId && sentTempIds.has(msg.clientTempId)) {
          // Replace the temp message with the real one
          const tempRow = document.getElementById('msg-' + msg.clientTempId);
          if (tempRow) {
            tempRow.id = 'msg-' + msg.id;
            tempRow.dataset.id = msg.id;
            if (msg.timestamp) tempRow.dataset.timestamp = msg.timestamp;
            tempRow.querySelectorAll('button[onclick]').forEach(btn => {
              const onclickVal = btn.getAttribute('onclick');
              if (onclickVal) {
                const newVal = onclickVal.replace(new RegExp(`'${msg.clientTempId}'`, 'g'), `'${msg.id}'`)
                                         .replace(new RegExp(`"${msg.clientTempId}"`, 'g'), `"${msg.id}"`);
                btn.setAttribute('onclick', newVal);
              }
            });
            const timeEl = tempRow.querySelector('.msg-time');
            if (timeEl) timeEl.textContent = formatTime(new Date((msg.timestamp || Math.floor(Date.now() / 1000)) * 1000));
          }
          sentTempIds.delete(msg.clientTempId);
          return;
        }

        // Show browser desktop notification for incoming messages
        const outgoing = msg.fromMe || msg.outgoing || false;
        if (!outgoing && Notification.permission === 'granted' && !notificationsMuted) {
          const isTabHidden = document.hidden || document.visibilityState === 'hidden';
          const isNotFocused = !document.hasFocus();
          const isDifferentChat = !activeChat || activeChat.id !== (msg.from || msg.jid);

          if (isTabHidden || isNotFocused || isDifferentChat) {
            const jid = msg.from || msg.jid;
            const chat = allChats.find(c => c.id === jid);
            const senderName = chat ? (chat.verifiedName || chat.name || cleanJid(chat.id)) : cleanJid(jid);

            let bodyText = msg.content || '';
            if (msg.mediaType && msg.mediaType !== 'text') {
              bodyText = `[${msg.mediaType.toUpperCase()}] ${bodyText || ''}`.trim();
            }

            const n = new Notification(senderName, {
              body: bodyText,
              tag: jid,
              renotify: true
            });

            n.onclick = () => {
              window.focus();
              openChatById(jid, senderName);
            };
          }
        }

        if (isActiveChatJid(msg.from) || isActiveChatJid(msg.jid)) {
          const outgoing = msg.fromMe || msg.outgoing || false;
          const isUnread = !outgoing;
          appendMessage(normalizeMessage(msg), true, false, isUnread);
          refreshDateSeparators();
          if (isUnread && unreadObserver) {
            const row = document.getElementById('msg-' + msg.id);
            if (row) unreadObserver.observe(row);
          }
        }

        // Update chat list preview
        const jid = msg.from || msg.jid;
        if (jid) {
          upsertChatRecord({
            ...(allChats.find(c => c.id === jid) || {}),
            id: jid,
            lastMsg: msg.content || '',
            timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : 0,
          });
          syncActiveChat();
          if (activeChat) renderChatHeader();
          renderChatList(allChats);
        }
      });

      socket.on('chat_messages', onChatMessagesLoaded);

      socket.on('message_flagged', ({ messageId, jid, flag }) => {
        if (isActiveChatJid(jid)) {
          const row = document.getElementById('msg-' + messageId);
          if (row) {
            row.classList.add('flagged-msg');
            const bubble = row.querySelector('.msg-bubble');
            if (bubble) {
              if (!bubble.querySelector('.msg-flag-banner')) {
                const banner = document.createElement('div');
                banner.className = 'msg-flag-banner';
                banner.innerHTML = `<span>🚩 Flagged by ${flag.flaggedByOperatorName || 'Team'}</span>${flag.note ? `<span class="msg-flag-note">("${flag.note}")</span>` : ''}`;
                bubble.insertBefore(banner, bubble.firstChild);
              }
            }
            const actions = row.querySelector('.msg-actions');
            if (actions && !actions.querySelector('.btn-resolve-flag')) {
              const btn = document.createElement('button');
              btn.className = 'btn-ghost-sm btn-resolve-flag';
              btn.style.color = 'var(--danger)';
              btn.onclick = () => resolveFlagDirect(messageId, activeChat?.id);
              btn.innerHTML = '🚩 Resolve';
              actions.appendChild(btn);
            }
          }
        }
        socket.emit('get_flagged_messages');
      });

      socket.on('message_unflagged', ({ messageId, jid }) => {
        if (isActiveChatJid(jid)) {
          const row = document.getElementById('msg-' + messageId);
          if (row) {
            row.classList.remove('flagged-msg');
            const banner = row.querySelector('.msg-flag-banner');
            if (banner) banner.remove();
            const btn = row.querySelector('.btn-resolve-flag');
            if (btn) btn.remove();
          }
        }
        socket.emit('get_flagged_messages');
      });

      socket.on('flagged_list', (list) => {
        flaggedList = list || [];
        updateFlaggedBadge();
        if (currentTab === 'flagged') renderPanel();
      });

      socket.on('flagged_list_updated', (list) => {
        flaggedList = list || [];
        updateFlaggedBadge();
        if (currentTab === 'flagged') renderPanel();
      });

      socket.on('message_ack', ({ clientTempId, serverId, timestamp }) => {
        if (clientTempId && sentTempIds.has(clientTempId)) {
          const tempRow = document.getElementById('msg-' + clientTempId);
          if (tempRow) {
            tempRow.id = 'msg-' + serverId;
            tempRow.dataset.id = serverId;
            if (timestamp) tempRow.dataset.timestamp = timestamp;
            tempRow.querySelectorAll('button[onclick]').forEach(btn => {
              const onclickVal = btn.getAttribute('onclick');
              if (onclickVal) {
                const newVal = onclickVal.replace(new RegExp(`'${clientTempId}'`, 'g'), `'${serverId}'`)
                                         .replace(new RegExp(`"${clientTempId}"`, 'g'), `"${serverId}"`);
                btn.setAttribute('onclick', newVal);
              }
            });
            const tickEl = document.getElementById('status-tick-' + clientTempId);
            if (tickEl) {
              tickEl.id = 'status-tick-' + serverId;
            }
            const timeEl = tempRow.querySelector('.msg-time');
            if (timeEl) {
              const timeStr = formatTime(new Date(timestamp * 1000));
              const editedMark = tempRow.querySelector('.msg-edited') ? '<div class="msg-edited">(edited)</div>' : '';
              const tickHtml = `<span class="msg-status-ticks status-sent" id="status-tick-${serverId}" title="Sent"><svg class="tick-svg" viewBox="0 0 16 11" width="12" height="9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle;"><path d="M1 5.5L5 9.5L15 1.5"/></svg></span>`;
              timeEl.innerHTML = `${timeStr}${editedMark}${tickHtml}`;
            }
          }
          sentTempIds.delete(clientTempId);
        }
      });

      socket.on('message_status_update', ({ jid, messageId, status, fromMe }) => {
        if (isActiveChatJid(jid)) {
          updateMessageStatusInUI(messageId, status);
        }
      });

      // Per-participant receipt arrived — live-refresh the Details modal if
      // it's open for that message.
      socket.on('message_receipt', ({ jid, messageId }) => {
        if (msgInfoTarget && msgInfoTarget.messageId === messageId) {
          refreshMessageInfo();
        }
      });

      socket.on('message_failed', ({ clientTempId, jid, error }) => {
        if (clientTempId) {
          updateMessageStatusInUI(clientTempId, 0);
          showToast(`Message failed to send: ${error}`, 'error');
          sentTempIds.delete(clientTempId);
        }
      });

      socket.on('message_edited', ({ jid, messageId, newContent, editedAt, edits }) => {
        if (isActiveChatJid(jid)) {
          updateMessageInPlace(messageId, newContent, editedAt, edits);
        }
      });

      socket.on('message_media_updated', ({ jid, messageId, mediaUrl, fileName, content, mediaType }) => {
        if (isActiveChatJid(jid)) {
          const row = document.getElementById('msg-' + messageId);
          if (row) {
            const placeholder = row.querySelector('.msg-media-placeholder, .msg-document-placeholder');
            if (placeholder) {
              const absoluteMediaUrl = mediaUrl.startsWith('http') ? mediaUrl : `${bridgeUrl}${mediaUrl}`;
              let html = '';
              if (mediaType === 'image') {
                html = `<img class="msg-image" src="${absoluteMediaUrl}" alt="Image" onclick="openLightbox('${absoluteMediaUrl}')">
                        <div class="msg-text">${formatWhatsAppText(content || '')}</div>`;
              } else if (mediaType === 'video') {
                html = `<video class="msg-video" controls><source src="${absoluteMediaUrl}"></video>
                        <div class="msg-text">${formatWhatsAppText(content || '')}</div>`;
              } else if (mediaType === 'audio' || mediaType === 'voice') {
                html = `<audio class="msg-audio" controls><source src="${absoluteMediaUrl}"></audio>`;
              } else if (mediaType === 'document') {
                html = `<a class="msg-document" href="${absoluteMediaUrl}" target="_blank" download>
                  <div class="doc-icon">${getDocIcon(fileName || content)}</div>
                  <div>
                    <div class="doc-name">${fileName || content || 'Document'}</div>
                    <div class="doc-size">Tap to download</div>
                  </div>
                </a>`;
              } else if (mediaType === 'sticker') {
                html = `<img class="msg-sticker" src="${absoluteMediaUrl}" alt="Sticker">`;
              }
              if (html) {
                placeholder.outerHTML = html;
              }
            }
          }
        }
      });

      socket.on('sync_status', (state) => {
        const isSyncing = state.syncingHistory || state.resolvingLids;
        const spinner = document.getElementById('syncSpinner');
        const dot = document.getElementById('statusDot');
        if (spinner) spinner.style.display = isSyncing ? 'block' : 'none';
        if (dot) dot.style.display = isSyncing ? 'none' : 'block';
      });

      socket.on('message_deleted', ({ jid, messageId }) => {
        if (isActiveChatJid(jid)) {
          markMessageDeleted(messageId);
        }
      });

      socket.on('group_created', (result) => {
        showToast(`Group "${result.subject}" created!`);
      });

      socket.on('group_update', (update) => {
        const existing = liveGroups.find(g => g.id === update.id);
        if (existing) Object.assign(existing, update);
      });

      socket.on('assignment_updated', ({ jid, chat, action }) => {
        upsertChatRecord(chat);
        syncActiveChat();
        if (activeChat?.id === jid) renderChatHeader();
        renderChatList(allChats);
      });

      socket.on('chat_claimed', ({ chat }) => {
        upsertChatRecord(chat);
        syncActiveChat();
        renderChatHeader();
        renderChatList(allChats);
      });

      socket.on('chat_merged', ({ lid, jid }) => {
        if (activeChat && activeChat.id === lid) {
          activeChat.id = jid;
          activeChat.phone = jid.split('@')[0].split(':')[0];
          renderChatHeader();
        }
        allChats.forEach(c => {
          if (c.id === lid) {
            c.id = jid;
            c.phone = jid.split('@')[0].split(':')[0];
          }
        });
        syncActiveChat();
        renderChatList(allChats);
      });

      socket.on('chat_released', ({ chat }) => {
        upsertChatRecord(chat);
        syncActiveChat();
        renderChatHeader();
        renderChatList(allChats);
      });

      socket.on('error', ({ message, assignedOperatorId, assignedOperatorName, jid }) => {
        if (jid) {
          upsertChatRecord({ ...(allChats.find(c => c.id === jid) || {}), id: jid, assignedOperatorId, assignedOperatorName });
          syncActiveChat();
          if (activeChat?.id === jid) renderChatHeader();
          renderChatList(allChats);
        }
        showToast('Error: ' + message, 'error');
      });

      socket.on('contacts_updated', () => {
        loadContacts();
      });

      socket.on('disconnect', () => {
        updateStatus('disconnected', 'Disconnected');
        showToast('Bridge disconnected', 'error');
        connectionStatus = 'disconnected';
        updateTopbarButtons();
      });
    }

    // ─── Notifications ────────────────────────────────────────────────────────────
    let notificationsMuted = localStorage.getItem('whatsapp_echo_notifications_muted') === 'true';

    function initNotifications() {
      const toggleBtn = document.getElementById('notificationToggleBtn');
      if (!toggleBtn) return;

      if (!('Notification' in window)) {
        console.warn('This browser does not support desktop notifications');
        toggleBtn.style.display = 'none';
        return;
      }

      toggleBtn.style.display = 'inline-flex';
      updateNotificationButton();
    }

    function updateNotificationButton() {
      const toggleBtn = document.getElementById('notificationToggleBtn');
      if (!toggleBtn) return;

      const state = Notification.permission;

      const activeBellSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"></path><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"></path></svg>`;
      const silentBellSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><path d="M13.73 21a2 2 0 0 1-3.46 0"></path><path d="M18.63 13A17.89 17.89 0 0 1 18 8"></path><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"></path><path d="M18 8a6 6 0 0 0-9.33-5"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
      const blockedBellSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><path d="M13.73 21a2 2 0 0 1-3.46 0"></path><path d="M18.63 13A17.89 17.89 0 0 1 18 8"></path><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"></path><path d="M18 8a6 6 0 0 0-9.33-5"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;

      if (state === 'denied') {
        toggleBtn.innerHTML = blockedBellSvg;
        toggleBtn.title = 'Notifications Blocked. Reset site permissions in your browser settings to enable.';
      } else if (state === 'granted') {
        if (notificationsMuted) {
          toggleBtn.innerHTML = silentBellSvg;
          toggleBtn.title = 'Notifications: Muted (Click to unmute)';
        } else {
          toggleBtn.innerHTML = activeBellSvg;
          toggleBtn.title = 'Notifications: Active (Click to mute)';
        }
      } else {
        // Default permission state
        toggleBtn.innerHTML = silentBellSvg;
        toggleBtn.title = 'Click to enable desktop notifications';
      }
    }

    function toggleNotifications() {
      if (!('Notification' in window)) return;

      const state = Notification.permission;
      if (state === 'denied') {
        showToast('Notifications are blocked by your browser. Please reset permission in browser site settings.', 'error');
        return;
      }

      if (state === 'default') {
        Notification.requestPermission().then(permission => {
          if (permission === 'granted') {
            notificationsMuted = false;
            localStorage.setItem('whatsapp_echo_notifications_muted', 'false');
            updateNotificationButton();
            showToast('Desktop notifications enabled!', 'success');
            // Show a test notification
            new Notification('ECHO', {
              body: 'Desktop notifications successfully enabled!',
              tag: 'test-notification'
            });
          } else {
            updateNotificationButton();
            showToast('Permission denied.', 'error');
          }
        });
        return;
      }

      // Toggle state if already granted
      notificationsMuted = !notificationsMuted;
      localStorage.setItem('whatsapp_echo_notifications_muted', notificationsMuted ? 'true' : 'false');
      updateNotificationButton();
      showToast(notificationsMuted ? 'Notifications silenced' : 'Notifications active', 'info');
    }

    // ─── New Chat Functions ───────────────────────────────────────────────────────
    function openNewChatModal() {
      document.getElementById('newChatOverlay').classList.remove('hidden');
      document.getElementById('newChatPhoneNumber').value = '';
      document.getElementById('newChatSearchInput').value = '';
      document.getElementById('newChatPhoneNumber').focus();
      loadContactsForNewChat();
    }

    function closeNewChatModal() {
      document.getElementById('newChatOverlay').classList.add('hidden');
    }

    async function loadContactsForNewChat() {
      if (socket) {
        try {
          const res = await fetch(`${bridgeUrl}/api/contacts`);
          allContacts = await res.json();
        } catch (e) {
          console.error('Failed to load contacts for new chat:', e);
        }
      }
      renderNewChatContacts(allContacts);
    }

    function renderNewChatContacts(contacts) {
      const list = document.getElementById('newChatContactsList');
      list.innerHTML = '';
      if (!contacts || contacts.length === 0) {
        list.innerHTML = '<div style="padding:12px;text-align:center;color:var(--muted);font-size:12px">No contacts found</div>';
        return;
      }
      contacts.forEach(contact => {
        const item = document.createElement('div');
        item.className = 'new-chat-contact-item';
        item.onclick = () => {
          openContactChat(contact);
          closeNewChatModal();
        };

        let cleanName = cleanJid(contact.name);
        const cleanPhone = contact.phone ? cleanJid(contact.phone) : '';
        const isLidOrJidName = (cleanName === cleanJid(contact.id) || cleanName.startsWith('LID: ') || /^\+?1\d{14}$/.test(cleanName.replace(/\s+/g, '')) || /^\+?\d{10,}$/.test(cleanName.replace(/\s+/g, '')));
        if (isLidOrJidName && cleanPhone && cleanPhone !== cleanName) {
          cleanName = cleanPhone;
        }
        const avatarInitial = (cleanName.startsWith('+') ? cleanName.slice(1) : cleanName || '?')[0].toUpperCase();

        item.innerHTML = `
          <div class="chat-avatar personal" style="width:28px;height:28px;font-size:11px;flex-shrink:0">${avatarInitial}</div>
          <div style="flex:1;min-width:0">
            <div class="new-chat-contact-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${cleanName}</div>
            <div class="new-chat-contact-phone">${fmtPhone('+' + contact.phone.split(':')[0])}</div>
          </div>
        `;
        list.appendChild(item);
      });
    }

    function onNewChatSearch(q) {
      const filtered = allContacts.filter(c => {
        const name = (c.name || '').toLowerCase();
        const phone = (c.phone || '').toLowerCase();
        const term = q.toLowerCase();
        return name.includes(term) || phone.includes(term);
      });
      renderNewChatContacts(filtered);
    }

    function submitNewChatUnknown() {
      const ccInput = document.getElementById('newChatCountryCode');
      const phoneInput = document.getElementById('newChatPhoneNumber');
      const countryCode = ccInput.value.trim();
      const phoneNumber = phoneInput.value.trim();

      const ccClean = countryCode.replace(/\D/g, '');
      const phoneClean = phoneNumber.replace(/\D/g, '');

      if (!ccClean) {
        showToast('Please enter a country code', 'error');
        ccInput.focus();
        return;
      }
      if (!phoneClean) {
        showToast('Please enter a phone number', 'error');
        phoneInput.focus();
        return;
      }

      openUnknownNumberChat(ccClean, phoneClean);
      closeNewChatModal();
    }

    function openUnknownNumberChat(cc, phone) {
      const jid = `${cc}${phone}@s.whatsapp.net`;
      let chat = allChats.find(c => c.id === jid);
      if (!chat) {
        chat = {
          id: jid,
          name: `+${cc} ${phone}`,
          type: 'personal',
          lastMsg: '',
          timestamp: Math.floor(Date.now() / 1000),
          unreadCount: 0,
          phone: `${cc}${phone}`
        };
        allChats.unshift(chat);
      }
      switchSidebarTab('chats');
      openChat(chat, null);
    }

    // ─── Group Details Modal Logic ──────────────────────────────────────────────
    async function openGroupDetailsModal(e) {
      if (e && e.target.closest('.mobile-back-btn')) return;
      if (!activeChat) return;
      
      const overlay = document.getElementById('groupDetailsOverlay');
      if (!overlay) return;
      
      overlay.classList.remove('hidden');
      renderGroupDetails(activeChat);
      
      try {
        const res = await fetch(`${bridgeUrl}/api/groups/${encodeURIComponent(activeChat.id)}`);
        if (res.ok) {
          const latestGroup = await res.json();
          const chatIdx = allChats.findIndex(c => c.id === activeChat.id);
          if (chatIdx >= 0) {
            allChats[chatIdx].participants = latestGroup.participants || [];
            allChats[chatIdx].name = latestGroup.subject;
            activeChat = allChats[chatIdx];
          } else {
            activeChat.participants = latestGroup.participants || [];
            activeChat.name = latestGroup.subject;
          }
          renderChatHeader();
          renderGroupDetails(activeChat);
        }
      } catch (err) {
        console.error('Error fetching group details:', err);
      }
    }

    function closeGroupDetailsModal() {
      const overlay = document.getElementById('groupDetailsOverlay');
      if (overlay) overlay.classList.add('hidden');
    }

    function openChatWithJid(jid) {
      if (!jid) return;
      if (myJid && cleanJid(jid).replace(/[^0-9]/g, '') === cleanJid(myJid).replace(/[^0-9]/g, '')) return; // Don't message yourself
      
      closeGroupDetailsModal();
      
      let chat = allChats.find(c => c.id === jid);
      if (!chat) {
        const contact = allContacts.find(c => c.id === jid);
        const name = contact ? contact.name : getParticipantDisplayName(jid);
        const phone = jid.split('@')[0];
        chat = {
          id: jid,
          name: name,
          type: 'personal',
          phone: phone,
          unreadCount: 0,
          timestamp: Date.now() / 1000,
          lastMsg: ''
        };
        allChats.unshift(chat);
        renderChatList(allChats);
      }
      
      switchSidebarTab('chats');
      openChat(chat, null);
    }

    function getParticipantDisplayName(jid) {
      if (jid.endsWith('@s.whatsapp.net')) {
        const phone = jid.split('@')[0];
        const contact = allContacts.find(c => c.id === jid || c.phone === phone);
        if (contact && contact.name) return contact.name;
        return fmtPhone('+' + phone);
      }
      return cleanJid(jid);
    }

    function renderGroupDetails(chat) {
      if (!chat) return;
      
      const subjectInput = document.getElementById('groupSubjectInput');
      subjectInput.value = chat.name || 'Group Chat';
      subjectInput.readOnly = true;
      subjectInput.style.borderBottomColor = 'transparent';
      
      const avatarEl = document.getElementById('groupDetailsAvatar');
      const initial = (chat.name || '?')[0].toUpperCase();
      avatarEl.textContent = initial;
      
      const metaEl = document.getElementById('groupDetailsMeta');
      metaEl.textContent = chat.id;
      
      const participants = chat.participants || [];
      document.getElementById('groupParticipantCount').textContent = participants.length;
      
      const myJidClean = myJid ? cleanJid(myJid).replace(/[^0-9]/g, '') : '';
      const botParticipant = participants.find(p => {
        const pClean = cleanJid(p.id).replace(/[^0-9]/g, '');
        return pClean === myJidClean;
      });
      const isBotAdmin = botParticipant && (botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin');
      
      const adminSection = document.getElementById('groupAddParticipantSection');
      const editBtn = document.getElementById('editGroupSubjectBtn');
      if (isBotAdmin) {
        adminSection.style.display = 'block';
        editBtn.style.display = 'inline-flex';
      } else {
        adminSection.style.display = 'none';
        editBtn.style.display = 'none';
      }
      
      const listEl = document.getElementById('groupParticipantsList');
      listEl.innerHTML = '';
      
      if (participants.length === 0) {
        listEl.innerHTML = '<div style="padding:12px;text-align:center;color:var(--muted);font-size:12px">No participants found</div>';
        return;
      }
      
      participants.forEach(p => {
        const item = document.createElement('div');
        item.className = 'group-details-participant';
        
        const isUserAdmin = p.admin === 'admin' || p.admin === 'superadmin';
        const isSelf = myJidClean && (cleanJid(p.id).replace(/[^0-9]/g, '') === myJidClean);
        const displayName = isSelf ? 'You (System)' : getParticipantDisplayName(p.id);
        const phoneDisplay = cleanJid(p.id);
        const pInitial = displayName[0].toUpperCase();
        
        let badgesHtml = '';
        if (isUserAdmin) {
          badgesHtml += '<span class="admin-badge">Group admin</span>';
        }
        
        let actionsHtml = '';
        if (isBotAdmin && !isSelf) {
          const actionText = isUserAdmin ? 'Dismiss Admin' : 'Make Admin';
          const actionType = isUserAdmin ? 'demote' : 'promote';
          actionsHtml = `
            <div class="participant-actions">
              <button class="btn-action-small" onclick="updateParticipantRole('${actionType}', '${p.id}')">${actionText}</button>
              <button class="btn-action-small remove-btn" onclick="removeParticipant('${p.id}')">Remove</button>
            </div>
          `;
        }
        
        const isLid = p.id && p.id.endsWith('@lid');
        item.innerHTML = `
          <div class="participant-info" onclick="openChatWithJid('${p.id}')" style="cursor: pointer;">
            <div class="participant-avatar">${pInitial}</div>
            <div class="participant-name-container">
              <div class="participant-display-name">${displayName}</div>
              ${(isLid || displayName === phoneDisplay) ? '' : `<div class="participant-phone">${phoneDisplay}</div>`}
            </div>
          </div>
          <div class="participant-badge-container">
            ${badgesHtml}
            ${actionsHtml}
          </div>
        `;
        listEl.appendChild(item);
      });
    }

    let isEditingGroupSubject = false;
    function toggleEditGroupSubject() {
      const input = document.getElementById('groupSubjectInput');
      const btn = document.getElementById('editGroupSubjectBtn');
      if (!isEditingGroupSubject) {
        isEditingGroupSubject = true;
        input.readOnly = false;
        input.style.borderBottomColor = 'var(--accent)';
        input.focus();
        btn.textContent = '💾';
      } else {
        saveGroupSubject();
      }
    }

    async function saveGroupSubject() {
      if (!activeChat) return;
      const input = document.getElementById('groupSubjectInput');
      const btn = document.getElementById('editGroupSubjectBtn');
      const newSubject = input.value.trim();
      if (!newSubject) {
        showToast('Group name cannot be empty', 'error');
        return;
      }
      
      try {
        const res = await fetch(`${bridgeUrl}/api/groups/${encodeURIComponent(activeChat.id)}/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subject: newSubject })
        });
        
        if (res.ok) {
          showToast('Group name updated successfully', 'success');
          const chatIdx = allChats.findIndex(c => c.id === activeChat.id);
          if (chatIdx >= 0) {
            allChats[chatIdx].name = newSubject;
            activeChat = allChats[chatIdx];
          } else {
            activeChat.name = newSubject;
          }
          renderChatHeader();
        } else {
          const data = await res.json();
          showToast(data.error || 'Failed to update group name', 'error');
        }
      } catch (err) {
        showToast('Error updating group name', 'error');
        console.error(err);
      } finally {
        isEditingGroupSubject = false;
        input.readOnly = true;
        input.style.borderBottomColor = 'transparent';
        btn.textContent = '✏️';
      }
    }

    async function addGroupParticipant() {
      if (!activeChat) return;
      const input = document.getElementById('addGroupParticipantPhone');
      const phoneRaw = input.value.trim().replace(/[^0-9]/g, '');
      if (!phoneRaw) {
        showToast('Please enter a valid phone number', 'error');
        return;
      }
      const participantJid = `${phoneRaw}@s.whatsapp.net`;
      
      try {
        showToast('Adding participant...', 'info');
        const res = await fetch(`${bridgeUrl}/api/groups/${encodeURIComponent(activeChat.id)}/participants`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'add', participants: [participantJid] })
        });
        
        if (res.ok) {
          showToast('Participant added successfully', 'success');
          input.value = '';
          openGroupDetailsModal();
        } else {
          const data = await res.json();
          showToast(data.error || 'Failed to add participant', 'error');
        }
      } catch (err) {
        showToast('Error adding participant', 'error');
        console.error(err);
      }
    }

    async function removeParticipant(participantJid) {
      if (!activeChat) return;
      if (!confirm('Are you sure you want to remove this participant?')) return;
      
      try {
        showToast('Removing participant...', 'info');
        const res = await fetch(`${bridgeUrl}/api/groups/${encodeURIComponent(activeChat.id)}/participants`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'remove', participants: [participantJid] })
        });
        
        if (res.ok) {
          showToast('Participant removed successfully', 'success');
          openGroupDetailsModal();
        } else {
          const data = await res.json();
          showToast(data.error || 'Failed to remove participant', 'error');
        }
      } catch (err) {
        showToast('Error removing participant', 'error');
        console.error(err);
      }
    }

    async function updateParticipantRole(action, participantJid) {
      if (!activeChat) return;
      
      try {
        showToast('Updating role...', 'info');
        const res = await fetch(`${bridgeUrl}/api/groups/${encodeURIComponent(activeChat.id)}/participants`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, participants: [participantJid] })
        });
        
        if (res.ok) {
          showToast('Participant role updated', 'success');
          openGroupDetailsModal();
        } else {
          const data = await res.json();
          showToast(data.error || 'Failed to update role', 'error');
        }
      } catch (err) {
        showToast('Error updating role', 'error');
        console.error(err);
      }
    }

    async function leaveGroup() {
      if (!activeChat) return;
      if (!confirm('Are you sure you want to leave this group? This action cannot be undone.')) return;
      
      const btn = document.getElementById('leaveGroupBtn');
      if (btn) btn.disabled = true;
      
      try {
        showToast('Leaving group...', 'info');
        const res = await fetch(`${bridgeUrl}/api/groups/${encodeURIComponent(activeChat.id)}/leave`, {
          method: 'POST'
        });
        
        if (res.ok) {
          showToast('Left the group successfully', 'success');
          closeGroupDetailsModal();
          activeChat = null;
          document.getElementById('chatView').style.display = 'none';
          document.getElementById('emptyState').style.display = 'flex';
        } else {
          const data = await res.json();
          showToast(data.error || 'Failed to leave group', 'error');
        }
      } catch (err) {
        showToast('Error leaving group', 'error');
        console.error(err);
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    // Attach event listener for enter key in group name input
    setTimeout(() => {
      const groupSubjInput = document.getElementById('groupSubjectInput');
      if (groupSubjInput) {
        groupSubjInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') saveGroupSubject();
        });
      }
    }, 500);

    // Expose toggle globally for HTML onclick handler
    window.toggleNotifications = toggleNotifications;
    window.openGroupDetailsModal = openGroupDetailsModal;
    window.openChatWithJid = openChatWithJid;
    window.closeGroupDetailsModal = closeGroupDetailsModal;
    window.toggleEditGroupSubject = toggleEditGroupSubject;
    window.saveGroupSubject = saveGroupSubject;
    window.addGroupParticipant = addGroupParticipant;
    window.removeParticipant = removeParticipant;
    window.updateParticipantRole = updateParticipantRole;
    window.leaveGroup = leaveGroup;
    // Expose reply functions globally (called from dynamically built HTML onclick attributes)
    window.openMessageInfo = openMessageInfo;
    window.closeMsgInfoModal = closeMsgInfoModal;
    window.startReply = startReply;
    window.cancelReply = cancelReply;
    window.scrollToMessage = scrollToMessage;

    // Expose new chat functions globally
    window.openNewChatModal = openNewChatModal;
    window.closeNewChatModal = closeNewChatModal;
    window.submitNewChatUnknown = submitNewChatUnknown;
    window.onNewChatSearch = onNewChatSearch;

    // Expose search functions globally
    window.toggleChatSearch = toggleChatSearch;
    window.onChatSearchInput = onChatSearchInput;
    window.scrollToOrLoadMessage = scrollToOrLoadMessage;

    // ─── Internet Connectivity Status ──────────────────────────────────────────────
    async function checkInternetConnectivity() {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      try {
        await fetch('https://www.google.com/favicon.ico?_cb=' + Date.now(), {
          mode: 'no-cors',
          cache: 'no-store',
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        return true;
      } catch (err) {
        clearTimeout(timeoutId);
        // Fallback check to Cloudflare
        try {
          const fallbackController = new AbortController();
          const fallbackTimeoutId = setTimeout(() => fallbackController.abort(), 3000);
          await fetch('https://1.1.1.1/favicon.ico?_cb=' + Date.now(), {
            mode: 'no-cors',
            cache: 'no-store',
            signal: fallbackController.signal
          });
          clearTimeout(fallbackTimeoutId);
          return true;
        } catch {
          return false;
        }
      }
    }

    async function updateInternetStatus() {
      // 1. Quick check using navigator.onLine
      let online = navigator.onLine;

      // 2. If navigator.onLine says online, double check with a quick fetch ping
      if (online) {
        online = await checkInternetConnectivity();
      }

      if (online !== isInternetOnline) {
        isInternetOnline = online;
        updateStatus(); // Trigger status pill redraw with updated network state
        if (!online) {
          showToast('You are offline. Please check your internet connection.', 'error');
        } else {
          showToast('Internet connection restored', 'success');
        }
      }
    }

    function resolveFlagDirect(messageId, jid) {
      if (socket?.connected) {
        socket.emit('unflag_message', { messageId, jid });
        showToast('Resolving flagged message...', 'info');
      }
    }
    window.resolveFlagDirect = resolveFlagDirect;

    function flagMessagePrompt(messageId, jid) {
      const note = prompt('Add a quick flag note (optional, e.g. "needs supervisor"):');
      if (note === null) return;
      if (socket?.connected) {
        socket.emit('flag_message', { messageId, jid, note });
        showToast('Flagging message...', 'info');
      }
    }
    window.flagMessagePrompt = flagMessagePrompt;

    function markChatUnreadDirect(jid, scope) {
      if (socket?.connected) {
        socket.emit('mark_chat_unread', { jid, scope });
        showToast('Marked chat as unread.');
      }
    }
    window.markChatUnreadDirect = markChatUnreadDirect;

    function jumpToFlaggedMessage(jid, messageId, timestamp) {
      console.log('[FlagJump] jumpToFlaggedMessage called. jid=', jid, 'messageId=', messageId, 'activeChat?.id=', activeChat?.id, 'sameChat=', activeChat && activeChat.id === jid);
      if (activeChat && activeChat.id === jid) {
        scrollToOrLoadMessage(messageId, timestamp);
      } else {
        pendingScrollToMessageId = messageId;
        pendingScrollToMessageTimestamp = timestamp;
        openChatById(jid, '');
      }
    }
    window.jumpToFlaggedMessage = jumpToFlaggedMessage;

    function initScrollObserver() {
      if (unreadObserver) {
        unreadObserver.disconnect();
      }
      
      const scrollArea = document.getElementById('messagesArea');
      if (!scrollArea) return;
      
      unreadObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const row = entry.target;
            row.classList.remove('unread-target');
            unreadObserver.unobserve(row);
            
            const msgId = row.id.replace('msg-', '');
            const timestamp = Number(row.dataset.timestamp) || 0;
            if (socket?.connected && activeChat) {
              socket.emit('set_read_pointer', {
                jid: activeChat.id,
                messageId: msgId,
                timestamp: timestamp
              });
            }
          }
        });
      }, {
        root: scrollArea,
        threshold: 0.1
      });
    }

    function triggerDownload(url, fileName) {
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName || 'download';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }

    async function downloadFromContext(messageId, jid) {
      const row = document.getElementById('msg-' + messageId);
      if (!row) return;

      const mediaType = row.dataset.mediaType;
      if (!mediaType || mediaType === 'text' || mediaType === 'location') return;

      try {
        showToast('Downloading media...', 'info', 3000);
        const response = await fetch(`${bridgeUrl}/api/messages/${encodeURIComponent(jid)}/${encodeURIComponent(messageId)}/download-media`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });

        if (response.status === 410) {
          showToast('Media is no longer available on WhatsApp servers', 'error');
          return;
        }

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || 'Failed to download media');
        }

        const data = await response.json();
        if (data.success && data.mediaUrl) {
          const absoluteUrl = data.mediaUrl.startsWith('http') ? data.mediaUrl : `${bridgeUrl}${data.mediaUrl}`;
          triggerDownload(absoluteUrl, data.fileName || 'download');
          showToast('Download started', 'success', 2000);
        }
      } catch (e) {
        console.error(e);
        showToast(e.message, 'error');
      }
    }

    // ─── Message Info (per-participant receipts) ─────────────────────────────────
    let msgInfoTarget = null; // { jid, messageId } while the modal is open

    async function openMessageInfo(messageId) {
      if (!activeChat) return;
      msgInfoTarget = { jid: activeChat.id, messageId };
      document.getElementById('msgInfoBody').innerHTML = '<div style="color:var(--muted);font-size:13px;">Loading…</div>';
      document.getElementById('msgInfoOverlay').classList.remove('hidden');
      await refreshMessageInfo();
    }

    function closeMsgInfoModal() {
      msgInfoTarget = null;
      document.getElementById('msgInfoOverlay').classList.add('hidden');
    }

    async function refreshMessageInfo() {
      if (!msgInfoTarget) return;
      const { jid, messageId } = msgInfoTarget;
      try {
        const res = await fetch(`${bridgeUrl}/api/messages/${encodeURIComponent(jid)}/${encodeURIComponent(messageId)}/receipts`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load message details');
        // Ignore stale responses if the modal moved to another message meanwhile
        if (!msgInfoTarget || msgInfoTarget.messageId !== messageId) return;
        renderMessageInfo(data);
      } catch (e) {
        const body = document.getElementById('msgInfoBody');
        if (body) body.innerHTML = `<div style="color:var(--danger);font-size:13px;">${escapeHtml(e.message)}</div>`;
      }
    }

    function formatReceiptTime(ms) {
      if (!ms) return '';
      const d = new Date(ms);
      const today = new Date();
      const sameDay = d.toDateString() === today.toDateString();
      const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return sameDay ? `today at ${time}` : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
    }

    function renderMessageInfo(data) {
      const body = document.getElementById('msgInfoBody');
      if (!body) return;

      const participants = data.participants || [];
      const readBy = participants.filter(p => p.readAt).sort((a, b) => b.readAt - a.readAt);
      const deliveredTo = participants.filter(p => p.deliveredAt && !p.readAt).sort((a, b) => b.deliveredAt - a.deliveredAt);
      const pending = participants.filter(p => !p.deliveredAt && !p.readAt);

      const row = (p, time) => `
        <div style="display:flex;align-items:center;gap:10px;padding:6px 0;">
          <div style="width:32px;height:32px;border-radius:50%;background:var(--surface2);color:var(--accent);display:flex;align-items:center;justify-content:center;font-weight:600;font-size:13px;flex-shrink:0;">${escapeHtml((p.name || '?').charAt(0).toUpperCase())}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(p.name)}</div>
            ${time ? `<div style="font-size:11px;color:var(--muted);">${escapeHtml(time)}</div>` : ''}
          </div>
        </div>`;

      const section = (title, color, list, timeOf) => `
        <div>
          <div style="font-size:12px;font-weight:600;color:${color};border-bottom:1px solid var(--border);padding-bottom:6px;margin-bottom:2px;">${title}</div>
          ${list.length ? list.map(p => row(p, timeOf(p))).join('') : '<div style="font-size:12px;color:var(--muted);padding:6px 0;">—</div>'}
        </div>`;

      if (!data.isGroup) {
        body.innerHTML = '<div style="font-size:13px;color:var(--muted);">Per-participant receipts are only available for group messages.</div>';
        return;
      }

      const total = participants.length;
      body.innerHTML =
        section(`👁‍🗨 Read by ${readBy.length}/${total}`, 'var(--accent)', readBy, p => formatReceiptTime(p.readAt)) +
        section(`✓✓ Delivered to ${deliveredTo.length}`, 'var(--muted)', deliveredTo, p => formatReceiptTime(p.deliveredAt)) +
        section(`🕓 Pending ${pending.length}`, 'var(--muted)', pending, () => '') +
        '<div style="font-size:11px;color:var(--muted);">Participants with read receipts disabled only ever show as delivered.</div>';
    }

    function setupCustomContextMenus() {
      const menu = document.getElementById('customContextMenu');
      if (!menu) return;
      
      const messagesArea = document.getElementById('messagesArea');
      if (messagesArea) {
        messagesArea.addEventListener('contextmenu', (e) => {
          const row = e.target.closest('.message-row');
          if (!row) return;
          
          e.preventDefault();
          const messageId = row.id.replace('msg-', '');
          const jid = activeChat ? activeChat.id : '';
          const isFlagged = row.classList.contains('flagged-msg');
          
          let menuHtml = '';
          if (isFlagged) {
            menuHtml += `<div class="context-menu-item" onclick="resolveFlagDirect('${messageId}', '${jid}')">🚩 Resolve Flag</div>`;
          } else {
            menuHtml += `<div class="context-menu-item" onclick="flagMessagePrompt('${messageId}', '${jid}')">🚩 Flag for Team</div>`;
          }
          
          menuHtml += `<div class="context-menu-divider"></div>`;
          
          const fromMe = row.dataset.fromMe === '1';
          const deleted = row.dataset.deleted === '1';
          const mediaType = row.dataset.mediaType || 'text';
          const timestamp = Number(row.dataset.timestamp) || 0;
          
          const isGroupChat = activeChat && (activeChat.type === 'group' || activeChat.type === 'community' || (activeChat.id || '').endsWith('@g.us'));
          if (fromMe && isGroupChat) {
            menuHtml += `<div class="context-menu-item" onclick="openMessageInfo('${messageId}')">ℹ️ Details</div>`;
          }

          if (!deleted) {
            menuHtml += `<div class="context-menu-item" onclick="startReply('${messageId}')">↩ Reply</div>`;

            const downloadableTypes = ['image', 'video', 'audio', 'voice', 'document', 'sticker'];
            if (downloadableTypes.includes(mediaType)) {
              menuHtml += `<div class="context-menu-item" onclick="downloadFromContext('${messageId}', '${jid}')">📥 Download</div>`;
            }
            
            const ageSec = Math.floor(Date.now() / 1000) - timestamp;
            if (fromMe && mediaType === 'text' && ageSec <= EDIT_WINDOW_SECONDS) {
              menuHtml += `<div class="context-menu-item" onclick="startEdit('${messageId}')">✎ Edit</div>`;
            }
            if (fromMe && ageSec <= DELETE_FOR_EVERYONE_WINDOW_SECONDS) {
              menuHtml += `<div class="context-menu-item" style="color:var(--danger)" onclick="startDelete('${messageId}')">🗑 Delete</div>`;
            }
          }
          
          menu.innerHTML = menuHtml;
          menu.style.left = e.clientX + 'px';
          menu.style.top = e.clientY + 'px';
          menu.classList.remove('hidden');
        });
      }
      
      const chatList = document.getElementById('chatList');
      if (chatList) {
        chatList.addEventListener('contextmenu', (e) => {
          const chatItem = e.target.closest('.chat-item');
          if (!chatItem) return;
          
          e.preventDefault();
          const jid = chatItem.getAttribute('data-jid');
          
          // Seen-status is global across operators, so there's a single
          // mark-as-unread action (per-operator scopes are on hold).
          let menuHtml = `
            <div class="context-menu-item" onclick="markChatUnreadDirect('${jid}', 'all')">🔵 Mark as Unread</div>
          `;
          
          menu.innerHTML = menuHtml;
          menu.style.left = e.clientX + 'px';
          menu.style.top = e.clientY + 'px';
          menu.classList.remove('hidden');
        });
      }
      
      document.addEventListener('click', (e) => {
        if (!e.target.closest('#customContextMenu')) {
          menu.classList.add('hidden');
        }
      });
      
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          menu.classList.add('hidden');
        }
      });
    }

    // ─── Drag & Drop file upload ─────────────────────────────────────────────────
    function setupDragAndDrop() {
      const zone = document.getElementById('chatView');
      if (!zone) return;

      const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
      // dragenter/dragleave fire for every child element crossed; track depth
      // so the highlight only clears when the pointer truly leaves the zone.
      let dragDepth = 0;

      zone.addEventListener('dragenter', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth++;
        zone.classList.add('drag-over');
      });
      zone.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      });
      zone.addEventListener('dragleave', (e) => {
        if (!hasFiles(e)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) zone.classList.remove('drag-over');
      });
      zone.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth = 0;
        zone.classList.remove('drag-over');
        addFilesToPending(e.dataTransfer.files);
      });

      // Anywhere else on the page: block the browser's default behavior of
      // navigating to (opening) the dropped file.
      document.addEventListener('dragover', (e) => {
        if (hasFiles(e)) e.preventDefault();
      });
      document.addEventListener('drop', (e) => {
        if (hasFiles(e)) e.preventDefault();
      });
    }

    // ─── Init ─────────────────────────────────────────────────────────────────────
    // Show empty state initially
    document.getElementById('chatList').innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:12px">Click "Connect Bridge" to start</div>';
    renderPanel();
    renderChatHeader();
    setupCustomContextMenus();
    setupDragAndDrop();

    // Internet connectivity check
    updateInternetStatus();
    setInterval(updateInternetStatus, 8000); // Check every 8 seconds

    window.addEventListener('online', updateInternetStatus);
    window.addEventListener('offline', updateInternetStatus);

    // Auto-connect to bridge on load
    const currentOrigin = window.location.protocol.startsWith('http') ? window.location.origin : bridgeUrl;
    connectBridgeDirect(currentOrigin);
    initSidebarResize();
    initNotifications();

    // ─── Mobile View Actions ──────────────────────────────────────────────────────
    function backToSidebar() {
      const main = document.querySelector('.main');
      if (main) {
        main.classList.remove('view-chat');
        main.classList.remove('view-panel');
        main.classList.add('view-chats');
      }
    }

    function toggleMobileMenu() {
      const menu = document.querySelector('.topbar-right');
      if (menu) {
        menu.classList.toggle('open');
      }
    }

    function closeMobileMenu() {
      const menu = document.querySelector('.topbar-right');
      if (menu) {
        menu.classList.remove('open');
      }
    }

    // Handle click-away for mobile dropdown menu and message actions touch-toggle
    document.addEventListener('click', (e) => {
      // 1. Mobile topbar menu click-away
      const menu = document.querySelector('.topbar-right');
      const toggle = document.getElementById('mobileMenuToggle');
      if (menu && toggle && !menu.contains(e.target) && !toggle.contains(e.target)) {
        menu.classList.remove('open');
      }

      // 2. Touch bubble actions toggle (mobile-friendly edit/delete)
      const bubble = e.target.closest('.msg-bubble');
      if (bubble) {
        // Toggle actions for this bubble and close all others
        const wasActive = bubble.classList.contains('show-actions');
        document.querySelectorAll('.msg-bubble').forEach(b => b.classList.remove('show-actions'));
        if (!wasActive) {
          bubble.classList.add('show-actions');
        }
      } else {
        // Clicked outside a bubble, close all actions
        document.querySelectorAll('.msg-bubble').forEach(b => b.classList.remove('show-actions'));
      }
    });

    // Paste handling (images -> pending attachments, text -> plain-text insert) lives
    // in handleComposerPaste(), wired up via the messageInput's onpaste attribute.
