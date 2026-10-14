/**
 * Independent Evaluation Harness — Case Runner (Child Process)
 * Runs a single case instance in complete isolation.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { createRunDatabase } = require('./fixtures');

// Parse CLI arguments: caseJson, runIndex, handler ('agent'|'legacy'|'stub')
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Usage: node run-case.js '<caseJson>' [runIndex] [handler]");
  process.exit(1);
}

const caseDef = JSON.parse(args[0]);
const runIndex = parseInt(args[1] || '1', 10);
const handler = args[2] || 'agent';

// Setup environment BEFORE loading any project modules
process.env.NODE_ENV = 'test';
process.env.PATIENT_AGENT_MODE = handler === 'agent' ? 'agent' : 'legacy';

const fixtureName = caseDef.opts.fx || 'OPEN';
const seedOthers = Boolean(caseDef.opts.seed);
const runKey = `${caseDef.id.replace(/[^a-zA-Z0-9_-]/g, '_')}_r${runIndex}_${process.pid}`;
const runDbPath = createRunDatabase(fixtureName, seedOthers, runKey);
process.env.RELAY_DB_PATH = runDbPath;

// Default clocks per fixture
const FIXTURE_DEFAULT_CLOCKS = {
  OPEN: '2026-10-18T09:00:00+05:30',
  PROD: '2026-10-18T08:30:00+05:30',
  TINY: '2026-10-18T09:00:00+05:30',
  OVR: '2026-10-27T20:30:00+05:30',
  OVRC: '2026-10-21T12:00:00+05:30'
};

function formatIsoClock(raw) {
  if (!raw) return FIXTURE_DEFAULT_CLOCKS[fixtureName] || '2026-10-18T09:00:00+05:30';
  let str = raw.trim();
  if (str.length === 16) {
    str += ':00'; // YYYY-MM-DDTHH:mm -> YYYY-MM-DDTHH:mm:00
  }
  if (!str.includes('+') && !str.includes('Z')) {
    str += '+05:30';
  }
  return str;
}

// Clocks per turn
let turnClocks = [];
if (caseDef.opts.clk) {
  const parts = caseDef.opts.clk.split('/');
  turnClocks = parts.map(formatIsoClock);
} else {
  turnClocks = [FIXTURE_DEFAULT_CLOCKS[fixtureName] || '2026-10-18T09:00:00+05:30'];
}

function getTurnClock(turnIdx) {
  if (turnIdx < turnClocks.length) {
    return turnClocks[turnIdx];
  }
  return turnClocks[turnClocks.length - 1];
}

// Set initial mock clock
process.env.MOCK_CURRENT_TIME = getTurnClock(0);

// Hash helper for agent_settings
function getSettingsHash(db) {
  try {
    const row = db.prepare("SELECT * FROM agent_settings WHERE agent_id = 'default'").get();
    if (!row) return null;
    return crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
  } catch (e) {
    return null;
  }
}

// Generate deterministic fake phone for this case + run
function getCasePhone(baseId, run) {
  let hash = 0;
  const str = `${baseId}_${run}`;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  const offset = Math.abs(hash) % 89999;
  return `9198000${String(10000 + offset)}`;
}

async function main() {
  const db = new Database(runDbPath);
  const settingsBeforeHash = getSettingsHash(db);

  // Load appropriate handler
  let handlePatientMessageV2 = null;
  let patientAgent = null;

  if (handler === 'agent') {
    const v2Module = require('../../src/ai-bot/patient-agent-v2');
    handlePatientMessageV2 = v2Module.handlePatientMessageV2;
  } else if (handler === 'legacy') {
    patientAgent = require('../../src/ai-bot/patient-agent');
    const config = require('../../src/ai-bot/config');
    config.init(process.cwd());
  }

  // Wrapper for a single call with infra retries (429/5xx/timeout)
  async function callHandlerWithRetry(phone, text) {
    if (handler === 'stub') {
      return 'ok';
    }

    let attempts = 0;
    while (attempts < 4) {
      try {
        if (handler === 'agent') {
          return await handlePatientMessageV2(phone, text, { isVoice: false });
        } else {
          return await patientAgent.handlePatientMessage(phone, text, null);
        }
      } catch (err) {
        attempts++;
        const msg = (err.message || String(err)).toLowerCase();
        const isInfra = msg.includes('429') || msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') || msg.includes('timeout') || msg.includes('rate limit');
        if (isInfra && attempts < 4) {
          console.error(`[INFRA RETRY] ${caseDef.id} r${runIndex} attempt ${attempts}: ${err.message}`);
          await new Promise(r => setTimeout(r, 1000 * attempts));
        } else {
          throw err;
        }
      }
    }
  }

  const turnResults = [];

  if (caseDef.isParallel) {
    // R5-01: 5 distinct phones sending concurrently
    const parallelTurns = caseDef.turns; // array of 5 single-turn arrays
    const phones = ['919800091001', '919800091002', '919800091003', '919800091004', '919800091005'];
    process.env.MOCK_CURRENT_TIME = getTurnClock(0);

    const start = Date.now();
    const promises = parallelTurns.map(async (turnArr, idx) => {
      const p = phones[idx];
      const text = turnArr[0];
      let reply = null;
      let error = null;
      const tStart = Date.now();
      try {
        reply = await callHandlerWithRetry(p, text);
      } catch (e) {
        error = e.message || String(e);
      }
      const tMs = Date.now() - tStart;
      const tokens = db.prepare("SELECT * FROM appointments_tokens WHERE patient_phone = ? AND status != 'cancelled'").all(p);
      return { patient: text, reply, tokens, error, ms: tMs, phone: p };
    });

    const settled = await Promise.all(promises);
    turnResults.push(...settled);
  } else if (caseDef.isParallelSamePhone) {
    // R5-02: 2 messages from same phone sent at the exact same moment
    const phone = '919800092001';
    process.env.MOCK_CURRENT_TIME = getTurnClock(0);

    const promises = caseDef.turns.map(async (text) => {
      let reply = null;
      let error = null;
      const tStart = Date.now();
      try {
        reply = await callHandlerWithRetry(phone, text);
      } catch (e) {
        error = e.message || String(e);
      }
      const tMs = Date.now() - tStart;
      const tokens = db.prepare("SELECT * FROM appointments_tokens WHERE patient_phone = ? AND status != 'cancelled'").all(phone);
      return { patient: text, reply, tokens, error, ms: tMs, phone };
    });

    const settled = await Promise.all(promises);
    turnResults.push(...settled);
  } else {
    // Normal sequential multi-turn conversation
    const phone = getCasePhone(caseDef.baseId, runIndex);

    for (let i = 0; i < caseDef.turns.length; i++) {
      const text = caseDef.turns[i];
      process.env.MOCK_CURRENT_TIME = getTurnClock(i);

      let reply = null;
      let error = null;
      const tStart = Date.now();

      try {
        reply = await callHandlerWithRetry(phone, text);
      } catch (e) {
        error = e.message || String(e);
      }

      const tMs = Date.now() - tStart;
      const tokens = db.prepare("SELECT * FROM appointments_tokens WHERE patient_phone = ? AND status != 'cancelled'").all(phone);
      turnResults.push({ patient: text, reply, tokens, error, ms: tMs, phone });
    }
  }

  // End-of-case queries
  let allTokens = [];
  let tokensTableExists = true;
  try {
    allTokens = db.prepare("SELECT * FROM appointments_tokens").all();
  } catch (e) {
    tokensTableExists = false;
  }

  let allAudit = [];
  try {
    allAudit = db.prepare("SELECT * FROM name_audit").all();
  } catch (e) {
    allAudit = [];
  }

  const settingsAfterHash = getSettingsHash(db);
  db.close();

  // Clean up temporary database copy
  try {
    if (fs.existsSync(runDbPath)) fs.unlinkSync(runDbPath);
    const wal = `${runDbPath}-wal`;
    const shm = `${runDbPath}-shm`;
    if (fs.existsSync(wal)) fs.unlinkSync(wal);
    if (fs.existsSync(shm)) fs.unlinkSync(shm);
  } catch (e) {}

  // Output single JSON line to stdout
  const output = {
    caseId: caseDef.id,
    run: runIndex,
    family: caseDef.family,
    category: caseDef.category,
    baseId: caseDef.baseId,
    variant: caseDef.variant,
    handler,
    turns: turnResults,
    allTokens,
    allAudit,
    settingsBeforeHash,
    settingsAfterHash,
    tokensTableExists
  };

  console.log(JSON.stringify(output));
}

main().catch(err => {
  console.error(JSON.stringify({
    caseId: caseDef.id,
    run: runIndex,
    family: caseDef.family,
    category: caseDef.category,
    error: err.message || String(err),
    turns: [{ error: err.message || String(err) }]
  }));
  process.exit(1);
});
