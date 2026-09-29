import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.ts';
import { setupLocal, livekitBinary, runtime } from './setup-local.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children: ChildProcess[] = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
for (const event of ['SIGINT', 'SIGTERM'] as const) process.on(event, () => stop());

try {
  const { localVoice } = await setupLocal();
  const config = loadConfig(root);
  if (localVoice) {
    if (!config.voice) throw new Error('本地语音已启用但缺少 voice 配置。');
    const voice = spawn(livekitBinary, ['--config', path.join(runtime, 'livekit.yaml')], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    });
    children.push(voice);
    voice.on('error', error => {
      console.error(error.message);
      stop(1);
    });
    voice.on('exit', code => {
      if (!stopping) {
        console.error('本地语音服务已停止。');
        stop(code || 1);
      }
    });
    let ready = false;
    for (let i = 0; i < 40 && !stopping; i++) {
      try {
        const response = await fetch(config.voice.apiUrl || config.voice.url.replace(/^ws/, 'http'), {
          signal: AbortSignal.timeout(700),
        });
        ready = response.ok;
      } catch {
        /* readiness retry */
      }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!ready) throw new Error('LiveKit 未能就绪，请检查 .runtime/livekit.yaml 的监听地址及端口占用。');
  }
  if (!stopping) {
    // npm start serves the built bundle (compressed, cache-friendly); --dev keeps Vite for local edits.
    const mode = process.argv.includes('--dev') ? [] : ['--production'];
    const app = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts', ...mode], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    });
    children.push(app);
    app.on('error', error => {
      console.error(error.message);
      stop(1);
    });
    app.on('exit', code => stop(code || 0));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  stop(1);
}
