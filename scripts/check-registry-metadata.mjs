#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const rootPackage = await readJson('../package.json');
const npmPackage = await readJson('../packages/server/package.json');
const server = await readJson('../server.json');
const registryPackage = server.packages?.find(
  (entry) => entry.registryType === 'npm' && entry.identifier === npmPackage.name,
);

const errors = [];

check(server.name === npmPackage.mcpName, 'server.json name must match packages/server/package.json mcpName');
check(server.version === npmPackage.version, 'server.json version must match the fluxmail package version');
check(rootPackage.version === npmPackage.version, 'root and fluxmail package versions must match');
check(Boolean(registryPackage), 'server.json must include the fluxmail npm package');
check(
  registryPackage?.version === npmPackage.version,
  'server.json npm package version must match the fluxmail package',
);

if (errors.length > 0) {
  for (const error of errors) console.error(`Error: ${error}`);
  process.exit(1);
}

console.log(`${server.name}@${server.version} registry metadata is consistent.`);

function check(condition, message) {
  if (!condition) errors.push(message);
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url)));
}
