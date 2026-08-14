#!/usr/bin/env node

const args = process.argv.slice(2);
const valueFor = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

const outputPrefix = valueFor('-of');
const audioFile = valueFor('-f');

if (!outputPrefix || !audioFile) {
  console.error('fake whisper-cli requires -of and -f');
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
