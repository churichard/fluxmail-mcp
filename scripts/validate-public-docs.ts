import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  GENERATED_MARKERS,
  PUBLIC_DOCS_ROOT,
  compatibilityManifest,
  pageFiles,
  parseFrontmatter,
  publicDocPages,
  readPublicDocsMeta,
  readPublicDocsManifest,
} from './public-docs.js';

const meta = readPublicDocsMeta();
const pages = publicDocPages(meta);
const manifest = readPublicDocsManifest();
const expectedManifest = compatibilityManifest(
  meta,
  pages.map((page) => page.slug),
);
if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) {
  throw new Error('Compatibility manifest differs from pages/meta.json. Run pnpm docs:generate.');
}

const RESERVED_MAIL_SLUGS = new Set([
  'what-is-fluxmail',
  'connect-your-gmail',
  'install-fluxmail',
  'home-inbox',
  'priority-and-newsletters',
  'flux-ai',
  'ai-drafting',
  'search',
  'email-actions',
  'tasks-and-reminders',
  'create-a-rule',
  'unified-inbox',
  'shortcuts',
  'insights',
  'privacy-and-security',
]);

for (const slug of meta.pages) {
  if (RESERVED_MAIL_SLUGS.has(slug)) {
    throw new Error(`MCP documentation slug ${slug} collides with an existing Fluxmail documentation page.`);
  }
}

const expectedFiles = pages.map((page) => page.filename).sort();
const actualFiles = pageFiles();
if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error(
    `Metadata and pages directory differ. Expected ${expectedFiles.join(', ')}, found ${actualFiles.join(', ')}.`,
  );
}

const sources = new Map<string, string>();
for (const { slug, filename: relativeFilename } of pages) {
  const filename = path.join(PUBLIC_DOCS_ROOT, 'pages', relativeFilename);
  const source = readFileSync(filename, 'utf8');
  parseFrontmatter(source, `${slug}.md`);
  if (/[—–]/u.test(source)) throw new Error(`${slug}.md contains an em dash or en dash. Rewrite it in plain language.`);
  sources.set(slug, source);
}

for (const [slug, source] of sources) {
  if (/\]\(\/docs\/mcp(?:\/|[)#?])/.test(source)) {
    throw new Error(`${slug}.md contains a nested /docs/mcp link. Use /docs/.`);
  }
  for (const match of source.matchAll(/\]\(\/docs\/([a-z0-9-]+(?:\/[a-z0-9-]+)*)(?:[)#?])/g)) {
    const target = match[1];
    if (target && !pages.some((page) => page.slug === target) && !RESERVED_MAIL_SLUGS.has(target)) {
      throw new Error(`${slug}.md links to unknown documentation page /docs/${target}.`);
    }
  }
}

const generatedPages = new Map<string, string[]>([
  ['tools.md', [GENERATED_MARKERS[0]]],
  ['cli.md', [GENERATED_MARKERS[1]]],
  ['configuration.md', [GENERATED_MARKERS[2]]],
  ['permissions.md', [GENERATED_MARKERS[3], GENERATED_MARKERS[4]]],
  ['rest-api/index.md', [GENERATED_MARKERS[5]]],
]);
for (const [filename, markers] of generatedPages) {
  const source = readFileSync(path.join(PUBLIC_DOCS_ROOT, 'pages', filename), 'utf8');
  for (const marker of markers) {
    if (
      !source.includes(`<!-- BEGIN GENERATED:${marker} -->`) ||
      !source.includes(`<!-- END GENERATED:${marker} -->`)
    ) {
      throw new Error(`${filename} is missing the ${marker} generated section.`);
    }
  }
}

const readmeDocLinks = new Map<string, (slug: string) => string>([
  ['README.md', (slug) => `docs/public/pages/${slug}.md`],
  ['packages/server/README.md', (slug) => `https://fluxmail.ai/docs/${slug}`],
]);
for (const [readme, docLink] of readmeDocLinks) {
  if (!existsSync(readme)) continue;
  const source = readFileSync(readme, 'utf8');
  for (const required of ['quickstart', 'tools', 'permissions', 'configuration', 'cli']) {
    const link = docLink(required);
    if (!source.includes(link)) throw new Error(`${readme} must link to ${link}.`);
  }
  if (readme === 'packages/server/README.md' && source.includes('../../docs/public/')) {
    throw new Error(`${readme} must use published documentation URLs because repository files are not shipped to npm.`);
  }
  if (/https:\/\/fluxmail\.ai\/docs\/mcp(?:\/|[)#?])/.test(source)) {
    throw new Error(`${readme} contains a nested published documentation URL. Use /docs/.`);
  }
}

console.log(`Validated ${pages.length} public documentation pages in Fumadocs order.`);
