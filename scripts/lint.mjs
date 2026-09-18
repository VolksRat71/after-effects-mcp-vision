#!/usr/bin/env node
/*
 * Dependency-free checks. Runs in CI, where After Effects does not exist.
 *
 * The important one is the ExtendScript dialect check: cep/host/*.jsx runs on
 * an ES3 engine. const, let, arrow functions, template literals and friends all
 * parse fine in Node and in an editor, then fail at runtime inside AE with an
 * unhelpful message - or, worse, throw where a modal dialog can block the whole
 * session. Catching that here is cheap; catching it in AE is not.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const rel = (f) => f.slice(ROOT.length + 1);

// 1. Every JS file must parse.
for (const f of files.filter((f) => ['.js', '.cjs', '.mjs'].includes(extname(f)))) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    problems.push(`${rel(f)}: does not parse\n    ${String(err.stderr).split('\n')[0]}`);
  }
}

// 2. ExtendScript is ES3. Flag anything newer.
const ES3_BANNED = [
  [/(^|[^.\w])(const|let)\s+[A-Za-z_$]/m, 'const/let (ExtendScript is ES3, use var)'],
  [/=>/, 'arrow function'],
  [/`/, 'template literal'],
  [/\.\.\./, 'spread/rest'],
  [/(^|[^.\w])class\s+[A-Za-z_$]/m, 'class declaration'],
  [/\bJSON\.(parse|stringify)\b/, null], // allowed - we ship a polyfill
];
for (const f of files.filter((f) => extname(f) === '.jsx')) {
  const src = readFileSync(f, 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (/^\s*\*/.test(line) || /^\s*\/\*/.test(line)) return; // block comment body
    for (const [re, label] of ES3_BANNED) {
      if (!label) continue;
      if (re.test(code)) problems.push(`${rel(f)}:${i + 1}: ${label}\n    ${line.trim().slice(0, 90)}`);
    }
  });
}

// Strip comments so prose mentioning require()/#include is not treated as code.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// 3. Every relative require() must resolve.
for (const f of files.filter((f) => ['.js', '.cjs'].includes(extname(f)))) {
  const src = stripComments(readFileSync(f, 'utf8'));
  for (const m of src.matchAll(/require\('(\.[^']+)'\)/g)) {
    const target = resolve(dirname(f), m[1]);
    if (!files.includes(target)) problems.push(`${rel(f)}: require('${m[1]}') does not resolve`);
  }
}

// 4. Every #include in the ExtendScript host must resolve.
for (const f of files.filter((f) => extname(f) === '.jsx')) {
  const src = stripComments(readFileSync(f, 'utf8'));
  for (const m of src.matchAll(/#include\s+"([^"]+)"/g)) {
    const target = resolve(dirname(f), m[1]);
    if (!files.includes(target)) problems.push(`${rel(f)}: #include "${m[1]}" does not resolve`);
  }
}

// 5. Manifest paths must point at files that exist.
const manifestPath = join(ROOT, 'cep/CSXS/manifest.xml');
const manifest = readFileSync(manifestPath, 'utf8');
for (const m of manifest.matchAll(/<(?:MainPath|ScriptPath)>\.\/([^<]+)<\//g)) {
  const target = join(ROOT, 'cep', m[1]);
  if (!files.includes(target)) problems.push(`cep/CSXS/manifest.xml: references missing ./${m[1]}`);
}

// 6. The cep tree must stay CommonJS, or CEP cannot require() anything in it.
const cepPkg = JSON.parse(readFileSync(join(ROOT, 'cep/package.json'), 'utf8'));
if (cepPkg.type !== 'commonjs') {
  problems.push('cep/package.json: "type" must be "commonjs" - the repo root sets "module"');
}

if (problems.length) {
  console.error(`lint: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`lint: clean (${files.filter((f) => ['.js', '.cjs', '.mjs', '.jsx'].includes(extname(f))).length} files checked)`);
