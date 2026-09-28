#!/usr/bin/env node
/**
 * scripts/gen-hash.js
 * Generates a bcrypt password hash for use as ECHO_ADMIN_PASSWORD_HASH.
 *
 * Usage:
 *   node scripts/gen-hash.js
 *   node scripts/gen-hash.js --password MySecret123
 *
 * Output: set ECHO_ADMIN_PASSWORD_HASH=<hash>
 *
 * Copy the hash into your .env file.
 */

'use strict';

const readline = require('readline');

async function main() {
  let password;

  const args = process.argv.slice(2);
  const pwIdx = args.indexOf('--password');
  if (pwIdx !== -1 && args[pwIdx + 1]) {
    password = args[pwIdx + 1];
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    password = await new Promise((resolve) => {
      rl.question('Enter password to hash: ', (ans) => {
        rl.close();
        resolve(ans.trim());
      });
    });
  }

  if (!password || password.length < 8) {
    console.error('Error: password must be at least 8 characters.');
    process.exit(1);
  }

  let bcrypt;
  try {
    bcrypt = require('bcrypt');
  } catch {
    console.error('bcrypt is not installed. Run: npm install bcrypt');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);
  console.log('\n=== Echo Dashboard Password Hash ===');
  console.log('Add this line to your .env:\n');
  console.log(`ECHO_ADMIN_PASSWORD_HASH=${hash}`);
  console.log('');
}

main().catch(e => { console.error(e.message); process.exit(1); });
