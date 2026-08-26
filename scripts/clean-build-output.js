const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

for (const directory of ['dist', 'release']) {
  fs.rmSync(path.join(repoRoot, directory), { recursive: true, force: true });
}
