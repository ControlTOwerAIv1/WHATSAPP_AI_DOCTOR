const store = require('../src/ai-bot/store');
const db = store.getDb();
if (db) {
  try {
    const res = db.prepare("DELETE FROM appointments_tokens WHERE sunday_date = '2026-10-11'").run();
    console.log(`Deleted ${res.changes} tokens from SQLite appointments_tokens for 2026-10-11.`);
  } catch (e) {
    console.log('Error deleting from SQLite:', e.message);
  }
}
