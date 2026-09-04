/**
 * AI Bot — Interactive Test Tool
 *
 * Usage examples:
 *   # Test with booking window OPEN (Saturday 9:30 PM):
 *   node test_interactive.js --open "token chahiye"
 *   node test_interactive.js --open "My name is Ahmed. I want a morning token."
 *
 *   # Test with booking window CLOSED (Tuesday 3:00 PM):
 *   node test_interactive.js --closed "token chahiye"
 *
 *   # Test with custom date/time:
 *   node test_interactive.js --time "2026-08-30T12:00:00" "Subah ka token milega? Naam Rahul"
 *
 *   # Clear session for a phone:
 *   node test_interactive.js --reset --phone "919876543210"
 */

const patientAgent = require('./src/ai-bot/patient-agent');
const session = require('./src/ai-bot/session');
const schedule = require('./src/ai-bot/schedule');
const clock = require('./src/ai-bot/clock');

async function main() {
  const args = process.argv.slice(2);

  let mockTime = '2026-08-29T21:30:00'; // Default: Window OPEN
  let phone = '919876543210';
  let message = '';
  let shouldReset = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--open') {
      mockTime = '2026-08-29T21:30:00'; // Saturday 9:30 PM
    } else if (args[i] === '--closed') {
      mockTime = '2026-08-25T15:00:00'; // Tuesday 3:00 PM
    } else if (args[i] === '--time' && args[i + 1]) {
      mockTime = args[i + 1];
      i++;
    } else if (args[i] === '--phone' && args[i + 1]) {
      phone = args[i + 1];
      i++;
    } else if (args[i] === '--reset') {
      shouldReset = true;
    } else if (!message) {
      message = args[i];
    }
  }

  // Set environment variables for mock time
  process.env.NODE_ENV = 'test';
  process.env.MOCK_CURRENT_TIME = mockTime;

  if (shouldReset) {
    session.clearSession(phone);
    const sundayDate = schedule.getTargetSundayDate(clock.getCurrentTime());
    schedule.resetTokensForTesting(sundayDate);
    console.log(`🧹 Session and tokens reset for phone: ${phone} on Sunday: ${sundayDate}`);
    if (!message) return;
  }

  if (!message) {
    console.log(`
ℹ️  Interactive Test Usage:
  node test_interactive.js --open "your message"
  node test_interactive.js --closed "your message"
  node test_interactive.js --time "YYYY-MM-DDTHH:mm:ss" "your message"
  node test_interactive.js --reset

Examples:
  node test_interactive.js --open "token chahiye"
  node test_interactive.js --open "My name is John. I need morning token."
  node test_interactive.js --closed "token chahiye"
`);
    return;
  }

  const currentTime = clock.getCurrentTime();
  const windowStatus = schedule.isBookingWindowOpen(currentTime);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🕒 Mocked Current Time : ${currentTime.toString()}`);
  console.log(`🚪 Booking Window      : ${windowStatus.open ? '🟢 OPEN' : '🔴 CLOSED'}`);
  console.log(`📱 Patient Phone       : ${phone}`);
  console.log(`💬 Inbound Message     : "${message}"`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const reply = await patientAgent.handlePatientMessage(phone, message);

  console.log('🤖 Bot Reply:');
  console.log('------------------------------------------------------------');
  console.log(reply);
  console.log('------------------------------------------------------------\n');

  // Check if token was booked
  const sundayDate = schedule.getTargetSundayDate(currentTime);
  const token = schedule.getTokenByPhone(phone, sundayDate);
  if (token) {
    console.log(`🎟️  Durable Token Recorded: #${token.token_number} (${token.slot_name.toUpperCase()}) | Arrival: ${token.arrival_time} | Patient: ${token.patient_name}`);
  }
}

main().catch(err => {
  console.error('Error:', err);
});
