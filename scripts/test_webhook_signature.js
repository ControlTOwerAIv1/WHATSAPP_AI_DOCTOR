require('dotenv').config();
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const appSecret = process.env.WHATSAPP_APP_SECRET;
const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

console.log('App Secret in env:', appSecret ? 'PRESENT (' + appSecret.length + ' chars)' : 'MISSING');
console.log('Verify Token in env:', verifyToken);

function sendRequest(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function runTests() {
  console.log('\n--- TEST 1: GET /webhook handshake (valid token) ---');
  const validGet = await sendRequest({
    hostname: '127.0.0.1',
    port: PORT,
    path: `/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=CHALLENGE_12345`,
    method: 'GET'
  });
  console.log(`Status: ${validGet.statusCode}, Body: ${validGet.body}`);

  console.log('\n--- TEST 2: GET /webhook handshake (wrong token) ---');
  const badGet = await sendRequest({
    hostname: '127.0.0.1',
    port: PORT,
    path: `/webhook?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=CHALLENGE_12345`,
    method: 'GET'
  });
  console.log(`Status: ${badGet.statusCode}, Body: ${badGet.body}`);

  console.log('\n--- TEST 3: POST /webhook with NO signature header ---');
  const testPayload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  const noSigRes = await sendRequest({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/webhook',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(testPayload)
    }
  }, testPayload);
  console.log(`Status: ${noSigRes.statusCode}, Body: ${noSigRes.body}`);

  console.log('\n--- TEST 4: POST /webhook with FORGED/INVALID signature ---');
  const forgedRes = await sendRequest({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/webhook',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(testPayload),
      'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000'
    }
  }, testPayload);
  console.log(`Status: ${forgedRes.statusCode}, Body: ${forgedRes.body}`);

  console.log('\n--- TEST 5: POST /webhook with VALID signature generated using NEW app secret ---');
  const validSig = 'sha256=' + crypto.createHmac('sha256', appSecret).update(Buffer.from(testPayload)).digest('hex');
  const validRes = await sendRequest({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/webhook',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(testPayload),
      'x-hub-signature-256': validSig
    }
  }, testPayload);
  console.log(`Status: ${validRes.statusCode}, Body: ${validRes.body}`);
}

runTests().catch(console.error);
