const childProcess = require('child_process');
const nodeCrypto = require('crypto');
const fs = require('fs');
const path = require('path');
const prettier = require('prettier');

const repoRoot = path.resolve(__dirname, '..');
const outputPath = path.join(repoRoot, 'THIRD_PARTY_NOTICES.md');

const normalizeRepository = (repository, homepage) => {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (raw) {
    return raw.replace(/^git\+/, '').replace(/\.git$/, '');
  }
  return homepage ?? '';
};

const findLicense = (packageDir, packageName) => {
  const licenseFile = fs
    .readdirSync(packageDir)
    .find((entry) => /^licen[cs]e(?:\.|$)/i.test(entry));

  if (licenseFile) {
    return fs.readFileSync(path.join(packageDir, licenseFile), 'utf8').trim();
  }

  // react-remove-scroll-bar omits its repository-level license from the npm tarball.
  if (packageName === 'react-remove-scroll-bar') {
    return fs
      .readFileSync(path.join(repoRoot, 'node_modules/react-remove-scroll/LICENSE'), 'utf8')
      .trim();
  }

  throw new Error(`No license text found for production package ${packageName}`);
};

const listProductionPackages = () => {
  const output = childProcess.execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  return output
    .trim()
    .split('\n')
    .slice(1)
    .map((packageDir) => {
      const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
      return {
        name: manifest.name,
        version: manifest.version,
        license: manifest.license,
        upstream: normalizeRepository(manifest.repository, manifest.homepage),
        licenseText: findLicense(packageDir, manifest.name),
      };
    })
    .filter(({ name }) => !name.startsWith('@types/') && name !== 'csstype')
    .sort((left, right) => left.name.localeCompare(right.name));
};

const mitLicense = (copyright) => `MIT License

${copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const generate = () => {
  const packages = listProductionPackages();
  const licenseGroups = new Map();

  for (const pkg of packages) {
    const digest = nodeCrypto.createHash('sha256').update(pkg.licenseText).digest('hex');
    const group = licenseGroups.get(digest) ?? { text: pkg.licenseText, packages: [] };
    group.packages.push(`${pkg.name}@${pkg.version}`);
    licenseGroups.set(digest, group);
  }

  const inventoryRows = packages
    .map(
      (pkg) =>
        `| ${pkg.name} | ${pkg.version} | ${pkg.license} | ${pkg.upstream || 'See npm metadata'} |`,
    )
    .join('\n');

  const licenseSections = [...licenseGroups.values()]
    .map(({ packages: names, text }) => `### ${names.join(', ')}\n\n\`\`\`text\n${text}\n\`\`\``)
    .join('\n\n');

  const electronLicense = fs
    .readFileSync(path.join(repoRoot, 'node_modules/electron/LICENSE'), 'utf8')
    .trim();
  const whisperCppLicense = mitLicense('Copyright (c) 2023-2026 The ggml authors');
  const whisperModelLicense = mitLicense('Copyright (c) 2022 OpenAI');
  const vadModelLicense = mitLicense('Copyright (c) 2020-present Silero Team');

  return `# Third-Party Notices

CounterNote is licensed under GPL-3.0-only. This document records third-party
software and model weights distributed in, or downloaded for use by, the
CounterNote macOS application. The notices below do not change the license of
CounterNote's own code.

## Native runtime components

| Component | Version | License | Upstream | Redistribution notes |
| --- | --- | --- | --- | --- |
| Electron | 43.1.0 | MIT and bundled Chromium/Node third-party licenses | https://github.com/electron/electron | The packaged app includes Electron's \`LICENSE.electron.txt\` and \`LICENSES.chromium.html\` in \`Contents/Resources\`. |
| whisper.cpp / whisper-cli | commit \`f049fff95a089aa9969deb009cdd4892b3e74916\` | MIT | https://github.com/ggml-org/whisper.cpp | Copyright and permission notice must accompany redistributed binaries. CounterNote builds without FFmpeg support. |
| Whisper large-v3-turbo-q5_0 model | model file \`ggml-large-v3-turbo-q5_0.bin\` | MIT | https://huggingface.co/ggerganov/whisper.cpp | Downloaded on user request and verified by size and SHA-256. OpenAI states that Whisper code and model weights are MIT licensed. |
| Silero VAD model | model file \`ggml-silero-v5.1.2.bin\` | MIT | https://huggingface.co/ggml-org/whisper-vad | Downloaded on user request and verified by size and SHA-256. ggml conversion of the MIT-licensed Silero VAD used for speech activity filtering. |

The Swift audio-capture helper and CounterNote artwork are project-owned and do
not add a third-party package. The helper links only to macOS system frameworks,
which are supplied by the operating system rather than redistributed. CounterNote
does not distribute FFmpeg.

## JavaScript runtime packages

The following packages are compiled into the renderer bundle. Type-only packages
and build/test dependencies are excluded.

| Package | Version | License | Upstream |
| --- | --- | --- | --- |
${inventoryRows}

## License texts

### Electron 43.1.0

\`\`\`text
${electronLicense}
\`\`\`

Electron's complete Chromium and Node third-party notices are retained in the
packaged application's \`Contents/Resources/LICENSES.chromium.html\` file.

### whisper.cpp / whisper-cli

\`\`\`text
${whisperCppLicense}
\`\`\`

### OpenAI Whisper model weights

\`\`\`text
${whisperModelLicense}
\`\`\`

### Silero VAD model weights

\`\`\`text
${vadModelLicense}
\`\`\`

${licenseSections}
`;
};

const main = async () => {
  const expected = await prettier.format(generate(), { parser: 'markdown' });
  if (process.argv.includes('--write')) {
    fs.writeFileSync(outputPath, expected);
    console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
  } else {
    const actual = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
    if (actual !== expected) {
      throw new Error('THIRD_PARTY_NOTICES.md is stale; run npm run notices:write');
    }
    console.log('OK: third-party notices match installed production dependencies');
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
