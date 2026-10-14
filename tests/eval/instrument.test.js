/**
 * Stage 1: Instrument Validation Test Suite (No model calls)
 * Validates language classifier, global checks, case assertions, held-out check, and stub run.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {
  getLang,
  getScript,
  convertDigitsToAscii,
  extractNumbers,
  isConfirmation,
  nameReq,
  redirect,
  countSentences,
  hasQ,
  has112,
  normaliseForRepeat,
  wordSetJaccard,
  extractStoredNameWords,
  createSystemPromptNgrams,
  checkSystemPromptLeak,
  evaluateGlobalChecks,
  evaluateCaseExpectations
} = require('./instrument');

const { runChildCase } = require('./run-eval');
const { generateReport } = require('./report');
const { buildAllTemplates } = require('./fixtures');

async function runStage1Validation() {
  console.log("=== STAGE 1: INSTRUMENT VALIDATION (NO BOT CALLS) ===\n");

  // ─────────────────────────────────────────────────────────────────────────────
  // 1a. Language Classifier (14 frozen strings)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- 1a. Language Classifier Validation (14/14) ---");
  const langCases = [
    // en (4 + 1)
    { str: "Please send your name so I can issue a token.", exp: "en" },
    { str: "Booking opens in about 30 minutes, at 8:00 AM today.", exp: "en" },
    { str: "You are welcome.", exp: "en" },
    { str: "Sorry, I can only help with appointment tokens.", exp: "en" },
    { str: "Thank you, we will see you soon.", exp: "en" }, // 14th

    // hing (5)
    { str: "Kripya apna pura naam batayein.", exp: "hing" },
    { str: "Aaj subah 8:00 baje booking khulegi.", exp: "hing" },
    { str: "Aapka token abhi nahi bana, kripya naam bhejein.", exp: "hing" },
    { str: "Maaf kijiye, main sirf appointment token mein madad kar sakta hoon.", exp: "hing" },
    { str: "Shukriya, aap ka swagat hai.", exp: "hing" },

    // deva (2)
    { str: "कृपया अपना पूरा नाम बताइए।", exp: "deva" },
    { str: "बुकिंग सुबह 8:00 बजे खुलेगी।", exp: "deva" },

    // urdu (2)
    { str: "براہ کرم اپنا پورا نام بتائیں۔", exp: "urdu" },
    { str: "بکنگ صبح 8:00 بجے کھلے گی۔", exp: "urdu" }
  ];

  let langPassed = 0;
  for (let i = 0; i < langCases.length; i++) {
    const { str, exp } = langCases[i];
    const actual = getLang(str);
    if (actual !== exp) {
      console.error(`❌ [FAIL 1a] Expected ${exp}, got ${actual} for: "${str}"`);
    } else {
      langPassed++;
    }
  }

  console.log(`Lang Classifier Result: ${langPassed}/${langCases.length}`);
  if (langPassed !== 14) {
    console.error(`STOP: Language classifier achieved ${langPassed}/14 (required 14/14).`);
    process.exit(1);
  }
  console.log("✅ 1a. ALL 14 LANGUAGE STRINGS CLASSIFIED EXACTLY.\n");

  // ─────────────────────────────────────────────────────────────────────────────
  // 1b. Hand-Made Passing & Failing Examples for Every Check and Assertion
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- 1b. Global Checks & Assertion Examples Validation ---");

  // Helper system prompt ngrams
  const dummyPrompt = "You are the WhatsApp receptionist for Al Ramzan Shifakhana clinic booking.";
  const promptNgrams = createSystemPromptNgrams(dummyPrompt);

  // g.empty
  const passEmpty = evaluateGlobalChecks({ turns: [{ reply: "Hello patient" }] }, promptNgrams);
  const failEmpty = evaluateGlobalChecks({ turns: [{ reply: "   " }] }, promptNgrams);
  assert.strictEqual(passEmpty.violations.some(v => v.check === 'g.empty'), false);
  assert.strictEqual(failEmpty.violations.some(v => v.check === 'g.empty'), true);

  // g.error
  const passError = evaluateGlobalChecks({ turns: [{ reply: "ok", error: null }] }, promptNgrams);
  const failError = evaluateGlobalChecks({ turns: [{ reply: null, error: "Network failed" }] }, promptNgrams);
  assert.strictEqual(passError.violations.some(v => v.check === 'g.error'), false);
  assert.strictEqual(failError.violations.some(v => v.check === 'g.error'), true);

  // g.dup
  const passDup = evaluateGlobalChecks({
    turns: [{ reply: "ok" }],
    allTokens: [
      { patient_phone: "919800000001", sunday_date: "2026-10-18" },
      { patient_phone: "919800000002", sunday_date: "2026-10-18" }
    ]
  }, promptNgrams);
  const failDup = evaluateGlobalChecks({
    turns: [{ reply: "ok" }],
    allTokens: [
      { patient_phone: "919800000001", sunday_date: "2026-10-18" },
      { patient_phone: "919800000001", sunday_date: "2026-10-18" }
    ]
  }, promptNgrams);
  assert.strictEqual(passDup.violations.some(v => v.check === 'g.dup'), false);
  assert.strictEqual(failDup.violations.some(v => v.check === 'g.dup'), true);

  // g.name
  const passName = evaluateGlobalChecks({
    turns: [{ reply: "ok" }],
    allTokens: [{ patient_name: "Rahim Sheikh" }]
  }, promptNgrams);
  const failNameDigit = evaluateGlobalChecks({
    turns: [{ reply: "ok" }],
    allTokens: [{ patient_name: "Rahim 123" }]
  }, promptNgrams);
  const failNameBrackets = evaluateGlobalChecks({
    turns: [{ reply: "ok" }],
    allTokens: [{ patient_name: "Rahim (child)" }]
  }, promptNgrams);
  assert.strictEqual(passName.violations.some(v => v.check === 'g.name'), false);
  assert.strictEqual(failNameDigit.violations.some(v => v.check === 'g.name'), true);
  assert.strictEqual(failNameBrackets.violations.some(v => v.check === 'g.name'), true);

  // g.repeat
  const passRepeat = evaluateGlobalChecks({
    turns: [
      { reply: "Please send your name." },
      { reply: "Booking opens at 8:00 AM." }
    ]
  }, promptNgrams);
  const failRepeatIdentical = evaluateGlobalChecks({
    turns: [
      { reply: "Please send your name." },
      { reply: "Please send your name!" }
    ]
  }, promptNgrams);
  const failRepeatJaccard = evaluateGlobalChecks({
    turns: [
      { reply: "Please send your name so we can book an appointment token for you today." },
      { reply: "Please send your full name so we can book an appointment token for you today." }
    ]
  }, promptNgrams);
  assert.strictEqual(passRepeat.violations.some(v => v.check === 'g.repeat'), false);
  assert.strictEqual(failRepeatIdentical.violations.some(v => v.check === 'g.repeat'), true);
  assert.strictEqual(failRepeatJaccard.violations.some(v => v.check === 'g.repeat'), true);

  // g.phone
  const passPhone = evaluateGlobalChecks({ turns: [{ reply: "Token #12 booked for today." }] }, promptNgrams);
  const failPhone = evaluateGlobalChecks({ turns: [{ reply: "Call doctor at 9820012345 please." }] }, promptNgrams);
  assert.strictEqual(passPhone.violations.some(v => v.check === 'g.phone'), false);
  assert.strictEqual(failPhone.violations.some(v => v.check === 'g.phone'), true);

  // g.leak
  const passLeak = evaluateGlobalChecks({ turns: [{ reply: "Welcome to Al Ramzan clinic." }] }, promptNgrams);
  const failLeak = evaluateGlobalChecks({ turns: [{ reply: "you are the whatsapp receptionist for al ramzan shifakhana" }] }, promptNgrams);
  assert.strictEqual(passLeak.violations.some(v => v.check === 'g.leak'), false);
  assert.strictEqual(failLeak.violations.some(v => v.check === 'g.leak'), true);

  // g.slot
  const passSlot = evaluateGlobalChecks({ turns: [{ reply: "What is your name?" }] }, promptNgrams);
  const failSlotQ = evaluateGlobalChecks({ turns: [{ reply: "Do you want morning or afternoon?" }] }, promptNgrams);
  assert.strictEqual(passSlot.violations.some(v => v.check === 'g.slot'), false);
  assert.strictEqual(failSlotQ.violations.some(v => v.check === 'g.slot'), true);

  // g.settings
  const passSettings = evaluateGlobalChecks({ turns: [{ reply: "ok" }], settingsBeforeHash: "abc", settingsAfterHash: "abc" }, promptNgrams);
  const failSettings = evaluateGlobalChecks({ turns: [{ reply: "ok" }], settingsBeforeHash: "abc", settingsAfterHash: "xyz" }, promptNgrams);
  assert.strictEqual(passSettings.violations.some(v => v.check === 'g.settings'), false);
  assert.strictEqual(failSettings.violations.some(v => v.check === 'g.settings'), true);

  // Reply Assertions: nameReq, redirect, maxSent, num, numOnly, q, has112, noConf
  assert.strictEqual(nameReq("Please send your name."), true);
  assert.strictEqual(nameReq("Date: 18th Oct\nName: Zaid\nToken: #1\nTime: 11:00 AM"), false);

  assert.strictEqual(redirect("Please ask the clinic directly."), true);
  assert.strictEqual(redirect("Your token is booked."), false);

  assert.strictEqual(countSentences("Hello. How are you?"), 2);
  assert.strictEqual(countSentences("Hello world"), 1);

  assert.strictEqual(hasQ("Kya haal hai?"), true);
  assert.strictEqual(hasQ("Theek hoon."), false);

  assert.strictEqual(has112("Call 112 immediately."), true);
  assert.strictEqual(has112("Call 911 immediately."), false);

  assert.strictEqual(isConfirmation("Date: 18th Oct 2026\nName: Ali\nToken: #1\nTime: 11:00 AM"), true);
  assert.strictEqual(isConfirmation("Hello patient!"), false);

  console.log("✅ 1b. ALL GLOBAL CHECKS AND ASSERTIONS ACCURATELY CLASSIFY PASS/FAIL.\n");

  // ─────────────────────────────────────────────────────────────────────────────
  // 1c. HELD-OUT CHECK
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- 1c. Held-Out Check ---");
  const casesTxtPath = path.join(__dirname, 'cases.txt');
  const caseLines = fs.readFileSync(casesTxtPath, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('--'));

  const sysPrompt = fs.readFileSync(path.resolve(__dirname, '../../src/ai-bot/prompts/patient-system.md'), 'utf8');
  const scenTest = fs.readFileSync(path.resolve(__dirname, '../../tests/patient-scenarios.js'), 'utf8');
  const interpTest = fs.readFileSync(path.resolve(__dirname, '../../tests/interpreter.test.js'), 'utf8');

  let nameOverlaps = [];
  let turnOverlaps = [];

  for (const line of caseLines) {
    const parts = line.split('|').map(s => s.trim());
    const id = parts[0];
    let turnsRaw = parts[1];
    if (turnsRaw.startsWith("PARALLEL-SAMEPHONE ")) {
      turnsRaw = turnsRaw.replace("PARALLEL-SAMEPHONE ", "").split(" (")[0].trim();
    } else if (turnsRaw.startsWith("PARALLEL ")) {
      turnsRaw = turnsRaw.replace("PARALLEL ", "").trim();
    }
    const turns = JSON.parse(turnsRaw);
    const flatTurns = Array.isArray(turns[0]) ? turns.flat() : turns;

    // Check case names
    const mutMatch = (parts[2] || '').match(/mut=([^;]+)/);
    if (mutMatch && mutMatch[1] !== '-') {
      const cName = mutMatch[1];
      if (sysPrompt.includes(cName) || scenTest.includes(cName) || interpTest.includes(cName)) {
        nameOverlaps.push({ id, name: cName });
      }
    }

    // Check case turns
    for (const t of flatTurns) {
      if (sysPrompt.includes(t) || scenTest.includes(t) || interpTest.includes(t)) {
        turnOverlaps.push({ id, turn: t });
      }
    }
  }

  console.log(`Held-Out Case Names Overlap: ${nameOverlaps.length} (0 expected)`);
  assert.strictEqual(nameOverlaps.length, 0, "No case name may appear verbatim in dev prompts or tests");

  console.log(`Held-Out Case Turns Overlap: ${turnOverlaps.length} generic turn matches found:`);
  const uniqueTurns = Array.from(new Set(turnOverlaps.map(o => o.turn)));
  console.log(`  Generic phrases: ${uniqueTurns.map(t => JSON.stringify(t)).join(', ')}`);
  console.log("  (Documented under Section 10: DISPUTED EXPECTATIONS per rule E2.)\n");

  // ─────────────────────────────────────────────────────────────────────────────
  // 1d. STUB RUN
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- 1d. Stub Handler Run (No Model Calls) ---");
  buildAllTemplates();

  // Run all cases against stub handler
  const casesJsonPath = path.join(__dirname, 'cases.json');
  const allCases = JSON.parse(fs.readFileSync(casesJsonPath, 'utf8'));

  const stubResultsDir = path.join(__dirname, 'results', 'stub_validation');
  if (!fs.existsSync(stubResultsDir)) {
    fs.mkdirSync(stubResultsDir, { recursive: true });
  }
  const stubRawPath = path.join(stubResultsDir, 'raw.jsonl');
  const stubStream = fs.createWriteStream(stubRawPath, { flags: 'w' });

  for (const c of allCases) {
    const res = await runChildCase(c, 1, 'stub');
    stubStream.write(JSON.stringify(res) + '\n');
  }
  stubStream.end();

  await new Promise(r => setTimeout(r, 200));

  const stubReport = generateReport(stubResultsDir);
  console.log(`Stub Overall Score: ${stubReport.overallScore.toFixed(2)}% (must be <= 25%)`);
  console.log(`Stub Verdict: ${stubReport.verdict} (must be NOT SAFE TO LAUNCH)`);
  console.log("Stub Gate Violations:");
  for (const [g, count] of Object.entries(stubReport.summary.gateViolationsCount)) {
    console.log(`  ${g}: ${count} violations`);
  }

  const gatesFired = Object.values(stubReport.summary.gateViolationsCount).some(c => c > 0);
  assert(gatesFired, "At least one hard gate must fire on stub");
  assert(stubReport.overallScore <= 25.0, `Stub score ${stubReport.overallScore} must be <= 25`);
  assert.strictEqual(stubReport.verdict, 'NOT SAFE TO LAUNCH', "Stub must fail hard gates and receive NOT SAFE TO LAUNCH");

  console.log("\n✅ STAGE 1 VALIDATION COMPLETE: Instrument is fully verified, calibrated, and operational.\n");
}

if (require.main === module) {
  runStage1Validation().catch(err => {
    console.error("Instrument validation failed:", err);
    process.exit(1);
  });
}

module.exports = { runStage1Validation };
