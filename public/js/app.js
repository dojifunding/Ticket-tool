/* ═══════════════════════════════════════════════════
   ProjectHub — Client-Side Application
   ═══════════════════════════════════════════════════ */

// ─── Socket.io Connection ─────────────────────────
const socket = io({ autoConnect: true });

socket.on('connect', () => {
  console.log('[Socket] Connected:', socket.id);
  loadNotifications();
});

socket.on('disconnect', () => {
  console.log('[Socket] Disconnected');
});

// ─── Online Users ─────────────────────────────────
socket.on('users:online', (users) => {
  const countEl = document.getElementById('onlineCount');
  if (countEl) countEl.textContent = users.length;
});

// ─── Notifications ────────────────────────────────
let notifOpen = false;

function toggleNotifications() {
  const dropdown = document.getElementById('notifDropdown');
  notifOpen = !notifOpen;
  dropdown.classList.toggle('active', notifOpen);
  if (notifOpen) loadNotifications();
}

// Close dropdown on outside click
document.addEventListener('click', (e) => {
  const bell = document.getElementById('notifBell');
  if (bell && !bell.contains(e.target)) {
    document.getElementById('notifDropdown').classList.remove('active');
    notifOpen = false;
  }
});

async function loadNotifications() {
  try {
    const res = await fetch('/api/notifications');
    const data = await res.json();
    renderNotifications(data.notifications);
    updateNotifBadge(data.unreadCount);
  } catch (err) {
    console.error('[Notif] Load error:', err);
  }
}

function renderNotifications(notifications) {
  const list = document.getElementById('notifList');
  if (!list) return;

  if (!notifications || notifications.length === 0) {
    list.innerHTML = '<div class="notif-empty">Aucune notification</div>';
    return;
  }

  list.innerHTML = notifications.map(n => {
    const icons = {
      task_assigned: '📋', task_update: '🔄', task_comment: '💬',
      ticket_assigned: '🎫', ticket_message: '💬', ticket_created: '🆕',
      escalation: '🔺', project_created: '📁'
    };
    const icon = icons[n.type] || '🔔';
    const timeAgo = getTimeAgo(n.created_at);

    return `
      <div class="notif-item ${n.is_read ? '' : 'unread'}" 
           onclick="readNotification(${n.id}, '${n.link || ''}')">
        <div class="notif-icon">${icon}</div>
        <div class="notif-content">
          <div class="notif-title">${escapeHtml(n.title)}</div>
          <div class="notif-message">${escapeHtml(n.message || '')}</div>
          <div class="notif-time">${timeAgo}</div>
        </div>
      </div>
    `;
  }).join('');
}

function updateNotifBadge(count) {
  const badge = document.getElementById('notifBadge');
  if (!badge) return;
  if (count > 0) {
    badge.style.display = 'flex';
    badge.textContent = count > 99 ? '99+' : count;
  } else {
    badge.style.display = 'none';
  }
}

async function readNotification(id, link) {
  try {
    await fetch(`/api/notifications/${id}/read`, { method: 'POST' });
    socket.emit('notifications:read', id);
    if (link) window.location.href = link;
    else loadNotifications();
  } catch (err) {
    console.error('[Notif] Read error:', err);
  }
}

async function markAllRead() {
  try {
    await fetch('/api/notifications/read-all', { method: 'POST' });
    socket.emit('notifications:readAll');
    loadNotifications();
  } catch (err) {
    console.error('[Notif] Mark all error:', err);
  }
}

// Listen for new notifications
socket.on('notification:new', () => {
  loadNotifications();
});

// ─── Sidebar Toggle ───────────────────────────────
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.classList.toggle('open');
}

// ─── Global Search ────────────────────────────────
const searchInput = document.getElementById('globalSearch');
const searchResults = document.getElementById('searchResults');
let searchTimeout = null;

if (searchInput) {
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const query = searchInput.value.trim();
    if (query.length < 2) {
      searchResults.classList.remove('active');
      return;
    }
    searchTimeout = setTimeout(() => performSearch(query), 300);
  });

  searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim().length >= 2) {
      searchResults.classList.add('active');
    }
  });

  document.addEventListener('click', (e) => {
    if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) {
      searchResults.classList.remove('active');
    }
  });
}

async function performSearch(query) {
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    renderSearchResults(data.results);
  } catch (err) {
    console.error('[Search] Error:', err);
  }
}

function renderSearchResults(results) {
  if (!searchResults) return;
  if (!results || results.length === 0) {
    searchResults.innerHTML = '<div class="notif-empty">Aucun résultat</div>';
    searchResults.classList.add('active');
    return;
  }

  searchResults.innerHTML = results.map(r => {
    let typeLabel, url;
    switch (r.result_type) {
      case 'task':
        typeLabel = '<span class="search-result-type type-task">Tâche</span>';
        url = `/projects/${r.project_id}/tasks/${r.id}`;
        break;
      case 'project':
        typeLabel = '<span class="search-result-type type-project">Projet</span>';
        url = `/projects/${r.id}/board`;
        break;
      case 'ticket':
        typeLabel = '<span class="search-result-type type-ticket">Ticket</span>';
        url = `/tickets/${r.id}`;
        break;
      default:
        typeLabel = '';
        url = '#';
    }
    return `
      <a href="${url}" class="search-result-item">
        ${typeLabel}
        <span class="search-result-title">${escapeHtml(r.title || r.name || r.subject)}</span>
      </a>
    `;
  }).join('');
  searchResults.classList.add('active');
}

// ─── Kanban Drag & Drop ───────────────────────────
let draggedTaskId = null;

function dragTask(event, taskId) {
  draggedTaskId = taskId;
  event.dataTransfer.effectAllowed = 'move';
  event.target.closest('.kanban-card').style.opacity = '0.5';
}

function dropTask(event) {
  event.preventDefault();
  const column = event.currentTarget;
  column.classList.remove('drag-over');

  if (!draggedTaskId) return;
  const newStatus = column.dataset.status;

  // Move card visually
  const card = document.querySelector(`[data-task-id="${draggedTaskId}"]`);
  if (card) {
    card.style.opacity = '1';
    column.appendChild(card);
  }

  // Update via API
  fetch(`/api/tasks/${draggedTaskId}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: newStatus })
  }).then(res => {
    if (res.ok) {
      socket.emit('task:move', { taskId: draggedTaskId, status: newStatus });
      updateColumnCounts();
    }
  }).catch(err => console.error('[Kanban] Move error:', err));

  draggedTaskId = null;
}

function updateColumnCounts() {
  document.querySelectorAll('.kanban-column').forEach(col => {
    const count = col.querySelectorAll('.kanban-card').length;
    const countEl = col.querySelector('.column-count');
    if (countEl) countEl.textContent = count;
  });
}

// Listen for real-time kanban updates from other users
socket.on('task:updated', (task) => {
  // If we're on a kanban board, reload to reflect changes
  if (document.getElementById('kanbanBoard')) {
    window.location.reload();
  }
});

// ─── Real-time Messages (Tickets) ─────────────────
socket.on('ticket:newMessage', (data) => {
  const messagesList = document.getElementById('messagesList');
  if (!messagesList) return;

  // Check if we're on the right ticket page
  const ticketId = messagesList.dataset.ticketId;
  if (ticketId && String(data.ticketId) === String(ticketId)) {
    appendMessage(data.message);
  }
});

function appendMessage(msg) {
  const list = document.getElementById('messagesList');
  if (!list) return;

  const emptyState = list.querySelector('.notif-empty, .empty-state');
  if (emptyState) emptyState.remove();

  const msgEl = document.createElement('div');
  msgEl.className = `message ${msg.is_internal ? 'message-internal' : ''}`;
  msgEl.innerHTML = `
    <div class="avatar avatar-sm" style="background-color: ${msg.avatar_color || '#6366f1'}">${(msg.full_name || '?').charAt(0)}</div>
    <div class="message-body">
      <div class="message-header">
        <strong>${escapeHtml(msg.full_name || 'Utilisateur')}</strong>
        <span class="message-role">${msg.role || ''}</span>
        ${msg.is_internal ? '<span class="internal-badge">Note interne</span>' : ''}
        <time>${new Date().toLocaleString('fr-FR')}</time>
      </div>
      <div class="message-content">${escapeHtml(msg.content)}</div>
    </div>
  `;
  list.appendChild(msgEl);
  list.scrollTop = list.scrollHeight;
}

function sendTicketMessage(ticketId) {
  const textarea = document.getElementById('messageInput');
  const internalCheck = document.getElementById('internalCheck');
  const content = textarea.value.trim();
  if (!content) return;

  socket.emit('ticket:message', {
    ticketId: parseInt(ticketId),
    content: content,
    isInternal: internalCheck ? internalCheck.checked : false
  });

  textarea.value = '';
  if (internalCheck) internalCheck.checked = false;
}

// ─── Real-time Comments (Tasks) ───────────────────
socket.on('task:newComment', (data) => {
  const commentsList = document.getElementById('commentsList');
  if (!commentsList) return;

  const taskId = commentsList.dataset.taskId;
  if (taskId && String(data.taskId) === String(taskId)) {
    appendComment(data.comment);
  }
});

function appendComment(comment) {
  const list = document.getElementById('commentsList');
  if (!list) return;

  const emptyState = list.querySelector('.notif-empty, .empty-state');
  if (emptyState) emptyState.remove();

  const el = document.createElement('div');
  el.className = 'comment';
  el.innerHTML = `
    <div class="avatar avatar-sm" style="background-color: ${comment.avatar_color || '#6366f1'}">${(comment.full_name || '?').charAt(0)}</div>
    <div class="comment-body">
      <div class="comment-header">
        <strong>${escapeHtml(comment.full_name || 'Utilisateur')}</strong>
        <time>${new Date().toLocaleString('fr-FR')}</time>
      </div>
      <div class="comment-content">${escapeHtml(comment.content)}</div>
    </div>
  `;
  list.appendChild(el);
  list.scrollTop = list.scrollHeight;
}

function sendTaskComment(taskId) {
  const textarea = document.getElementById('commentInput');
  const content = textarea.value.trim();
  if (!content) return;

  socket.emit('task:comment', {
    taskId: parseInt(taskId),
    content: content
  });

  textarea.value = '';
}

// ─── Modal (New Task in Kanban) ───────────────────
function openNewTaskModal() {
  const overlay = document.getElementById('newTaskModal');
  if (overlay) overlay.classList.add('active');
}

function closeNewTaskModal() {
  const overlay = document.getElementById('newTaskModal');
  if (overlay) overlay.classList.remove('active');
}

// Close modal on overlay click
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('active');
  }
});

// Close modal on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach(m => {
      m.classList.remove('active');
    });
  }
});

// ─── Ctrl+Enter to Submit Textareas ───────────────
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    const textarea = e.target;
    if (textarea.tagName !== 'TEXTAREA') return;

    // Find the submit button nearest to this textarea
    const wrapper = textarea.closest('.comment-form, .message-form, .comment-input-wrapper, .message-input-wrapper');
    if (wrapper) {
      const btn = wrapper.querySelector('button[type="submit"], .btn-primary, button[onclick]');
      if (btn) btn.click();
    }
  }
});

// ─── Demo Account Buttons (Login Page) ────────────
function fillDemo(username, password) {
  const userInput = document.querySelector('input[name="username"]');
  const passInput = document.querySelector('input[name="password"]');
  if (userInput) userInput.value = username;
  if (passInput) passInput.value = password;
}

// ─── Real-time Ticket Updates ─────────────────────
socket.on('ticket:created', () => {
  // If on tickets list, reload
  if (window.location.pathname === '/tickets') {
    window.location.reload();
  }
});

socket.on('ticket:updated', () => {
  // If on tickets list, reload
  if (window.location.pathname === '/tickets') {
    window.location.reload();
  }
});

socket.on('escalation:new', (data) => {
  // Show a browser notification if permitted
  if (Notification.permission === 'granted') {
    new Notification('🔺 Nouvelle escalade', {
      body: data.message || 'Un ticket a été escaladé vers l\'équipe développement',
    });
  }
  loadNotifications();
});

// ─── Task Created Real-time ───────────────────────
socket.on('task:created', () => {
  if (document.getElementById('kanbanBoard')) {
    window.location.reload();
  }
});

// ─── Utility Functions ────────────────────────────

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getTimeAgo(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'À l\'instant';
  if (diffMins < 60) return `Il y a ${diffMins} min`;
  if (diffHours < 24) return `Il y a ${diffHours}h`;
  if (diffDays < 7) return `Il y a ${diffDays}j`;
  return date.toLocaleDateString('fr-FR');
}

// ─── Auto-resize Textareas ────────────────────────
document.querySelectorAll('textarea').forEach(textarea => {
  textarea.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });
});

// ─── Request Browser Notification Permission ──────
if ('Notification' in window && Notification.permission === 'default') {
  // Request permission after first user interaction
  document.addEventListener('click', function requestPerm() {
    Notification.requestPermission();
    document.removeEventListener('click', requestPerm);
  }, { once: true });
}

// ─── Init ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Scroll messages/comments to bottom
  document.querySelectorAll('.messages-list, .comments-list').forEach(list => {
    list.scrollTop = list.scrollHeight;
  });
});

console.log('[ProjectHub] App initialized ✓');
