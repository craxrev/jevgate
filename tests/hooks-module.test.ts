import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// The engine refuses a function-hook module that imports anything but its own files and "claude-code".
test('hooks/compact.ts reaches only relative files and claude-code', () => {
  const seen = new Set<string>();
  const bad: string[] = [];
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^\s*(?:import|export)\s(?:type\s)?[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
      const spec = m[1]!;
      if (/^import\s+type\s/.test(m[0].trim())) continue; // type-only imports vanish at load
      if (spec === 'claude-code') continue;
      if (spec.startsWith('.')) walk(resolve(dirname(file), spec));
      else bad.push(`${file.replace(/.*jevgate\//, '')}: ${spec}`);
    }
  };
  walk(new URL('../hooks/compact.ts', import.meta.url).pathname);
  assert.deepEqual(bad, []);
  assert.ok(seen.size > 3);
});
