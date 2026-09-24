#!/usr/bin/env node
/*
 * Write package.json's version into cep/CSXS/manifest.xml.
 *
 * The manifest is what CEP and every extension manager report as the installed
 * version. Only build-zxp.sh used to stamp it, and only on its own staging
 * copy, so every .dmg and .exe shipped the hardcoded "2.0.0" whatever the
 * release. Keeping the SOURCE manifest in step fixes all three packagers at
 * once. Runs automatically during `npm version` (the "version" lifecycle
 * script), and test/unit/packaging.test.cjs fails the release if they drift.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const file = join(root, 'cep', 'CSXS', 'manifest.xml');

const before = readFileSync(file, 'utf8');
const after = before
  .replace(/(ExtensionBundleVersion=")[^"]+(")/, `$1${version}$2`)
  .replace(/(<Extension Id="[^"]+"\s+Version=")[^"]+(")/g, `$1${version}$2`);

if (after !== before) writeFileSync(file, after);
console.log(`manifest.xml -> ${version}${after === before ? ' (already current)' : ''}`);
