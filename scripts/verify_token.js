require('dotenv').config();
const https = require('https');

const token = process.env.WHATSAPP_ACCESS_TOKEN;
const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;

console.log('Testing debug_token API...');
const url = `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`;

https.get(url, (res) => {
  let raw = '';
  res.on('data', chunk => raw += chunk);
  res.on('end', () => {
    try {
      const data = JSON.parse(raw);
      console.log('=== DEBUG_TOKEN RESPONSE ===');
      console.log(JSON.stringify(data, null, 2));

      if (data.data) {
        console.log('\n--- TOKEN INSPECTION ---');
        console.log('App ID:', data.data.app_id);
        console.log('Type:', data.data.type);
        console.log('Application:', data.data.application);
        console.log('Is Valid:', data.data.is_valid);
        console.log('Expires At:', data.data.expires_at, data.data.expires_at === 0 ? '(Permanent! ✅)' : '(Temporary / Expiring ❌)');
        console.log('Scopes/Granular Scopes:', JSON.stringify(data.data.granular_scopes || data.data.scopes));
      }
    } catch (err) {
      console.error('Failed to parse response:', raw);
    }

    // Also test fetching Phone Number ID info
    console.log('\nTesting Phone Number ID info...');
    const phoneUrl = `https://graph.facebook.com/v21.0/${phoneId}?access_token=${encodeURIComponent(token)}`;
    https.get(phoneUrl, (phoneRes) => {
      let pRaw = '';
      phoneRes.on('data', c => pRaw += c);
      phoneRes.on('end', () => {
        try {
          const pData = JSON.parse(pRaw);
          console.log('=== PHONE NUMBER DETAILS ===');
          console.log(JSON.stringify(pData, null, 2));
        } catch (e) {
          console.log('Phone details raw:', pRaw);
        }
      });
    });
  });
}).on('error', (err) => {
  console.error('Request failed:', err);
});
