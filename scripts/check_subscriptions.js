require('dotenv').config();
const https = require('https');

const token = process.env.WHATSAPP_ACCESS_TOKEN;
const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;

function req(path, method = 'GET') {
  return new Promise((resolve) => {
    const url = new URL(`https://graph.facebook.com/v21.0/${path}`);
    if (method === 'GET') {
      url.searchParams.set('access_token', token);
    }
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Authorization': `Bearer ${token}`
      }
    };
    const r = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch(e) { resolve(d); }
      });
    });
    r.on('error', e => resolve({ error: e.message }));
    r.end();
  });
}

async function run() {
  console.log('--- 1. WABA Subscribed Apps ---');
  const subs = await req(`${wabaId}/subscribed_apps`);
  console.log(JSON.stringify(subs, null, 2));

  console.log('\n--- 2. Phone Number Webhook Info ---');
  const phone = await req(`${phoneId}?fields=verified_name,display_phone_number,webhook_configuration`);
  console.log(JSON.stringify(phone, null, 2));

  // If subscribed_apps is empty or not subscribed, let's see what happens if we subscribe
  if (!subs.data || subs.data.length === 0) {
    console.log('\n--- ⚠️ WABA IS NOT SUBSCRIBED TO THIS APP! Subscribing now... ---');
    const subscribeRes = await req(`${wabaId}/subscribed_apps`, 'POST');
    console.log('Subscribe result:', JSON.stringify(subscribeRes, null, 2));
  }
}

run();
