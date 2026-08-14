#!/usr/bin/env node
'use strict';

/**
 * Fake audio capture helper for renderer/lifecycle E2E tests.
 *
 * Writes valid version-1 binary protocol frames to stdout, drains stdin,
 * and selects a scripted scenario from its executable basename.
 *
 * Example: copying this file to `fake-audio-capture-helper__delayed-ready.js`
 * and setting INTERVIEW_COPILOT_AUDIO_CAPTURE_HELPER to that path selects the
 * "delayed-ready" scenario.
 *
 * The helper never reads a scenario variable from the spawned child environment
 * and never writes outside its pipes.
 */

const PCM_BLOCK_BYTES = 1280;
const FRAME_TYPE = { ready: 0x01, pcm: 0x02, gap: 0x03, interruption: 0x04, stopped: 0x06, error: 0x07 };

let sequenceCounter = 0;

function buildHeader(frameType, payloadLength) {
  const header = Buffer.alloc(16);
  header.write('ICAP', 0, 'ascii');
  header.writeUInt8(1, 4); // version
  header.writeUInt8(frameType, 5);
  header.writeUInt8(0, 6); // reserved
  header.writeUInt8(0, 7); // reserved
  header.writeUInt32LE(payloadLength, 8);
  header.writeUInt32LE(sequenceCounter++, 12);
  return header;
}

function writeFrame(frameType, payload) {
  const payloadBuf = typeof payload === 'string' ? Buffer.from(payload) : payload;
  const header = buildHeader(frameType, payloadBuf.length);
  process.stdout.write(header);
  process.stdout.write(payloadBuf);
}

function writeReady() {
  writeFrame(FRAME_TYPE.ready, JSON.stringify({
    type: 'ready',
    sampleRateHz: 16000,
    framesPerBlock: 320,
    encoding: 's16le',
    channelOrder: ['interviewer', 'you'],
    firstBlock: 0,
  }));
}

function writePcm(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.alloc(PCM_BLOCK_BYTES);
  writeFrame(FRAME_TYPE.pcm, buf);
}

function writeInterruptionOpen(id, channel, startBlock, reason) {
  writeFrame(FRAME_TYPE.interruption, JSON.stringify({
    type: 'interruption',
    phase: 'opened',
    id,
    channel,
    startBlock,
    reason,
  }));
}

function writeInterruptionClosed(id, channel, startBlock, endBlockExclusive, reason, recovered) {
  writeFrame(FRAME_TYPE.interruption, JSON.stringify({
    type: 'interruption',
    phase: 'closed',
    id,
    channel,
    startBlock,
    endBlockExclusive,
    reason,
    recovered,
  }));
}

function writeGap(startBlock, endBlockExclusive) {
  writeFrame(FRAME_TYPE.gap, JSON.stringify({
    type: 'gap',
    channel: 'capture',
    startBlock,
    endBlockExclusive,
    reason: 'buffer-overflow',
    recovered: true,
  }));
}

function writeStopped(finalBlockExclusive, pcmBlocks, gapBlocks) {
  writeFrame(FRAME_TYPE.stopped, JSON.stringify({
    type: 'stopped',
    reason: 'stop',
    finalBlockExclusive,
    pcmBlocks,
    gapBlocks,
    openInterruptionIds: [],
  }));
}

function writeError(phase, code, channel) {
  const payload = { type: 'error', phase, code, terminal: true };
  if (channel) payload.channel = channel;
  writeFrame(FRAME_TYPE.error, JSON.stringify(payload));
}

// ── Scenario selection ───────────────────────────────────────────

const scenarioArgIndex = process.argv.indexOf('--scenario');
const scenarioArg = scenarioArgIndex !== -1 ? process.argv[scenarioArgIndex + 1] : undefined;
const envScenario = process.env.INTERVIEW_COPILOT_CAPTURE_SCENARIO;
const basename = require('path').basename(process.argv[1] || '', '.js');
const scenarioMatch = basename.match(/fake-audio-capture-helper__(.+)$/);
const scenario = scenarioArg ?? envScenario ?? (scenarioMatch ? scenarioMatch[1] : 'default');

// ── Drain stdin (required to preserve Task 10 minimal env invariant) ──

process.stdin.on('data', () => {});
process.stdin.on('end', () => {});
process.stdin.resume();

// ── Run scenario ─────────────────────────────────────────────────

function runScenario() {
  switch (scenario) {
    case 'slow': {
      // Long-running recording: ready, 30 PCM blocks at 1/s, stopped.
      // Gives tests ~30s of active recording time.
      writeReady();
      let block = 0;
      const totalBlocks = 30;
      const interval = setInterval(() => {
        if (block >= totalBlocks) {
          clearInterval(interval);
          writeStopped(totalBlocks, totalBlocks, 0);
          return;
        }
        writePcm();
        block++;
      }, 1000);
      break;
    }

    case 'overflow-slow': {
      // Overflow with extra trailing PCM so recording stays active for assertions.
      writeReady();
      const beforeGap = 3;
      for (let i = 0; i < beforeGap; i++) writePcm();

      const gapSize = 5;
      writeGap(beforeGap, beforeGap + gapSize);

      // Keep emitting PCM for ~10s so the test can observe the health UI
      const trailingBlocks = 10;
      let trailing = 0;
      const trailingInterval = setInterval(() => {
        if (trailing >= trailingBlocks) {
          clearInterval(trailingInterval);
          const totalPcm = beforeGap + trailingBlocks;
          const totalBlocks = beforeGap + gapSize + trailingBlocks;
          writeStopped(totalBlocks, totalPcm, gapSize);
          return;
        }
        writePcm();
        trailing++;
      }, 1000);
      break;
    }

    case 'default': {
      // Normal recording: ready, 10 PCM blocks, stopped
      writeReady();
      const pcmBlocks = 10;
      for (let i = 0; i < pcmBlocks; i++) {
        writePcm();
      }
      writeStopped(pcmBlocks, pcmBlocks, 0);
      break;
    }

    case 'delayed-ready': {
      // Delay ready by 2 seconds (enough for cancel-during-starting tests)
      setTimeout(() => {
        writeReady();
        const pcmBlocks = 5;
        for (let i = 0; i < pcmBlocks; i++) {
          writePcm();
        }
        writeStopped(pcmBlocks, pcmBlocks, 0);
      }, 2000);
      break;
    }

    case 'single-channel-interruption': {
      // Ready, PCM, microphone interruption, more PCM, close interruption, stopped
      writeReady();
      const beforeGap = 5;
      for (let i = 0; i < beforeGap; i++) writePcm();

      writeInterruptionOpen(1, 'you', beforeGap, 'stream-error');

      const duringGap = 3;
      const silentRight = Buffer.alloc(PCM_BLOCK_BYTES);
      for (let i = 0; i < duringGap; i++) writePcm(silentRight);

      writeInterruptionClosed(1, 'you', beforeGap, beforeGap + duringGap, 'stream-error', true);

      const afterGap = 2;
      for (let i = 0; i < afterGap; i++) writePcm();

      const totalPcm = beforeGap + duringGap + afterGap;
      writeStopped(totalPcm, totalPcm, 0);
      break;
    }

    case 'recovery-ready': {
      // Ready, PCM blocks, stopped (for recovery scenario tests)
      writeReady();
      const pcmBlocks = 8;
      for (let i = 0; i < pcmBlocks; i++) writePcm();
      writeStopped(pcmBlocks, pcmBlocks, 0);
      break;
    }

    case 'overflow': {
      // Ready, PCM, gap (output overflow), more PCM, stopped
      writeReady();
      const beforeGap = 3;
      for (let i = 0; i < beforeGap; i++) writePcm();

      const gapSize = 5;
      writeGap(beforeGap, beforeGap + gapSize);

      const afterGap = 2;
      for (let i = 0; i < afterGap; i++) writePcm();

      const totalPcm = beforeGap + afterGap;
      const totalBlocks = beforeGap + gapSize + afterGap;
      writeStopped(totalBlocks, totalPcm, gapSize);
      break;
    }

    case 'error-init': {
      // Emit initialization error instead of ready
      writeError('initialization', 'source-start-failed', 'interviewer');
      break;
    }

    default: {
      // Unknown scenario: emit error
      writeError('runtime', 'internal');
      break;
    }
  }
}

// Use setImmediate to ensure stdin listeners are attached first
setImmediate(runScenario);
