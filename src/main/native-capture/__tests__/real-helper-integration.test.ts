import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { CaptureProtocolDecoder } from '../protocol';
import type { CaptureFrame } from '../../../types/native-capture';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const NATIVE_PACKAGE_PATH = path.join(REPO_ROOT, 'native', 'audio-capture');
const FIXTURES_PATH = path.join(NATIVE_PACKAGE_PATH, 'Tests', 'Fixtures');
const BINARY_PATH = path.join(
  NATIVE_PACKAGE_PATH,
  '.build',
  'arm64-apple-macosx',
  'debug',
  'InterviewAudioCapture',
);

let binaryBuilt = false;

function buildHelper(): void {
  if (binaryBuilt) return;
  execSync(
    `swift build -c debug --package-path ${NATIVE_PACKAGE_PATH} -Xswiftc -DCAPTURE_TEST_SEAMS`,
    { cwd: REPO_ROOT, timeout: 120_000, stdio: 'pipe' },
  );
  binaryBuilt = true;
}

function loadFixture(name: string): Record<string, unknown> {
  const fixturePath = path.join(FIXTURES_PATH, `${name}.json`);
  return JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
}

async function spawnAndDecode(fixtureName: string): Promise<CaptureFrame[]> {
  const fixturePath = path.join(FIXTURES_PATH, `${fixtureName}.json`);
  const child = spawn(BINARY_PATH, ['--test-fixture', fixturePath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const decoder = new CaptureProtocolDecoder();
  const frames: CaptureFrame[] = [];

  return new Promise<CaptureFrame[]>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        const newFrames = decoder.push(chunk);
        frames.push(...newFrames);
      } catch (error) {
        child.kill();
        reject(error);
      }
    });

    child.stdout.on('end', () => {
      try {
        decoder.finish();
        resolve(frames);
      } catch (error) {
        reject(error);
      }
    });

    child.on('error', reject);
    child.stderr.on('data', () => {}); // drain stderr
  });
}

beforeAll(() => {
  buildHelper();
}, 180_000);

describe('real-helper integration', () => {
  describe('dual-rate-60m', () => {
    let frames: CaptureFrame[];
    let manifest: Record<string, unknown>;

    beforeAll(async () => {
      manifest = loadFixture('dual-rate-60m');
      frames = await spawnAndDecode('dual-rate-60m');
    }, 120_000);

    it('ready is the first frame', () => {
      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0].frameType).toBe('ready');
    });

    it('ready payload matches manifest output format', () => {
      const ready = frames[0].payload as {
        type: string;
        sampleRateHz: number;
        framesPerBlock: number;
        encoding: string;
        channelOrder: string[];
        firstBlock: number;
      };
      expect(ready.type).toBe('ready');
      expect(ready.sampleRateHz).toBe((manifest as any).outputSampleRate);
      expect(ready.framesPerBlock).toBe((manifest as any).framesPerBlock);
      expect(ready.encoding).toBe('s16le');
      expect(ready.channelOrder).toEqual(['interviewer', 'you']);
      expect(ready.firstBlock).toBe(0);
    });

    it('every PCM payload is 1,280 bytes', () => {
      const pcmFrames = frames.filter((f) => f.frameType === 'pcm');
      for (const frame of pcmFrames) {
        expect((frame.payload as Buffer).length).toBe(
          (manifest as any).pcmBlockBytes,
        );
      }
    });

    it('total PCM blocks match manifest expectation', () => {
      const pcmFrames = frames.filter((f) => f.frameType === 'pcm');
      expect(pcmFrames.length).toBe((manifest as any).expected.totalBlocks);
    });

    it('no gap frames in dual-rate scenario', () => {
      const gapFrames = frames.filter((f) => f.frameType === 'gap');
      expect(gapFrames.length).toBe(0);
    });

    it('no interruption frames in dual-rate scenario', () => {
      const interruptionFrames = frames.filter(
        (f) => f.frameType === 'interruption',
      );
      expect(interruptionFrames.length).toBe(0);
    });

    it('stopped is the last frame with valid counters', () => {
      const lastFrame = frames[frames.length - 1];
      expect(lastFrame.frameType).toBe('stopped');
      const stopped = lastFrame.payload as {
        type: string;
        reason: string;
        finalBlockExclusive: number;
        pcmBlocks: number;
        gapBlocks: number;
        openInterruptionIds: number[];
      };
      expect(stopped.type).toBe('stopped');
      expect(stopped.reason).toBe('stop');
      expect(stopped.finalBlockExclusive).toBe(
        (manifest as any).expected.totalBlocks,
      );
      expect(stopped.pcmBlocks).toBe((manifest as any).expected.pcmBlocks);
      expect(stopped.gapBlocks).toBe((manifest as any).expected.gapBlocks);
      expect(stopped.openInterruptionIds).toEqual([]);
      expect(stopped.finalBlockExclusive).toBe(
        stopped.pcmBlocks + stopped.gapBlocks,
      );
    });

    it('protocol sequence is contiguous', () => {
      for (let i = 0; i < frames.length; i++) {
        expect(frames[i].sequence).toBe(i);
      }
    });

    it('system impulses are in left channel (even bytes)', () => {
      const pcmFrames = frames.filter((f) => f.frameType === 'pcm');
      const impulseInterval = (manifest as any).impulseIntervalBlocks;
      const amplitude = (manifest as any).impulseAmplitude;

      // Check a few impulse blocks
      for (let block = impulseInterval; block < pcmFrames.length; block += impulseInterval) {
        const payload = pcmFrames[block].payload as Buffer;
        // First sample, left channel (bytes 0-1)
        const leftSample = payload.readInt16LE(0);
        expect(leftSample).toBe(amplitude);
      }
    });

    it('microphone impulses are in right channel (odd bytes)', () => {
      const pcmFrames = frames.filter((f) => f.frameType === 'pcm');
      const impulseInterval = (manifest as any).impulseIntervalBlocks;
      const amplitude = (manifest as any).impulseAmplitude;

      // Check a few impulse blocks
      for (let block = impulseInterval; block < pcmFrames.length; block += impulseInterval) {
        const payload = pcmFrames[block].payload as Buffer;
        // First sample, right channel (bytes 2-3)
        const rightSample = payload.readInt16LE(2);
        expect(rightSample).toBe(amplitude);
      }
    });

    it('every paired impulse differs by at most one block', () => {
      const pcmFrames = frames.filter((f) => f.frameType === 'pcm');
      const impulseInterval = (manifest as any).impulseIntervalBlocks;
      const amplitude = (manifest as any).impulseAmplitude;

      // Find all blocks with left impulse
      const leftImpulseBlocks: number[] = [];
      const rightImpulseBlocks: number[] = [];

      for (let i = 0; i < pcmFrames.length; i++) {
        const payload = pcmFrames[i].payload as Buffer;
        const leftSample = payload.readInt16LE(0);
        const rightSample = payload.readInt16LE(2);
        if (leftSample === amplitude) leftImpulseBlocks.push(i);
        if (rightSample === amplitude) rightImpulseBlocks.push(i);
      }

      // Each impulse block should have both channels
      expect(leftImpulseBlocks.length).toBe(rightImpulseBlocks.length);
      expect(leftImpulseBlocks.length).toBeGreaterThan(0);

      // Paired impulses should be at the same block index (difference <= 1)
      for (let i = 0; i < leftImpulseBlocks.length; i++) {
        const diff = Math.abs(leftImpulseBlocks[i] - rightImpulseBlocks[i]);
        expect(diff).toBeLessThanOrEqual(1);
      }
    });

    it('final duration is exactly 180,000 timeline blocks', () => {
      const stopped = frames[frames.length - 1].payload as {
        finalBlockExclusive: number;
      };
      expect(stopped.finalBlockExclusive).toBe(180_000);
    });
  });

  describe('timestamp-discontinuity', () => {
    let frames: CaptureFrame[];
    let manifest: Record<string, unknown>;

    beforeAll(async () => {
      manifest = loadFixture('timestamp-discontinuity');
      frames = await spawnAndDecode('timestamp-discontinuity');
    }, 120_000);

    it('ready is the first frame', () => {
      expect(frames[0].frameType).toBe('ready');
    });

    it('emits exactly one interruption open for microphone', () => {
      const openedInterruptions = frames.filter(
        (f) =>
          f.frameType === 'interruption' &&
          (f.payload as { phase: string }).phase === 'opened',
      );
      expect(openedInterruptions.length).toBe(1);
      const payload = openedInterruptions[0].payload as {
        channel: string;
        reason: string;
      };
      expect(payload.channel).toBe('you');
      expect(payload.reason).toBe('timestamp-discontinuity');
    });

    it('interruption closes with recovered: true', () => {
      const closedInterruptions = frames.filter(
        (f) =>
          f.frameType === 'interruption' &&
          (f.payload as { phase: string }).phase === 'closed',
      );
      expect(closedInterruptions.length).toBe(1);
      const payload = closedInterruptions[0].payload as {
        recovered: boolean;
        channel: string;
        reason: string;
      };
      expect(payload.recovered).toBe(true);
      expect(payload.channel).toBe('you');
      expect(payload.reason).toBe('timestamp-discontinuity');
    });

    it('interruption keeps same ID and reason through reconstruction', () => {
      const opened = frames.find(
        (f) =>
          f.frameType === 'interruption' &&
          (f.payload as { phase: string }).phase === 'opened',
      )!.payload as { id: number; reason: string };
      const closed = frames.find(
        (f) =>
          f.frameType === 'interruption' &&
          (f.payload as { phase: string }).phase === 'closed',
      )!.payload as { id: number; reason: string };
      expect(closed.id).toBe(opened.id);
      expect(closed.reason).toBe(opened.reason);
    });

    it('emits no overlapping interruption', () => {
      const interruptionFrames = frames.filter(
        (f) => f.frameType === 'interruption',
      );
      // Exactly 2: one opened, one closed
      expect(interruptionFrames.length).toBe(2);
    });

    it('PCM blocks during interruption have silent microphone channel', () => {
      const discConfig = (manifest as any).discontinuity;
      const pcmFrames = frames.filter((f) => f.frameType === 'pcm');
      const gapStart = discConfig.atBlock;
      const gapEnd = gapStart + discConfig.gapBlocks;

      // Check PCM blocks during the interruption gap
      for (let i = gapStart; i < gapEnd && i < pcmFrames.length; i++) {
        const payload = pcmFrames[i].payload as Buffer;
        // Right channel (microphone) should be silent
        let hasNonZeroRight = false;
        for (let sample = 0; sample < payload.length / 4; sample++) {
          const rightSample = payload.readInt16LE(sample * 4 + 2);
          if (rightSample !== 0) {
            hasNonZeroRight = true;
            break;
          }
        }
        expect(hasNonZeroRight).toBe(false);
      }
    });

    it('finishes with valid counters', () => {
      const lastFrame = frames[frames.length - 1];
      expect(lastFrame.frameType).toBe('stopped');
      const stopped = lastFrame.payload as {
        finalBlockExclusive: number;
        pcmBlocks: number;
        gapBlocks: number;
        openInterruptionIds: number[];
      };
      expect(stopped.finalBlockExclusive).toBe(180_000);
      expect(stopped.pcmBlocks + stopped.gapBlocks).toBe(180_000);
      expect(stopped.openInterruptionIds).toEqual([]);
    });

    it('protocol sequence is contiguous', () => {
      for (let i = 0; i < frames.length; i++) {
        expect(frames[i].sequence).toBe(i);
      }
    });

    it('no gap frames emitted', () => {
      const gapFrames = frames.filter((f) => f.frameType === 'gap');
      expect(gapFrames.length).toBe(0);
    });
  });
});
