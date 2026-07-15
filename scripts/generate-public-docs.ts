import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCliProgram } from '../packages/server/src/cli.js';
import { CONFIG_REFERENCE } from '../packages/server/src/config.js';
import { buildMcpServer } from '../packages/server/src/mcp/buildServer.js';
import { createRestApi } from '../packages/server/src/http/rest.js';
import {
  MCP_CAPABILITIES,
  MCP_CAPABILITY_DESCRIPTIONS,
  NAMED_PERMISSION_PROFILES,
  PERMISSION_PROFILE_DESCRIPTIONS,
  customPermissionPolicy,
  permissionPolicyForProfile,
} from '../packages/server/src/permissions.js';
import { generateRestApiReference } from './openapi-docs.js';
import {
  generateCliReference,
  generateMcpReference,
  type GeneratedReference,
  type ToolReference,
} from './reference-docs.js';
import {
  PUBLIC_DOCS_ROOT,
  compatibilityManifest,
  parseFrontmatter,
  publicDocPages,
  readPublicDocsMeta,
  replaceGeneratedSection,
} from './public-docs.js';

async function listTools(permissions?: ReturnType<typeof customPermissionPolicy>): Promise<ToolReference[]> {
  const server = buildMcpServer({ enforceQuota: () => undefined } as never, permissions ? { permissions } : undefined);
  const client = new Client({ name: 'fluxmail-docs', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools as ToolReference[];
  } finally {
    await client.close();
    await server.close();
  }
}

function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

async function toolRequirements(): Promise<{ tools: ToolReference[]; requirements: Map<string, string[][]> }> {
  const tools = (await listTools()).sort((a, b) => a.name.localeCompare(b.name));
  const requirements = new Map<string, string[][]>();
  for (let size = 1; size <= MCP_CAPABILITIES.length; size += 1) {
    for (const capabilities of capabilityCombinations(size)) {
      for (const tool of await listTools(customPermissionPolicy(capabilities))) {
        const known = requirements.get(tool.name) ?? [];
        if (!known.some((requirement) => requirement.every((capability) => capabilities.includes(capability)))) {
          requirements.set(tool.name, [...known, capabilities]);
        }
      }
    }
  }
  return { tools, requirements };
}

function capabilityCombinations(size: number): string[][] {
  const combinations: string[][] = [];
  function visit(start: number, selected: string[]): void {
    if (selected.length === size) {
      combinations.push(selected);
      return;
    }
    for (let index = start; index < MCP_CAPABILITIES.length; index += 1) {
      const capability = MCP_CAPABILITIES[index];
      if (capability) visit(index + 1, [...selected, capability]);
    }
  }
  visit(0, []);
  return combinations;
}

function configurationSection(): string {
  const rows = Object.entries(CONFIG_REFERENCE)
    .filter(([, entry]) => !('documented' in entry) || entry.documented !== false)
    .map(
      ([name, entry]) =>
        `| \`${name}\` | \`${markdownCell(entry.defaultValue)}\` | ${markdownCell(entry.description)} |`,
    );
  return ['| Environment variable | Default | Purpose |', '| --- | --- | --- |', ...rows].join('\n');
}

function permissionProfilesSection(): string {
  const rows = NAMED_PERMISSION_PROFILES.map((profile) => {
    const capabilities = permissionPolicyForProfile(profile)
      .capabilities.map((item) => `\`${item}\``)
      .join(', ');
    return `| \`${profile}\` | ${PERMISSION_PROFILE_DESCRIPTIONS[profile]} | ${capabilities} |`;
  });
  return ['| Profile | What it allows | Capabilities |', '| --- | --- | --- |', ...rows].join('\n');
}

function permissionCapabilitiesSection(): string {
  const rows = MCP_CAPABILITIES.map(
    (capability) => `| \`${capability}\` | ${MCP_CAPABILITY_DESCRIPTIONS[capability]} |`,
  );
  return ['| Capability | Actions |', '| --- | --- |', ...rows].join('\n');
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const stale: string[] = [];
  const references: Array<{ directory: string; marker: string; reference: GeneratedReference }> = [];

  const restDirectory = path.join(PUBLIC_DOCS_ROOT, 'pages', 'rest-api');
  const restIndex = path.join(restDirectory, 'index.md');
  const restIndexSource = readFileSync(restIndex, 'utf8');
  const updated = parseFrontmatter(restIndexSource, 'rest-api/index.md').updated;
  const restApp = createRestApi({} as never);
  const openApiResponse = await restApp.request('/api/v1/openapi.json');
  if (!openApiResponse.ok) throw new Error(`Could not generate the OpenAPI document: HTTP ${openApiResponse.status}.`);
  const restReference = generateRestApiReference((await openApiResponse.json()) as never, updated);
  references.push({ directory: 'rest-api', marker: 'rest-api-endpoints', reference: restReference });

  const toolsIndex = path.join(PUBLIC_DOCS_ROOT, 'pages', 'tools', 'index.md');
  const toolsIndexSource = readFileSync(toolsIndex, 'utf8');
  const toolsUpdated = parseFrontmatter(toolsIndexSource, 'tools/index.md').updated;
  const { tools, requirements } = await toolRequirements();
  references.push({
    directory: 'tools',
    marker: 'mcp-tool-reference',
    reference: generateMcpReference(tools, requirements, toolsUpdated),
  });

  const cliIndex = path.join(PUBLIC_DOCS_ROOT, 'pages', 'cli', 'index.md');
  const cliIndexSource = readFileSync(cliIndex, 'utf8');
  const cliUpdated = parseFrontmatter(cliIndexSource, 'cli/index.md').updated;
  references.push({
    directory: 'cli',
    marker: 'cli-command-reference',
    reference: generateCliReference(createCliProgram(), cliUpdated),
  });

  for (const { directory, marker, reference } of references) {
    const referenceDirectory = path.join(PUBLIC_DOCS_ROOT, 'pages', directory);
    const indexFile = path.join(referenceDirectory, 'index.md');
    const indexSource = readFileSync(indexFile, 'utf8');
    const nextIndex = replaceGeneratedSection(indexSource, marker, reference.indexSection);
    if (nextIndex !== indexSource) {
      if (check) stale.push(`${directory}/index.md`);
      else writeFileSync(indexFile, nextIndex);
    }

    if (!check) mkdirSync(referenceDirectory, { recursive: true });
    const expectedFiles = new Map<string, string>([['meta.json', reference.meta], ...reference.pages]);
    for (const [filename, content] of expectedFiles) {
      const file = path.join(referenceDirectory, filename);
      const current = readFileIfPresent(file);
      if (current === content) continue;
      if (check) stale.push(`${directory}/${filename}`);
      else writeFileSync(file, content);
    }
    for (const filename of readdirSync(referenceDirectory)) {
      if (filename === 'index.md' || expectedFiles.has(filename) || !filename.endsWith('.md')) continue;
      if (check) stale.push(`${directory}/${filename}`);
      else unlinkSync(path.join(referenceDirectory, filename));
    }
  }

  const manifestFile = path.join(PUBLIC_DOCS_ROOT, 'manifest.json');
  const currentManifest = readFileSync(manifestFile, 'utf8');
  const meta = readPublicDocsMeta();
  const nextManifest = `${JSON.stringify(
    compatibilityManifest(
      meta,
      publicDocPages(meta).map((page) => page.slug),
    ),
    null,
    2,
  )}\n`;
  const generated = new Map<string, Map<string, string>>([
    ['configuration.md', new Map([['configuration', configurationSection()]])],
    [
      'permissions.md',
      new Map([
        ['permission-profiles', permissionProfilesSection()],
        ['permission-capabilities', permissionCapabilitiesSection()],
      ]),
    ],
  ]);
  if (nextManifest !== currentManifest) {
    if (check) stale.push('manifest.json');
    else writeFileSync(manifestFile, nextManifest);
  }
  for (const [filename, sections] of generated) {
    const file = path.join(PUBLIC_DOCS_ROOT, 'pages', filename);
    const current = readFileSync(file, 'utf8');
    let next = current;
    for (const [marker, content] of sections) next = replaceGeneratedSection(next, marker, content);
    if (next === current) continue;
    if (check) stale.push(filename);
    else writeFileSync(file, next);
  }
  if (stale.length) throw new Error(`Generated documentation is stale: ${stale.join(', ')}. Run pnpm docs:generate.`);
}

function readFileIfPresent(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

await main();
