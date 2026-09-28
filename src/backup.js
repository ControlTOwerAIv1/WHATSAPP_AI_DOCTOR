/**
 * SQLite Nightly Backup Job
 *
 * Uses better-sqlite3's .backup() method (online backup API — safe while DB is being written).
 * Keeps 14 dated files in backups/.
 * If AWS credentials are configured, also uploads to S3.
 *
 * Usage:  require('./src/backup').start();
 *
 * S3 env vars (all optional — skipped if not set):
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_BACKUP_BUCKET
 */

'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');

const DB_PATH      = path.join(process.cwd(), 'relay.sqlite');
const BACKUP_DIR   = path.join(process.cwd(), 'backups');
const KEEP_DAYS    = 14;
const CRON_HOUR    = 2; // 2 AM local time

/**
 * Run one backup right now. Returns the path to the created file.
 * @returns {Promise<string>} backup file path
 */
async function runBackup() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dest  = path.join(BACKUP_DIR, `relay_${stamp}.sqlite`);

  // --- online backup (safe with WAL, no raw file copy) ---
  const source = new Database(DB_PATH, { readonly: true });
  await source.backup(dest);
  source.close();

  const sizeKB = Math.round(fs.statSync(dest).size / 1024);
  console.log(`[Backup] Created ${dest} (${sizeKB} KB)`);

  // --- prune old backups ---
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

  let pruned = 0;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    const m = f.match(/^relay_(\d{4}-\d{2}-\d{2})\.sqlite$/);
    if (m && m[1] < cutoffStr) {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
      pruned++;
    }
  }
  if (pruned > 0) console.log(`[Backup] Pruned ${pruned} old backup(s)`);

  // --- optional S3 upload ---
  if (
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY &&
    process.env.AWS_BACKUP_BUCKET
  ) {
    await _uploadToS3(dest, `relay_${stamp}.sqlite`);
  }

  return dest;
}

async function _uploadToS3(localPath, key) {
  try {
    // Require lazily so the app starts even if the aws-sdk is not installed
    // (it's an optional dev dependency — install with: npm install @aws-sdk/client-s3)
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const client = new S3Client({
      region: process.env.AWS_REGION || 'ap-south-1',
      credentials: {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    const body = fs.createReadStream(localPath);
    await client.send(new PutObjectCommand({
      Bucket: process.env.AWS_BACKUP_BUCKET,
      Key:    `backups/${key}`,
      Body:   body,
      ContentType: 'application/x-sqlite3',
    }));

    console.log(`[Backup] Uploaded s3://${process.env.AWS_BACKUP_BUCKET}/backups/${key}`);
  } catch (err) {
    console.error('[Backup] S3 upload failed (non-fatal):', err.message);
  }
}

/**
 * Schedule the nightly backup cron (fires at CRON_HOUR each day).
 */
function start() {
  // Fire first backup after 1 minute so we don't block startup
  setTimeout(() => {
    runBackup().catch(err => console.error('[Backup] Startup backup failed:', err.message));
  }, 60 * 1000);

  // Then every 24 hours
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  // Calculate ms until next CRON_HOUR
  const now    = new Date();
  let   target = new Date(now);
  target.setHours(CRON_HOUR, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  const delay = target.getTime() - now.getTime();

  setTimeout(() => {
    runBackup().catch(err => console.error('[Backup] Nightly backup failed:', err.message));
    setInterval(() => {
      runBackup().catch(err => console.error('[Backup] Backup failed:', err.message));
    }, MS_PER_DAY).unref();
  }, delay).unref();

  console.log(`[Backup] Scheduled nightly at ${CRON_HOUR}:00. Next in ${Math.round(delay / 60000)} min.`);
}

module.exports = { start, runBackup };
