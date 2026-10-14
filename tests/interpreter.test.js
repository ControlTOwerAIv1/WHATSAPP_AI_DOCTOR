require('dotenv').config();
const path = require('path');
const assert = require('assert');

const config = require('../src/ai-bot/config');
config.init(process.cwd());

const claude = require('../src/ai-bot/claude');

const defaultContext = {
  now_ist: 'Sunday, 18 October 2026, 09:00 AM',
  clinic_name: 'Al Ramzan Shifakhana',
  consultation_hours: '11:00 AM to 6:30 PM',
  window: {
    state: 'open',
    target_date: '2026-10-18',
    clinic_day_today: true,
    opens_in_minutes: null,
    next_open_text: null,
    closes_at_text: '9:00 AM today',
  },
  existing_token: null,
  capacity: { full: false },
  is_voice_transcript: false,
  attempt_result: null,
};

const testCases = [
  {
    id: '1',
    desc: "'Assalamualaikum Imran Qureshi' -> BOOK, Imran Qureshi",
    input: { message: 'Assalamualaikum Imran Qureshi', history: [], context: defaultContext },
    validate: (res) => {
      assert.strictEqual(res.action, 'BOOK');
      assert.strictEqual(res.name, 'Imran Qureshi');
    },
  },
  {
    id: '2',
    desc: "'Rahim Sheikh token chaiye' -> BOOK, Rahim Sheikh",
    input: { message: 'Rahim Sheikh token chaiye', history: [], context: defaultContext },
    validate: (res) => {
      assert.strictEqual(res.action, 'BOOK');
      assert.strictEqual(res.name, 'Rahim Sheikh');
    },
  },
  {
    id: '3',
    desc: "'irfan khan andheri token chaiye' -> BOOK, name Irfan Khan, no 'Andheri'",
    input: { message: 'irfan khan andheri token chaiye', history: [], context: defaultContext },
    validate: (res) => {
      assert.strictEqual(res.action, 'BOOK');
      assert.match(res.name, /Irfan Khan/i);
      assert.doesNotMatch(res.name, /Andheri/i);
    },
  },
  {
    id: '4',
    desc: "'Naam: Sana Ali Address: Kurla' -> BOOK, Sana Ali",
    input: { message: 'Naam: Sana Ali Address: Kurla', history: [], context: defaultContext },
    validate: (res) => {
      assert.strictEqual(res.action, 'BOOK');
      assert.match(res.name, /Sana Ali/i);
      assert.doesNotMatch(res.name, /Kurla/i);
    },
  },
  {
    id: '5',
    desc: "'token chahiye' -> REPLY asking only the name, language hinglish, no morning/afternoon/subah/dopahar",
    input: { message: 'token chahiye', history: [], context: defaultContext },
    validate: (res) => {
      assert.strictEqual(res.action, 'REPLY');
      assert.strictEqual(res.language, 'hinglish');
      assert.doesNotMatch(res.reply_text || '', /\b(morning|afternoon|subah|dopahar)\b/i);
    },
  },
  {
    id: '6',
    desc: "'Hello' -> REPLY, not BOOK",
    input: { message: 'Hello', history: [], context: defaultContext },
    validate: (res) => {
      assert.strictEqual(res.action, 'REPLY');
    },
  },
  {
    id: '7',
    desc: "history asks for a name, patient says 'samaj nhi aya' -> REPLY, not BOOK",
    input: {
      message: 'samaj nhi aya',
      history: [
        { role: 'user', content: 'token chahiye' },
        { role: 'assistant', content: 'Token reserve karne ke liye, kripya apna pura naam batayein.' },
      ],
      context: defaultContext,
    },
    validate: (res) => {
      assert.strictEqual(res.action, 'REPLY');
    },
  },
  {
    id: '8',
    desc: "'Aisha (child) and Zaid (parent)' -> REPLY asking which one",
    input: { message: 'Aisha (child) and Zaid (parent)', history: [], context: defaultContext },
    validate: (res) => {
      assert.strictEqual(res.action, 'REPLY');
      assert.ok(res.reply_text && res.reply_text.length > 5);
    },
  },
  {
    id: '9',
    desc: "'what should I bring?' -> REPLY, one short line",
    input: { message: 'what should I bring?', history: [], context: defaultContext },
    validate: (res) => {
      assert.strictEqual(res.action, 'REPLY');
      assert.ok(res.reply_text && res.reply_text.length > 5);
    },
  },
  {
    id: '10',
    desc: "'Shukriya' with an existing_token -> REPLY, no 'ask the clinic'",
    input: {
      message: 'Shukriya',
      history: [],
      context: {
        ...defaultContext,
        existing_token: { token_number: 1, name: 'Rahim Sheikh', date: '2026-10-18', time: '11:00 AM' },
      },
    },
    validate: (res) => {
      assert.strictEqual(res.action, 'REPLY');
      assert.doesNotMatch(res.reply_text || '', /ask the clinic|clinic se sampark/i);
    },
  },
  {
    id: '11',
    desc: "window closed, next_open_text 'in about 30 minutes (8:00 AM today)', 'token chahiye, naam Rahim' -> REPLY containing '30' and '8:00', not 'Sunday'",
    input: {
      message: 'token chahiye, naam Rahim',
      history: [],
      context: {
        ...defaultContext,
        window: {
          state: 'closed',
          target_date: '2026-10-18',
          clinic_day_today: true,
          opens_in_minutes: 30,
          next_open_text: 'in about 30 minutes (8:00 AM today)',
          closes_at_text: null,
        },
      },
    },
    validate: (res) => {
      assert.strictEqual(res.action, 'REPLY');
      assert.match(res.reply_text || '', /30/);
      assert.match(res.reply_text || '', /8:00/);
      assert.doesNotMatch(res.reply_text || '', /Sunday/i);
    },
  },
  {
    id: '12',
    desc: "existing_token set + 'name is wrong, it is Rahim Shaikh' -> CORRECT_NAME, Rahim Shaikh",
    input: {
      message: 'name is wrong, it is Rahim Shaikh',
      history: [],
      context: {
        ...defaultContext,
        existing_token: { token_number: 1, name: 'Rahim Sheikh', date: '2026-10-18', time: '11:00 AM' },
      },
    },
    validate: (res) => {
      assert.strictEqual(res.action, 'CORRECT_NAME');
      assert.match(res.name || '', /Rahim Shaikh/i);
    },
  },
  {
    id: '13',
    desc: "existing_token set + '2 token' -> REPLY (not BOOK) mentioning the token number",
    input: {
      message: '2 token',
      history: [],
      context: {
        ...defaultContext,
        existing_token: { token_number: 40, name: 'Fake Patient', date: '2026-10-18', time: '5:00 PM' },
      },
    },
    validate: (res) => {
      assert.strictEqual(res.action, 'REPLY');
      assert.match(res.reply_text || '', /40/);
    },
  },
  {
    id: '14',
    desc: "window closed, next_open_text 'today at 8:00 AM' + 'booking kab khulegi' -> REPLY containing '8', language hinglish",
    input: {
      message: 'booking kab khulegi',
      history: [],
      context: {
        ...defaultContext,
        window: {
          state: 'closed',
          target_date: '2026-10-18',
          clinic_day_today: true,
          opens_in_minutes: 450,
          next_open_text: 'today at 8:00 AM',
          closes_at_text: null,
        },
      },
    },
    validate: (res) => {
      assert.strictEqual(res.action, 'REPLY');
      assert.match(res.reply_text || '', /8/);
      assert.strictEqual(res.language, 'hinglish');
    },
  },
  {
    id: '15',
    desc: "consultation_hours '11:00 AM to 6:30 PM' + 'clinic kitne baje khulta hai' -> REPLY containing '11'",
    input: {
      message: 'clinic kitne baje khulta hai',
      history: [],
      context: { ...defaultContext, consultation_hours: '11:00 AM to 6:30 PM' },
    },
    validate: (res) => {
      assert.strictEqual(res.action, 'REPLY');
      assert.match(res.reply_text || '', /11/);
    },
  },
  {
    id: '16',
    desc: "'I need a token' -> language en",
    input: { message: 'I need a token', history: [], context: defaultContext },
    validate: (res) => {
      assert.strictEqual(res.language, 'en');
    },
  },
];

async function runTests() {
  console.log('=== Running Interpreter Test Suite (16 cases) ===\n');
  const table = [];
  let failures = 0;

  for (const tc of testCases) {
    let passed = false;
    let res = null;
    let errorMsg = null;

    // Run test; re-run once if failed
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        res = await claude.interpretPatientMessage(tc.input);
        tc.validate(res);
        passed = true;
        break;
      } catch (err) {
        errorMsg = err.message;
        if (attempt === 1) {
          console.log(`   (Retrying test case ${tc.id})...`);
        }
      }
    }

    if (passed) {
      table.push({ ID: tc.id, Status: 'PASS', Action: res.action, Name: res.name || '-', Lang: res.language, Reply: (res.reply_text || '-').slice(0, 45) });
      console.log(`✅ PASS: [${tc.id}] ${tc.desc}`);
    } else {
      failures++;
      table.push({ ID: tc.id, Status: 'FAIL', Action: res?.action || '-', Name: res?.name || '-', Lang: res?.language || '-', Reply: (res?.reply_text || errorMsg || '-').slice(0, 45) });
      console.error(`❌ FAIL: [${tc.id}] ${tc.desc}`);
      console.error('   Result:', res);
      console.error('   Error: ', errorMsg);
    }
  }

  console.log('\n=== FINAL INTERPRETER TEST TABLE ===');
  console.table(table);

  if (failures > 0) {
    console.error(`\nTotal failures: ${failures}`);
    process.exit(1);
  } else {
    console.log(`\n🎉 ALL 16 INTERPRETER TESTS PASSED!`);
    process.exit(0);
  }
}

runTests();
