require('dotenv').config();
const https = require('https');

const token = process.env.WHATSAPP_ACCESS_TOKEN;
const appSecret = process.env.WHATSAPP_APP_SECRET;
const appId = '1744615076840881';
const appToken = `${appId}|${appSecret}`;

function get(path, auth) {
  return new Promise((resolve) => {
    https.get(`https://graph.facebook.com/v21.0/${path}?access_token=${auth}`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch(e) { resolve(d); }
      });
    }).on('error', e => resolve({ error: e.message }));
  });
}

async function check() {
  console.log('--- App Subscriptions with App Access Token ---');
  const subs = await get(`${appId}/subscriptions`, appToken);
  console.log(JSON.stringify(subs, null, 2));
}

check();
