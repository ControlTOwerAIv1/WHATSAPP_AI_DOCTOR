/**
 * Independent Evaluation Harness — Case Builder
 * Deterministically parses cases.txt and generates mutated cases (Set A & Set B)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function mulberry32(a) {
  return function() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function shuffle(array, rng) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const TYPO_WORDS = ["token", "tokens", "chahiye", "chaiye", "appointment", "please", "need", "book", "number", "milega"];

function applyMutation(op, text, mut, rng) {
  const isProtected = mut && mut !== "-";
  const protectedStr = isProtected ? mut : "";
  
  if (op === "M1") {
    return text.toUpperCase();
  }
  if (op === "M2") {
    return text.toLowerCase();
  }
  if (op === "M3") {
    return text + " 🙏";
  }
  if (op === "M4") {
    const choices = ["hi, ", "bhai ", "sir ", "please "];
    const pick = choices[Math.floor(rng() * choices.length)];
    return pick + text;
  }
  if (op === "M5") {
    const choices = [" pls", " plz", " asap", "!!"];
    const pick = choices[Math.floor(rng() * choices.length)];
    return text + pick;
  }
  if (op === "M6") {
    if (!protectedStr) {
      return text.replace(/ /g, "  ") + "...";
    }
    const idx = text.indexOf(protectedStr);
    if (idx === -1) {
      return text.replace(/ /g, "  ") + "...";
    }
    const before = text.slice(0, idx).replace(/ /g, "  ");
    const middle = protectedStr;
    const after = text.slice(idx + protectedStr.length).replace(/ /g, "  ");
    return before + middle + after + "...";
  }
  if (op === "M7") {
    let before = "";
    let middle = "";
    let after = "";
    if (protectedStr) {
      const idx = text.indexOf(protectedStr);
      if (idx !== -1) {
        before = text.slice(0, idx);
        middle = protectedStr;
        after = text.slice(idx + protectedStr.length);
      } else {
        before = text;
      }
    } else {
      before = text;
    }
    
    function tryTypo(str) {
      const regex = new RegExp("\\b(" + TYPO_WORDS.join("|") + ")\\b", "i");
      const match = str.match(regex);
      if (!match) return null;
      const word = match[0];
      const len = word.length;
      const pos1 = Math.floor(len / 2) - 1;
      const pos2 = Math.floor(len / 2);
      const swapped = word.slice(0, pos1) + word[pos2] + word[pos1] + word.slice(pos2 + 1);
      return str.replace(regex, swapped);
    }

    const beforeTypo = tryTypo(before);
    if (beforeTypo !== null) {
      return beforeTypo + middle + after;
    }
    const afterTypo = tryTypo(after);
    if (afterTypo !== null) {
      return before + middle + afterTypo;
    }
    return null;
  }
  return null;
}

function parseCaseLine(line) {
  const parts = line.split("|").map(s => s.trim());
  const id = parts[0];
  let rawTurns = parts[1];
  let isParallel = false;
  let isParallelSamePhone = false;

  if (rawTurns.startsWith("PARALLEL-SAMEPHONE ")) {
    isParallelSamePhone = true;
    rawTurns = rawTurns.replace("PARALLEL-SAMEPHONE ", "").split(" (")[0].trim();
  } else if (rawTurns.startsWith("PARALLEL ")) {
    isParallel = true;
    rawTurns = rawTurns.replace("PARALLEL ", "").trim();
  }

  const turns = JSON.parse(rawTurns);
  const rawOpts = parts[2] || "";
  const opts = {};

  const pairs = rawOpts.split(";").map(s => s.trim()).filter(Boolean);
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx !== -1) {
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      opts[k] = v;
    } else {
      if (pair.startsWith("each phone tok=")) {
        opts["each_phone_tok"] = parseInt(pair.replace("each phone tok=", ""), 10);
      } else {
        opts[pair] = true;
      }
    }
  }

  // Family is prefix before last '-' (e.g. U1-03 -> U1)
  const lastDash = id.lastIndexOf("-");
  const family = lastDash !== -1 ? id.slice(0, lastDash) : id;
  const category = id[0];

  return {
    id,
    baseId: id,
    variant: 'base',
    family,
    category,
    turns,
    isParallel,
    isParallelSamePhone,
    opts,
    inf: Boolean(opts.inf)
  };
}

function buildCaseSet(casesTxtPath, seed) {
  const lines = fs.readFileSync(casesTxtPath, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('--'));

  const rng = mulberry32(seed);
  const allCases = [];

  for (const line of lines) {
    const baseCase = parseCaseLine(line);
    allCases.push(baseCase);

    const opts = baseCase.opts;
    if (opts.mut !== undefined) {
      const mut = opts.mut;
      const mt = opts.mt ? parseInt(opts.mt, 10) : 1;
      const textToMut = baseCase.turns[mt - 1];

      const ops = shuffle(["M1", "M2", "M3", "M4", "M5", "M6", "M7"], rng);
      const applied = [];
      for (const op of ops) {
        const mutatedText = applyMutation(op, textToMut, mut, rng);
        if (mutatedText !== null) {
          applied.push({ op, text: mutatedText });
          if (applied.length === 4) break;
        }
      }

      applied.forEach((item, idx) => {
        const mutatedTurns = [...baseCase.turns];
        mutatedTurns[mt - 1] = item.text;
        allCases.push({
          id: `${baseCase.id}.m${idx + 1}`,
          baseId: baseCase.id,
          variant: `m${idx + 1}`,
          mutationOp: item.op,
          family: baseCase.family,
          category: baseCase.category,
          turns: mutatedTurns,
          isParallel: baseCase.isParallel,
          isParallelSamePhone: baseCase.isParallelSamePhone,
          opts: { ...baseCase.opts },
          inf: baseCase.inf
        });
      });
    }
  }

  return allCases;
}

function main() {
  const casesTxtPath = path.join(__dirname, 'cases.txt');
  const setAPath = path.join(__dirname, 'cases.json');
  const setBPath = path.join(__dirname, 'cases.setB.json');

  const setA = buildCaseSet(casesTxtPath, 20261018);
  fs.writeFileSync(setAPath, JSON.stringify(setA, null, 2), 'utf8');
  const hashA = crypto.createHash('sha256').update(fs.readFileSync(setAPath)).digest('hex');

  const setB = buildCaseSet(casesTxtPath, 20261101);
  fs.writeFileSync(setBPath, JSON.stringify(setB, null, 2), 'utf8');
  const hashB = crypto.createHash('sha256').update(fs.readFileSync(setBPath)).digest('hex');

  console.log(`Set A: ${setA.length} cases (Seed: 20261018) -> SHA256: ${hashA}`);
  console.log(`Set B: ${setB.length} cases (Seed: 20261101) -> SHA256: ${hashB}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildCaseSet,
  parseCaseLine,
  applyMutation,
  mulberry32,
  shuffle
};
