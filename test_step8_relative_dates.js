/**
 * STEP 8: Relative Date Resolution in parseAdminCommand() Test
 *
 * Tests resolving against a known MOCK_CURRENT_TIME (Wednesday 2026-08-26 12:00:00):
 * 1. "today" -> 2026-08-26
 * 2. "tomorrow" -> 2026-08-27
 * 3. "this Sunday" -> 2026-08-30
 * 4. "next Wednesday" -> 2026-09-02
 * 5. "this weekend" -> 2026-08-30
 */

require('dotenv').config();
const assert = require('assert');
const botConfig = require('./src/ai-bot/config');
const claude = require('./src/ai-bot/claude');
const sheets = require('./src/ai-bot/sheets');
const adminAgent = require('./src/ai-bot/admin-agent');
const session = require('./src/ai-bot/session');

async function testStep8RelativeDates() {
  console.log('================================================================');
  console.log('STEP 8: RELATIVE DATE RESOLUTION VERIFICATION TEST');
  console.log('================================================================\n');

  botConfig.init(process.cwd());

  const ADMIN_PHONE = '919876543000';
  const MOCK_TIME = '2026-08-26T12:00:00'; // Wednesday
  process.env.NODE_ENV = 'test';
  process.env.MOCK_CURRENT_TIME = MOCK_TIME;

  console.log(`Clock Anchor: Wednesday ${MOCK_TIME}`);
  console.log('Reference Calendar:');
  console.log('  Today:          Wednesday 2026-08-26');
  console.log('  Tomorrow:       Thursday  2026-08-27');
  console.log('  This Sunday:    Sunday    2026-08-30');
  console.log('  Next Wednesday: Wednesday 2026-09-02');
  console.log('  This Weekend:   Sunday    2026-08-30\n');

  const testCases = [
    {
      phrase: 'today',
      command: 'close the clinic today',
      expectedDate: '2026-08-26',
    },
    {
      phrase: 'tomorrow',
      command: 'open tomorrow with 25 tokens',
      expectedDate: '2026-08-27',
    },
    {
      phrase: 'this Sunday',
      command: 'close the clinic this Sunday',
      expectedDate: '2026-08-30',
    },
    {
      phrase: 'next Wednesday',
      command: "we're open next Wednesday with 30 tokens",
      expectedDate: '2026-09-02',
    },
    {
      phrase: 'this weekend',
      command: 'close the clinic this weekend',
      expectedDate: '2026-08-30',
    },
  ];

  const currentSettings = await sheets.getSettingsFromSheet();

  for (const tc of testCases) {
    console.log(`--- Testing relative phrase: "${tc.phrase}" ---`);
    console.log(`Command input: "${tc.command}"`);

    // 1. Test direct parseAdminCommand
    const parsed = await claude.parseAdminCommand(tc.command, currentSettings, MOCK_TIME);
    assert(parsed, `parseAdminCommand must return parsed object for: "${tc.command}"`);
    assert.strictEqual(parsed.target_tab, 'Overrides', 'Must target Overrides tab');

    const resolvedDate = parsed.override_data?.target_date;
    console.log(`  Parsed target_date: ${resolvedDate} (Expected: ${tc.expectedDate})`);
    assert.strictEqual(resolvedDate, tc.expectedDate, `Relative date "${tc.phrase}" must resolve to ${tc.expectedDate}`);

    // 2. Test full confirmation prompt through adminAgent.handleAdminMessage
    session.clearSession(ADMIN_PHONE);
    const reply = await adminAgent.handleAdminMessage(ADMIN_PHONE, tc.command, 'Doctor Admin');
    console.log(`  Admin Agent Confirmation Message:\n  "${reply.trim().replace(/\n/g, ' ')}"`);

    // Verify session pending state stored the exact resolved ISO date for Overrides tab
    const pending = session.getAdminPending(ADMIN_PHONE);
    assert(pending, 'Session must hold pending confirmation');
    assert.strictEqual(pending.data.target_date, tc.expectedDate, `Pending data target_date must match ${tc.expectedDate}`);

    // Verify confirmation message references the date or phrase
    const [y, m, d] = tc.expectedDate.split('-');
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const monthName = monthNames[parseInt(m, 10) - 1];
    const dayNum = parseInt(d, 10);
    const hasIso = reply.includes(tc.expectedDate);
    const hasSpoken = reply.includes(`${monthName} ${dayNum}`) || reply.includes(`${dayNum} ${monthName}`);
    const hasPhrase = reply.toLowerCase().includes(tc.phrase.toLowerCase());
    assert(hasIso || hasSpoken || hasPhrase, `Confirmation message must reference date: ${tc.expectedDate} / ${monthName} ${dayNum}`);

    console.log(`✅ Phrase "${tc.phrase}" successfully resolved to ${tc.expectedDate}\n`);
  }

  console.log('================================================================');
  console.log('✅ STEP 8 ALL 5 RELATIVE DATES VERIFIED ACCURATELY RESOLVED!');
  console.log('================================================================\n');
}

testStep8RelativeDates().catch(err => {
  console.error('\n❌ STEP 8 TEST FAILED:', err);
  process.exit(1);
});
