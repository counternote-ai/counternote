#!/usr/bin/env node

const args = process.argv.slice(2);
const valueFor = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

const outputPrefix = valueFor('-of');
const audioFile = valueFor('-f');
const vadModel = valueFor('--vad-model');

if (!outputPrefix || !audioFile || !vadModel || !args.includes('--vad')) {
  console.error('fake whisper-cli requires -of, -f, --vad, and --vad-model');
  process.exitCode = 2;
} else {
  console.error('fake whisper-cli: 50%');
  console.error('fake whisper-cli: 100%');
  require('fs').writeFileSync(
    `${outputPrefix}.json`,
    JSON.stringify({
      transcription: [
        {
          offsets: { from: 0, to: 250 },
          text: 'Deterministic local transcript.',
        },
      ],
    }),
  );
}
