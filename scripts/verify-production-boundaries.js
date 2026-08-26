const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const runtimeBundles = ['dist/main/index.js', 'dist/main/preload.js', 'dist/renderer/renderer.js'];
const forbidden = [
  { label: 'Groq integration', pattern: /\bgroq\b/i },
  { label: 'FFmpeg dependency', pattern: /ffmpeg-static/i },
];

for (const relativePath of runtimeBundles) {
  const absolutePath = path.join(repoRoot, relativePath);
  const source = fs.readFileSync(absolutePath, 'utf8');
  for (const boundary of forbidden) {
    if (boundary.pattern.test(source)) {
      throw new Error(`${boundary.label} found in production bundle ${relativePath}`);
    }
  }
}

const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
if (packageJson.dependencies?.['ffmpeg-static'] !== undefined) {
  throw new Error('ffmpeg-static must not be a production dependency');
}

console.log('OK: production bundles contain no Groq endpoint or FFmpeg dependency');
