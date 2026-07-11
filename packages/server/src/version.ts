import { readFileSync } from 'node:fs';

interface PackageManifest {
  version?: unknown;
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as PackageManifest;

if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
  throw new Error('The fluxmail package manifest must define a version.');
}

export const VERSION = manifest.version;
