import { describe, expect, it } from 'vitest';
import { parseEnvContent } from '../src/configMigration.js';

describe('parseEnvContent', () => {
  it('parses assignments used by explicit and legacy imports', () => {
    const parsed = parseEnvContent('FM_TEST_A=hello\n# comment\n\nFM_TEST_B="quoted value"\n');
    expect(parsed.FM_TEST_A).toBe('hello');
    expect(parsed.FM_TEST_B).toBe('quoted value');
  });

  it('strips inline comments from unquoted values but keeps # inside quotes', () => {
    const parsed = parseEnvContent(
      [
        'FM_TEST_A=127.0.0.1 # set to 0.0.0.0 in Docker',
        'FM_TEST_B="value # not a comment"',
        "FM_TEST_C='quoted' # trailing comment",
      ].join('\n'),
    );
    expect(parsed.FM_TEST_A).toBe('127.0.0.1');
    expect(parsed.FM_TEST_B).toBe('value # not a comment');
    expect(parsed.FM_TEST_C).toBe('quoted');
  });

  it('handles export prefixes and single quotes', () => {
    const parsed = parseEnvContent("export FM_TEST_EXPORT=yes\nFM_TEST_QUOTED='single'\n");
    expect(parsed.FM_TEST_EXPORT).toBe('yes');
    expect(parsed.FM_TEST_QUOTED).toBe('single');
  });
});
