import * as fs from 'fs';
import * as path from 'path';

/* Design-token guardrail.
 *
 * Product components must resolve color through the semantic tokens in
 * styles.css (bg-primary, text-muted-foreground, ...) or the shared
 * primitives in components/ui. A hardcoded color literal in product code
 * bypasses the palette and drifts out of sync, so this scan fails the suite
 * when one appears. New color needs a new token or primitive variant first;
 * components/ui stays exempt because primitives are where variants live. */

const rendererRoot = __dirname;
const sourceFilePattern = /\.(ts|tsx)$/;
const skippedFilePattern = /\.test\.ts$|__mocks__/;
const primitivesDir = path.join(rendererRoot, 'components', 'ui') + path.sep;

const hardcodedColorPatterns: Array<{ name: string; pattern: RegExp }> = [
  { name: 'hex color', pattern: /#[0-9a-fA-F]{3,8}\b/ },
  { name: 'color function', pattern: /\b(?:oklch|oklab|lch|lab|rgb|rgba|hsl|hsla)\(/ },
  {
    name: 'Tailwind palette utility',
    pattern:
      /\b(?:bg|text|border|ring|fill|stroke|from|via|to|divide|outline|decoration|caret|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/,
  },
];

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (sourceFilePattern.test(entry.name) && !skippedFilePattern.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('design token guard', () => {
  it('scans a non-empty renderer source tree', () => {
    expect(collectSourceFiles(rendererRoot).length).toBeGreaterThan(0);
  });

  it('keeps hardcoded color values out of product components', () => {
    const violations: string[] = [];
    for (const file of collectSourceFiles(rendererRoot)) {
      if (file.startsWith(primitivesDir)) {
        continue;
      }
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          for (const { name, pattern } of hardcodedColorPatterns) {
            if (pattern.test(line)) {
              violations.push(`${path.relative(rendererRoot, file)}:${index + 1} ${name}: ${line.trim()}`);
            }
          }
        });
    }
    expect(violations).toEqual([]);
  });
});
