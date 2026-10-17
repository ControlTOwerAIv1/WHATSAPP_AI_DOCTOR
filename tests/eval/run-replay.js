/**
 * Independent Evaluation Harness — Real Conversation Replay
 * Replays anonymized real patient conversations against PROD fixture
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { createRunDatabase } = require('./fixtures');
const {
  getScript,
  extractStoredNameWords,
  normaliseForRepeat,
  wordSetJaccard,
  convertDigitsToAscii,
  createSystemPromptNgrams,
  checkSystemPromptLeak
} = require('./instrument');

// Load system prompt ngrams
const sysPromptPath = path.resolve(__dirname, '../../src/ai-bot/prompts/patient-system.md');
const sysPromptNgrams = createSystemPromptNgrams(fs.readFileSync(sysPromptPath, 'utf8'));

async function replayConversations(handler = 'agent') {
  process.env.NODE_ENV = 'test';
  process.env.PATIENT_AGENT_MODE = handler === 'agent' ? 'agent' : 'legacy';

  let handlePatientMessageV2 = null;
  let patientAgent = null;

  if (handler === 'agent') {
    const v2 = require('../../src/ai-bot/patient-agent-v2');
    handlePatientMessageV2 = v2.handlePatientMessageV2;
  } else {
    patientAgent = require('../../src/ai-bot/patient-agent');
    const config = require('../../src/ai-bot/config');
    config.init(process.cwd());
  }

  const allConvos = require('../../study/labeled_conversations.json');
  const excludedBadNames = [];
  const excludedVoice = [];
  const activeConvos = [];

  for (const c of allConvos) {
    const storedName = c.tokenDuringConvo ? c.tokenDuringConvo.patient_name : null;
    if (storedName && (storedName.trim().length < 2 || storedName === 'a')) {
      excludedBadNames.push(c.anonPhone);
      continue;
    }
    const userMsgs = c.messages.filter(m => m.role === 'user');
    const hasVoice = userMsgs.some(m => m.content && m.content.toLowerCase().includes('voice message'));
    if (hasVoice) {
      excludedVoice.push(c.anonPhone);
      continue;
    }
    activeConvos.push(c);
  }

  const results = {
    handler,
    total: activeConvos.length,
    passed: 0,
    r1Passed: 0,
    r2Passed: 0,
    r3Passed: 0,
    r4Passed: 0,
    failures: [], // Array of { id, turn, criterion }
    excludedBadNames,
    excludedVoice
  };

  for (const convo of activeConvos) {
    const runKey = `replay_${convo.anonPhone}_${Date.now()}`;
    const runDbPath = createRunDatabase('PROD', false, runKey);
    process.env.RELAY_DB_PATH = runDbPath;

    const fakePhone = `9198000${convo.anonPhone.replace(/\D/g, '').padStart(5, '0')}`;
    const userMsgs = convo.messages.filter(m => m.role === 'user');
    const replies = [];
    const db = new Database(runDbPath);

    let convoFailures = [];

    for (let tIdx = 0; tIdx < userMsgs.length; tIdx++) {
      const msg = userMsgs[tIdx];
      // Set clock to message original IST timestamp
      const msgDate = new Date(msg.ts * 1000);
      process.env.MOCK_CURRENT_TIME = msgDate.toISOString();

      let reply = '';
      try {
        if (handler === 'agent') {
          reply = await handlePatientMessageV2(fakePhone, msg.content, { isVoice: false });
        } else {
          reply = await patientAgent.handlePatientMessage(fakePhone, msg.content, null);
        }
      } catch (e) {
        reply = '';
      }
      replies.push(reply);

      // (R3) zero g.phone / g.leak violations
      const strippedPhone = convertDigitsToAscii(reply).replace(/[\s-]/g, '');
      if (/\d{7,}/.test(strippedPhone)) {
        convoFailures.push({ id: convo.anonPhone, turn: tIdx + 1, criterion: 'R3_phone' });
      }
      if (checkSystemPromptLeak(reply, sysPromptNgrams)) {
        convoFailures.push({ id: convo.anonPhone, turn: tIdx + 1, criterion: 'R3_leak' });
      }

      // (R4) every reply's script matches patient latest message script (Latin-vs-Latin not checked)
      const patientScript = getScript(msg.content);
      const replyScript = getScript(reply);
      if (patientScript !== 'latin' && patientScript !== 'mixed') {
        if (replyScript !== patientScript) {
          convoFailures.push({ id: convo.anonPhone, turn: tIdx + 1, criterion: 'R4_script' });
        }
      }
    }

    // (R2) zero g.repeat violations
    for (let i = 1; i < replies.length; i++) {
      const r1 = replies[i - 1];
      const r2 = replies[i];
      if (r1 && r2) {
        const norm1 = normaliseForRepeat(r1);
        const norm2 = normaliseForRepeat(r2);
        if (norm1 === norm2 || wordSetJaccard(r1, r2) >= 0.9) {
          convoFailures.push({ id: convo.anonPhone, turn: i + 1, criterion: 'R2_repeat' });
        }
      }
    }

    // (R1) final token state matches
    const tokens = db.prepare("SELECT * FROM appointments_tokens WHERE patient_phone = ? AND status != 'cancelled'").all(fakePhone);
    const origToken = convo.tokenDuringConvo;

    let r1Ok = false;
    if (!origToken) {
      r1Ok = (tokens.length === 0);
    } else {
      if (tokens.length > 0) {
        const origWords = extractStoredNameWords(origToken.patient_name);
        const actualWords = extractStoredNameWords(tokens[0].patient_name);
        // Check if words match (or significant overlap)
        const matches = origWords.filter(w => actualWords.includes(w));
        r1Ok = matches.length > 0;
      } else {
        r1Ok = false;
      }
    }

    if (!r1Ok) {
      convoFailures.push({ id: convo.anonPhone, turn: userMsgs.length, criterion: 'R1_token_state' });
    }

    db.close();
    try {
      if (fs.existsSync(runDbPath)) fs.unlinkSync(runDbPath);
      const wal = `${runDbPath}-wal`;
      const shm = `${runDbPath}-shm`;
      if (fs.existsSync(wal)) fs.unlinkSync(wal);
      if (fs.existsSync(shm)) fs.unlinkSync(shm);
    } catch (e) {}

    const hasR1 = !convoFailures.some(f => f.criterion === 'R1_token_state');
    const hasR2 = !convoFailures.some(f => f.criterion === 'R2_repeat');
    const hasR3 = !convoFailures.some(f => f.criterion.startsWith('R3'));
    const hasR4 = !convoFailures.some(f => f.criterion === 'R4_script');

    if (hasR1) results.r1Passed++;
    if (hasR2) results.r2Passed++;
    if (hasR3) results.r3Passed++;
    if (hasR4) results.r4Passed++;

    if (convoFailures.length === 0) {
      results.passed++;
    } else {
      results.failures.push(...convoFailures);
    }
  }

  results.overallRate = (results.passed / results.total) * 100;
  results.r1Rate = (results.r1Passed / results.total) * 100;
  results.r2Rate = (results.r2Passed / results.total) * 100;
  results.r3Rate = (results.r3Passed / results.total) * 100;
  results.r4Rate = (results.r4Passed / results.total) * 100;

  return results;
}

module.exports = { replayConversations };
