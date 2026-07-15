import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export interface PublicDocsManifest {
  schemaVersion: 1;
  id: string;
  category: string;
  pages: string[];
}

export interface PublicDocsMeta {
  title: string;
  pages: string[];
}

export interface PublicDocsFrontmatter {
  title: string;
  description: string;
  updated: string;
  draft?: boolean;
}

export const PUBLIC_DOCS_ROOT = path.resolve('docs/public');
export const GENERATED_MARKERS = [
  'tools',
  'cli',
  'configuration',
  'permission-profiles',
  'permission-capabilities',
] as const;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function parseMeta(value: unknown): PublicDocsMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Meta must be a JSON object.');
  const meta = value as Record<string, unknown>;
  const keys = Object.keys(meta).sort();
  const expected = ['pages', 'title'];
  if (JSON.stringify(keys) !== JSON.stringify(expected))
    throw new Error(`Meta fields must be: ${expected.join(', ')}.`);
  if (typeof meta.title !== 'string' || !meta.title.trim()) throw new Error('Meta title is required.');
  validatePageSlugs(meta.pages, 'Meta');
  return meta as unknown as PublicDocsMeta;
}

export function compatibilityManifest(meta: PublicDocsMeta): PublicDocsManifest {
  return {
    schemaVersion: 1,
    id: 'fluxmail-mcp',
    category: meta.title,
    pages: meta.pages,
  };
}

export function parseManifest(value: unknown): PublicDocsManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Manifest must be a JSON object.');
  const manifest = value as Record<string, unknown>;
  const keys = Object.keys(manifest).sort();
  const expected = ['category', 'id', 'pages', 'schemaVersion'];
  if (JSON.stringify(keys) !== JSON.stringify(expected))
    throw new Error(`Manifest fields must be: ${expected.join(', ')}.`);
  if (manifest.schemaVersion !== 1) throw new Error('Manifest schemaVersion must be 1.');
  if (manifest.id !== 'fluxmail-mcp') throw new Error('Manifest id must be fluxmail-mcp.');
  if (typeof manifest.category !== 'string' || !manifest.category.trim())
    throw new Error('Manifest category is required.');
  validatePageSlugs(manifest.pages, 'Manifest');
  return manifest as unknown as PublicDocsManifest;
}

export function parseFrontmatter(source: string, filename = 'page'): PublicDocsFrontmatter {
  const match = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match?.[1]) throw new Error(`${filename} has no frontmatter.`);
  const values: Record<string, string | boolean> = {};
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 1) throw new Error(`${filename} has malformed frontmatter.`);
    const key = line.slice(0, separator).trim();
    let value: string | boolean = line.slice(separator + 1).trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    } else if (value === 'true' || value === 'false') {
      value = value === 'true';
    }
    values[key] = value;
  }
  const allowed = new Set(['title', 'description', 'updated', 'draft']);
  const unexpected = Object.keys(values).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new Error(`${filename} has unsupported frontmatter: ${unexpected.join(', ')}.`);
  if (typeof values.title !== 'string' || !values.title.trim()) throw new Error(`${filename} needs a title.`);
  if (typeof values.description !== 'string' || !values.description.trim())
    throw new Error(`${filename} needs a description.`);
  if (typeof values.updated !== 'string' || !isValidDate(values.updated)) {
    throw new Error(`${filename} needs an updated date in YYYY-MM-DD format.`);
  }
  if (values.draft !== undefined && typeof values.draft !== 'boolean')
    throw new Error(`${filename} draft must be true or false.`);
  return values as unknown as PublicDocsFrontmatter;
}

export function replaceGeneratedSection(source: string, marker: string, content: string): string {
  const start = `<!-- BEGIN GENERATED:${marker} -->`;
  const end = `<!-- END GENERATED:${marker} -->`;
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
  if (!pattern.test(source)) throw new Error(`Missing generated section ${marker}.`);
  return source.replace(pattern, `${start}\n${content.trim()}\n${end}`);
}

export function readPublicDocsManifest(root = PUBLIC_DOCS_ROOT): PublicDocsManifest {
  return parseManifest(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as unknown);
}

export function readPublicDocsMeta(root = PUBLIC_DOCS_ROOT): PublicDocsMeta {
  return parseMeta(JSON.parse(readFileSync(path.join(root, 'pages', 'meta.json'), 'utf8')) as unknown);
}

export function pageFiles(root = PUBLIC_DOCS_ROOT): string[] {
  return readdirSync(path.join(root, 'pages'))
    .filter((file) => file.endsWith('.md'))
    .sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validatePageSlugs(value: unknown, owner: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${owner} pages must be a non-empty array.`);
  if (!value.every((slug) => typeof slug === 'string' && SLUG_PATTERN.test(slug))) {
    throw new Error(`${owner} pages contain an unsafe or invalid slug.`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${owner} pages contain duplicate slugs.`);
}
