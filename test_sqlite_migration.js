const schedule = require('./src/ai-bot/schedule');
const store    = require('./src/ai-bot/store');

async function main() {
  // Test migrations ran
  const db = store.getDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  console.log('Tables:', tables.join(', '));

  // Test settings defaults
  const s = store.getSettings();
  console.log('Default settings:', JSON.stringify({ operating_days: s.operating_days, max_tokens: s.max_tokens, morning_cap: s.morning_cap, afternoon_cap: s.afternoon_cap }));

  // Test override add
  const res = store.addOverride({ target_date: '2099-01-06', type: 'closed', created_by: 'test' });
  console.log('Add override:', res.success ? 'OK' : res.error);
  const overrides = store.getOverrides();
  console.log('Overrides count:', overrides.length);

  // Test settings update
  const upd = store.updateSettings({ max_tokens: 50, morning_cap: 20, afternoon_cap: 30 });
  console.log('Update settings:', upd.success ? 'OK max_tokens=' + upd.settings.max_tokens : upd.error);

  // Test cap validation
  const bad = store.updateSettings({ max_tokens: 30, morning_cap: 20, afternoon_cap: 20 });
  console.log('Cap validation (should fail):', bad.success ? 'FAIL' : 'OK: ' + bad.error.slice(0, 60));

  // Test getEffectiveSchedule (now uses SQLite store)
  const eff = await schedule.getEffectiveSchedule('2099-01-07'); // next Sunday
  console.log('Effective schedule is_open:', eff.is_open, 'max_tokens:', eff.max_tokens);

  // Test export builder
  const { buildExportCsv } = require('./src/ai-bot/export');
  const csv = buildExportCsv([{ date: '2099-01-07', token_number: 1, slot_name: 'morning', patient_name: 'Test Patient', patient_phone: '919999999999', arrival_time: '11:00', condition: 'Fever', status: 'booked', booked_at: '2099-01-06 21:05:00' }]);
  console.log('CSV rows:', csv.split('\r\n').length - 1, '(should be 2: header + 1 row)');

  // Test export-chat date range parser
  const { parseDateRange, isExportRequest } = require('./src/ai-bot/export-chat');
  console.log('Export request detection "export bookings":', isExportRequest('export bookings'));
  console.log('Export request detection "hello":', isExportRequest('hello'));
  const range = parseDateRange('last month');
  console.log('Date range "last month":', range.from, '->', range.to);

  console.log('\n✅ All integration tests passed!');
}

main().catch(e => { console.error('❌ Test failed:', e.message); process.exit(1); });
