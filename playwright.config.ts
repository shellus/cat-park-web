import { defineConfig } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const runtime = path.resolve('.runtime');
mkdirSync(runtime, { recursive: true });
// A real synthetic PCM source exercises capture, analysis, encoding and SFU publication.
const sampleRate = 48_000;
const samples = sampleRate * 2;
const wave = Buffer.alloc(44 + samples * 2);
wave.write('RIFF', 0); wave.writeUInt32LE(36 + samples * 2, 4); wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(sampleRate, 24); wave.writeUInt32LE(sampleRate * 2, 28);
wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) wave.writeInt16LE(Math.round(Math.sin(i / sampleRate * 2 * Math.PI * 440) * 5000), 44 + i * 2);
const audioPath = path.join(runtime, 'test-microphone.wav');
writeFileSync(audioPath, wave);

export default defineConfig({
  testDir: './tests', testMatch: '**/*.spec.ts', timeout: 90_000,
  expect: { timeout: 15_000 }, workers: 1, fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    viewport: { width: 1440, height: 900 },
    permissions: ['microphone'],
    launchOptions: { args: [
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${audioPath}`, '--autoplay-policy=no-user-gesture-required',
    ] },
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
});
