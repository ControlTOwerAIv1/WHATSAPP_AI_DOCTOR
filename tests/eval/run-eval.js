/**
 * Independent Evaluation Harness — Parent Runner
 * Concurrently manages child processes and records all raw outputs to raw.jsonl
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { buildAllTemplates } = require('./fixtures');

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    handler: 'agent',
    runs: 3,
    concurrency: 4,
    casesPath: path.join(__dirname, 'cases.json'),
    outputDir: null
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--handler' && args[i + 1]) {
      options.handler = args[++i];
    } else if (args[i] === '--runs' && args[i + 1]) {
      options.runs = parseInt(args[++i], 10);
    } else if (args[i] === '--concurrency' && args[i + 1]) {
      options.concurrency = parseInt(args[++i], 10);
    } else if (args[i] === '--cases' && args[i + 1]) {
      options.casesPath = path.resolve(args[++i]);
    } else if (args[i] === '--output' && args[i + 1]) {
      options.outputDir = path.resolve(args[++i]);
    }
  }

  return options;
}

function formatDateTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const y = now.getFullYear();
  const m = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  return `${y}${m}${d}_${hh}${mm}${ss}`;
}

async function runChildCase(caseDef, runIndex, handler) {
  return new Promise((resolve, reject) => {
    const childPath = path.join(__dirname, 'run-case.js');
    const child = spawn(process.execPath, [childPath, JSON.stringify(caseDef), String(runIndex), handler], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, NODE_ENV: 'test' }
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      // Find the JSON line in stdout
      const lines = stdout.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith('{') && line.endsWith('}')) {
          try {
            const parsed = JSON.parse(line);
            return resolve(parsed);
          } catch (e) {}
        }
      }

      // If no valid JSON line found
      resolve({
        caseId: caseDef.id,
        run: runIndex,
        family: caseDef.family,
        category: caseDef.category,
        baseId: caseDef.baseId,
        variant: caseDef.variant,
        handler,
        error: `Child exited with code ${code}. Stderr: ${stderr.slice(0, 300)}`,
        turns: [{ error: `Child exited with code ${code}` }],
        allTokens: [],
        allAudit: [],
        tokensTableExists: true
      });
    });

    child.on('error', (err) => {
      resolve({
        caseId: caseDef.id,
        run: runIndex,
        family: caseDef.family,
        category: caseDef.category,
        baseId: caseDef.baseId,
        variant: caseDef.variant,
        handler,
        error: err.message,
        turns: [{ error: err.message }],
        allTokens: [],
        allAudit: [],
        tokensTableExists: true
      });
    });
  });
}

async function main() {
  const options = parseArgs();

  // Ensure fixture template DBs exist
  buildAllTemplates();

  // Prepare output directory
  const ts = formatDateTimestamp();
  const resultsDir = options.outputDir || path.join(__dirname, 'results', ts);
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const rawJsonlPath = path.join(resultsDir, 'raw.jsonl');
  const rawStream = fs.createWriteStream(rawJsonlPath, { flags: 'a' });

  // Load cases
  const allCases = JSON.parse(fs.readFileSync(options.casesPath, 'utf8'));

  // Build task list: cases x runs
  const tasks = [];
  for (let r = 1; r <= options.runs; r++) {
    for (const c of allCases) {
      tasks.push({ caseDef: c, runIndex: r });
    }
  }

  const totalTasks = tasks.length;
  console.log(`=== STARTING EVALUATION RUN ===`);
  console.log(`Handler: ${options.handler}`);
  console.log(`Mode: ${options.runs === 1 ? 'QUICK (1 run)' : `FULL (${options.runs} runs)`}`);
  console.log(`Total Cases: ${allCases.length} | Total Runs: ${totalTasks}`);
  console.log(`Concurrency: ${options.concurrency}`);
  console.log(`Output: ${rawJsonlPath}`);

  const startTime = Date.now();
  let completed = 0;
  let activeCount = 0;
  let taskIdx = 0;

  await new Promise((resolve) => {
    function launchNext() {
      if (completed === totalTasks) {
        return resolve();
      }

      while (activeCount < options.concurrency && taskIdx < totalTasks) {
        const { caseDef, runIndex } = tasks[taskIdx++];
        activeCount++;

        runChildCase(caseDef, runIndex, options.handler).then((result) => {
          rawStream.write(JSON.stringify(result) + '\n');
          activeCount--;
          completed++;

          if (completed % 25 === 0 || completed === totalTasks) {
            const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`[Progress] ${completed}/${totalTasks} (${((completed/totalTasks)*100).toFixed(1)}%) in ${elapsedSec}s`);
          }

          launchNext();
        });
      }
    }

    launchNext();
  });

  rawStream.end();
  const wallSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== EVALUATION COMPLETE ===`);
  console.log(`Finished ${totalTasks} runs in ${wallSec}s`);
  console.log(`Raw data written to: ${rawJsonlPath}`);

  // Return the results directory path
  return { resultsDir, rawJsonlPath };
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal eval runner error:", err);
    process.exit(1);
  });
}

module.exports = { main, runChildCase };
