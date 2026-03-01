// ============================================================
//  TaskFlow — Shared Client Module (Phase 3)
//  Socket.IO connection, toast notifications, audio alerts,
//  notification badge, and shared utilities.
//  Imported by login.html, manager.html, employee.html.
// ============================================================

const TaskFlowApp = {
    currentUser: null,      // Set on login: { id, name, role, email, avatar_color }
    jwtToken: null,         // JWT token for API auth
    socket: null,           // Socket.IO connection
    unreadCount: 0,         // Notification badge count
    soundEnabled: true,     // Mute toggle state
    toastContainer: null,   // DOM reference, created on first toast
    onlineUsers: new Map(), // userId → { name, role, online }

    // Phase 4 callback hooks — set per page
    onTaskAssigned: null,
    onTaskUpdated: null,
    onTaskDeleted: null,
    onProgressUpdate: null,
    onStatusChange: null,
    onNewComment: null,
    onPresenceChange: null,
    onNotificationNew: null,
    onReconnect: null,
};

// ============================================================
//  Section 2: Socket.IO Connection
// ============================================================

TaskFlowApp.initSocket = function () {
    if (!this.currentUser) return;

    this.socket = io({
        auth: { token: this.jwtToken },
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000
    });

    this.socket.on('connect', () => {
        console.log('[TaskFlow] Connected to server');
        if (typeof this.onReconnect === 'function') {
            this.onReconnect();
        }
    });

    this.socket.on('disconnect', (reason) => {
        console.log('[TaskFlow] Disconnected:', reason);
    });

    this.socket.on('connect_error', (err) => {
        console.error('[TaskFlow] Connection error:', err.message);
    });

    this._registerEventListeners();
};

// ============================================================
//  Section 3: Event Listeners
// ============================================================

TaskFlowApp._registerEventListeners = function () {
    const socket = this.socket;

    socket.on('task:assigned', (data) => {
        // Server sends flat task object (not wrapped in {task: ...})
        this.showToast('New Task Assigned',
            `${data.creator_name || 'Manager'} assigned you: "${data.title || 'a task'}"`,
            'task_assigned');
        if (typeof this.onTaskAssigned === 'function') this.onTaskAssigned(data);
    });

    socket.on('task:updated', (data) => {
        if (typeof this.onTaskUpdated === 'function') this.onTaskUpdated(data);
    });

    socket.on('task:deleted', (data) => {
        this.showToast('Task Removed', `"${data.taskTitle}" has been deleted`, 'task_deleted');
        if (typeof this.onTaskDeleted === 'function') this.onTaskDeleted(data);
    });

    socket.on('progress:update', (data) => {
        this.showToast('Progress Update',
            `${data.employeeName} updated "${data.taskTitle}": ${data.oldProgress}% → ${data.newProgress}%`,
            'progress_update');
        if (typeof this.onProgressUpdate === 'function') this.onProgressUpdate(data);
    });

    socket.on('status:change', (data) => {
        this.showToast('Status Changed',
            `${data.changedBy} moved "${data.taskTitle}" to ${data.newStatus.replace(/_/g, ' ')}`,
            'status_change');
        if (typeof this.onStatusChange === 'function') this.onStatusChange(data);
    });

    socket.on('comment:new', (data) => {
        // Only show toast if comment is NOT from current user
        if (data.comment && data.comment.user_id !== this.currentUser.id) {
            this.showToast('New Comment',
                `${data.comment.author_name} commented on a task`,
                'comment');
        }
        if (typeof this.onNewComment === 'function') this.onNewComment(data);
    });

    // notification:new only updates the badge — specific events above handle toasts
    socket.on('notification:new', (data) => {
        this.unreadCount++;
        this._updateBadge();
        if (typeof this.onNotificationNew === 'function') this.onNotificationNew(data);
    });

    socket.on('user:online', (data) => {
        this.onlineUsers.clear();
        if (data.onlineUsers) {
            data.onlineUsers.forEach(u => this.onlineUsers.set(u.id, u));
        }
        if (typeof this.onPresenceChange === 'function') this.onPresenceChange(data);
    });
};

// ============================================================
//  Section 4: Toast Notification System
// ============================================================

TaskFlowApp.showToast = function (title, message, type) {
    type = type || 'info';

    // Create container on first use
    if (!this.toastContainer) {
        this.toastContainer = document.createElement('div');
        this.toastContainer.id = 'toast-container';
        this.toastContainer.style.cssText = 'position:fixed;top:20px;right:20px;z-index:10000;display:flex;flex-direction:column;gap:10px;max-width:380px;';
        document.body.appendChild(this.toastContainer);
    }

    // Color map per TRD design system
    const colors = {
        task_assigned: '#1B3A4B',
        progress_update: '#4A7C6F',
        status_change: '#E8913A',
        comment: '#1B3A4B',
        task_completed: '#4A7C6F',
        overdue_warning: '#C0392B',
        task_deleted: '#C0392B',
        info: '#1B3A4B'
    };

    const toast = document.createElement('div');
    toast.className = 'taskflow-toast';
    toast.style.cssText =
        'background:white;' +
        'border-left:4px solid ' + (colors[type] || colors.info) + ';' +
        'border-radius:8px;' +
        'padding:14px 18px;' +
        'box-shadow:0 8px 24px rgba(0,0,0,0.12);' +
        'cursor:pointer;' +
        'opacity:0;' +
        'transform:translateX(100%);' +
        'transition:all 0.3s ease;' +
        "font-family:'Plus Jakarta Sans',sans-serif;";

    toast.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:start;">' +
        '<div>' +
        '<div style="font-weight:600;font-size:13px;color:#1A1A2E;margin-bottom:4px;">' + this.escapeHtml(title) + '</div>' +
        '<div style="font-size:12px;color:#5E6C84;line-height:1.4;">' + this.escapeHtml(message) + '</div>' +
        '</div>' +
        '<button style="background:none;border:none;font-size:16px;color:#5E6C84;cursor:pointer;padding:0 0 0 10px;line-height:1;" onclick="this.closest(\'div\').parentElement.remove()">&times;</button>' +
        '</div>';

    this.toastContainer.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateX(0)';
    });

    // Play audio
    this.playAlert(type);

    // Auto-dismiss after 8 seconds per PRD
    const timeout = setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 8000);

    // Click to dismiss early
    toast.addEventListener('click', () => {
        clearTimeout(timeout);
        toast.remove();
    });
};

// ============================================================
//  Section 5: Audio Alert System
// ============================================================

TaskFlowApp.playAlert = function (type) {
    if (!this.soundEnabled) return;

    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioCtx.createOscillator();
        const gain = audioCtx.createGain();

        oscillator.connect(gain);
        gain.connect(audioCtx.destination);

        if (type === 'task_assigned') {
            // Two-note ascending chime (more attention-grabbing)
            oscillator.frequency.setValueAtTime(587, audioCtx.currentTime);       // D5
            oscillator.frequency.setValueAtTime(784, audioCtx.currentTime + 0.1); // G5
            gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
            oscillator.start(audioCtx.currentTime);
            oscillator.stop(audioCtx.currentTime + 0.4);
        } else {
            // Single soft chime for general notifications
            oscillator.frequency.setValueAtTime(659, audioCtx.currentTime); // E5
            gain.gain.setValueAtTime(0.05, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);
            oscillator.start(audioCtx.currentTime);
            oscillator.stop(audioCtx.currentTime + 0.25);
        }
    } catch (e) {
        // Web Audio API not available — silent fallback
        console.warn('[TaskFlow] Audio alert unavailable:', e.message);
    }
};

// ============================================================
//  Section 6: Notification Badge Manager
// ============================================================

TaskFlowApp._updateBadge = function () {
    const badge = document.getElementById('notification-badge');
    if (!badge) return; // Element doesn't exist yet (Phase 4 creates it)

    if (this.unreadCount > 0) {
        badge.textContent = this.unreadCount > 99 ? '99+' : this.unreadCount;
        badge.style.display = 'flex';
    } else {
        badge.style.display = 'none';
    }
};

TaskFlowApp.resetBadge = function () {
    this.unreadCount = 0;
    this._updateBadge();
};

// ============================================================
//  Section 7: Utility Functions
// ============================================================

// Initialize the full app (called after login)
TaskFlowApp.init = function (user, jwtToken) {
    this.currentUser = user;
    this.jwtToken = jwtToken;
    this.initSocket();
    this.loadUnreadCount();
};

// Fetch unread count on page load
TaskFlowApp.loadUnreadCount = function () {
    this.api('/api/notifications')
        .then(data => {
            this.unreadCount = data.unread_count || 0;
            this._updateBadge();
        })
        .catch(err => console.error('[TaskFlow] Failed to load notifications:', err));
};

// API helper with automatic JWT authentication
TaskFlowApp.api = function (url, options) {
    options = options || {};
    const headers = Object.assign({
        'Content-Type': 'application/json',
        'Authorization': this.jwtToken ? 'Bearer ' + this.jwtToken : ''
    }, options.headers || {});

    return fetch(url, Object.assign({}, options, { headers: headers }))
        .then(function (r) {
            if (r.status === 401) {
                sessionStorage.clear();
                window.location.href = '/login.html';
                return Promise.reject({ error: 'Session expired' });
            }
            if (!r.ok) return r.json().then(function (err) { return Promise.reject(err); });
            return r.json();
        });
};

// Format relative time (e.g., "2 minutes ago")
TaskFlowApp.timeAgo = function (dateString) {
    const seconds = Math.floor((Date.now() - new Date(dateString).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.floor(hours / 24);
    return days + 'd ago';
};

// Format date for display
TaskFlowApp.formatDate = function (dateString) {
    return new Date(dateString).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
    });
};

// Days remaining/overdue calculator
TaskFlowApp.daysUntil = function (dateString) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const due = new Date(dateString);
    due.setHours(0, 0, 0, 0);
    return Math.ceil((due - now) / (1000 * 60 * 60 * 24));
};

// Sound toggle
TaskFlowApp.toggleSound = function () {
    this.soundEnabled = !this.soundEnabled;
    return this.soundEnabled;
};

// HTML escape utility (prevents XSS in dynamic content)
TaskFlowApp.escapeHtml = function (str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};
