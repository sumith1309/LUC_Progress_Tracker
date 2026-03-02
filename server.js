// ============================================================
//  TaskFlow — Real-Time Task Management System
//  Main Entry Point (server.js)
//  Database: MongoDB (migrated from SQLite in Phase 6)
// ============================================================

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { MongoClient, GridFSBucket } = require('mongodb');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const UPLOAD_MAX_SIZE = parseInt(process.env.UPLOAD_MAX_SIZE) || 10 * 1024 * 1024;

if (!MONGODB_URI) {
    console.error('[FATAL] MONGODB_URI environment variable is not set');
    console.error('        Create a .env file with: MONGODB_URI=mongodb://localhost:27017/taskflow');
    process.exit(1);
}

if (!JWT_SECRET) {
    console.error('[FATAL] JWT_SECRET environment variable is not set');
    console.error('        Create a .env file with: JWT_SECRET=<your-secret-key>');
    process.exit(1);
}

const ALLOWED_MIMETYPES = [
    'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain', 'text/csv'
];

// ============================================================
//  Section A2: Multer Configuration (T2.6)
//  Memory storage — files go to req.file.buffer, then GridFS
// ============================================================

const fileFilter = (req, file, cb) => {
    if (ALLOWED_MIMETYPES.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('FILE_TYPE_NOT_ALLOWED'), false);
    }
};

const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter,
    limits: { fileSize: UPLOAD_MAX_SIZE }
});

// ============================================================
//  Section B: Environment Validation (T1.3)
// ============================================================

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
    console.log('[SETUP] Created public/uploads directory');
}

// ============================================================
//  Section C: Forward References & Database Variables
// ============================================================

let client;           // MongoClient instance (for shutdown)
let db;               // MongoDB database handle
let bucket;           // GridFSBucket for file storage
let usersCache = {};  // { 'uuid': userDoc } — 4 static users, loaded on startup
let io;               // Phase 3: Forward reference for Socket.IO

// In-memory online presence tracking
const onlineUsers = new Map();

// ============================================================
//  Section C2: Database Initialization
// ============================================================

async function initDatabase() {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    console.log('[DB] Connected to MongoDB');

    db = client.db(); // Uses database name from connection string
    bucket = new GridFSBucket(db, { bucketName: 'uploads' });

    // Create indexes (idempotent — safe to run every startup)
    await Promise.all([
        db.collection('tasks').createIndex({ assigned_to: 1 }),
        db.collection('tasks').createIndex({ created_by: 1 }),
        db.collection('tasks').createIndex({ status: 1 }),
        db.collection('tasks').createIndex({ due_date: 1 }),
        db.collection('comments').createIndex({ task_id: 1, created_at: 1 }),
        db.collection('attachments').createIndex({ task_id: 1 }),
        db.collection('notifications').createIndex({ user_id: 1, created_at: -1 }),
        db.collection('notifications').createIndex({ user_id: 1, is_read: 1 }),
    ]);
    console.log('[DB] Indexes created');

    // Seed users if empty
    const userCount = await db.collection('users').countDocuments();
    if (userCount === 0) {
        const now = new Date().toISOString();
        await db.collection('users').insertMany([
            { _id: uuidv4(), name: 'Mushtaq',  role: 'manager',  email: 'mushtaq@learnerseducation.com',  avatar_color: '#1B3A4B', password_hash: bcrypt.hashSync('Mushtaq@LUC2025',  10), created_at: now },
            { _id: uuidv4(), name: 'Sreejith', role: 'employee', email: 'Sreejith@learnerseducation.com', avatar_color: '#4A7C6F', password_hash: bcrypt.hashSync('Sreejith@LUC2025', 10), created_at: now },
            { _id: uuidv4(), name: 'Creative', role: 'employee', email: 'Creative@learnerseducation.com', avatar_color: '#E8913A', password_hash: bcrypt.hashSync('Creative@LUC2025', 10), created_at: now },
            { _id: uuidv4(), name: 'Indika',   role: 'employee', email: 'Indika@learnerseducation.com',   avatar_color: '#8E6BBF', password_hash: bcrypt.hashSync('Indika@LUC2025',   10), created_at: now },
        ]);
        console.log('[DB] 4 users seeded with LUC credentials');
    }

    await loadUsersCache();
}

async function loadUsersCache() {
    const users = await db.collection('users')
        .find({}, { projection: { password_hash: 0 } })
        .sort({ role: -1, created_at: 1 })
        .toArray();
    usersCache = {};
    users.forEach(u => { usersCache[u._id] = u; });
    console.log(`[DB] Users cache loaded: ${Object.keys(usersCache).length} users`);
}

// ============================================================
//  Section C3: Normalization & Enrichment Helpers
//  MongoDB stores _id, but API returns id. These helpers bridge that.
//  Enrichment replaces SQL JOINs by looking up user names from cache.
// ============================================================

function normalizeDoc(doc) {
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return { id: _id, ...rest };
}

function normalizeDocs(docs) {
    return docs.map(normalizeDoc);
}

function enrichTask(task) {
    if (!task) return null;
    const normalized = normalizeDoc(task);
    const assignee = usersCache[task.assigned_to];
    const creator = usersCache[task.created_by];
    if (assignee) {
        normalized.assignee_name = assignee.name;
        normalized.assignee_color = assignee.avatar_color;
    }
    if (creator) {
        normalized.creator_name = creator.name;
    }
    return normalized;
}

function enrichComment(comment) {
    const normalized = normalizeDoc(comment);
    const author = usersCache[comment.user_id];
    if (author) {
        normalized.author_name = author.name;
        normalized.author_color = author.avatar_color;
    }
    return normalized;
}

function enrichAttachment(attachment) {
    const normalized = normalizeDoc(attachment);
    const uploader = usersCache[attachment.uploaded_by];
    if (uploader) {
        normalized.uploader_name = uploader.name;
    }
    return normalized;
}

// ============================================================
//  Section E: Express App Setup (T1.5)
// ============================================================

const app = express();
const server = http.createServer(app);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS headers
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Redirect root to login page
app.get('/', (req, res) => res.redirect('/login.html'));

// ============================================================
//  Section E1: Health & GridFS Download Routes
//  Placed before user middleware — no auth needed
// ============================================================

// Health check for Render
app.get('/health', async (req, res) => {
    try {
        await db.command({ ping: 1 });
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    } catch (err) {
        res.status(503).json({ status: 'error', message: 'Database connection failed' });
    }
});

// GridFS file download — serves uploaded files from MongoDB instead of disk
app.get('/uploads/:filename', async (req, res) => {
    try {
        const att = await db.collection('attachments').findOne({
            filepath: `public/uploads/${req.params.filename}`
        });
        if (att) {
            res.set('Content-Type', att.mimetype);
            res.set('Content-Disposition', `inline; filename="${att.filename}"`);
        }
        const downloadStream = bucket.openDownloadStreamByName(req.params.filename);
        downloadStream.on('error', () => {
            if (!res.headersSent) res.status(404).json({ error: 'File not found' });
        });
        downloadStream.pipe(res);
    } catch (err) {
        if (!res.headersSent) res.status(404).json({ error: 'File not found' });
    }
});

// ============================================================
//  Section E2a: Authentication Endpoints (Phase 7)
//  Placed BEFORE JWT middleware — no token required
// ============================================================

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required.' });
        }

        const user = await db.collection('users').findOne({
            email: { $regex: new RegExp('^' + email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }
        });

        if (!user || !await bcrypt.compare(password, user.password_hash)) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const token = jwt.sign(
            { userId: user._id, role: user.role, name: user.name },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            token,
            user: {
                id: user._id,
                name: user.name,
                role: user.role,
                email: user.email,
                avatar_color: user.avatar_color
            }
        });
    } catch (err) {
        console.error('[AUTH] Login error:', err.message);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

app.get('/api/auth/me', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required.' });
    }

    try {
        const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
        const user = usersCache[decoded.userId];
        if (!user) {
            return res.status(401).json({ error: 'User not found.' });
        }
        res.json(normalizeDoc(user));
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token.' });
    }
});

// ============================================================
//  Section E2b: JWT Authentication Middleware (Phase 7)
//  Populates req.currentUser from Authorization Bearer token.
//  Never rejects — routes decide if auth is needed.
// ============================================================

app.use((req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
            const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
            if (decoded.userId && usersCache[decoded.userId]) {
                req.currentUser = normalizeDoc(usersCache[decoded.userId]);
            } else {
                req.currentUser = null;
            }
        } catch (err) {
            req.currentUser = null;
        }
    } else {
        req.currentUser = null;
    }
    next();
});

// Inline guard functions — called at top of route handlers, not middleware
function requireUser(req, res) {
    if (!req.currentUser) {
        res.status(401).json({ error: 'Authentication required. Provide a valid Bearer token.' });
        return false;
    }
    return true;
}

function requireManager(req, res) {
    if (!requireUser(req, res)) return false;
    if (req.currentUser.role !== 'manager') {
        res.status(403).json({ error: 'Only the Manager can perform this action.' });
        return false;
    }
    return true;
}

// ============================================================
//  Section E3: Helpers (T2.7)
// ============================================================

async function createNotification({ userId, taskId, type, title, message }) {
    const id = uuidv4();
    const now = new Date().toISOString();
    const doc = {
        _id: id,
        user_id: userId,
        task_id: taskId || null,
        type,
        title,
        message,
        is_read: false,
        created_at: now
    };
    await db.collection('notifications').insertOne(doc);
    return { id, user_id: userId, task_id: taskId || null, type, title, message, is_read: false, created_at: now };
}

// Phase 3: Real-time emission helpers
function emitToUser(userId, event, data) {
    if (io) io.to(`user:${userId}`).emit(event, data);
}

function emitToAll(event, data) {
    if (io) io.emit(event, data);
}

function getManagerId() {
    const mgr = Object.values(usersCache).find(u => u.role === 'manager');
    return mgr ? mgr._id : null;
}

function emitToManager(event, data) {
    const mid = getManagerId();
    if (mid) emitToUser(mid, event, data);
}

function isValidStatusTransition(oldStatus, newStatus, role) {
    if (role === 'manager') {
        if (newStatus === 'todo') return true;
        if (oldStatus === 'review' && newStatus === 'completed') return true;
        if (oldStatus === 'review' && newStatus === 'in_progress') return true;
        return false;
    }
    // Employee
    if (oldStatus === 'todo' && newStatus === 'in_progress') return true;
    if (oldStatus === 'in_progress' && newStatus === 'review') return true;
    return false;
}

// ============================================================
//  Section F: User Endpoints (T1.6, T2.1)
// ============================================================

// GET /api/users — List all users (Manager first, then employees in insertion order)
app.get('/api/users', async (req, res) => {
    try {
        const users = await db.collection('users')
            .find({}, { projection: { password_hash: 0 } })
            .sort({ role: -1, created_at: 1 })
            .toArray();
        res.json(normalizeDocs(users));
    } catch (err) {
        console.error('[API] Error fetching users:', err.message);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// GET /api/users/online — List currently online users (Phase 3)
app.get('/api/users/online', (req, res) => {
    const online = Array.from(onlineUsers.entries()).map(([id, data]) => ({
        id,
        name: data.name,
        role: data.role,
        online: true
    }));
    res.json({ online });
});

// GET /api/users/:id — Single user detail
app.get('/api/users/:id', async (req, res) => {
    try {
        const user = await db.collection('users').findOne(
            { _id: req.params.id },
            { projection: { password_hash: 0 } }
        );
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json(normalizeDoc(user));
    } catch (err) {
        console.error('[API] Error fetching user:', err.message);
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

// ============================================================
//  Section G2: Task Endpoints (T2.2, T2.3, T2.4)
// ============================================================

// POST /api/tasks — Create task (Manager only)
app.post('/api/tasks', async (req, res) => {
    if (!requireManager(req, res)) return;

    try {
        const { title, description, assigned_to, priority, due_date, estimated_hours } = req.body;

        // Validate title
        if (!title || typeof title !== 'string' || title.trim().length === 0 || title.trim().length > 200) {
            return res.status(400).json({ error: 'Title is required and must be 1-200 characters.' });
        }

        // Validate assigned_to — must exist and be an employee
        if (!assigned_to) return res.status(400).json({ error: 'assigned_to is required.' });
        const assignee = usersCache[assigned_to];
        if (!assignee) return res.status(404).json({ error: 'Assigned user not found.' });
        if (assignee.role !== 'employee') return res.status(400).json({ error: 'Tasks can only be assigned to employees.' });

        // Validate priority
        const validPriorities = ['low', 'medium', 'high', 'critical'];
        if (!priority || !validPriorities.includes(priority)) {
            return res.status(400).json({ error: 'Priority is required and must be one of: low, medium, high, critical.' });
        }

        // Validate due_date — required, valid date, not in the past (BR-05)
        if (!due_date) return res.status(400).json({ error: 'Due date is required.' });
        const parsedDue = new Date(due_date);
        if (isNaN(parsedDue.getTime())) return res.status(400).json({ error: 'Invalid due date format.' });
        const today = new Date().toISOString().split('T')[0];
        if (parsedDue.toISOString().split('T')[0] < today) {
            return res.status(400).json({ error: 'Due date cannot be in the past.' });
        }

        // Validate estimated_hours (optional)
        if (estimated_hours !== undefined && estimated_hours !== null) {
            if (typeof estimated_hours !== 'number' || estimated_hours <= 0) {
                return res.status(400).json({ error: 'Estimated hours must be a positive number.' });
            }
        }

        const id = uuidv4();
        const now = new Date().toISOString();

        await db.collection('tasks').insertOne({
            _id: id, title: title.trim(), description: description || null,
            assigned_to, created_by: req.currentUser.id, priority,
            status: 'todo', progress: 0,
            due_date: parsedDue.toISOString(),
            estimated_hours: estimated_hours || null,
            created_at: now, updated_at: now, completed_at: null
        });

        const notif = await createNotification({
            userId: assigned_to, taskId: id, type: 'task_assigned',
            title: 'New task assigned',
            message: `${req.currentUser.name} assigned you: ${title.trim()}`
        });

        // Fetch and enrich (replaces SQL JOIN)
        const taskDoc = await db.collection('tasks').findOne({ _id: id });
        const task = enrichTask(taskDoc);

        // Phase 3: Real-time emissions
        emitToUser(assigned_to, 'task:assigned', task);
        emitToUser(assigned_to, 'notification:new', notif);
        emitToManager('task:updated', { task });

        res.status(201).json(task);
    } catch (err) {
        console.error('[API] Error creating task:', err.message);
        res.status(500).json({ error: 'Failed to create task' });
    }
});

// GET /api/tasks/stats — Task statistics (Manager only) — MUST be before :id route
app.get('/api/tasks/stats', async (req, res) => {
    if (!requireManager(req, res)) return;

    try {
        const total = await db.collection('tasks').countDocuments();

        const statusAgg = await db.collection('tasks').aggregate([
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ]).toArray();
        const byStatus = {};
        statusAgg.forEach(r => { byStatus[r._id] = r.count; });

        const priorityAgg = await db.collection('tasks').aggregate([
            { $group: { _id: '$priority', count: { $sum: 1 } } }
        ]).toArray();
        const byPriority = {};
        priorityAgg.forEach(r => { byPriority[r._id] = r.count; });

        const overdue = await db.collection('tasks').countDocuments({
            due_date: { $lt: new Date().toISOString() },
            status: { $ne: 'completed' }
        });

        const employees = Object.values(usersCache).filter(u => u.role === 'employee');
        const byEmployee = await Promise.all(employees.map(async (emp) => {
            const empTotal = await db.collection('tasks').countDocuments({ assigned_to: emp._id });
            const completed = await db.collection('tasks').countDocuments({ assigned_to: emp._id, status: 'completed' });
            return { id: emp._id, name: emp.name, total: empTotal, completed };
        }));

        res.json({ total, by_status: byStatus, by_priority: byPriority, overdue, by_employee: byEmployee });
    } catch (err) {
        console.error('[API] Error fetching task stats:', err.message);
        res.status(500).json({ error: 'Failed to fetch task stats' });
    }
});

// GET /api/tasks — List tasks (role-filtered)
app.get('/api/tasks', async (req, res) => {
    if (!requireUser(req, res)) return;

    try {
        const filter = {};

        // BR-12: employees only see own tasks
        if (req.currentUser.role === 'employee') {
            filter.assigned_to = req.currentUser.id;
        }

        // Optional filters
        if (req.query.status) filter.status = req.query.status;
        if (req.query.priority) filter.priority = req.query.priority;
        if (req.query.assigned_to) filter.assigned_to = req.query.assigned_to;

        const tasks = await db.collection('tasks').find(filter).toArray();

        // Sort by priority (critical=1, high=2, medium=3, low=4), then due_date
        const priorityOrder = { critical: 1, high: 2, medium: 3, low: 4 };
        tasks.sort((a, b) => {
            const pa = priorityOrder[a.priority] || 5;
            const pb = priorityOrder[b.priority] || 5;
            if (pa !== pb) return pa - pb;
            return (a.due_date || '').localeCompare(b.due_date || '');
        });

        res.json(tasks.map(enrichTask));
    } catch (err) {
        console.error('[API] Error fetching tasks:', err.message);
        res.status(500).json({ error: 'Failed to fetch tasks' });
    }
});

// GET /api/tasks/:id — Task detail with nested comments and attachments
app.get('/api/tasks/:id', async (req, res) => {
    if (!requireUser(req, res)) return;

    try {
        const taskDoc = await db.collection('tasks').findOne({ _id: req.params.id });
        if (!taskDoc) return res.status(404).json({ error: 'Task not found' });
        if (req.currentUser.role === 'employee' && taskDoc.assigned_to !== req.currentUser.id) {
            return res.status(403).json({ error: 'You can only view your own tasks.' });
        }

        const task = enrichTask(taskDoc);

        const comments = await db.collection('comments')
            .find({ task_id: req.params.id })
            .sort({ created_at: 1 })
            .toArray();
        task.comments = comments.map(enrichComment);

        const attachments = await db.collection('attachments')
            .find({ task_id: req.params.id })
            .sort({ created_at: -1 })
            .toArray();
        task.attachments = attachments.map(enrichAttachment);

        res.json(task);
    } catch (err) {
        console.error('[API] Error fetching task:', err.message);
        res.status(500).json({ error: 'Failed to fetch task' });
    }
});

// PATCH /api/tasks/:id — Update task (role-aware)
app.patch('/api/tasks/:id', async (req, res) => {
    if (!requireUser(req, res)) return;

    try {
        const task = await db.collection('tasks').findOne({ _id: req.params.id });
        if (!task) return res.status(404).json({ error: 'Task not found' });
        if (req.currentUser.role === 'employee' && task.assigned_to !== req.currentUser.id) {
            return res.status(403).json({ error: 'You can only update your own tasks.' });
        }

        const updateFields = {};
        const role = req.currentUser.role;
        const body = req.body;

        // Track changes for notifications
        let progressChanged = false, oldProgress = task.progress;
        let statusChanged = false, oldStatus = task.status;
        let assigneeChanged = false, oldAssignee = task.assigned_to;

        // --- Status transition ---
        if (body.status !== undefined) {
            const validStatuses = ['todo', 'in_progress', 'review', 'completed'];
            if (!validStatuses.includes(body.status)) {
                return res.status(400).json({ error: 'Invalid status. Must be: todo, in_progress, review, completed.' });
            }
            if (!isValidStatusTransition(task.status, body.status, role)) {
                return res.status(400).json({ error: `Invalid status transition: ${task.status} → ${body.status} for ${role}.` });
            }
            updateFields.status = body.status;
            statusChanged = true;

            if (body.status === 'completed') {
                updateFields.completed_at = new Date().toISOString();
            }
            if (body.status === 'todo' && task.status !== 'todo') {
                updateFields.completed_at = null;
                updateFields.progress = 0;
            }
        }

        // --- Progress (employees only) ---
        if (body.progress !== undefined && role === 'employee') {
            const p = body.progress;
            if (!Number.isInteger(p) || p < 0 || p > 100) {
                return res.status(400).json({ error: 'Progress must be an integer between 0 and 100.' });
            }
            updateFields.progress = p;
            progressChanged = true;
        }

        // --- Manager-only fields ---
        if (role === 'manager') {
            if (body.title !== undefined) {
                if (typeof body.title !== 'string' || body.title.trim().length === 0 || body.title.trim().length > 200) {
                    return res.status(400).json({ error: 'Title must be 1-200 characters.' });
                }
                updateFields.title = body.title.trim();
            }
            if (body.description !== undefined) {
                updateFields.description = body.description;
            }
            if (body.assigned_to !== undefined) {
                const newAssignee = usersCache[body.assigned_to];
                if (!newAssignee) return res.status(404).json({ error: 'Assigned user not found.' });
                if (newAssignee.role !== 'employee') return res.status(400).json({ error: 'Tasks can only be assigned to employees.' });
                updateFields.assigned_to = body.assigned_to;
                assigneeChanged = true;
            }
            if (body.priority !== undefined) {
                const validPriorities = ['low', 'medium', 'high', 'critical'];
                if (!validPriorities.includes(body.priority)) {
                    return res.status(400).json({ error: 'Priority must be: low, medium, high, critical.' });
                }
                updateFields.priority = body.priority;
            }
            if (body.due_date !== undefined) {
                const parsedDue = new Date(body.due_date);
                if (isNaN(parsedDue.getTime())) return res.status(400).json({ error: 'Invalid due date format.' });
                updateFields.due_date = parsedDue.toISOString();
            }
            if (body.estimated_hours !== undefined) {
                if (body.estimated_hours !== null && (typeof body.estimated_hours !== 'number' || body.estimated_hours <= 0)) {
                    return res.status(400).json({ error: 'Estimated hours must be a positive number.' });
                }
                updateFields.estimated_hours = body.estimated_hours;
            }
        }

        if (Object.keys(updateFields).length === 0) {
            return res.status(400).json({ error: 'No valid fields to update.' });
        }

        updateFields.updated_at = new Date().toISOString();

        await db.collection('tasks').updateOne(
            { _id: req.params.id },
            { $set: updateFields }
        );

        // Fetch updated task
        const updatedDoc = await db.collection('tasks').findOne({ _id: req.params.id });
        const updated = enrichTask(updatedDoc);

        // --- Notifications + Phase 3 real-time emissions ---
        const managerId = getManagerId();

        if (progressChanged) {
            const notif = await createNotification({
                userId: managerId, taskId: task._id, type: 'progress_update',
                title: 'Progress updated',
                message: `${req.currentUser.name} updated progress on "${task.title}": ${oldProgress}% → ${body.progress}%`
            });
            emitToUser(managerId, 'progress:update', {
                taskId: task._id, taskTitle: task.title,
                employeeId: req.currentUser.id, employeeName: req.currentUser.name,
                oldProgress, newProgress: body.progress
            });
            emitToUser(managerId, 'notification:new', notif);
        }
        if (statusChanged) {
            const otherParty = role === 'manager' ? task.assigned_to : managerId;
            const notif = await createNotification({
                userId: otherParty, taskId: task._id, type: 'status_change',
                title: 'Status changed',
                message: `${req.currentUser.name} moved "${task.title}" to ${body.status}`
            });
            emitToUser(otherParty, 'status:change', {
                taskId: task._id, taskTitle: task.title,
                oldStatus, newStatus: body.status,
                changedBy: req.currentUser.name
            });
            emitToUser(otherParty, 'notification:new', notif);

            if (body.status === 'completed') {
                const completedNotif = await createNotification({
                    userId: task.assigned_to, taskId: task._id, type: 'task_completed',
                    title: 'Task completed',
                    message: `"${task.title}" has been marked completed`
                });
                emitToUser(task.assigned_to, 'notification:new', completedNotif);
            }
        }
        if (assigneeChanged) {
            const newNotif = await createNotification({
                userId: body.assigned_to, taskId: task._id, type: 'task_assigned',
                title: 'New task assigned',
                message: `${req.currentUser.name} assigned you: ${task.title}`
            });
            emitToUser(body.assigned_to, 'task:assigned', updated);
            emitToUser(body.assigned_to, 'notification:new', newNotif);

            // Notify old assignee (task_deleted repurposed as "unassigned" — v1.0 shortcut)
            const oldNotif = await createNotification({
                userId: oldAssignee, taskId: task._id, type: 'task_deleted',
                title: 'Task unassigned',
                message: `You have been unassigned from "${task.title}"`
            });
            emitToUser(oldAssignee, 'notification:new', oldNotif);
        }

        // Broadcast task:updated for board/list refresh in any open view
        emitToAll('task:updated', { task: updated });

        res.json(updated);
    } catch (err) {
        console.error('[API] Error updating task:', err.message);
        res.status(500).json({ error: 'Failed to update task' });
    }
});

// DELETE /api/tasks/:id — Delete with cascade (Manager only)
app.delete('/api/tasks/:id', async (req, res) => {
    if (!requireManager(req, res)) return;

    try {
        const task = await db.collection('tasks').findOne({ _id: req.params.id });
        if (!task) return res.status(404).json({ error: 'Task not found' });

        // Fetch attachment filepaths before deleting
        const attachments = await db.collection('attachments')
            .find({ task_id: req.params.id })
            .project({ filepath: 1 })
            .toArray();

        // Cascade delete — children first, then task last (sequential, not Promise.all)
        await db.collection('comments').deleteMany({ task_id: req.params.id });
        await db.collection('attachments').deleteMany({ task_id: req.params.id });
        await db.collection('notifications').deleteMany({ task_id: req.params.id });
        await db.collection('tasks').deleteOne({ _id: req.params.id });

        // Clean up GridFS files
        for (const att of attachments) {
            const gridFilename = att.filepath.replace('public/uploads/', '');
            const gridFile = await db.collection('uploads.files').findOne({ filename: gridFilename });
            if (gridFile) try { await bucket.delete(gridFile._id); } catch (_) {}
        }

        // Notify assigned employee (task_id = null since task is gone)
        const notif = await createNotification({
            userId: task.assigned_to, taskId: null, type: 'task_deleted',
            title: 'Task deleted',
            message: `"${task.title}" has been deleted by ${req.currentUser.name}`
        });

        // Phase 3: Real-time emissions
        emitToUser(task.assigned_to, 'task:deleted', { taskId: req.params.id, taskTitle: task.title });
        emitToUser(task.assigned_to, 'notification:new', notif);
        emitToManager('task:updated', { deleted: true, taskId: req.params.id });

        res.json({ message: 'Task deleted successfully', id: req.params.id });
    } catch (err) {
        console.error('[API] Error deleting task:', err.message);
        res.status(500).json({ error: 'Failed to delete task' });
    }
});

// ============================================================
//  Section G3: Comment Endpoints (T2.5)
// ============================================================

// GET /api/tasks/:id/comments
app.get('/api/tasks/:id/comments', async (req, res) => {
    if (!requireUser(req, res)) return;

    try {
        const task = await db.collection('tasks').findOne({ _id: req.params.id });
        if (!task) return res.status(404).json({ error: 'Task not found' });
        if (req.currentUser.role === 'employee' && task.assigned_to !== req.currentUser.id) {
            return res.status(403).json({ error: 'You can only view comments on your own tasks.' });
        }

        const comments = await db.collection('comments')
            .find({ task_id: req.params.id })
            .sort({ created_at: 1 })
            .toArray();

        res.json(comments.map(enrichComment));
    } catch (err) {
        console.error('[API] Error fetching comments:', err.message);
        res.status(500).json({ error: 'Failed to fetch comments' });
    }
});

// POST /api/tasks/:id/comments
app.post('/api/tasks/:id/comments', async (req, res) => {
    if (!requireUser(req, res)) return;

    try {
        const task = await db.collection('tasks').findOne({ _id: req.params.id });
        if (!task) return res.status(404).json({ error: 'Task not found' });
        if (req.currentUser.role === 'employee' && task.assigned_to !== req.currentUser.id) {
            return res.status(403).json({ error: 'You can only comment on your own tasks.' });
        }

        const { content } = req.body;
        if (!content || typeof content !== 'string' || content.trim().length === 0) {
            return res.status(400).json({ error: 'Comment content is required.' });
        }

        const id = uuidv4();
        const now = new Date().toISOString();
        await db.collection('comments').insertOne({
            _id: id, task_id: req.params.id, user_id: req.currentUser.id,
            content: content.trim(), created_at: now
        });

        // Notify other party
        const managerId = getManagerId();
        const recipient = req.currentUser.role === 'manager' ? task.assigned_to : managerId;
        const notif = await createNotification({
            userId: recipient, taskId: task._id, type: 'comment',
            title: 'New comment',
            message: `${req.currentUser.name} commented on "${task.title}"`
        });

        const comment = {
            id, task_id: req.params.id, user_id: req.currentUser.id,
            content: content.trim(), created_at: now,
            author_name: req.currentUser.name, author_color: req.currentUser.avatar_color
        };

        // Phase 3: Real-time emissions — targeted to manager + assigned employee only (BR-12)
        emitToUser(task.assigned_to, 'comment:new', { taskId: task._id, comment });
        emitToManager('comment:new', { taskId: task._id, comment });
        emitToUser(recipient, 'notification:new', notif);

        res.status(201).json(comment);
    } catch (err) {
        console.error('[API] Error creating comment:', err.message);
        res.status(500).json({ error: 'Failed to create comment' });
    }
});

// ============================================================
//  Section G4: Attachment Endpoints (T2.6)
//  Files stored in GridFS, not on disk
// ============================================================

// GET /api/tasks/:id/attachments
app.get('/api/tasks/:id/attachments', async (req, res) => {
    if (!requireUser(req, res)) return;

    try {
        const task = await db.collection('tasks').findOne({ _id: req.params.id });
        if (!task) return res.status(404).json({ error: 'Task not found' });
        if (req.currentUser.role === 'employee' && task.assigned_to !== req.currentUser.id) {
            return res.status(403).json({ error: 'You can only view attachments on your own tasks.' });
        }

        const attachments = await db.collection('attachments')
            .find({ task_id: req.params.id })
            .sort({ created_at: -1 })
            .toArray();

        res.json(attachments.map(enrichAttachment));
    } catch (err) {
        console.error('[API] Error fetching attachments:', err.message);
        res.status(500).json({ error: 'Failed to fetch attachments' });
    }
});

// POST /api/tasks/:id/attachments — File upload via Multer + GridFS
app.post('/api/tasks/:id/attachments', async (req, res) => {
    if (!requireUser(req, res)) return;

    try {
        const task = await db.collection('tasks').findOne({ _id: req.params.id });
        if (!task) return res.status(404).json({ error: 'Task not found' });
        if (req.currentUser.role === 'employee' && task.assigned_to !== req.currentUser.id) {
            return res.status(403).json({ error: 'You can only upload to your own tasks.' });
        }

        upload.single('file')(req, res, async (multerErr) => {
            if (multerErr) {
                if (multerErr.code === 'LIMIT_FILE_SIZE') {
                    return res.status(413).json({ error: 'File too large. Maximum size is 10MB.' });
                }
                if (multerErr.message === 'FILE_TYPE_NOT_ALLOWED') {
                    return res.status(400).json({ error: 'File type not allowed. Accepted: images, PDF, documents, text files.' });
                }
                return res.status(500).json({ error: 'File upload failed.' });
            }

            if (!req.file) return res.status(400).json({ error: 'No file provided.' });

            try {
                const gridFilename = `${uuidv4()}-${req.file.originalname}`;

                // Upload to GridFS
                const uploadStream = bucket.openUploadStream(gridFilename, {
                    contentType: req.file.mimetype
                });
                uploadStream.end(req.file.buffer);
                await new Promise((resolve, reject) => {
                    uploadStream.on('finish', resolve);
                    uploadStream.on('error', reject);
                });

                const id = uuidv4();
                const filepath = path.join('public', 'uploads', gridFilename);
                const now = new Date().toISOString();

                await db.collection('attachments').insertOne({
                    _id: id, task_id: req.params.id, uploaded_by: req.currentUser.id,
                    filename: req.file.originalname, filepath, mimetype: req.file.mimetype,
                    size: req.file.size, created_at: now
                });

                res.status(201).json({
                    id, task_id: req.params.id, uploaded_by: req.currentUser.id,
                    filename: req.file.originalname, filepath, mimetype: req.file.mimetype,
                    size: req.file.size, created_at: now, uploader_name: req.currentUser.name
                });
            } catch (err) {
                console.error('[API] Attachment insert error:', err.message);
                res.status(500).json({ error: 'Failed to save attachment.' });
            }
        });
    } catch (err) {
        console.error('[API] Error uploading attachment:', err.message);
        res.status(500).json({ error: 'Failed to upload attachment' });
    }
});

// DELETE /api/attachments/:id — Delete attachment (uploader or Manager)
app.delete('/api/attachments/:id', async (req, res) => {
    if (!requireUser(req, res)) return;

    try {
        const attachment = await db.collection('attachments').findOne({ _id: req.params.id });
        if (!attachment) return res.status(404).json({ error: 'Attachment not found' });

        if (req.currentUser.role !== 'manager' && attachment.uploaded_by !== req.currentUser.id) {
            return res.status(403).json({ error: 'You can only delete your own attachments.' });
        }

        await db.collection('attachments').deleteOne({ _id: req.params.id });

        // Clean up GridFS file
        const gridFilename = attachment.filepath.replace('public/uploads/', '');
        const gridFile = await db.collection('uploads.files').findOne({ filename: gridFilename });
        if (gridFile) try { await bucket.delete(gridFile._id); } catch (_) {}

        res.json({ message: 'Attachment deleted', id: req.params.id });
    } catch (err) {
        console.error('[API] Error deleting attachment:', err.message);
        res.status(500).json({ error: 'Failed to delete attachment' });
    }
});

// ============================================================
//  Section G5: Notification Endpoints (T2.7)
//  IMPORTANT: /read-all MUST be registered BEFORE /:id/read
// ============================================================

// GET /api/notifications — Last 20 for user + unread count
app.get('/api/notifications', async (req, res) => {
    if (!requireUser(req, res)) return;

    try {
        const userId = req.query.userId || req.currentUser.id;
        if (req.currentUser.role === 'employee' && userId !== req.currentUser.id) {
            return res.status(403).json({ error: 'You can only view your own notifications.' });
        }

        const notifications = await db.collection('notifications')
            .find({ user_id: userId })
            .sort({ created_at: -1 })
            .limit(20)
            .toArray();

        const unread_count = await db.collection('notifications')
            .countDocuments({ user_id: userId, is_read: false });

        res.json({ notifications: normalizeDocs(notifications), unread_count });
    } catch (err) {
        console.error('[API] Error fetching notifications:', err.message);
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

// PATCH /api/notifications/read-all — Mark all as read (BEFORE /:id/read!)
app.patch('/api/notifications/read-all', async (req, res) => {
    if (!requireUser(req, res)) return;

    try {
        const result = await db.collection('notifications')
            .updateMany(
                { user_id: req.currentUser.id, is_read: false },
                { $set: { is_read: true } }
            );

        res.json({ message: 'All notifications marked as read', updated: result.modifiedCount });
    } catch (err) {
        console.error('[API] Error marking notifications read:', err.message);
        res.status(500).json({ error: 'Failed to mark notifications as read' });
    }
});

// PATCH /api/notifications/:id/read — Mark single as read
app.patch('/api/notifications/:id/read', async (req, res) => {
    if (!requireUser(req, res)) return;

    try {
        const notification = await db.collection('notifications').findOne({ _id: req.params.id });
        if (!notification) return res.status(404).json({ error: 'Notification not found' });
        if (notification.user_id !== req.currentUser.id) {
            return res.status(403).json({ error: 'You can only mark your own notifications as read.' });
        }

        await db.collection('notifications').updateOne({ _id: req.params.id }, { $set: { is_read: true } });
        res.json({ ...normalizeDoc(notification), is_read: true });
    } catch (err) {
        console.error('[API] Error marking notification read:', err.message);
        res.status(500).json({ error: 'Failed to mark notification as read' });
    }
});

// ============================================================
//  Section G6: Analytics Endpoints (T2.8)
//  SQLite date functions replaced with JS computation
// ============================================================

// GET /api/analytics/overview — Dashboard KPIs (Manager only)
app.get('/api/analytics/overview', async (req, res) => {
    if (!requireManager(req, res)) return;

    try {
        const total = await db.collection('tasks').countDocuments();
        const completed = await db.collection('tasks').countDocuments({ status: 'completed' });
        const in_progress = await db.collection('tasks').countDocuments({ status: 'in_progress' });
        const overdue = await db.collection('tasks').countDocuments({
            due_date: { $lt: new Date().toISOString() },
            status: { $ne: 'completed' }
        });

        // Average completion time (replaces julianday arithmetic)
        const completedTasks = await db.collection('tasks')
            .find({ completed_at: { $ne: null } })
            .project({ completed_at: 1, created_at: 1 })
            .toArray();

        let avgHours = 0;
        if (completedTasks.length > 0) {
            const totalHours = completedTasks.reduce((sum, t) => {
                const start = new Date(t.created_at).getTime();
                const end = new Date(t.completed_at).getTime();
                return sum + (end - start) / (1000 * 60 * 60);
            }, 0);
            avgHours = Math.round((totalHours / completedTasks.length) * 10) / 10;
        }

        // Completed today
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const completedToday = await db.collection('tasks').countDocuments({
            completed_at: { $gte: todayStart.toISOString() }
        });

        // Completed this week
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const completedThisWeek = await db.collection('tasks').countDocuments({
            completed_at: { $gte: sevenDaysAgo }
        });

        res.json({
            total_tasks: total,
            completed_tasks: completed,
            completion_rate: total > 0 ? Math.round((completed / total) * 1000) / 10 : 0,
            in_progress_tasks: in_progress,
            overdue_tasks: overdue,
            average_completion_time_hours: avgHours,
            tasks_completed_today: completedToday,
            tasks_completed_this_week: completedThisWeek
        });
    } catch (err) {
        console.error('[API] Error fetching analytics overview:', err.message);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

// GET /api/analytics/team — Per-employee metrics (Manager only)
app.get('/api/analytics/team', async (req, res) => {
    if (!requireManager(req, res)) return;

    try {
        const employees = Object.values(usersCache).filter(u => u.role === 'employee');
        const now = new Date().toISOString();

        const employeeMetrics = await Promise.all(employees.map(async (emp) => {
            const tasks = await db.collection('tasks').find({ assigned_to: emp._id }).toArray();
            const total_tasks = tasks.length;
            const completedTasks = tasks.filter(t => t.status === 'completed');

            // Avg completion time
            let avg_completion_time_hours = 0;
            if (completedTasks.length > 0) {
                const totalHours = completedTasks.reduce((sum, t) => {
                    return sum + (new Date(t.completed_at).getTime() - new Date(t.created_at).getTime()) / (1000 * 60 * 60);
                }, 0);
                avg_completion_time_hours = Math.round((totalHours / completedTasks.length) * 10) / 10;
            }

            // On-time rate
            const onTime = completedTasks.filter(t => t.completed_at <= t.due_date).length;
            const on_time_rate = completedTasks.length > 0 ? Math.round((onTime / completedTasks.length) * 1000) / 10 : 0;
            const completion_rate = total_tasks > 0 ? Math.round((completedTasks.length / total_tasks) * 1000) / 10 : 0;

            return {
                id: emp._id, name: emp.name, avatar_color: emp.avatar_color,
                total_tasks,
                completed: completedTasks.length,
                in_progress: tasks.filter(t => t.status === 'in_progress').length,
                review: tasks.filter(t => t.status === 'review').length,
                todo: tasks.filter(t => t.status === 'todo').length,
                overdue: tasks.filter(t => t.due_date < now && t.status !== 'completed').length,
                avg_completion_time_hours, on_time_rate, completion_rate
            };
        }));

        // Status distribution
        const statusAgg = await db.collection('tasks').aggregate([
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ]).toArray();
        const statusDist = {};
        statusAgg.forEach(r => { statusDist[r._id] = r.count; });

        // Completion trend (last 30 days)
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const completedRecent = await db.collection('tasks')
            .find({ completed_at: { $gte: thirtyDaysAgo } })
            .project({ completed_at: 1 })
            .toArray();

        const trendMap = {};
        completedRecent.forEach(t => {
            const date = t.completed_at.split('T')[0];
            trendMap[date] = (trendMap[date] || 0) + 1;
        });
        const completionTrend = Object.entries(trendMap)
            .map(([date, count]) => ({ date, count }))
            .sort((a, b) => a.date.localeCompare(b.date));

        res.json({ employees: employeeMetrics, status_distribution: statusDist, completion_trend: completionTrend });
    } catch (err) {
        console.error('[API] Error fetching team analytics:', err.message);
        res.status(500).json({ error: 'Failed to fetch team analytics' });
    }
});

// GET /api/analytics/employee/:id — Individual employee metrics (Manager only)
app.get('/api/analytics/employee/:id', async (req, res) => {
    if (!requireManager(req, res)) return;

    try {
        const employee = usersCache[req.params.id];
        if (!employee || employee.role !== 'employee') {
            return res.status(404).json({ error: 'Employee not found' });
        }

        const tasks = await db.collection('tasks').find({ assigned_to: req.params.id }).toArray();
        const now = new Date().toISOString();
        const completedTasks = tasks.filter(t => t.status === 'completed');

        const stats = {
            total_assigned: tasks.length,
            completed: completedTasks.length,
            in_progress: tasks.filter(t => t.status === 'in_progress').length,
            in_review: tasks.filter(t => t.status === 'review').length,
            todo: tasks.filter(t => t.status === 'todo').length,
            overdue: tasks.filter(t => t.due_date < now && t.status !== 'completed').length,
            current_active_tasks: tasks.filter(t => ['in_progress', 'review'].includes(t.status)).length,
        };

        // Avg completion time
        if (completedTasks.length > 0) {
            const totalHours = completedTasks.reduce((sum, t) => {
                return sum + (new Date(t.completed_at).getTime() - new Date(t.created_at).getTime()) / (1000 * 60 * 60);
            }, 0);
            stats.avg_completion_time_hours = Math.round((totalHours / completedTasks.length) * 10) / 10;
        } else {
            stats.avg_completion_time_hours = 0;
        }

        // On-time rate
        const onTime = completedTasks.filter(t => t.completed_at <= t.due_date).length;
        stats.completion_rate = stats.total_assigned > 0 ? Math.round((stats.completed / stats.total_assigned) * 1000) / 10 : 0;
        stats.on_time_delivery_rate = completedTasks.length > 0 ? Math.round((onTime / completedTasks.length) * 1000) / 10 : 0;

        const recent_tasks = await db.collection('tasks')
            .find({ assigned_to: req.params.id })
            .sort({ updated_at: -1 })
            .limit(10)
            .toArray();

        res.json({
            employee: { id: employee._id, name: employee.name, avatar_color: employee.avatar_color },
            metrics: stats,
            recent_tasks: normalizeDocs(recent_tasks).map(t => ({
                id: t.id, title: t.title, status: t.status,
                priority: t.priority, due_date: t.due_date, completed_at: t.completed_at
            }))
        });
    } catch (err) {
        console.error('[API] Error fetching employee analytics:', err.message);
        res.status(500).json({ error: 'Failed to fetch employee analytics' });
    }
});

// ============================================================
//  Section G: Error Handling (T1.5)
// ============================================================

// 404 handler for unknown API routes
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
});

// Global error handler (4-param signature required by Express)
app.use((err, req, res, next) => {
    console.error('[ERROR]', err.stack);
    res.status(err.status || 500).json({
        error: err.message || 'Internal server error'
    });
});

// ============================================================
//  Section H: Socket.IO Setup (Phase 3: T3.1, T3.2, T3.4)
// ============================================================

io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

io.on('connection', (socket) => {
    // Authenticate via JWT token
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) {
        console.log(`[WS] Rejected connection (no token): ${socket.id}`);
        socket.disconnect();
        return;
    }

    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
        console.log(`[WS] Rejected connection (invalid token): ${socket.id}`);
        socket.disconnect();
        return;
    }

    const userId = decoded.userId;
    const user = usersCache[userId];
    if (!user) {
        console.log(`[WS] Rejected connection (user not found): ${socket.id}`);
        socket.disconnect();
        return;
    }

    // Join personal room
    socket.join(`user:${userId}`);

    // If manager, also join 'managers' room
    if (user.role === 'manager') {
        socket.join('managers');
    }

    // Store userId on socket for disconnect handler
    socket.userId = userId;
    socket.userName = user.name;
    socket.userRole = user.role;

    // Track online presence
    onlineUsers.set(userId, {
        socketId: socket.id,
        name: user.name,
        role: user.role,
        connectedAt: new Date().toISOString()
    });

    // Broadcast updated online list to ALL connected clients
    io.emit('user:online', {
        userId,
        name: user.name,
        online: true,
        onlineUsers: Array.from(onlineUsers.entries()).map(([id, data]) => ({
            id,
            name: data.name,
            role: data.role,
            online: true
        }))
    });

    console.log(`[WS] ${user.name} connected: ${socket.id} (room: user:${userId})`);

    socket.on('disconnect', () => {
        console.log(`[WS] ${socket.userName} disconnected: ${socket.id}`);

        // 30-second grace period per PRD US-014
        setTimeout(() => {
            const current = onlineUsers.get(socket.userId);
            if (current && current.socketId === socket.id) {
                onlineUsers.delete(socket.userId);
                io.emit('user:online', {
                    userId: socket.userId,
                    name: socket.userName,
                    online: false,
                    onlineUsers: Array.from(onlineUsers.entries()).map(([id, data]) => ({
                        id,
                        name: data.name,
                        role: data.role,
                        online: true
                    }))
                });
                console.log(`[WS] ${socket.userName} is now offline (30s timeout)`);
            }
        }, 30000);
    });
});

// ============================================================
//  Section I: Server Startup (T1.6)
// ============================================================

async function main() {
    try {
        await initDatabase();

        server.listen(PORT, async () => {
            const collections = await db.listCollections().toArray();
            const userCount = await db.collection('users').countDocuments();

            console.log('========================================');
            console.log('  TaskFlow Server Started');
            console.log('========================================');
            console.log(`  Port:        ${PORT}`);
            console.log(`  Database:    MongoDB`);
            console.log(`  Collections: ${collections.length}`);
            console.log(`  Users:       ${userCount}`);
            console.log('========================================');
            console.log(`  Open: http://localhost:${PORT}/login.html`);
            console.log('========================================');
        });
    } catch (err) {
        console.error('[FATAL] Startup failed:', err.message);
        process.exit(1);
    }
}

main();

// ============================================================
//  Section J: Graceful Shutdown
// ============================================================

process.on('SIGINT', async () => {
    console.log('\n[SERVER] Shutting down...');
    if (client) await client.close();
    server.close(() => {
        console.log('[SERVER] Closed');
        process.exit(0);
    });
});

process.on('SIGTERM', async () => {
    if (client) await client.close();
    server.close(() => process.exit(0));
});
