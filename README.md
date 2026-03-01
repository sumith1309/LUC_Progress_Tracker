# TaskFlow - Real-Time Task Management System

A lightweight, real-time task management web application built for small teams: **1 Manager + 3 Employees**. Designed as a focused alternative to Jira/Asana with live updates, role-based dashboards, and a glassmorphism UI.

---

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Architecture Overview](#architecture-overview)
- [Authentication Flow](#authentication-flow)
- [Application Flow](#application-flow)
- [Real-Time Events](#real-time-events)
- [Database Schema](#database-schema)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Default Users](#default-users)
- [Business Rules](#business-rules)
- [Design System](#design-system)

---

## Features

- **Role-based dashboards** — Manager gets Kanban board + analytics; Employees get task list + inline controls
- **JWT authentication** — Email + password login with bcrypt-hashed passwords
- **Real-time updates** — Socket.IO pushes task changes, comments, and presence to all connected clients
- **Task lifecycle** — Create, assign, update status/priority/progress, comment, attach files, delete
- **Analytics dashboard** — Doughnut, bar, pie, and line charts (Chart.js) for the manager
- **File attachments** — Uploaded via Multer, stored in MongoDB GridFS
- **Toast notifications** — Color-coded, auto-dismissing alerts with Web Audio API chimes
- **Online presence** — Green dots on team cards with 30-second disconnect grace period
- **Ocean Glass UI** — Glassmorphism design system with animated gradient mesh background

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Runtime** | Node.js |
| **Server** | Express.js |
| **Database** | MongoDB (with GridFS for file storage) |
| **Real-Time** | Socket.IO |
| **Auth** | JWT (jsonwebtoken) + bcryptjs |
| **File Upload** | Multer (memory storage -> GridFS) |
| **Frontend** | Vanilla HTML/CSS/JS (no framework) |
| **Charts** | Chart.js v4 |
| **Fonts** | Google Fonts (Plus Jakarta Sans + DM Serif Display) |
| **IDs** | UUID v4 |

---

## Architecture Overview

```mermaid
graph TB
    subgraph Client ["Browser (Frontend)"]
        LOGIN["login.html<br/>Email + Password Form"]
        MGR["manager.html<br/>Kanban + Analytics + Team"]
        EMP["employee.html<br/>Task List + Filters"]
        APP["app.js<br/>Shared Module"]
        CSS["style.css<br/>Ocean Glass Design System"]
    end

    subgraph Server ["Node.js Server (server.js)"]
        EXPRESS["Express.js<br/>REST API (24 routes)"]
        SOCKETIO["Socket.IO<br/>Real-Time Events"]
        AUTH["JWT Middleware<br/>Authentication"]
        MULTER["Multer<br/>File Upload"]
    end

    subgraph Database ["MongoDB"]
        USERS["users"]
        TASKS["tasks"]
        COMMENTS["comments"]
        ATTACHMENTS["attachments"]
        NOTIFICATIONS["notifications"]
        GRIDFS["GridFS (uploads)"]
    end

    LOGIN -->|"POST /api/auth/login"| AUTH
    MGR -->|"REST API + Socket.IO"| EXPRESS
    EMP -->|"REST API + Socket.IO"| EXPRESS
    APP -->|"Bearer Token"| AUTH
    AUTH --> EXPRESS
    EXPRESS --> TASKS
    EXPRESS --> COMMENTS
    EXPRESS --> NOTIFICATIONS
    MULTER --> GRIDFS
    SOCKETIO -->|"Real-time push"| MGR
    SOCKETIO -->|"Real-time push"| EMP
```

---

## Authentication Flow

TaskFlow uses **JWT (JSON Web Tokens)** for stateless authentication. Tokens are stored in `sessionStorage` (cleared when the browser tab closes).

```mermaid
sequenceDiagram
    participant B as Browser
    participant S as Server
    participant DB as MongoDB

    Note over B: User opens login.html

    B->>S: POST /api/auth/login<br/>{email, password}
    S->>DB: Find user by email
    DB-->>S: User document (with password_hash)
    S->>S: bcrypt.compare(password, hash)

    alt Valid credentials
        S->>S: jwt.sign({userId, role, name}, SECRET, {expiresIn: '24h'})
        S-->>B: 200 {token, user: {id, name, role, email, avatar_color}}
        B->>B: sessionStorage.set('taskflow_token', token)
        B->>B: Redirect based on role

        alt role === 'manager'
            B->>B: window.location = /manager.html
        else role === 'employee'
            B->>B: window.location = /employee.html
        end

        Note over B: Dashboard loads
        B->>S: GET /api/auth/me<br/>Authorization: Bearer <token>
        S->>S: jwt.verify(token)
        S-->>B: 200 {id, name, role, email, avatar_color}
        B->>B: Verify role matches page<br/>Initialize TaskFlowApp
    else Invalid credentials
        S-->>B: 401 {error: "Invalid email or password."}
        B->>B: Show error message
    end

    Note over B: On every subsequent API call
    B->>S: GET/POST/PATCH /api/*<br/>Authorization: Bearer <token>
    S->>S: JWT middleware extracts user
    S-->>B: Response (or 401 if expired)

    Note over B: On logout or token expiry
    B->>B: sessionStorage.clear()
    B->>B: Redirect to /login.html
```

### Token Lifecycle

```mermaid
stateDiagram-v2
    [*] --> NoToken: Browser opened
    NoToken --> LoginPage: Navigate to any page
    LoginPage --> Authenticated: POST /api/auth/login (success)
    Authenticated --> Dashboard: Role-based redirect
    Dashboard --> Dashboard: API calls with Bearer token
    Dashboard --> Expired: Token expires (24h)
    Dashboard --> LoggedOut: User clicks Logout
    Expired --> LoginPage: 401 response triggers redirect
    LoggedOut --> LoginPage: sessionStorage.clear()
    Dashboard --> TabClosed: Browser/tab closed
    TabClosed --> NoToken: sessionStorage cleared automatically
```

---

## Application Flow

### Manager Workflow

```mermaid
flowchart LR
    LOGIN["Login as Manager<br/>(ahmed@taskflow.com)"] --> DASH["Dashboard View<br/>Kanban Board"]

    DASH --> CREATE["Create Task<br/>Title, Assignee, Priority,<br/>Due Date, Est. Hours"]
    DASH --> KANBAN["Kanban Columns<br/>To Do | In Progress |<br/>In Review | Completed"]
    DASH --> ANALYTICS["Analytics View<br/>4 Chart.js Charts"]
    DASH --> TEAM["Team View<br/>Employee Cards + Presence"]
    DASH --> NOTIF["Notifications<br/>Mark Read / Read All"]

    KANBAN --> DETAIL["Task Detail Drawer"]
    DETAIL --> STATUS["Change Status<br/>any→todo, review→completed,<br/>review→in_progress"]
    DETAIL --> EDIT["Edit Priority, Assignee,<br/>Due Date, Est. Hours"]
    DETAIL --> COMMENT["Add Comment"]
    DETAIL --> ATTACH["Upload Attachment"]
    DETAIL --> DELETE["Delete Task"]

    CREATE -->|"Socket.IO"| EMPLOYEE["Employee gets<br/>real-time notification"]
    STATUS -->|"Socket.IO"| EMPLOYEE
```

### Employee Workflow

```mermaid
flowchart LR
    LOGIN["Login as Employee<br/>(sara@taskflow.com)"] --> TASKS["My Tasks View<br/>Filtered Task List"]

    TASKS --> FILTER["Filter & Sort<br/>Status, Priority,<br/>Due Date, Title"]
    TASKS --> INLINE["Inline Controls"]

    INLINE --> PROGRESS["Update Progress<br/>0-100% Slider"]
    INLINE --> STATUSCHG["Change Status<br/>todo→in_progress<br/>in_progress→review"]

    PROGRESS -->|"100%"| PROMPT["BR-09: Auto-prompt<br/>Move to Review?"]
    PROMPT --> REVIEW["Status → review"]

    TASKS --> DETAIL["Task Detail Drawer<br/>(Read-only fields)"]
    DETAIL --> COMMENT["Add Comment"]
    DETAIL --> ATTACH["Upload Attachment"]

    STATUSCHG -->|"Socket.IO"| MANAGER["Manager gets<br/>real-time notification"]
    PROGRESS -->|"Socket.IO"| MANAGER
```

### Complete Task Lifecycle

```mermaid
stateDiagram-v2
    [*] --> todo: Manager creates task
    todo --> in_progress: Employee starts work
    in_progress --> review: Employee submits for review
    review --> completed: Manager approves
    review --> in_progress: Manager requests changes
    completed --> [*]: Task done

    note right of todo: Manager can reset any → todo
    note right of in_progress: Employee updates progress 0-100%
    note right of review: Auto-prompted at 100% progress (BR-09)
```

---

## Real-Time Events

All real-time communication flows through Socket.IO. The server pushes events to specific users or broadcasts to all.

```mermaid
sequenceDiagram
    participant M as Manager
    participant S as Server
    participant E as Employee

    Note over M,E: Connection (JWT Auth)
    M->>S: io({ auth: { token: jwt } })
    S->>S: jwt.verify(token)
    S->>S: Join room: user:{managerId}
    S->>S: Join room: managers
    S-->>M: Connected

    E->>S: io({ auth: { token: jwt } })
    S->>S: jwt.verify(token)
    S->>S: Join room: user:{employeeId}
    S-->>E: Connected
    S-->>M: user:online (presence update)
    S-->>E: user:online (presence update)

    Note over M,E: Task Creation
    M->>S: POST /api/tasks
    S-->>E: task:assigned (flat task object)
    S-->>E: notification:new
    S-->>M: task:updated

    Note over M,E: Progress Update
    E->>S: PATCH /api/tasks/:id {progress: 75}
    S-->>M: progress:update
    S-->>M: notification:new
    S-->>E: task:updated

    Note over M,E: Status Change
    E->>S: PATCH /api/tasks/:id {status: 'review'}
    S-->>M: status:change
    S-->>M: notification:new
    S-->>E: task:updated

    Note over M,E: Comment
    E->>S: POST /api/tasks/:id/comments
    S-->>M: comment:new (targeted)
    S-->>M: notification:new

    Note over M,E: Disconnect (30s grace)
    E->>S: disconnect
    S->>S: Wait 30 seconds
    S-->>M: user:online (offline)
```

### Event Reference

| Event | Direction | Target | Payload |
|-------|-----------|--------|---------|
| `task:assigned` | Server → Client | Assigned employee | Flat task object |
| `task:updated` | Server → Client | All users | `{ task }` or `{ deleted, taskId }` |
| `task:deleted` | Server → Client | Assigned employee | `{ taskId, taskTitle }` |
| `progress:update` | Server → Client | Manager | `{ taskId, taskTitle, employeeName, oldProgress, newProgress }` |
| `status:change` | Server → Client | Other party | `{ taskId, taskTitle, changedBy, oldStatus, newStatus }` |
| `comment:new` | Server → Client | Manager + assigned employee | `{ taskId, comment }` |
| `notification:new` | Server → Client | Target user | Notification object |
| `user:online` | Server → All | Broadcast | `{ userId, name, online, onlineUsers[] }` |

---

## Database Schema

TaskFlow uses 5 MongoDB collections plus GridFS for file storage.

```mermaid
erDiagram
    USERS {
        string _id PK "UUID v4"
        string name "Ahmed, Sara, Omar, Layla"
        string role "manager | employee"
        string email "unique"
        string avatar_color "hex color"
        string password_hash "bcrypt"
        string created_at "ISO 8601"
    }

    TASKS {
        string _id PK "UUID v4"
        string title "1-200 chars"
        string description "optional"
        string assigned_to FK "-> users._id"
        string created_by FK "-> users._id"
        string priority "low | medium | high | critical"
        string status "todo | in_progress | review | completed"
        int progress "0-100"
        string due_date "ISO 8601"
        float estimated_hours "optional"
        string created_at "ISO 8601"
        string updated_at "ISO 8601"
        string completed_at "ISO 8601 | null"
    }

    COMMENTS {
        string _id PK "UUID v4"
        string task_id FK "-> tasks._id"
        string user_id FK "-> users._id"
        string content "1-1000 chars"
        string created_at "ISO 8601"
    }

    ATTACHMENTS {
        string _id PK "UUID v4"
        string task_id FK "-> tasks._id"
        string uploaded_by FK "-> users._id"
        string filename "original name"
        string filepath "storage path"
        string mimetype "MIME type"
        int size "bytes"
        string created_at "ISO 8601"
    }

    NOTIFICATIONS {
        string _id PK "UUID v4"
        string user_id FK "-> users._id"
        string task_id FK "-> tasks._id | null"
        string type "task_assigned | status_change | ..."
        string title "display title"
        string message "display message"
        boolean is_read "default false"
        string created_at "ISO 8601"
    }

    USERS ||--o{ TASKS : "assigned_to"
    USERS ||--o{ TASKS : "created_by"
    USERS ||--o{ COMMENTS : "writes"
    USERS ||--o{ NOTIFICATIONS : "receives"
    TASKS ||--o{ COMMENTS : "has"
    TASKS ||--o{ ATTACHMENTS : "has"
    TASKS ||--o{ NOTIFICATIONS : "triggers"
```

### Indexes

| Collection | Index | Purpose |
|-----------|-------|---------|
| `tasks` | `assigned_to` | Filter tasks by employee |
| `tasks` | `created_by` | Filter tasks by creator |
| `tasks` | `status` | Kanban column queries |
| `tasks` | `due_date` | Sort by deadline |
| `comments` | `task_id, created_at` | Comments for a task (chronological) |
| `attachments` | `task_id` | Attachments for a task |
| `notifications` | `user_id, created_at` | User notifications (reverse chrono) |
| `notifications` | `user_id, is_read` | Unread count queries |

---

## API Reference

All endpoints (except auth and health) require `Authorization: Bearer <token>` header.

### Authentication

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/auth/login` | No | Login with email + password |
| `GET` | `/api/auth/me` | Yes | Get current user from token |

### Users

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/users` | Yes | List all users (manager first) |
| `GET` | `/api/users/online` | Yes | List currently online users |
| `GET` | `/api/users/:id` | Yes | Get single user by ID |

### Tasks

| Method | Endpoint | Auth | Role | Description |
|--------|----------|------|------|-------------|
| `POST` | `/api/tasks` | Yes | Manager | Create and assign a task |
| `GET` | `/api/tasks` | Yes | Any | List tasks (filtered by role) |
| `GET` | `/api/tasks/stats` | Yes | Manager | Task count statistics |
| `GET` | `/api/tasks/:id` | Yes | Any | Get task + comments + attachments |
| `PATCH` | `/api/tasks/:id` | Yes | Any | Update task fields (role-restricted) |
| `DELETE` | `/api/tasks/:id` | Yes | Manager | Delete task + cascade |

### Comments

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/tasks/:id/comments` | Yes | List comments for a task |
| `POST` | `/api/tasks/:id/comments` | Yes | Add a comment (1-1000 chars) |

### Attachments

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/tasks/:id/attachments` | Yes | List attachments for a task |
| `POST` | `/api/tasks/:id/attachments` | Yes | Upload file (max 10MB) |
| `DELETE` | `/api/attachments/:id` | Yes | Delete an attachment |
| `GET` | `/uploads/:filename` | No | Download file from GridFS |

### Notifications

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/notifications` | Yes | List user's notifications + unread count |
| `PATCH` | `/api/notifications/read-all` | Yes | Mark all as read |
| `PATCH` | `/api/notifications/:id/read` | Yes | Mark one as read |

### Analytics

| Method | Endpoint | Auth | Role | Description |
|--------|----------|------|------|-------------|
| `GET` | `/api/analytics/overview` | Yes | Manager | Dashboard stats + charts data |
| `GET` | `/api/analytics/team` | Yes | Manager | Per-employee performance |
| `GET` | `/api/analytics/employee/:id` | Yes | Any | Individual employee stats |

### System

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/health` | No | Health check (pings MongoDB) |

---

## Project Structure

```
LUC Progress Tracker/
├── server.js                   # Main entry point (~1420 lines)
│                               #   - Express + Socket.IO + MongoDB
│                               #   - 24 REST API routes
│                               #   - JWT auth middleware
│                               #   - Real-time event emissions
│                               #   - GridFS file serving
│
├── package.json                # 8 dependencies
├── package-lock.json           # Lockfile
├── .env                        # Environment variables (gitignored)
├── .env.example                # Template for .env
├── .gitignore                  # Excludes node_modules, .env, db/, uploads
│
├── public/                     # Static frontend (served by Express)
│   ├── login.html              # Email + password login form
│   ├── manager.html            # Manager dashboard (Kanban + Analytics + Team)
│   ├── employee.html           # Employee dashboard (Task List + Filters)
│   ├── css/
│   │   └── style.css           # Ocean Glass design system (~2160 lines)
│   ├── js/
│   │   └── app.js              # Shared client module (Socket.IO, toasts, API helper)
│   └── uploads/
│       └── .gitkeep            # Preserves directory in git
│
├── TaskFlow_PRD copy.docx      # Product Requirements Document
├── TaskFlow_TRD copy.docx      # Technical Requirements Document
└── TaskFlow_Implementation_Plan_v1.1 copy.docx  # Build plan
```

---

## Getting Started

### Prerequisites

- **Node.js** (v18 or higher)
- **MongoDB** (v6 or higher) — local or Atlas

### Installation

```bash
# 1. Clone the repository
git clone git@github.com:sumith1309/LUC_Progress_Tracker.git
cd LUC_Progress_Tracker

# 2. Switch to the feature branch
git checkout feature/sumith

# 3. Install dependencies
npm install

# 4. Create environment file
cp .env.example .env
# Edit .env with your MongoDB URI and a JWT secret:
#   MONGODB_URI=mongodb://localhost:27017/taskflow
#   JWT_SECRET=your-secret-key-here
#   PORT=3000

# 5. Start the server
npm start

# 6. Open in browser
open http://localhost:3000/login.html
```

### First Run

On first startup, the server automatically:
1. Connects to MongoDB
2. Creates indexes on all collections
3. Seeds 4 users with default password `taskflow123`
4. Starts listening on the configured port

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MONGODB_URI` | Yes | — | MongoDB connection string |
| `JWT_SECRET` | Yes | — | Secret key for signing JWT tokens |
| `PORT` | No | `3000` | Server port |
| `UPLOAD_MAX_SIZE` | No | `10485760` (10MB) | Max file upload size in bytes |

---

## Default Users

All users are seeded on first run with password: **`taskflow123`**

| Name | Role | Email | Avatar |
|------|------|-------|--------|
| Ahmed | Manager | ahmed@taskflow.com | Navy (#1B3A4B) |
| Sara | Employee | sara@taskflow.com | Teal (#4A7C6F) |
| Omar | Employee | omar@taskflow.com | Amber (#E8913A) |
| Layla | Employee | layla@taskflow.com | Purple (#8E6BBF) |

---

## Business Rules

| Rule | Description |
|------|-------------|
| **BR-01** | Only the Manager can create, delete, and reassign tasks |
| **BR-02** | Tasks can only be assigned to employees (not the manager) |
| **BR-03** | Priority levels: low, medium, high, critical |
| **BR-04** | Status values: todo, in_progress, review, completed |
| **BR-05** | Due date cannot be in the past |
| **BR-06** | Manager transitions: any→todo, review→completed, review→in_progress |
| **BR-07** | Employee transitions: todo→in_progress, in_progress→review |
| **BR-08** | Only employees can update progress (0-100%) |
| **BR-09** | At 100% progress, employee is auto-prompted to move to review |
| **BR-10** | Deleting a task cascades to comments, attachments, and notifications |
| **BR-11** | Attachments: max 10MB, allowed types: images, PDF, Word, Excel, text, CSV |
| **BR-12** | Comments are targeted — only manager + assigned employee see comment notifications |
| **BR-13** | 30-second disconnect grace period before marking user offline |

---

## Design System

**Theme: Ocean Glass** — A glassmorphism design with frosted panels over an animated gradient mesh.

| Token | Value |
|-------|-------|
| Primary | `#1B3A4B` (Navy) |
| Accent | `#4A7C6F` (Teal) |
| Aqua | `#7DD3C0` |
| Warn | `#E8913A` (Amber) |
| Danger | `#C0392B` (Red) |
| Font (Body) | Plus Jakarta Sans |
| Font (Heading) | DM Serif Display |
| Glass BG | `rgba(255,255,255,0.06)` |
| Border Radius | 8px — 20px |
| Animations | 11 keyframe animations (tf-* prefixed) |

---

## License

ISC
