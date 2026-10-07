const { execSync } = require('child_process');

console.log('Stopping cloudflared...');
try {
  execSync('taskkill /F /IM cloudflared.exe', { stdio: 'ignore' });
} catch (e) {}

console.log('Stopping node processes on port 3000...');
try {
  const netstat = execSync('netstat -ano | findstr :3000', { encoding: 'utf8' });
  const lines = netstat.split('\n');
  const pids = new Set();
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 5 && parts[1].includes(':3000')) {
      const pid = parts[parts.length - 1];
      if (pid && pid !== '0') pids.add(pid);
    }
  }
  for (const pid of pids) {
    try {
      execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
      console.log(`Killed PID ${pid}`);
    } catch (e) {}
  }
} catch (e) {}

console.log('Stopped.');
