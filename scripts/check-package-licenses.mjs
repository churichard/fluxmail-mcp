#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const packageDirectories = process.argv.slice(2);

if (packageDirectories.length === 0) {
  fail('No package directories were provided.');
}

const rootLicense = await readFile(new URL('../LICENSE.md', import.meta.url), 'utf8');
const staleLicenses = [];

for (const directory of packageDirectories) {
  try {
    const packageLicense = await readFile(path.join(directory, 'LICENSE.md'), 'utf8');
    if (packageLicense !== rootLicense) {
      staleLicenses.push(directory);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    staleLicenses.push(directory);
  }
}

if (staleLicenses.length > 0) {
  fail(
    `These packages have a missing or outdated LICENSE.md: ${staleLicenses.join(', ')}. ` +
      'Copy the root LICENSE.md into each package before publishing.',
  );
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}
