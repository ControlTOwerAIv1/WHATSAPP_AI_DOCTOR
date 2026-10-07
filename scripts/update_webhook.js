require('dotenv').config();
const https = require('https');

const fs = require('fs');
const path = require('path');

const appId = '1744615076840881';
const appSecret = process.env.WHATSAPP_APP_SECRET;
const appToken = `${appId}|${appSecret}`;
const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
const baseTunnelUrl = fs.existsSync(path.join(__dirname, '../cloudflare_url.txt'))
  ? fs.readFileSync(path.join(__dirname, '../cloudflare_url.txt'), 'utf8').trim()
  : 'https://sullivan-letters-stomach-rise.trycloudflare.com';
const tunnelUrl = `${baseTunnelUrl.replace(/\/+$/, '')}/webhook`;

console.log(`Updating Meta App webhook to: ${tunnelUrl}`);

const params = new URLSearchParams({
  object: 'whatsapp_business_account',
  callback_url: tunnelUrl,
  verify_token: verifyToken,
  fields: 'messages,message_template_status_update',
  access_token: appToken
});

const req = https.request({
  hostname: 'graph.facebook.com',
  path: `/v21.0/${appId}/subscriptions`,
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(params.toString())
  }
}, (res) => {
  let d = '';
  res.on('data', chunk => d += chunk);
  res.on('end', () => {
    console.log(`Status: ${res.statusCode}`);
    console.log(`Response: ${d}`);
  });
});

req.on('error', (err) => {
  console.error('Error updating webhook:', err);
});

req.write(params.toString());
req.end();
