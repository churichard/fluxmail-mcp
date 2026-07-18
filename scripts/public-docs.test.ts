import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compatibilityManifest,
  parseFrontmatter,
  parseManifest,
  parseMeta,
  publicDocManifestPages,
  publicDocPages,
  replaceGeneratedSection,
} from './public-docs.js';

const manifest = { schemaVersion: 1, id: 'fluxmail', category: 'Fluxmail MCP', pages: ['quickstart'] };
const meta = { title: 'Fluxmail MCP', pages: ['quickstart'] };

describe('public docs bundle validation', () => {
  it('parses Fumadocs metadata without changing page order', () => {
    expect(parseMeta(meta).pages).toEqual(['quickstart']);
    expect(parseMeta({ ...meta, pages: ['---Getting started---', 'quickstart'] }).pages).toEqual([
      '---Getting started---',
      'quickstart',
    ]);
    expect(parseMeta({ title: 'REST API', pagesIndex: 'index', defaultOpen: false, pages: ['list-accounts'] })).toEqual(
      { title: 'REST API', pagesIndex: 'index', defaultOpen: false, pages: ['list-accounts'] },
    );
    expect(parseMeta({ title: 'Upgrade guides', pages: ['0.5.0'] }).pages).toEqual(['0.5.0']);
  });

  it('derives the compatibility manifest from Fumadocs metadata', () => {
    expect(compatibilityManifest(parseMeta({ ...meta, pages: ['---Getting started---', 'quickstart'] }))).toEqual({
      schemaVersion: 1,
      id: 'fluxmail',
      category: 'Fluxmail MCP',
      pages: ['quickstart'],
    });
  });

  it('parses a valid manifest without changing its order', () => {
    expect(parseManifest(manifest).pages).toEqual(['quickstart']);
    expect(parseManifest({ ...manifest, pages: ['rest-api', 'rest-api/list-accounts'] }).pages).toEqual([
      'rest-api',
      'rest-api/list-accounts',
    ]);
    expect(parseManifest({ ...manifest, pages: ['upgrades/0.5.0'] }).pages).toEqual(['upgrades/0.5.0']);
  });

  it('rejects unsafe paths and duplicate slugs', () => {
    expect(() => parseMeta({ ...meta, pages: ['../secret'] })).toThrow(/unsafe|invalid/);
    expect(() => parseMeta({ ...meta, pages: ['---   ---'] })).toThrow(/unsafe|invalid/);
    expect(() => parseMeta({ ...meta, pages: ['quickstart', 'quickstart'] })).toThrow(/duplicate/);
    expect(() => parseMeta({ ...meta, pagesIndex: 'quickstart' })).toThrow(/must not also appear/);
    expect(() => parseManifest({ ...manifest, pages: ['../secret'] })).toThrow(/unsafe|invalid/);
    expect(() => parseManifest({ ...manifest, pages: ['quickstart', 'quickstart'] })).toThrow(/duplicate/);
  });

  it('requires the public frontmatter contract', () => {
    expect(
      parseFrontmatter(
        "---\ntitle: 'Test'\ndescription: 'A page'\nupdated: '2026-07-14'\ndraft: false\nhidden: true\n---\n",
      ),
    ).toMatchObject({
      title: 'Test',
      draft: false,
      hidden: true,
    });
    expect(() => parseFrontmatter("---\ntitle: 'Test'\ndescription: 'A page'\nupdated: '2026-02-30'\n---\n")).toThrow(
      /updated date/,
    );
    expect(() =>
      parseFrontmatter("---\ntitle: 'Test'\ndescription: 'A page'\nupdated: '2026-07-14'\nhidden: yes\n---\n"),
    ).toThrow(/hidden/);
    expect(() => parseFrontmatter("---\ntitle: 'Test'\ncategory: 'Wrong owner'\n---\n")).toThrow();
  });

  it('updates only a marked generated section', () => {
    expect(
      replaceGeneratedSection(
        'before\n<!-- BEGIN GENERATED:test -->\nold\n<!-- END GENERATED:test -->\nafter',
        'test',
        'new',
      ),
    ).toBe('before\n<!-- BEGIN GENERATED:test -->\nnew\n<!-- END GENERATED:test -->\nafter');
  });

  it('resolves folder indexes and nested pages in navigation order', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fluxmail-public-docs-'));
    try {
      const pages = path.join(root, 'pages');
      const restApi = path.join(pages, 'rest-api');
      mkdirSync(restApi, { recursive: true });
      writeFileSync(path.join(pages, 'overview.md'), 'overview');
      writeFileSync(path.join(restApi, 'index.md'), 'index');
      writeFileSync(path.join(restApi, 'list-accounts.md'), 'accounts');
      writeFileSync(
        path.join(restApi, 'meta.json'),
        JSON.stringify({
          title: 'REST API',
          pagesIndex: 'index',
          defaultOpen: false,
          pages: ['list-accounts'],
        }),
      );

      expect(
        publicDocPages(
          { title: 'Fluxmail MCP', pages: ['---Getting started---', 'overview', '---Reference---', 'rest-api'] },
          root,
        ),
      ).toEqual([
        { slug: 'overview', filename: 'overview.md' },
        { slug: 'rest-api', filename: 'rest-api/index.md' },
        { slug: 'rest-api/list-accounts', filename: 'rest-api/list-accounts.md' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps hidden routes in the compatibility manifest without adding them to navigation', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fluxmail-public-docs-'));
    try {
      const pages = path.join(root, 'pages');
      mkdirSync(pages, { recursive: true });
      writeFileSync(path.join(pages, 'overview.md'), 'overview');
      writeFileSync(path.join(pages, 'legacy.md'), 'legacy');

      expect(publicDocPages({ title: 'Fluxmail', pages: ['overview'] }, root)).toEqual([
        { slug: 'overview', filename: 'overview.md' },
      ]);
      expect(publicDocManifestPages({ title: 'Fluxmail', pages: ['overview'] }, root)).toEqual([
        { slug: 'overview', filename: 'overview.md' },
        { slug: 'legacy', filename: 'legacy.md' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
