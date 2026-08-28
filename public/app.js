/* Filo — client app
 * Comunica con il backend via REST (/api/...) e realtime via Socket.IO.
 * NOTE: l'autenticazione è una demo basata solo sul numero di telefono
 * (vedi README). Non usare questo schema in produzione.
 */
(() => {
  'use strict';

  const state = {
    me: null,
    conversations: [],      // ordinate dal server: più recente prima
    activeConvId: null,
    messagesByConv: {},     // cache locale dei messaggi già caricati
    socket: null,
  };

  const el = (id) => document.getElementById(id);
  const authScreen = el('auth-screen');
  const appScreen = el('app-screen');
  const loginForm = el('login-form');
  const phoneInput = el('phone-input');
  const nameField = el('name-field');
  const nameInput = el('name-input');
  const authError = el('auth-error');
  const loginBtn = el('login-btn');

  const meAvatar = el('me-avatar');
  const meName = el('me-name');
  const mePhone = el('me-phone');
  const chatList = el('chat-list');
  const searchInput = el('search-input');

  const noConvSelected = el('no-conv-selected');
  const activeConv = el('active-conv');
  const convAvatar = el('conv-avatar');
  const convTitle = el('conv-title');
  const convSub = el('conv-sub');
  const messagesArea = el('messages-area');
  const composerInput = el('composer-input');
  const sendBtn = el('send-btn');
  const backBtn = el('back-btn');

  const modalOverlay = el('modal-overlay');
  const contactPhoneInput = el('contact-phone-input');
  const modalMsg = el('modal-msg');
  const modalSearch = el('modal-search');
  const modalCancel = el('modal-cancel');
  const newChatBtn = el('new-chat-btn');
  const logoutBtn = el('logout-btn');
  const toastEl = el('toast');

  // ---------- Helpers ----------
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  function initials(name, phone) {
    const src = (name && name.trim()) || phone || '?';
    const parts = src.trim().split(/\s+/);
    if (parts.length >= 2 && name) return (parts[0][0] + parts[1][0]).toUpperCase();
    return src.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  }

  function displayNameOf(conv) {
    return conv.contact_display_name || conv.contact_phone;
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return 'Ieri';
    return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
  }

  function fmtDayDivider(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* no body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Errore ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------- Auth ----------
  phoneInput.addEventListener('input', () => {
    // Rivela il campo nome dopo che l'utente ha iniziato a digitare un numero plausibile
    nameField.style.display = phoneInput.value.replace(/\D/g, '').length >= 5 ? 'block' : 'none';
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.textContent = '';
    loginBtn.disabled = true;
    loginBtn.textContent = 'Accesso in corso…';
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: { phone: phoneInput.value, displayName: nameInput.value },
      });
      state.me = data.user;
      enterApp();
    } catch (err) {
      authError.textContent = err.message || 'Numero non valido.';
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Continua';
    }
  });

  async function tryResumeSession() {
    try {
      const data = await api('/auth/me');
      state.me = data.user;
      enterApp();
    } catch (_) {
      // nessuna sessione attiva: resta sulla schermata di login
    }
  }

  logoutBtn.addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch (_) {}
    if (state.socket) state.socket.disconnect();
    state.me = null;
    state.conversations = [];
    state.activeConvId = null;
    appScreen.style.display = 'none';
    authScreen.style.display = 'flex';
    loginForm.reset();
    nameField.style.display = 'none';
  });

  // ---------- App bootstrap ----------
  async function enterApp() {
    authScreen.style.display = 'none';
    appScreen.style.display = 'block';
    meAvatar.textContent = initials(state.me.displayName, state.me.phone);
    meName.textContent = state.me.displayName || state.me.phone;
    mePhone.textContent = state.me.phone;

    connectSocket();
    await loadConversations();
  }

  function connectSocket() {
    state.socket = io({ withCredentials: true });

    state.socket.on('message:new', ({ message, conversationId }) => {
      // aggiorna cache messaggi se la conversazione è aperta
      if (state.messagesByConv[conversationId]) {
        state.messagesByConv[conversationId].push(message);
      }
      if (state.activeConvId === conversationId) {
        renderMessages(conversationId);
        markRead(conversationId);
      }
      bumpConversation(conversationId, message);
    });

    state.socket.on('conversation:new', () => {
      loadConversations();
    });
  }

  // ---------- Conversations ----------
  async function loadConversations() {
    const data = await api('/conversations');
    state.conversations = data.conversations;
    renderChatList();
    if (state.activeConvId) {
      const conv = state.conversations.find(c => c.id === state.activeConvId);
      if (conv) renderConvHeader(conv);
    }
  }

  function bumpConversation(conversationId, message) {
    const idx = state.conversations.findIndex(c => c.id === conversationId);
    if (idx === -1) { loadConversations(); return; }
    const conv = state.conversations[idx];
    conv.last_message_content = message.content;
    conv.last_message_at = message.createdAt;
    if (message.senderId !== state.me.id && state.activeConvId !== conversationId) {
      conv.unread_count = (conv.unread_count || 0) + 1;
    }
    state.conversations.splice(idx, 1);
    state.conversations.unshift(conv);
    renderChatList();
  }

  function renderChatList() {
    const query = searchInput.value.trim().toLowerCase();
    const items = state.conversations.filter(c => {
      if (!query) return true;
      return displayNameOf(c).toLowerCase().includes(query);
    });

    if (items.length === 0) {
      chatList.innerHTML = `<div class="empty-list">${
        state.conversations.length === 0
          ? 'Nessuna conversazione. Premi “+” per iniziarne una.'
          : 'Nessun risultato.'
      }</div>`;
      return;
    }

    chatList.innerHTML = '';
    for (const conv of items) {
      const item = document.createElement('div');
      item.className = 'chat-item' + (conv.id === state.activeConvId ? ' active' : '');
      item.dataset.id = conv.id;
      const name = displayNameOf(conv);
      item.innerHTML = `
        <div class="avatar">${initials(conv.contact_display_name, conv.contact_phone)}</div>
        <div class="chat-meta">
          <div class="chat-top">
            <span class="chat-name">${escapeHtml(name)}</span>
            <span class="chat-time">${fmtTime(conv.last_message_at)}</span>
          </div>
          <div class="chat-bottom">
            <span class="chat-last">${escapeHtml(conv.last_message_content || 'Dì ciao 👋')}</span>
            ${conv.unread_count ? `<span class="unread-badge">${conv.unread_count}</span>` : ''}
          </div>
        </div>`;
      item.addEventListener('click', () => openConversation(conv.id));
      chatList.appendChild(item);
    }
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str == null ? '' : String(str);
    return d.innerHTML;
  }

  function renderConvHeader(conv) {
    convAvatar.textContent = initials(conv.contact_display_name, conv.contact_phone);
    convTitle.textContent = displayNameOf(conv);
    convSub.textContent = conv.contact_phone;
  }

  async function openConversation(convId) {
    state.activeConvId = convId;
    document.body.classList.add('conv-open');
    noConvSelected.style.display = 'none';
    activeConv.style.display = 'flex';

    const conv = state.conversations.find(c => c.id === convId);
    if (conv) {
      renderConvHeader(conv);
      conv.unread_count = 0;
    }
    renderChatList();

    if (!state.messagesByConv[convId]) {
      const data = await api(`/conversations/${convId}/messages`);
      state.messagesByConv[convId] = data.messages;
    }
    renderMessages(convId);
    markRead(convId);
    composerInput.focus();
  }

  backBtn.addEventListener('click', () => {
    document.body.classList.remove('conv-open');
  });

  async function markRead(convId) {
    try { await api(`/conversations/${convId}/read`, { method: 'POST' }); } catch (_) {}
  }

  function renderMessages(convId) {
    const msgs = state.messagesByConv[convId] || [];
    messagesArea.innerHTML = '';
    let lastDay = null;
    for (const m of msgs) {
      const day = new Date(m.createdAt).toDateString();
      if (day !== lastDay) {
        const divider = document.createElement('div');
        divider.className = 'day-divider';
        divider.textContent = fmtDayDivider(m.createdAt);
        messagesArea.appendChild(divider);
        lastDay = day;
      }
      const row = document.createElement('div');
      const out = m.senderId === state.me.id;
      row.className = 'msg-row ' + (out ? 'out' : 'in');
      row.innerHTML = `<div class="bubble">${escapeHtml(m.content)}<span class="msg-time">${
        new Date(m.createdAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
      }</span></div>`;
      messagesArea.appendChild(row);
    }
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }

  // ---------- Sending messages ----------
  function autoGrow() {
    composerInput.style.height = 'auto';
    composerInput.style.height = Math.min(composerInput.scrollHeight, 120) + 'px';
  }
  composerInput.addEventListener('input', autoGrow);
  composerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  sendBtn.addEventListener('click', sendMessage);

  async function sendMessage() {
    const content = composerInput.value.trim();
    if (!content || !state.activeConvId) return;
    composerInput.value = '';
    autoGrow();
    sendBtn.disabled = true;
    try {
      const data = await api(`/conversations/${state.activeConvId}/messages`, {
        method: 'POST',
        body: { content },
      });
      if (!state.messagesByConv[state.activeConvId]) state.messagesByConv[state.activeConvId] = [];
      state.messagesByConv[state.activeConvId].push(data.message);
      renderMessages(state.activeConvId);
      bumpConversation(state.activeConvId, data.message);
    } catch (err) {
      showToast(err.message || 'Invio non riuscito.');
    } finally {
      sendBtn.disabled = false;
    }
  }

  // ---------- New chat modal ----------
  function openModal() {
    modalOverlay.classList.add('show');
    contactPhoneInput.value = '';
    modalMsg.textContent = '';
    modalMsg.className = 'modal-msg';
    setTimeout(() => contactPhoneInput.focus(), 50);
  }
  function closeModal() { modalOverlay.classList.remove('show'); }

  newChatBtn.addEventListener('click', openModal);
  modalCancel.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

  modalSearch.addEventListener('click', async () => {
    const phone = contactPhoneInput.value.trim();
    if (!phone) return;
    modalMsg.textContent = 'Ricerca in corso…';
    modalMsg.className = 'modal-msg';
    modalSearch.disabled = true;
    try {
      const data = await api('/conversations', {
        method: 'POST',
        body: { phone },
      });
      closeModal();
      await loadConversations();
      openConversation(data.conversation.id);
    } catch (err) {
      modalMsg.textContent = err.message || 'Utente non trovato.';
      modalMsg.className = 'modal-msg error';
    } finally {
      modalSearch.disabled = false;
    }
  });

  searchInput.addEventListener('input', renderChatList);

  // ---------- Boot ----------
  tryResumeSession();
})();
