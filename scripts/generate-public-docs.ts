import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Command } from 'commander';
import { createCliProgram } from '../packages/server/src/cli.js';
import { CONFIG_REFERENCE } from '../packages/server/src/config.js';
import { buildMcpServer } from '../packages/server/src/mcp/buildServer.js';
import {
  MCP_CAPABILITIES,
  MCP_CAPABILITY_DESCRIPTIONS,
  NAMED_PERMISSION_PROFILES,
  PERMISSION_PROFILE_DESCRIPTIONS,
  customPermissionPolicy,
  permissionPolicyForProfile,
} from '../packages/server/src/permissions.js';
import { PUBLIC_DOCS_ROOT, compatibilityManifest, readPublicDocsMeta, replaceGeneratedSection } from './public-docs.js';

interface ToolReference {
  name: string;
  description?: string;
  inputSchema: { properties?: Record<string, unknown>; required?: string[] };
}

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

function inputSummary(tool: ToolReference): string {
  const required = new Set(tool.inputSchema.required ?? []);
  const names = Object.keys(tool.inputSchema.properties ?? {});
  if (!names.length) return 'None';
  return names
    .map((name) => `\`${name}\`${required.has(name) ? '' : '?'} `)
    .join('')
    .trim();
}

async function toolsSection(): Promise<string> {
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
  const rows = tools.map((tool) => {
    const visibility = (requirements.get(tool.name) ?? [])
      .map((requirement) => requirement.map((item) => `\`${item}\``).join(' + '))
      .join(' or ');
    return `| \`${tool.name}\` | ${markdownCell(tool.description ?? '')} | ${inputSummary(tool)} | ${visibility} |`;
  });
  const schemas = tools.flatMap((tool) => [
    `<details><summary><code>${tool.name}</code> input schema</summary>`,
    '',
    '```json',
    JSON.stringify(tool.inputSchema, null, 2),
    '```',
    '',
    '</details>',
    '',
  ]);
  return [
    `Fluxmail exposes ${tools.length} tools. Optional inputs have a \`?\` suffix. A plus sign means the connection needs both capabilities.`,
    '',
    '| Tool | Description | Inputs | Capabilities |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    '### Input schemas',
    '',
    ...schemas,
  ].join('\n');
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

function commandPath(command: Command): string {
  const parts: string[] = [];
  let current: Command | null = command;
  while (current) {
    if (current.name()) parts.unshift(current.name());
    current = current.parent;
  }
  const args = command.registeredArguments.map((argument) => {
    const suffix = argument.variadic ? '...' : '';
    return argument.required ? `<${argument.name()}${suffix}>` : `[${argument.name()}${suffix}]`;
  });
  return [...parts, ...args].join(' ');
}

function allCommands(root: Command): Command[] {
  return root.commands.flatMap((command) => [command, ...allCommands(command)]);
}

function cliSection(): string {
  const commands = allCommands(createCliProgram());
  const rows = commands.map((command) => {
    const options = command.options.map((option) => `\`${option.flags}\``).join(', ') || 'None';
    return `| \`${commandPath(command)}\` | ${markdownCell(command.description())} | ${options} |`;
  });
  return ['| Command | Description | Options |', '| --- | --- | --- |', ...rows].join('\n');
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
  const manifestFile = path.join(PUBLIC_DOCS_ROOT, 'manifest.json');
  const currentManifest = readFileSync(manifestFile, 'utf8');
  const nextManifest = `${JSON.stringify(compatibilityManifest(readPublicDocsMeta()), null, 2)}\n`;
  const generated = new Map<string, Map<string, string>>([
    ['tools.md', new Map([['tools', await toolsSection()]])],
    ['cli.md', new Map([['cli', cliSection()]])],
    ['configuration.md', new Map([['configuration', configurationSection()]])],
    [
      'permissions.md',
      new Map([
        ['permission-profiles', permissionProfilesSection()],
        ['permission-capabilities', permissionCapabilitiesSection()],
      ]),
    ],
  ]);
  const stale: string[] = [];
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

await main();
