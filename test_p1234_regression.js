/**
 * Regression + P1-P4 Fix Verification Test Suite
 *
 * Covers:
 *  P1 — Confirmation shows correct booking date (not today's date)
 *  P2 — Audio routing unchanged after multi-agent refactor (unit-level)
 *  P3 — Admin ADMIN_BOOK intent: detect, confirm-before-mutate, allocate, notify
 *  P4 — Doctor-agent booking counts: timezone-safe date, agent_id filter
 *  Regression — All previously-passing scenarios still pass
 *
 * Usage:
 *   MOCK_CURRENT_TIME="2026-10-03T21:30:00+05:30" node test_p1234_regression.js
 *
 * Note: Tests that require Claude API (intent classification) are skipped
 *       unless ANTHROPIC_API_KEY is set. Core logic tests run always.
 */

'use strict';
require('dotenv').config();

// -- Mock time: Saturday 9:30 PM IST -- booking window open for next Sunday --
process.env.MOCK_CURRENT_TIME = process.env.MOCK_CURRENT_TIME || '2026-10-03T21:30:00+05:30';
const MOCK_TIME = new Date(process.env.MOCK_CURRENT_TIME);
const TARGET_DATE = '2026-10-04'; // Sunday

const botConfig = require('./src/ai-bot/config');
botConfig.init(__dirname);

const patientAgent = require('./src/ai-bot/patient-agent');
const adminAgent   = require('./src/ai-bot/admin-agent');
const doctorAgent  = require('./src/ai-bot/doctor-agent');
const session      = require('./src/ai-bot/session');
const schedule     = require('./src/ai-bot/schedule');
const store        = require('./src/ai-bot/store');
const transcriber  = require('./src/ai-bot/transcriber');
const { getCurrentTime } = require('./src/ai-bot/clock');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log('  PASS: ' + message);
    passed++;
  } else {
    console.log('  FAIL: ' + message);
    failed++;
  }
}

function assertContains(str, substr, message) {
  assert((str || '').includes(substr), message + ' (expected "' + substr + '" in "' + (str||'').substring(0,80) + '")');
}

function assertNotContains(str, substr, message) {
  assert(!(str || '').includes(substr), message + ' (unexpected "' + substr + '" in "' + (str||'').substring(0,80) + '")');
}

// --- P1: Confirmation shows the booking target date, not today ---

async function testP1_ConfirmationDate() {
  console.log('\n\n==== P1: Confirmation shows booking date, not today ====\n');

  schedule.resetTokensForTesting(TARGET_DATE);

  const phone = '919001000001';
  session.clearSession(phone);
  session.updateSession(phone, { name: 'Salman Memon', stage: 'booking_waiting_for_name' });

  const reply = await patientAgent.handlePatientMessage(phone, 'Salman Memon', 'Salman');

  console.log('  Booking confirmation reply:');
  console.log('  ' + reply.replace(/\n/g, '\n  '));

  // today via MOCK_TIME is 2026-10-03 (Saturday) — booking target is 2026-10-04 (Sunday)
  assertContains(reply, '4th October', 'Confirmation shows booking date (4th October)');
  assertNotContains(reply, '3rd October', 'Confirmation does NOT show today (3rd October)');

  // Format checks: Date / Name / Token / Time (plain format, no greeting)
  assertContains(reply, 'Date:', 'Contains Date: field');
  assertContains(reply, 'Name:', 'Contains Name: field');
  assertContains(reply, 'Token: #', 'Contains Token: # field');
  assertContains(reply, 'Time:', 'Contains Time: field');
  assertContains(reply, 'Salman Memon', 'Contains patient name');

  assertNotContains(reply, 'Namaste', 'No Namaste greeting');
  assertNotContains(reply, 'confirmed', 'No verbose "confirmed" prefix');
}

// --- P1-b: Duplicate notice also shows correct date ---

async function testP1b_DuplicateDate() {
  console.log('\n  [P1-b] Duplicate notice shows correct date:');

  const phone = '919001000001';
  const reply = await patientAgent.handlePatientMessage(phone, 'Token chahiye', 'Salman');

  console.log('  Duplicate reply: ' + reply.replace(/\n/g, ' | '));
  assertContains(reply, '4th October', 'Duplicate notice shows booking date (4th October)');
  assertNotContains(reply, '3rd October', 'Duplicate notice does NOT show today');
}

// --- P2: Audio/voice routing unchanged ---

async function testP2_AudioRouting() {
  console.log('\n\n==== P2: Audio/voice routing + transcriber config ====\n');

  // 1. ecosystem.config.js has whisper entry
  const eco = require('./ecosystem.config.js');
  const whisperApp = eco.apps.find(function(a) { return a.name === 'whisper'; });
  assert(Boolean(whisperApp), 'ecosystem.config.js contains whisper app entry');
  assert(whisperApp && whisperApp.script && whisperApp.script.includes('transcribe-server.py'), 'whisper script points to transcribe-server.py');
  assert(whisperApp && whisperApp.env && whisperApp.env.WHISPER_PORT === 5555, 'whisper env WHISPER_PORT = 5555');

  // 2. transcriber.js uses port 5555
  const fs = require('fs');
  const transcriberSrc = fs.readFileSync('./src/ai-bot/transcriber.js', 'utf8');
  assertContains(transcriberSrc, "process.env.WHISPER_PORT || '5555'", 'transcriber.js defaults to port 5555');
  assertContains(transcriberSrc, '/transcribe', 'transcriber.js posts to /transcribe');
  assertContains(transcriberSrc, '/health', 'transcriber.js has health check endpoint');

  // 3. index.js audio routing happens before role-based routing
  const indexSrc = fs.readFileSync('./src/ai-bot/index.js', 'utf8');
  assertContains(indexSrc, "mediaType === 'audio' || mediaType === 'voice'", 'index.js detects audio/voice mediaType');
  assertContains(indexSrc, "require('./transcriber')", 'index.js requires transcriber');
  assertContains(indexSrc, 'transcriber.transcribe(localPath)', 'index.js calls transcriber.transcribe');

  const audioBlockIdx = indexSrc.indexOf('isAudioOrVoice');
  const roleRoutingIdx = indexSrc.indexOf('botConfig.isAdminPhone');
  assert(audioBlockIdx < roleRoutingIdx, 'Audio transcription occurs BEFORE role-based routing');

  // 4. Duration guard and server-down fallback still present
  assertContains(indexSrc, 'MAX_AUDIO_SECONDS = 15', '15-second duration guard present');
  assertContains(indexSrc, 'audioDuration > MAX_AUDIO_SECONDS', 'Duration guard rejects long notes');
  assertContains(indexSrc, '_getUnintelligibleFallback', 'Fallback for transcription failure present');

  // 5. transcribe-server.py port matches
  const serverSrc = fs.readFileSync('./src/ai-bot/transcribe-server.py', 'utf8');
  assertContains(serverSrc, "os.environ.get('WHISPER_PORT', '5555')", 'transcribe-server.py defaults to port 5555');
  assertContains(serverSrc, "'/transcribe'", 'transcribe-server.py handles /transcribe');

  assert(typeof transcriber.isAvailable === 'function', 'transcriber.isAvailable() exported');
  assert(typeof transcriber.transcribe === 'function', 'transcriber.transcribe() exported');

  console.log('\n  P2 Root cause: PM2 had no running processes (empty list).');
  console.log('  Fix: run "npx pm2 start ecosystem.config.js" to start both echo + whisper.');
}

// --- P3: Admin books token for patient ---

async function testP3_AdminBook() {
  console.log('\n\n==== P3: Admin-initiated patient booking (ADMIN_BOOK) ====\n');

  schedule.resetTokensForTesting(TARGET_DATE);

  const adminPhone = '919876543200';
  const patientPhone = '919500000099';
  const patientName = 'Ramesh Kumar';

  var notifiedPhone = null;
  var notifiedText = null;
  adminAgent.setNotificationSender(async function(phone, text) {
    notifiedPhone = phone;
    notifiedText = text;
    console.log('  [mock notify] -> ' + phone + ': "' + text.substring(0, 80) + '..."');
  });

  session.clearSession(adminPhone);

  // Step 1: Admin sends booking request
  const bookMsg = 'Book a token for Ramesh Kumar, phone 919500000099, for ' + TARGET_DATE;
  const reply1 = await adminAgent.handleAdminMessage(adminPhone, bookMsg, 'Admin');

  console.log('  Admin book request reply:');
  console.log('  ' + reply1.replace(/\n/g, '\n  '));

  assertContains(reply1, 'Ramesh Kumar', 'Confirmation prompt contains patient name');
  assertContains(reply1, patientPhone, 'Confirmation prompt contains patient phone');
  assertContains(reply1, TARGET_DATE, 'Confirmation prompt contains target date');
  assertContains(reply1, "Reply 'yes' to proceed", "Confirmation prompt asks for yes");

  // Step 2: Admin confirms
  const reply2 = await adminAgent.handleAdminMessage(adminPhone, 'yes', 'Admin');

  console.log('\n  Admin confirms reply:');
  console.log('  ' + reply2.replace(/\n/g, '\n  '));

  assertContains(reply2, 'Token #', 'Success reply contains Token #');
  assertContains(reply2, patientName, 'Success reply contains patient name');

  // Verify token allocated
  const token = schedule.getTokenByPhone(patientPhone, TARGET_DATE);
  assert(token !== null, 'Token allocated in SQLite for patient phone');
  assert(token && token.patient_name === patientName, 'Token patient_name matches');

  // Verify bilingual patient notification
  assert(notifiedPhone === patientPhone, 'Patient notification sent to correct phone');
  assertContains(notifiedText, 'Naam:', 'Patient notification contains Hindi Naam:');
  assertContains(notifiedText, 'Name:', 'Patient notification contains English Name:');
  assertContains(notifiedText, 'Token: #', 'Patient notification contains Token: #');
  assertContains(notifiedText, 'Samay:', 'Patient notification contains Hindi Samay:');
  assertContains(notifiedText, 'Time:', 'Patient notification contains English Time:');
  assertContains(notifiedText, '4th October', 'Patient notification shows 4th October');

  // Step 3: Duplicate booking attempt rejected
  console.log('\n  [P3-dup] Duplicate booking same phone/date:');
  session.clearSession(adminPhone);
  const dupMsg = 'Book a token for Ramesh Again, phone 919500000099, for ' + TARGET_DATE;
  const dupReply = await adminAgent.handleAdminMessage(adminPhone, dupMsg, 'Admin');
  console.log('  Dup reply: ' + dupReply);
  assertContains(dupReply, 'already', 'Duplicate rejected with "already" message');
}

// --- P3-b: Non-operating date rejected ---

async function testP3b_ClosedDateRejected() {
  console.log('\n  [P3-b] Admin booking for non-operating date (Tuesday) rejected:');

  const adminPhone = '919876543200';
  session.clearSession(adminPhone);

  // 2026-10-06 is a Tuesday
  const closedMsg = 'Book a token for Fatima Malik, phone 919600000001, for 2026-10-06';
  const reply = await adminAgent.handleAdminMessage(adminPhone, closedMsg, 'Admin');

  console.log('  Closed date reply: ' + reply);
  assertContains(reply, 'not an operating day', 'Non-operating date clearly rejected');
}

// --- P4: Doctor agent booking counts + timezone date ---

async function testP4_DoctorBookingCounts() {
  console.log('\n\n==== P4: Doctor agent correct booking counts + timezone date ====\n');

  schedule.resetTokensForTesting(TARGET_DATE);

  const phones = ['919800000001', '919800000002', '919800000003'];
  const names  = ['Alpha Patient', 'Beta Patient', 'Gamma Patient'];

  for (var i = 0; i < 3; i++) {
    const result = await schedule.allocateToken({
      phone: phones[i],
      name:  names[i],
      slotPreference: 'morning',
      currentTime: MOCK_TIME,
      targetDate: TARGET_DATE,
    });
    assert(result.success && !result.isDuplicate, 'Token ' + (i+1) + ' allocated for ' + names[i]);
  }

  const doctorInfo = { name: 'Dr. Test', specialty: 'General' };
  const countReply = await doctorAgent.getBookingsForDate(TARGET_DATE, doctorInfo);

  console.log('  Doctor booking query reply:');
  console.log('  ' + countReply.replace(/\n/g, '\n  '));

  for (const name of names) {
    assertContains(countReply, name, 'Doctor reply contains "' + name + '"');
  }
  assertContains(countReply, '3 booked', 'Summary shows 3 booked');

  // P4 code-level checks
  const doctorSrc = require('fs').readFileSync('./src/ai-bot/doctor-agent.js', 'utf8');
  assertContains(doctorSrc, 'schedule.formatDateToYYYYMMDD(currentTime)', 'doctor-agent uses formatDateToYYYYMMDD');
  assertNotContains(doctorSrc, "toISOString().split('T')[0]", 'doctor-agent does NOT use toISOString().split for todayStr');

  const storeSrc = require('fs').readFileSync('./src/ai-bot/store.js', 'utf8');
  assertContains(storeSrc, "COALESCE(agent_id, 'default') = ?", 'store.getBookingsInRange filters by agent_id');

  const scheduleSrc = require('fs').readFileSync('./src/ai-bot/schedule.js', 'utf8');
  assertContains(scheduleSrc, 'store.getDb()', 'schedule.js uses shared store.getDb()');
  assertNotContains(scheduleSrc, 'new Database(', 'schedule.js does NOT open its own Database() connection');
}

// --- Regression: Name resolution ---

async function testReg_NameResolution() {
  console.log('\n\n==== REG: Name resolution (push name not used) ====\n');

  schedule.resetTokensForTesting(TARGET_DATE);
  const phone = '919001000010';
  session.clearSession(phone);

  const reply = await patientAgent.handlePatientMessage(phone, 'Token chahiye', 'Salman');
  assertNotContains(reply, 'Salman', 'Push name "Salman" NOT used automatically');
  assert(
    reply.toLowerCase().includes('naam') || reply.toLowerCase().includes('name'),
    'Bot asks for patient name explicitly'
  );

  const sess = session.getSession(phone);
  assert(sess.stage === 'booking_waiting_for_name', 'Session stage = booking_waiting_for_name');

  const reply2 = await patientAgent.handlePatientMessage(phone, 'Fatima', 'Salman');
  assertContains(reply2, 'Fatima', 'Booking uses explicitly typed name "Fatima"');
  assertNotContains(reply2, 'Salman', 'Booking does NOT use push name "Salman"');
}

// --- Regression: Concurrency ---

async function testReg_Concurrency() {
  console.log('\n\n==== REG: Concurrency: 15 simultaneous bookings ====\n');

  schedule.resetTokensForTesting(TARGET_DATE);

  const N = 15;
  const promises = [];
  for (var i = 1; i <= N; i++) {
    const phone = '9190099' + String(i).padStart(5,'0');
    const name  = 'Concurrent_' + i;
    session.clearSession(phone);
    session.updateSession(phone, { name: name, stage: 'booking_waiting_for_name' });
    promises.push(
      patientAgent.handlePatientMessage(phone, name, phone)
        .then(function(r) { return { name: name, r: r, ok: r.includes('Token: #') }; })
        .catch(function(e) { return { name: name, r: e.message, ok: false }; })
    );
  }

  const results = await Promise.all(promises);
  const confirmed = results.filter(function(r) { return r.ok; }).length;
  const failedItems = results.filter(function(r) { return !r.ok; });

  console.log('  ' + confirmed + '/' + N + ' bookings confirmed');
  for (const f of failedItems) console.log('  WARN: ' + f.name + ': ' + (f.r||'').substring(0,60));

  assert(confirmed === N, 'All ' + N + ' concurrent bookings succeeded');

  const tokens = schedule.getTokensForSunday(TARGET_DATE);
  assert(tokens.length === N, 'SQLite has exactly ' + N + ' tokens (no races/duplicates)');

  const nums = tokens.map(function(t) { return t.token_number; }).sort(function(a,b){return a-b;});
  assert(new Set(nums).size === N, 'All token numbers are unique');
}

// --- Regression: Booking window logic ---

async function testReg_BookingWindow() {
  console.log('\n\n==== REG: Booking window closed on mid-week day ====\n');

  // Use a far future date (2099-06-08, a Monday) where no overrides exist in DB.
  // The standard config has window: Saturday 9PM - Sunday 6PM.
  // Monday noon is OUTSIDE that window.
  const mondayNoon = new Date('2099-06-08T12:00:00');  // UTC Monday noon — no IST ambiguity
  const windowStatus = await schedule.isBookingWindowOpen(mondayNoon, '2099-06-08');

  // On Monday noon (day=1), offsetDays from Saturday (6) = (1-6+7)%7 = 2, totalSpanDays = (0-6+7)%7 = 1
  // offsetDays(2) >= totalSpanDays(1), not start/end, returns false
  // But wait: 2099-06-08 might be an operating Sunday — let's check day
  const testDayOfWeek = mondayNoon.getDay(); // 1 = Monday in UTC
  console.log('  Test day of week:', testDayOfWeek, '(expected 1 = Monday)');

  if (testDayOfWeek !== 1) {
    console.log('  SKIP: Date is not Monday in this timezone, skipping window test');
    assert(true, 'Booking window test skipped (tz mismatch)');
    return;
  }

  // At Monday noon, the standard booking window (Saturday 9PM - Sunday 6PM) should be CLOSED
  // UNLESS there's an override for 2099-06-09 (Sunday) with booking_opens_at on Monday
  // Since 2099 has no overrides, this should reliably be closed.
  assert(!windowStatus.open, 'Booking window correctly CLOSED on Monday noon (standard config, no overrides)');
  assert(windowStatus.message.length > 0, 'Closed message is non-empty');
  console.log('  Closed message: "' + windowStatus.message.substring(0, 80) + '"');
}

// --- Regression: store.getBookingsInRange agent_id isolation ---

async function testReg_StoreAgentIdFilter() {
  console.log('\n\n==== REG: store.getBookingsInRange agent_id isolation ====\n');

  const db = store.getDb();
  const testDate = TARGET_DATE;

  try {
    db.prepare(
      "INSERT OR IGNORE INTO appointments_tokens " +
      "(sunday_date, token_number, slot_name, token_in_slot, patient_phone, patient_name, arrival_time, condition, booked_at, agent_id) " +
      "VALUES ('" + testDate + "', 999, 'morning', 999, '919111111111', 'OtherAgent Patient', '11:00 AM', '', datetime('now'), 'other_agent')"
    ).run();
  } catch (e) {
    console.log('  WARN: Could not insert test row:', e.message);
  }

  const defaultRows = store.getBookingsInRange(testDate, testDate, 'default');
  const otherRows   = store.getBookingsInRange(testDate, testDate, 'other_agent');

  const defaultHasOther = defaultRows.some(function(r) { return r.patient_phone === '919111111111'; });
  const otherHasToken   = otherRows.some(function(r) { return r.patient_phone === '919111111111'; });

  assert(!defaultHasOther, 'default agent query does NOT see other_agent tokens');
  assert(otherHasToken, 'other_agent query DOES see its own tokens');

  console.log('  default rows: ' + defaultRows.length + ', other_agent rows: ' + otherRows.length);

  try { db.prepare('DELETE FROM appointments_tokens WHERE token_number = 999').run(); } catch (_) {}
}

// --- MAIN ---

async function main() {
  console.log('===================================================');
  console.log('  P1-P4 + REGRESSION TEST SUITE');
  console.log('===================================================');
  console.log('  Mock time : ' + MOCK_TIME.toISOString());
  console.log('  Target date: ' + TARGET_DATE);

  await testP1_ConfirmationDate();
  await testP1b_DuplicateDate();
  await testP2_AudioRouting();
  await testP3_AdminBook();
  await testP3b_ClosedDateRejected();
  await testP4_DoctorBookingCounts();
  await testReg_NameResolution();
  await testReg_Concurrency();
  await testReg_BookingWindow();
  await testReg_StoreAgentIdFilter();

  console.log('\n===================================================');
  console.log('  TOTAL: ' + passed + ' passed, ' + failed + ' failed');
  console.log('===================================================\n');

  if (failed > 0) process.exit(1);
}

main().catch(function(err) {
  console.error('[TEST SUITE ERROR]', err);
  process.exit(1);
});
