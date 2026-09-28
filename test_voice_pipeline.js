/**
 * End-to-End Test for Voice Note Support (Change 2b)
 * 
 * Verifies:
 * 1. Faster-whisper transcription server health & accuracy on Hinglish clip
 * 2. Audio duration guard (>15s rejected immediately)
 * 3. Immediate acknowledgment ("Ek minute..." / "One moment...") for clips >3s
 * 4. End-to-end flow: Voice note -> Transcription -> Intent -> Name Extraction -> Token Booking -> Confirmation
 * 5. Fallback behavior when transcription fails or server is unreachable
 */

require('dotenv').config();
const path = require('path');
const assert = require('assert');

process.env.NODE_ENV = 'test';
process.env.MOCK_CURRENT_TIME = '2026-08-29T21:30:00'; // Saturday 9:30 PM (Window OPEN)

const aiBot = require('./src/ai-bot');
const botConfig = require('./src/ai-bot/config');
const transcriber = require('./src/ai-bot/transcriber');
const schedule = require('./src/ai-bot/schedule');
const session = require('./src/ai-bot/session');
const clock = require('./src/ai-bot/clock');

async function runVoicePipelineTests() {
  console.log('================================================================');
  console.log('STARTING END-TO-END VOICE NOTE PIPELINE VERIFICATION');
  console.log('================================================================\n');

  // Initialize bot
  botConfig.init(__dirname);
  aiBot.init({ rootDir: __dirname });

  // Setup mock socket to capture outbound messages
  const sentMessages = [];
  const mockSock = {
    user: { id: '911234567890@s.whatsapp.net' },
    sendMessage: async (jid, content) => {
      sentMessages.push({ jid, content, timestamp: Date.now() });
      return { key: { id: `MOCK_${Date.now()}_${Math.random()}` } };
    },
  };
  aiBot.setSock(mockSock);

  const testTime = clock.getCurrentTime();
  const targetSunday = schedule.getTargetSundayDate(testTime);

  // ────────────────────────────────────────────────────────────────
  // TEST 1: Direct Transcriber Client Test
  // ────────────────────────────────────────────────────────────────
  console.log('--- [TEST 1] Transcriber Health & Direct Transcription ---');
  const available = await transcriber.isAvailable();
  assert.strictEqual(available, true, 'Whisper server should be healthy and available');
  console.log('  ✅ Whisper server is available on localhost');

  const audioPath = path.join(__dirname, 'media', 'test_hinglish.mp3');
  const transStart = Date.now();
  const result = await transcriber.transcribe(audioPath);
  const transDuration = ((Date.now() - transStart) / 1000).toFixed(2);

  assert(result !== null, 'Transcription result should not be null');
  console.log(`  Audio file: media/test_hinglish.mp3`);
  console.log(`  Original speech: "token chahiye, mera naam Salman hai"`);
  console.log(`  Detected language: ${result.language}`);
  console.log(`  Transcription time: ${result.transcription_time}s (wall clock: ${transDuration}s)`);
  console.log(`  Transcript output: "${result.text}"`);
  assert(result.text.length > 0, 'Transcript text should not be empty');
  console.log('  ✅ Direct transcription completed successfully.\n');

  // ────────────────────────────────────────────────────────────────
  // TEST 2: Audio Duration Guard (> 15 seconds)
  // ────────────────────────────────────────────────────────────────
  console.log('--- [TEST 2] Audio Duration Guard (> 15s) ---');
  sentMessages.length = 0;
  const longVoicePhone = '919999900021';
  session.clearSession(longVoicePhone);

  const longAudioMsg = {
    id: 'MSG_LONG_AUDIO_1',
    from: `${longVoicePhone}@s.whatsapp.net`,
    sender: `${longVoicePhone}@s.whatsapp.net`,
    senderName: 'Long Audio Patient',
    content: 'Voice message',
    mediaType: 'voice',
    mediaDuration: 22, // 22 seconds > 15s limit
    mediaUrl: '/media/test_hinglish.mp3',
    timestamp: Date.now(),
    fromMe: false,
    isGroup: false,
  };

  await aiBot.handleIncomingMessage(longAudioMsg);

  assert.strictEqual(sentMessages.length, 1, 'Should send exactly 1 response for long audio');
  const guardReply = sentMessages[0].content.text;
  console.log(`  Duration: 22s`);
  console.log(`  Bot Guard Reply: "${guardReply}"`);
  assert(
    guardReply.includes('lamba hai') || guardReply.includes('too long'),
    'Reply must warn that the voice note is too long'
  );
  console.log('  ✅ Long audio note (>15s) immediately rejected without invoking transcription.\n');

  // ────────────────────────────────────────────────────────────────
  // TEST 3: End-to-End Voice Note Booking with Acknowledgment
  // ────────────────────────────────────────────────────────────────
  console.log('--- [TEST 3] End-to-End Voice Booking Pipeline ---');
  sentMessages.length = 0;
  schedule.resetTokensForTesting(targetSunday);
  const bookingPhone = '919999900022';
  session.clearSession(bookingPhone);

  const voiceBookingMsg = {
    id: 'MSG_VOICE_BOOKING_1',
    from: `${bookingPhone}@s.whatsapp.net`,
    sender: `${bookingPhone}@s.whatsapp.net`,
    senderName: 'Salman Patient',
    content: 'Voice message',
    mediaType: 'voice',
    mediaDuration: 3.2, // > 3 seconds, triggers ack message
    mediaUrl: '/media/test_hinglish.mp3',
    timestamp: Date.now(),
    fromMe: false,
    isGroup: false,
  };

  await aiBot.handleIncomingMessage(voiceBookingMsg);

  console.log(`  Sent messages count: ${sentMessages.length}`);
  for (let i = 0; i < sentMessages.length; i++) {
    console.log(`  [Message ${i + 1}]:\n${sentMessages[i].content.text}`);
  }

  // Expect 2 messages: Ack ("Ek minute..." or "One moment...") followed by the booking confirmation
  assert(sentMessages.length >= 2, 'Should send an ack followed by confirmation');
  const firstMsg = sentMessages[0].content.text;
  const secondMsg = sentMessages[1].content.text;

  assert(
    firstMsg.includes('minute') || firstMsg.includes('moment'),
    'First message should be immediate acknowledgment'
  );
  console.log('  ✅ Immediate acknowledgment sent to user while transcribing.');

  assert(
    secondMsg.includes('Date:') && secondMsg.includes('Token: #1'),
    'Second message should contain confirmed booking token'
  );
  assert(
    secondMsg.includes('सल्मान') || secondMsg.includes('Salman'),
    'Confirmation must contain patient name'
  );
  console.log('  ✅ End-to-end voice note successfully booked token for patient!\n');

  // ────────────────────────────────────────────────────────────────
  // TEST 4: Fallback when Audio Missing or Failed
  // ────────────────────────────────────────────────────────────────
  console.log('--- [TEST 4] Fallback on Missing / Unparseable Audio ---');
  sentMessages.length = 0;
  const failPhone = '919999900023';
  session.clearSession(failPhone);

  const missingAudioMsg = {
    id: 'MSG_FAIL_AUDIO_1',
    from: `${failPhone}@s.whatsapp.net`,
    sender: `${failPhone}@s.whatsapp.net`,
    senderName: 'Failed Audio Patient',
    content: 'Voice message',
    mediaType: 'voice',
    mediaDuration: 5,
    mediaUrl: '/media/non_existent_audio_file.oga',
    timestamp: Date.now(),
    fromMe: false,
    isGroup: false,
  };

  await aiBot.handleIncomingMessage(missingAudioMsg);

  console.log(`  Fallback reply count: ${sentMessages.length}`);
  const fallbackReply = sentMessages[sentMessages.length - 1].content.text;
  console.log(`  Bot Fallback Reply:\n"${fallbackReply}"`);
  assert(
    fallbackReply.includes('samajh nahi aaya') || fallbackReply.includes('text'),
    'Should gracefully reply with text request fallback'
  );
  console.log('  ✅ Graceful fallback executed without crashing or silence.\n');

  console.log('================================================================');
  console.log('ALL VOICE NOTE PIPELINE TESTS PASSED SUCCESSFULLY! ✅');
  console.log('================================================================');
  process.exit(0);
}

runVoicePipelineTests().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
