const path = require('path');

/**
 * Validate and format patient name.
 * @param {string} rawName
 * @returns {{ ok: boolean, name?: string, reason?: string }}
 */
function validatePatientName(rawName) {
  if (!rawName || typeof rawName !== 'string') {
    return { ok: false, reason: 'empty' };
  }

  let name = rawName.trim();
  // Strip trailing punctuation
  name = name.replace(/[.,;:!]+$/, '').trim();
  // Collapse whitespace
  name = name.replace(/\s+/g, ' ');

  if (!name) {
    return { ok: false, reason: 'empty' };
  }

  // Reject digits
  if (/\d/.test(name)) {
    return { ok: false, reason: 'contains_digits' };
  }

  // Reject brackets ( ) [ ]
  if (/[()[\]]/.test(name)) {
    return { ok: false, reason: 'contains_brackets' };
  }

  // Allowed characters: letters of any script (plus combining marks/matras), spaces, and . ' -
  if (!/^[\p{L}\p{M}\s.'\-]+$/u.test(name)) {
    return { ok: false, reason: 'invalid_characters' };
  }

  // Check letter count
  const letters = (name.match(/\p{L}/gu) || []).length;
  if (letters < 2) {
    return { ok: false, reason: 'fewer_than_2_letters' };
  }

  // Check word count
  const words = name.split(' ').filter(Boolean);
  if (words.length > 5) {
    return { ok: false, reason: 'more_than_5_words' };
  }

  // Title-case only words that are entirely lowercase or entirely uppercase Latin; leave other scripts alone
  const transformedWords = words.map(w => {
    if (/^[a-zA-Z.'\-]+$/.test(w)) {
      const isAllLower = w === w.toLowerCase();
      const isAllUpper = w === w.toUpperCase();
      if (isAllLower || isAllUpper) {
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      }
    }
    return w;
  });

  return { ok: true, name: transformedWords.join(' ') };
}

/**
 * Normalise text: lowercase, remove punctuation and emoji, collapse spaces.
 * @param {string} str
 * @returns {string}
 */
function normalizeText(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compute Dice coefficient on character bigrams.
 * @param {string} s1
 * @param {string} s2
 * @returns {number}
 */
function diceCoefficient(s1, s2) {
  if (s1 === s2) return 1.0;
  if (s1.length < 2 || s2.length < 2) return 0.0;

  const b1 = new Map();
  for (let i = 0; i < s1.length - 1; i++) {
    const bg = s1.slice(i, i + 2);
    b1.set(bg, (b1.get(bg) || 0) + 1);
  }

  let intersection = 0;
  for (let i = 0; i < s2.length - 1; i++) {
    const bg = s2.slice(i, i + 2);
    const count = b1.get(bg);
    if (count && count > 0) {
      intersection++;
      b1.set(bg, count - 1);
    }
  }

  const total = (s1.length - 1) + (s2.length - 1);
  return (2 * intersection) / total;
}

/**
 * Check if newText is a repeat of any of the last 3 outbound texts.
 * @param {string} newText
 * @param {Array<string|{content: string}>} lastOutboundTexts
 * @returns {boolean}
 */
function isRepeat(newText, lastOutboundTexts = []) {
  if (!newText || !lastOutboundTexts || lastOutboundTexts.length === 0) {
    return false;
  }

  const normNew = normalizeText(newText);
  if (!normNew) return false;

  // Extract string content from elements if objects
  const rawTexts = lastOutboundTexts.slice(-3).map(item => {
    if (typeof item === 'string') return item;
    if (item && typeof item.content === 'string') return item.content;
    return '';
  });

  for (const raw of rawTexts) {
    const normOld = normalizeText(raw);
    if (!normOld) continue;
    if (normNew === normOld) return true;
    if (diceCoefficient(normNew, normOld) >= 0.9) return true;
  }

  return false;
}

/**
 * Update token name (wraps schedule.correctTokenName).
 */
function correctTokenName(phone, targetDate, newName) {
  const schedule = require('./schedule');
  return schedule.correctTokenName(phone, targetDate, newName);
}

module.exports = {
  validatePatientName,
  normalizeText,
  diceCoefficient,
  isRepeat,
  correctTokenName,
};
