# Patient Agent V2 Rollout & Operations Guide

## Overview
Patient Agent V2 provides an LLM-powered decision loop for WhatsApp appointment booking at Al Ramzan Shifakhana. It replaces regex-based routing with single-turn intent extraction and slot decisioning, while enforcing all business constraints (capacity, operating days, one-token-per-phone, booking window, name verification) deterministically in code.

---

## Configuration Flags

### 1. `PATIENT_AGENT_MODE`
Controls which patient flow processes incoming WhatsApp messages.
- `legacy` (default): Runs the original regex-based finite-state machine in `src/ai-bot/patient-agent.js`.
- `agent`: Routes incoming patient messages through `src/ai-bot/patient-agent-v2.js`.

### 2. `AGENT_MODEL_PATIENT`
Specifies the Anthropic Claude model used for patient message interpretation.
- Defaults to `claude-sonnet-4-5` if unset.
- Example: `AGENT_MODEL_PATIENT=claude-3-5-haiku-20241022`

---

## Rollback Procedure
If any unexpected behavior occurs in production, you can immediately revert to the legacy flow without touching any code:

1. In `.env`, set:
   ```env
   PATIENT_AGENT_MODE=legacy
   ```
2. Restart the application process:
   ```bash
   pm2 restart whatsapp-relay
   ```
   *(or `pm2 restart ecosystem.config.js` / node process)*

All patient traffic will immediately revert to the legacy `patientAgent.handlePatientMessage` flow.

---

## Observability & Audit: `agent_log` Table
Every message handled by Patient Agent V2 writes an audit and latency metric row to the SQLite database in the `agent_log` table:

```sql
CREATE TABLE IF NOT EXISTS agent_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_last4 TEXT,
  action      TEXT,
  result      TEXT,
  ms          INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Privacy Guarantee:** For strict patient privacy compliance, no message text or full phone numbers are ever stored in `agent_log`.

---

## 10 Test Messages for Live Trial
Send these 10 messages in sequence from your phone to the test WhatsApp number:

1. **S1 (Direct Name Booking):**
   `Rahim Sheikh`
   *Expected:* Books token immediately in 1 turn with name "Rahim Sheikh".

2. **S3 (Token Request with Name):**
   `Imran Qureshi token chaiye`
   *Expected:* Books token in 1 turn with name "Imran Qureshi".

3. **S6 (Two-step Booking):**
   - Step 1: `token chahiye` *(Bot asks only for your name; no slot questions)*
   - Step 2: `Rahim` *(Bot confirms booking for "Rahim")*

4. **S9 (Handling Confusion Before Name):**
   - Step 1: `token chahiye`
   - Step 2: `samaj nhi aya` *(Bot politely re-asks for your name)*
   - Step 3: `Rahim Sheikh` *(Bot books token)*

5. **S13 (Courtesy / Thanks with Active Token):**
   `Shukriya`
   *Expected:* Bot sends a warm reply ("Aapka swagat hai", etc.) without repeating the out-of-scope warning.

6. **S15 (Cancellation Inquiry):**
   `cancel my appointment`
   *Expected:* Bot informs you that appointments cannot be cancelled via WhatsApp and directs you to contact the clinic. Token remains active.

7. **S17 (Early Request Before 8:00 AM):**
   `Imran Qureshi token chaiye` *(sent before booking window opens, e.g., 07:30 AM)*
   *Expected:* Informs you that booking opens at 8:00 AM today (no "coming Sunday" error).

8. **Voice Note (Clear):**
   *Audio message saying:* `"Mera naam Rahim Shaikh hai token chahiye"`
   *Expected:* Transcribes and books token for "Rahim Shaikh".

9. **Voice Note (Unclear / Background Noise):**
   *Audio message with garbled sound or muttering:* `"mmm uh"`
   *Expected:* Asks you to type your name; never hangs silently.

10. **S12 (Name Correction):**
    `name is wrong, it's Rahim Shaikh`
    *Expected:* Updates name on active token to "Rahim Shaikh", resends confirmation, and writes audit record to `name_audit`.
