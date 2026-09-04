# 🏥 WhatsApp AI Doctor — Intelligent Clinic Management System

> **An AI-powered WhatsApp bot for automated patient appointment booking, doctor schedule management, and clinic administration — built on the Meta WhatsApp Cloud API with Claude AI.**

---

## 📋 Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Key Features](#key-features)
- [Technology Stack](#technology-stack)
- [Project Structure](#project-structure)
- [Setup & Installation](#setup--installation)
- [Configuration](#configuration)
- [How It Works](#how-it-works)
- [Deployment](#deployment)
- [API Endpoints](#api-endpoints)

---

## 🔎 Overview

WhatsApp AI Doctor is a full-stack WhatsApp relay bridge with an integrated AI chatbot. It connects to the **Meta WhatsApp Business Cloud API** and uses **Anthropic's Claude AI** to provide:

- **Automated patient appointment booking** via natural language (English, Hindi, Urdu, Hinglish)
- **Token-based queuing system** with morning/afternoon slot management
- **Doctor schedule viewing** for registered doctor phone numbers
- **Admin commands** for schedule overrides and permanent settings changes
- **Operator dashboard** (web UI) for human agents to monitor and take over chats
- **Multi-operator support** with chat locking/assignment

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                   WhatsApp AI Doctor System                      │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────┐    Webhook     ┌────────────────┐                 │
│  │ WhatsApp │ ◄────────────► │  bridge.js      │                │
│  │ Cloud API│   (POST/GET)   │  (Entrypoint)   │                │
│  └──────────┘                └───────┬────────┘                 │
│                                      │                           │
│            ┌─────────────────────────┼───────────────────┐      │
│            │                         │                    │      │
│   ┌────────▼────────┐   ┌───────────▼──────┐  ┌─────────▼───┐ │
│   │   cloudapi.js    │   │   stores.js       │  │  routes.js   │ │
│   │ (Meta Graph API) │   │ (In-memory state  │  │ (REST API +  │ │
│   │  Send/Receive    │   │  + Chat locking)  │  │  Socket.IO)  │ │
│   └────────┬────────┘   └───────────────────┘  └──────┬──────┘ │
│            │                                           │        │
│   ┌────────▼────────┐                          ┌──────▼──────┐ │
│   │   ai-bot/        │                          │  Dashboard  │ │
│   │  ┌─────────────┐ │                          │  (HTML/JS)  │ │
│   │  │ index.js     │ │   ┌──────────────┐      └─────────────┘ │
│   │  │ (Router)     │ │   │   db.js       │                     │
│   │  ├─────────────┤ │   │  (SQLite)     │                     │
│   │  │patient-agent │ │   └──────────────┘                     │
│   │  │doctor-agent  │ │                                         │
│   │  │admin-agent   │ │   ┌──────────────┐                     │
│   │  ├─────────────┤ │   │  Google       │                     │
│   │  │ claude.js    │ │◄──►  Sheets      │                     │
│   │  │ schedule.js  │ │   │  (Schedule)  │                     │
│   │  │ sheets.js    │ │   └──────────────┘                     │
│   │  └─────────────┘ │                                         │
│   └─────────────────┘                                           │
└──────────────────────────────────────────────────────────────────┘
```

---

## ✨ Key Features

### 🤖 AI-Powered Patient Interactions
- **Multi-language support**: English, Hindi, Urdu, Hinglish
- **Intent classification**: Distinguishes between appointment requests, medical questions, medicine queries, and general chat
- **Smart token allocation**: Sequential token numbers with morning/afternoon slot preferences
- **Estimated arrival times**: Dynamically calculated based on slot distribution
- **Duplicate prevention**: Same patient can't book twice for the same day

### 👨‍⚕️ Doctor Agent
- Registered doctors get personalized access to:
  - Today's appointment list with patient details
  - Upcoming schedule view
  - Patient information queries

### 👑 Admin Agent
- **Query mode**: Ask about current schedule, timings, token capacity
- **Command mode**: Modify schedule with confirm-before-mutate workflow
  - One-off overrides (extra days, closures, capacity changes)
  - Permanent settings changes (operating days, caps, timings)
- **Multi-language confirmation**: Supports "haan", "yes", "theek hai", etc.

### 📊 Operator Dashboard
- Real-time chat monitoring via Socket.IO
- Multi-operator support with chat assignment/locking
- Message search, flagging, and read tracking
- Media support (images, video, audio, documents, stickers, location)
- Contact import (VCF)

### 📅 Schedule Engine
- Google Sheets as the source of truth for clinic settings
- **Settings tab**: Permanent clinic configuration
- **Overrides tab**: One-off date exceptions
- 60-second TTL caching for performance
- Dynamic prompt template rendering

---

## 🛠️ Technology Stack

| Component | Technology |
|-----------|-----------|
| **Runtime** | Node.js |
| **WhatsApp** | Meta Cloud API (Graph API v21.0) |
| **AI/LLM** | Anthropic Claude (claude-sonnet-4-5) |
| **Database** | SQLite (better-sqlite3) |
| **Web Server** | Express.js |
| **Real-time** | Socket.IO |
| **Schedule Data** | Google Sheets API v4 |
| **Process Manager** | PM2 |
| **CI/CD** | GitHub Actions |

---

## 📁 Project Structure

```
whatsapp-relay/
├── bridge.js                          # Application entrypoint — wires all modules together
├── config.json                        # Runtime configuration overrides
├── ecosystem.config.js                # PM2 process manager configuration
├── package.json                       # Node.js dependencies and scripts
├── .env.example                       # Environment variables template
├── .gitignore                         # Git ignore rules
├── SETUP.md                           # Detailed setup instructions
├── DEPLOYMENT_GUIDE.md                # Production deployment guide
│
├── src/
│   ├── logging.js                     # stdout/stderr tee to logs/bridge.log with rotation
│   ├── db.js                          # SQLite persistence (contacts, chats, messages, metadata)
│   ├── stores.js                      # In-memory state, chat locking, normalizers
│   ├── cloudapi.js                    # Meta WhatsApp Cloud API integration
│   ├── routes.js                      # Express REST API + Socket.IO operator events
│   │
│   └── ai-bot/                        # AI chatbot module
│       ├── index.js                   # Bot entry point, message router (patient/doctor/admin)
│       ├── config.js                  # Bot configuration, doctor registry, phone normalization
│       ├── claude.js                  # Anthropic Claude API wrapper (classify, chat, validate)
│       ├── session.js                 # In-memory session store (30-min TTL, conversation state)
│       ├── clock.js                   # Centralized clock (supports mock time for testing)
│       ├── patient-agent.js           # Patient message handler (booking flow FSM)
│       ├── doctor-agent.js            # Doctor message handler (schedule/appointments view)
│       ├── admin-agent.js             # Admin message handler (query/command with confirmation)
│       ├── schedule.js                # Schedule engine, token management, arrival time math
│       ├── sheets.js                  # Google Sheets read/write (availability, bookings, settings)
│       ├── config/
│       │   └── clinic-schedule.json   # Default clinic schedule seed configuration
│       └── prompts/
│           └── appointment-behavior.md # Dynamic prompt template for Claude receptionist
│
├── public/                            # Operator dashboard web UI
│   ├── dashboard.html                 # Dashboard HTML
│   ├── dashboard.js                   # Dashboard JavaScript (Socket.IO client)
│   ├── dashboard.css                  # Dashboard styles
│   ├── logo.png                       # Clinic logo
│   └── new_chat.png                   # New chat icon
│
├── .github/workflows/
│   ├── deploy-prod.yml                # GitHub Actions: deploy to production on push to `prod`
│   └── deploy-test.yml                # GitHub Actions: deploy to test on push to `master`
│
├── data/                              # Runtime data (tokens, etc.) — gitignored
├── logs/                              # Application logs — gitignored
└── media/                             # Downloaded/uploaded media files — gitignored
```

---

## 🚀 Setup & Installation

### Prerequisites
- **Node.js** 18+ installed
- **Meta Developer Account** with WhatsApp Business API access
- **Anthropic API Key** for Claude AI
- **Google Cloud Service Account** with Sheets API enabled
- **Google Spreadsheet** shared with the service account email

### 1. Clone the Repository

```bash
git clone https://github.com/ControlTOwerAIv1/WHATSAPP_AI_DOCTOR.git
cd WHATSAPP_AI_DOCTOR
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

```bash
cp .env.example .env
# Edit .env with your actual credentials
```

### 4. Configure Doctor Registry

Create a `doctors.json` file in the project root:

```json
{
  "doctors": [
    {
      "name": "Dr. Sarah",
      "phone": "919876543210",
      "specialty": "General Medicine"
    }
  ]
}
```

### 5. Set Up Google Sheets

Place your Google Service Account `credentials.json` in the project root. The bot will auto-create **Settings** and **Overrides** tabs on first run.

### 6. Configure Meta Webhook

Point your Meta WhatsApp webhook to:
```
https://your-domain.com/webhook
```

### 7. Start the Server

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

The dashboard will be available at `http://localhost:3001`.

---

## ⚙️ Configuration

### Environment Variables (`.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `WHATSAPP_ACCESS_TOKEN` | ✅ | Meta permanent/temporary access token |
| `WHATSAPP_PHONE_NUMBER_ID` | ✅ | WhatsApp Business phone number ID |
| `WHATSAPP_VERIFY_TOKEN` | ✅ | Webhook verification secret |
| `ANTHROPIC_API_KEY` | ✅ | Anthropic Claude API key |
| `GOOGLE_SHEET_ID` | ✅ | Google Spreadsheet ID |
| `GOOGLE_CREDENTIALS_FILE` | ❌ | Path to service account JSON (default: `credentials.json`) |
| `ADMIN_PHONE_NUMBER` | ❌ | Admin phone number for schedule commands |
| `AI_BOT_ENABLED` | ❌ | Enable/disable AI bot (default: `true`) |
| `PORT` | ❌ | Server port (default: `3001`) |

### Runtime Config (`config.json`)

```json
{
  "MAX_MESSAGES_PER_CHAT": 500,
  "SAVE_DEBOUNCE_MS": 2000,
  "DB_PATH": "./relay.sqlite",
  "RELEASE_ASSIGNMENTS_ON_DISCONNECT": true,
  "MESSAGE_EDIT_WINDOW_SECONDS": 900,
  "MESSAGE_DELETE_FOR_EVERYONE_WINDOW_SECONDS": 216000
}
```

---

## 🔄 How It Works

### Patient Booking Flow

```
Patient sends "token chahiye"
       │
       ▼
┌─ Intent Classification (Claude) ─┐
│  → appointment / general / etc.  │
└──────────────┬───────────────────┘
               │
       ▼ (appointment)
┌─ Booking Window Check ───────────┐
│  Is it Saturday 9PM – Sunday 6PM?│
│  (or override window)            │
└──────────────┬───────────────────┘
               │
       ▼ (window open)
┌─ Duplicate Check ────────────────┐
│  Already booked for this date?   │
└──────────────┬───────────────────┘
               │
       ▼ (not duplicate)
┌─ Collect Info ───────────────────┐
│  Name → Slot Preference          │
└──────────────┬───────────────────┘
               │
       ▼
┌─ Allocate Token ─────────────────┐
│  Sequential #, arrival time calc  │
│  Persist to SQLite + JSON backup  │
└──────────────┬───────────────────┘
               │
       ▼
"Your morning token is #5.
 Please arrive around 11:30 AM."
```

### Admin Command Flow

```
Admin: "open next Wednesday with 30 tokens, booking from Tuesday 9pm"
       │
       ▼
┌─ Classify: QUERY vs COMMAND ─────┐
└──────────────┬───────────────────┘
               │
       ▼ (COMMAND)
┌─ Parse Command (Claude) ─────────┐
│  → ONE-OFF override or PERMANENT │
│  → target_date, timings, caps    │
└──────────────┬───────────────────┘
               │
       ▼
"I'll write a one-off override to the
 Overrides tab for 2026-09-10.
 Should I proceed? Reply 'yes'."
       │
       ▼ (admin confirms)
┌─ Write to Google Sheets ─────────┐
│  Overrides tab → new row         │
│  Invalidate cache immediately    │
└──────────────────────────────────┘
```

---

## 🚢 Deployment

### PM2 (Production)

```bash
pm2 start ecosystem.config.js
pm2 save
```

### GitHub Actions CI/CD

- **Push to `master`** → Auto-deploys to test server
- **Push to `prod`** → Auto-deploys to production server

See `.github/workflows/` for deployment configuration.

---

## 📡 API Endpoints

### Webhook
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/webhook` | Meta webhook verification |
| `POST` | `/webhook` | Incoming WhatsApp messages |

### Status & Info
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | Connection status |
| `GET` | `/api/health` | Health check |
| `GET` | `/api/operators` | Connected operators |

### Chats & Messages
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/chats` | All chats sorted by timestamp |
| `GET` | `/api/messages?jid=...` | Messages for a chat |
| `GET` | `/api/messages/search?jid=...&q=...` | Search messages |
| `POST` | `/api/chats/:jid/claim` | Claim/assign a chat |
| `POST` | `/api/chats/:jid/release` | Release a chat assignment |

### Send Messages
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/send` | Send text message |
| `POST` | `/api/send/image` | Send image (multipart) |
| `POST` | `/api/send/video` | Send video (multipart) |
| `POST` | `/api/send/audio` | Send audio (multipart) |
| `POST` | `/api/send/document` | Send document (multipart) |
| `POST` | `/api/send/location` | Send location |

### Contacts
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/contacts` | All contacts |
| `GET` | `/api/contacts/search?q=...` | Search contacts |
| `POST` | `/api/contacts/import` | Import VCF file |

---

## 📄 License

Private repository. All rights reserved.
