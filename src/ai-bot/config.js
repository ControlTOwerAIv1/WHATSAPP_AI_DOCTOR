/**
 * AI Bot — Configuration & Doctor Recognition
 *
 * Loads environment variables, doctors registry, and provides helpers
 * for identifying whether a phone number belongs to a registered doctor.
 */

const fs = require('fs');
const path = require('path');

let _doctors = [];
let _doctorPhoneSet = new Set();
let _config = {};

/**
 * Initialize the configuration module.
 * @param {string} rootDir - Project root directory
 */
function init(rootDir) {
  // Load doctors registry
  const doctorsPath = path.join(rootDir, 'doctors.json');
  try {
    if (fs.existsSync(doctorsPath)) {
      const data = JSON.parse(fs.readFileSync(doctorsPath, 'utf8'));
      _doctors = data.doctors || [];
      _doctorPhoneSet = new Set(_doctors.map(d => normalizePhone(d.phone)));
      console.log(`[AI-Bot] Loaded ${_doctors.length} doctor(s) from doctors.json`);
    } else {
      console.warn('[AI-Bot] doctors.json not found — all users treated as patients');
    }
  } catch (e) {
    console.error('[AI-Bot] Failed to load doctors.json:', e.message);
  }

  // Build config from env
  const rawAdmin = process.env.ADMIN_PHONE_NUMBER || '919876543200';
  const adminPhones = rawAdmin.split(',').map(p => normalizePhone(p)).filter(Boolean);

  _config = {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    adminPhoneNumbers: adminPhones,
    adminPhoneNumber: adminPhones[0] || '',
    enabled: (process.env.AI_BOT_ENABLED || 'true').toLowerCase() === 'true',
  };

  if (!_config.anthropicApiKey) {
    console.warn('[AI-Bot] ANTHROPIC_API_KEY not set — AI bot will not function');
  }
}

/**
 * Normalize a phone number by stripping everything except digits.
 * Baileys JIDs look like "919876543210@s.whatsapp.net" — this extracts
 * just the numeric part.
 */
function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/[^0-9]/g, '');
}

/**
 * Extract the raw phone number from a Baileys JID.
 * "919876543210@s.whatsapp.net" → "919876543210"
 */
function jidToPhone(jid) {
  if (!jid) return '';
  return jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

/**
 * Check if a JID belongs to a registered doctor.
 */
function isDoctorJid(jid) {
  const phone = jidToPhone(jid);
  return _doctorPhoneSet.has(phone);
}

/**
 * Check if a phone number belongs to the admin.
 */
function isAdminPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  const adminList = _config.adminPhoneNumbers || (process.env.ADMIN_PHONE_NUMBER || '919876543200').split(',').map(p => normalizePhone(p)).filter(Boolean);
  return adminList.includes(normalized);
}

/**
 * Get doctor info for a JID, or null if not a doctor.
 */
function getDoctorInfo(jid) {
  const phone = jidToPhone(jid);
  return _doctors.find(d => normalizePhone(d.phone) === phone) || null;
}

function getConfig() {
  return _config;
}

module.exports = {
  init,
  normalizePhone,
  jidToPhone,
  isDoctorJid,
  isAdminPhone,
  getDoctorInfo,
  getConfig,
};
