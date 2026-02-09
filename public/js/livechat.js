// ═══════════════════════════════════════════════════════
//  LIVECHAT WIDGET — Help Center
// ═══════════════════════════════════════════════════════
(function() {
  'use strict';

  const STORAGE_KEY = 'ph_livechat_token';
  let state = {
    open: false,
    token: localStorage.getItem(STORAGE_KEY) || null,
    session: null,
    messages: [],
    mode: 'ai', // ai | human | closed
    socket: null,
    polling: null,
    lastMsgTime: null,
    lang: document.documentElement.lang || 'fr'
  };

  const T = {
    fr: {
      title: 'Assistance',
      subtitle: 'Posez votre question, notre IA vous répond instantanément',
      placeholder: 'Tapez votre message...',
      send: 'Envoyer',
      humanBtn: '🧑 Parler à un humain',
      humanConnecting: 'Connexion à un agent...',
      humanConnected: 'Vous êtes connecté à un agent. Référence :',
      nameLabel: 'Votre nom',
      emailLabel: 'Votre email',
      startBtn: 'Démarrer le chat',
      aiLabel: '🤖 Assistant IA',
      agentLabel: '🧑 Agent',
      youLabel: 'Vous',
      typing: 'L\'assistant réfléchit...',
      closed: 'Conversation terminée.',
      close: 'Fermer',
      minimize: 'Réduire',
      powered: 'Propulsé par ProjectHub AI',
      newChat: 'Nouvelle conversation',
      escalateInfo: 'Pour vous mettre en relation avec un agent, merci de renseigner vos coordonnées :',
      cancel: 'Annuler'
    },
    en: {
      title: 'Support',
      subtitle: 'Ask your question, our AI responds instantly',
      placeholder: 'Type your message...',
      send: 'Send',
      humanBtn: '🧑 Talk to a human',
      humanConnecting: 'Connecting to an agent...',
      humanConnected: 'You are connected to an agent. Reference:',
      nameLabel: 'Your name',
      emailLabel: 'Your email',
      startBtn: 'Start chat',
      aiLabel: '🤖 AI Assistant',
      agentLabel: '🧑 Agent',
      youLabel: 'You',
      typing: 'Assistant is thinking...',
      closed: 'Conversation ended.',
      close: 'Close',
      minimize: 'Minimize',
      powered: 'Powered by ProjectHub AI',
      newChat: 'New conversation',
      escalateInfo: 'To connect you with an agent, please provide your contact details:',
      cancel: 'Cancel'
    }
  };

  function t(key) { return (T[state.lang] || T.fr)[key] || key; }

  // ─── Build Widget DOM ──────────────────────────────
  function buildWidget() {
    const widget = document.createElement('div');
    widget.id = 'livechat-widget';
    widget.innerHTML = `
      <button id="lc-toggle" aria-label="Chat">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 21 1.9-5.7a8.5 8.5 0 1 1 3.8 3.8z"/></svg>
        <span id="lc-badge" style="display:none">1</span>
      </button>
      <div id="lc-window" class="lc-hidden">
        <div id="lc-header">
          <div class="lc-header-info">
            <div class="lc-avatar-dot">💬</div>
            <div>
              <div class="lc-header-title">${t('title')}</div>
              <div class="lc-header-sub" id="lc-status">${t('subtitle')}</div>
            </div>
          </div>
          <div class="lc-header-btns">
            <button id="lc-minimize" title="${t('minimize')}">─</button>
            <button id="lc-close-btn" title="${t('close')}">×</button>
          </div>
        </div>
        <div id="lc-body">
          <div id="lc-intro" class="lc-intro">
            <div class="lc-intro-icon">🤖</div>
            <h3>${t('title')}</h3>
            <p>${t('subtitle')}</p>
            <div class="lc-intro-form">
              <input type="text" id="lc-name" placeholder="${t('nameLabel')}" autocomplete="name">
              <input type="email" id="lc-email" placeholder="${t('emailLabel')}" autocomplete="email">
              <button id="lc-start-btn" class="lc-btn-primary">${t('startBtn')}</button>
            </div>
          </div>
          <div id="lc-messages" class="lc-messages" style="display:none"></div>
          <div id="lc-typing" class="lc-typing" style="display:none">
            <div class="lc-typing-dots"><span></span><span></span><span></span></div>
            <span>${t('typing')}</span>
          </div>
        </div>
        <div id="lc-footer" style="display:none">
          <div id="lc-escalate-bar" style="display:none">
            <button id="lc-human-btn" class="lc-btn-outline">${t('humanBtn')}</button>
          </div>
          <div class="lc-input-row">
            <input type="text" id="lc-input" placeholder="${t('placeholder')}" autocomplete="off">
            <button id="lc-send" class="lc-btn-send" disabled>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>
          <div class="lc-powered">${t('powered')}</div>
        </div>
      </div>
    `;
    document.body.appendChild(widget);
    bindEvents();
  }

  // ─── Bind Events ───────────────────────────────────
  function bindEvents() {
    document.getElementById('lc-toggle').addEventListener('click', toggleChat);
    document.getElementById('lc-minimize').addEventListener('click', () => { state.open = false; document.getElementById('lc-window').classList.add('lc-hidden'); });
    document.getElementById('lc-close-btn').addEventListener('click', closeChat);
    document.getElementById('lc-start-btn').addEventListener('click', startChat);
    document.getElementById('lc-send').addEventListener('click', sendMessage);
    document.getElementById('lc-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
    document.getElementById('lc-input').addEventListener('input', () => {
      document.getElementById('lc-send').disabled = !document.getElementById('lc-input').value.trim();
    });

    const humanBtn = document.getElementById('lc-human-btn');
    if (humanBtn) humanBtn.addEventListener('click', escalateToHuman);

    // Resume existing session
    if (state.token) resumeSession();
  }

  // ─── Toggle ────────────────────────────────────────
  function toggleChat() {
    state.open = !state.open;
    document.getElementById('lc-window').classList.toggle('lc-hidden', !state.open);
    if (state.open) {
      document.getElementById('lc-badge').style.display = 'none';
      scrollToBottom();
      const input = document.getElementById('lc-input');
      if (input.offsetParent) input.focus();
    }
  }

  // ─── Start New Chat ────────────────────────────────
  async function startChat() {
    const name = document.getElementById('lc-name').value.trim();
    const email = document.getElementById('lc-email').value.trim();

    const btn = document.getElementById('lc-start-btn');
    btn.disabled = true; btn.textContent = '...';

    try {
      const res = await fetch('/api/chat/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email })
      });
      const data = await res.json();
      if (data.ok) {
        state.token = data.session.visitor_token;
        state.session = data.session;
        state.messages = data.messages || [];
        state.mode = data.session.status;
        localStorage.setItem(STORAGE_KEY, state.token);
        showChatUI();
        connectSocket();
      }
    } catch (e) { console.error('[Livechat]', e); }

    btn.disabled = false; btn.textContent = t('startBtn');
  }

  // ─── Resume Session ────────────────────────────────
  async function resumeSession() {
    try {
      const res = await fetch('/api/chat/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: state.token })
      });
      const data = await res.json();
      if (data.ok) {
        // Server may have created a new session if old token was invalid
        if (data.session.visitor_token !== state.token) {
          state.token = data.session.visitor_token;
          localStorage.setItem(STORAGE_KEY, state.token);
        }
        state.session = data.session;
        state.messages = data.messages || [];
        state.mode = data.session.status;
        if (state.mode === 'closed') {
          showChatUI();
          showClosedState(null);
        } else {
          showChatUI();
          connectSocket();
        }
      } else {
        resetSession();
      }
    } catch (e) {
      console.error('[Livechat] Resume error:', e);
      resetSession();
    }
  }

  function resetSession() {
    localStorage.removeItem(STORAGE_KEY);
    state.token = null;
    state.messages = [];
    state.mode = 'ai';
    state.session = null;
  }

  // ─── Show Chat UI ─────────────────────────────────
  function showChatUI() {
    document.getElementById('lc-intro').style.display = 'none';
    document.getElementById('lc-messages').style.display = 'flex';
    document.getElementById('lc-footer').style.display = 'block';

    if (state.mode === 'ai') {
      document.getElementById('lc-escalate-bar').style.display = 'flex';
      document.getElementById('lc-status').textContent = t('aiLabel');
    } else if (state.mode === 'human') {
      document.getElementById('lc-escalate-bar').style.display = 'none';
      document.getElementById('lc-status').textContent = t('agentLabel');
    }

    renderMessages();
    scrollToBottom();
  }

  // ─── Render Messages ───────────────────────────────
  function renderMessages() {
    const container = document.getElementById('lc-messages');
    container.innerHTML = '';
    state.messages.forEach(msg => appendMessageDOM(msg));
  }

  function appendMessageDOM(msg) {
    const container = document.getElementById('lc-messages');
    const div = document.createElement('div');
    const isVisitor = msg.sender_type === 'visitor';
    div.className = `lc-msg ${isVisitor ? 'lc-msg-visitor' : 'lc-msg-other'}`;

    const label = isVisitor ? t('youLabel') : (msg.sender_type === 'ai' ? '🤖' : '🧑 ' + (msg.sender_name || 'Agent'));
    const time = msg.created_at ? new Date(msg.created_at).toLocaleTimeString(state.lang, { hour: '2-digit', minute: '2-digit' }) : '';

    // AI messages: render markdown. Visitor messages: escape only.
    const rendered = isVisitor ? escapeHtml(msg.content) : renderMd(msg.content);

    div.innerHTML = `
      <div class="lc-msg-label">${label}</div>
      <div class="lc-msg-bubble">${rendered}</div>
      <div class="lc-msg-time">${time}</div>
    `;
    container.appendChild(div);
  }

  function scrollToBottom() {
    setTimeout(() => {
      const el = document.getElementById('lc-messages');
      if (el) el.scrollTop = el.scrollHeight;
    }, 50);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML.replace(/\n/g, '<br>');
  }

  // Simple Markdown → HTML for chat bubbles
  function renderMd(text) {
    // Escape HTML first
    const div = document.createElement('div');
    div.textContent = text;
    let html = div.innerHTML;

    // Bold: **text** or __text__
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

    // Italic: *text* or _text_
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

    // Bullet lists: lines starting with - or •
    html = html.replace(/^[\-•]\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

    // Numbered lists: lines starting with 1. 2. etc
    html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

    // Headers: ### → bold, ## → bold, # → bold
    html = html.replace(/^#{1,3}\s+(.+)$/gm, '<strong>$1</strong>');

    // Line breaks
    html = html.replace(/\n/g, '<br>');

    // Clean up: remove <br> inside/around lists
    html = html.replace(/<br>\s*<ul>/g, '<ul>');
    html = html.replace(/<\/ul>\s*<br>/g, '</ul>');
    html = html.replace(/<br>\s*<li>/g, '<li>');
    html = html.replace(/<\/li>\s*<br>/g, '</li>');

    return html;
  }

  // ─── Send Message ──────────────────────────────────
  async function sendMessage() {
    const input = document.getElementById('lc-input');
    const content = input.value.trim();
    if (!content || !state.token) return;

    input.value = '';
    document.getElementById('lc-send').disabled = true;

    // Optimistic UI
    const visitorMsg = { sender_type: 'visitor', sender_name: 'Vous', content, created_at: new Date().toISOString() };
    state.messages.push(visitorMsg);
    appendMessageDOM(visitorMsg);
    scrollToBottom();

    // Show typing for AI mode
    if (state.mode === 'ai') {
      document.getElementById('lc-typing').style.display = 'flex';
      scrollToBottom();
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000); // 25s client timeout

      const res = await fetch('/api/chat/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: state.token, content }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      const data = await res.json();

      document.getElementById('lc-typing').style.display = 'none';

      // Session expired or DB reset — auto-reset
      if (!res.ok && (data.error === 'Session not found' || res.status === 404)) {
        resetSession();
        const sysMsg = {
          sender_type: 'ai', sender_name: 'System',
          content: state.lang === 'fr'
            ? '⚠️ Votre session a expiré. Veuillez démarrer une nouvelle conversation.'
            : '⚠️ Your session has expired. Please start a new conversation.',
          created_at: new Date().toISOString()
        };
        appendMessageDOM(sysMsg);
        scrollToBottom();
        // Show new chat button
        setTimeout(() => { if (window._lcNewChat) window._lcNewChat(); }, 2000);
        return;
      }

      if (data.aiMessage) {
        state.messages.push(data.aiMessage);
        appendMessageDOM(data.aiMessage);
        scrollToBottom();
      } else if (data.error) {
        const errMsg = { sender_type: 'ai', sender_name: 'System', content: '⚠️ ' + data.error, created_at: new Date().toISOString() };
        state.messages.push(errMsg);
        appendMessageDOM(errMsg);
        scrollToBottom();
      }
    } catch (e) {
      console.error('[Livechat] Send error:', e);
      document.getElementById('lc-typing').style.display = 'none';
      // Show error to user instead of silently failing
      const errMsg = {
        sender_type: 'ai', sender_name: 'System',
        content: e.name === 'AbortError'
          ? (state.lang === 'fr' ? '⏳ La réponse prend trop de temps. Essayez de reformuler ou parlez à un humain.' : '⏳ Response is taking too long. Try rephrasing or talk to a human.')
          : (state.lang === 'fr' ? '⚠️ Erreur de connexion. Réessayez.' : '⚠️ Connection error. Please retry.'),
        created_at: new Date().toISOString()
      };
      state.messages.push(errMsg);
      appendMessageDOM(errMsg);
      scrollToBottom();
    }

    input.focus();
  }

  // ─── Escalate to Human ─────────────────────────────
  async function escalateToHuman() {
    // If name/email missing, show inline form instead of browser prompt()
    if (!state.session?.visitor_name) {
      showEscalateForm();
      return;
    }
    doEscalate();
  }

  function showEscalateForm() {
    const bar = document.getElementById('lc-escalate-bar');
    bar.innerHTML = `
      <div class="lc-escalate-form">
        <p style="font-size:0.78rem; color:var(--lc-text-muted,#64748b); margin:0 0 8px;">${t('escalateInfo')}</p>
        <input type="text" id="lc-esc-name" placeholder="${t('nameLabel')}" class="lc-esc-input" autocomplete="name">
        <input type="email" id="lc-esc-email" placeholder="${t('emailLabel')}" class="lc-esc-input" autocomplete="email">
        <div style="display:flex; gap:6px; margin-top:6px;">
          <button class="lc-btn-primary lc-btn-sm" id="lc-esc-confirm">${t('humanBtn')}</button>
          <button class="lc-btn-outline lc-btn-sm" id="lc-esc-cancel">${t('cancel')}</button>
        </div>
      </div>
    `;
    bar.style.display = 'block';

    document.getElementById('lc-esc-confirm').addEventListener('click', async () => {
      const name = document.getElementById('lc-esc-name').value.trim();
      const email = document.getElementById('lc-esc-email').value.trim();
      if (name || email) {
        await fetch('/api/chat/session/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: state.token, name, email })
        });
        if (state.session) {
          state.session.visitor_name = name;
          state.session.visitor_email = email;
        }
      }
      doEscalate();
    });

    document.getElementById('lc-esc-cancel').addEventListener('click', () => {
      bar.innerHTML = '<button id="lc-human-btn" class="lc-btn-outline">' + t('humanBtn') + '</button>';
      document.getElementById('lc-human-btn').addEventListener('click', escalateToHuman);
    });

    document.getElementById('lc-esc-name').focus();
  }

  async function doEscalate() {
    const bar = document.getElementById('lc-escalate-bar');
    bar.innerHTML = '<div style="text-align:center; padding:8px; font-size:0.8rem; color:var(--lc-text-muted,#64748b);">' + t('humanConnecting') + '</div>';

    try {
      const res = await fetch('/api/chat/escalate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: state.token })
      });
      const data = await res.json();

      if (data.ok) {
        state.mode = 'human';
        bar.style.display = 'none';
        document.getElementById('lc-status').textContent = t('agentLabel');

        const sysMsg = { sender_type: 'ai', sender_name: 'System', content: t('humanConnected') + ' ' + data.ticketRef, created_at: new Date().toISOString() };
        state.messages.push(sysMsg);
        appendMessageDOM(sysMsg);
        scrollToBottom();

        startPolling();
        connectSocket();
      }
    } catch (e) {
      console.error('[Livechat] Escalate error:', e);
      bar.innerHTML = '<button id="lc-human-btn" class="lc-btn-outline">' + t('humanBtn') + '</button>';
      document.getElementById('lc-human-btn').addEventListener('click', escalateToHuman);
    }
  }


  // ─── Socket.io Connection ──────────────────────────
  function connectSocket() {
    if (state.socket) return;
    if (typeof io === 'undefined') return startPolling(); // fallback

    state.socket = io({ transports: ['websocket', 'polling'] });
    state.socket.emit('livechat:join', state.token);

    state.socket.on('livechat:newMessage', (msg) => {
      // Check if message is already in state (avoid duplicates)
      const isDup = state.messages.some(m => m.content === msg.content && m.sender_type === msg.sender_type && Math.abs(new Date(m.created_at) - new Date(msg.created_at)) < 2000);
      if (isDup) return;

      state.messages.push(msg);
      appendMessageDOM(msg);
      scrollToBottom();

      if (!state.open) {
        const badge = document.getElementById('lc-badge');
        badge.style.display = 'flex';
        badge.textContent = parseInt(badge.textContent || '0') + 1;
      }
    });

    // Agent closed the conversation
    state.socket.on('livechat:closed', (data) => {
      showClosedState(data.message);
    });
  }

  // ─── Polling (fallback / human mode) ───────────────
  function startPolling() {
    if (state.polling) return;
    state.polling = setInterval(async () => {
      if (!state.token || state.mode === 'closed') {
        clearInterval(state.polling);
        state.polling = null;
        return;
      }
      try {
        const lastTime = state.messages.length > 0
          ? state.messages[state.messages.length - 1].created_at
          : '1970-01-01';
        const res = await fetch(`/api/chat/messages/${state.token}?after=${encodeURIComponent(lastTime)}`);
        const data = await res.json();
        if (data.ok && data.messages.length > 0) {
          data.messages.forEach(msg => {
            if (msg.sender_type !== 'visitor') {
              const isDup = state.messages.some(m => m.content === msg.content && m.sender_type === msg.sender_type);
              if (!isDup) {
                state.messages.push(msg);
                appendMessageDOM(msg);
              }
            }
          });
          scrollToBottom();
          if (!state.open && data.messages.some(m => m.sender_type !== 'visitor')) {
            const badge = document.getElementById('lc-badge');
            badge.style.display = 'flex';
            badge.textContent = parseInt(badge.textContent || '0') + 1;
          }
        }
        if (data.status === 'closed' && state.mode !== 'closed') {
          showClosedState(t('closed'));
          clearInterval(state.polling);
          state.polling = null;
        }
      } catch (e) {}
    }, 3000);
  }

  // ─── Show Closed State ──────────────────────────────
  function showClosedState(message) {
    state.mode = 'closed';
    if (state.polling) { clearInterval(state.polling); state.polling = null; }

    // Add system message (only if message is provided — avoids duplicate on resume)
    if (message) {
      const sysMsg = { sender_type: 'ai', sender_name: 'System', content: message, created_at: new Date().toISOString() };
      state.messages.push(sysMsg);
      appendMessageDOM(sysMsg);
      scrollToBottom();
    }

    // Hide input, show new conversation button
    document.getElementById('lc-footer').innerHTML = `
      <div style="text-align:center; padding: 12px;">
        <p style="font-size:0.8rem; color:var(--lc-text-muted, #64748b); margin-bottom:10px;">${t('closed')}</p>
        <button class="lc-btn-primary" onclick="window._lcNewChat()" style="max-width:240px; margin:0 auto;">${t('newChat')}</button>
      </div>
    `;
    document.getElementById('lc-status').textContent = t('closed');
  }

  // Expose for inline onclick
  window._lcNewChat = function() {
    localStorage.removeItem(STORAGE_KEY);
    state.token = null;
    state.messages = [];
    state.mode = 'ai';
    state.session = null;
    if (state.socket) { state.socket.disconnect(); state.socket = null; }
    if (state.polling) { clearInterval(state.polling); state.polling = null; }

    // Reset UI fully
    document.getElementById('lc-intro').style.display = 'flex';
    document.getElementById('lc-messages').style.display = 'none';
    document.getElementById('lc-footer').style.display = 'none';
    document.getElementById('lc-footer').innerHTML = `
      <div id="lc-escalate-bar" style="display:none">
        <button id="lc-human-btn" class="lc-btn-outline">${t('humanBtn')}</button>
      </div>
      <div class="lc-input-row">
        <input type="text" id="lc-input" placeholder="${t('placeholder')}" autocomplete="off">
        <button id="lc-send" class="lc-btn-send" disabled>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
      <div class="lc-powered">${t('powered')}</div>
    `;
    document.getElementById('lc-status').textContent = t('subtitle');
    document.getElementById('lc-messages').innerHTML = '';
    document.getElementById('lc-name').value = '';
    document.getElementById('lc-email').value = '';

    // Re-bind events
    document.getElementById('lc-human-btn')?.addEventListener('click', escalateToHuman);
    document.getElementById('lc-send')?.addEventListener('click', sendMessage);
    document.getElementById('lc-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
    document.getElementById('lc-input')?.addEventListener('input', () => {
      document.getElementById('lc-send').disabled = !document.getElementById('lc-input').value.trim();
    });
  };

  // ─── Close Chat ────────────────────────────────────
  function closeChat() {
    if (state.token && state.mode !== 'closed') {
      const msg = state.lang === 'fr' ? 'Terminer cette conversation ?' : 'End this conversation?';
      if (confirm(msg)) {
        fetch('/api/chat/close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: state.token })
        });
        showClosedState(t('closed'));
      }
    } else if (state.mode === 'closed' || !state.token) {
      // Just minimize
      document.getElementById('lc-window').classList.add('lc-hidden');
      state.open = false;
    }
  }

  // ─── Init ──────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildWidget);
  } else {
    buildWidget();
  }
})();
