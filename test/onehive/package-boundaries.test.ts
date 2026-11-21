import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { relative } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(pattern: string): string[] {
  return globSync(pattern, { exclude: ['**/*.d.ts'] }).sort();
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /import\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /export\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /await\s+import\(['"]([^'"]+)['"]\)/g,
    /import\(['"]([^'"]+)['"]\)/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) specs.push(specifier);
    }
  }
  return specs;
}

function expectNoMatchingImport(files: string[], forbidden: RegExp, reason: string): void {
  const violations = files.flatMap((file) =>
    importSpecifiers(read(file))
      .filter((specifier) => forbidden.test(specifier))
      .map((specifier) => `${relative(process.cwd(), file)} -> ${specifier}`)
  );
  expect(violations, reason).toEqual([]);
}

describe('standalone Honey CLI boundaries', () => {
  it('keeps the protocol layer independent of CLI and agent paths', () => {
    const coreFiles = sourceFiles('src/onehive/**/*.ts');
    expectNoMatchingImport(
      coreFiles,
      /(?:^|\/)honey-cli(?:\.js)?$|(?:^|\/)honey-signer(?:\.js)?$|extensions\/|skills\/|prompts\//,
      'src/onehive is the neutral protocol layer and must not import CLI entrypoints or agent-package files'
    );
  });

  it('keeps CLI entrypoints on the public protocol seam', () => {
    const cliFiles = ['src/honey-cli.ts', 'src/honey-signer.ts'];
    expectNoMatchingImport(cliFiles, /extensions\/|skills\/|prompts\//, 'CLI must not import Pi/Bee package internals');
    expect(read('src/honey-cli.ts')).toContain("from './onehive/index.js'");
    expect(read('src/honey-cli.ts')).not.toMatch(/from ['"]\.\/onehive\/(?:tools|clients|abis)\//);
  });
});
