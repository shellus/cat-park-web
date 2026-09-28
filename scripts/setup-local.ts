import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadConfig, type AppConfig } from '../server/config.ts';

export const LIVEKIT_VERSION = '1.13.7';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const runtime = path.join(root, '.runtime');
export const livekitBinary = path.join(runtime, 'livekit', process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server');

function isLoopbackHost(hostname: string) {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}

function localVoiceEnabled(voice: AppConfig['voice']) {
  if (!voice) return false;
  if (voice.local) return voice.local.enabled;
  return isLoopbackHost(new URL(voice.url).hostname);
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`下载失败 ${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function setupLocal(): Promise<{ localVoice: boolean }> {
  await mkdir(runtime, { recursive: true });
  const configPath = path.join(root, 'config.yaml');
  if (!existsSync(configPath)) {
    const config = {
      version: 1,
      server: { host: '127.0.0.1', port: 3000 },
      database: { path: 'data/game.sqlite' },
      game: { maxPartySize: 6, maxPlayers: 64, reconnectSeconds: 30 },
      voice: { url: 'ws://localhost:7880', apiUrl: 'http://127.0.0.1:7880', apiKey: `local_${randomBytes(12).toString('hex')}`, apiSecret: randomBytes(32).toString('hex') },
    };
    await writeFile(configPath, YAML.stringify(config), { flag: 'wx', mode: 0o600 });
    console.log('已生成本地 config.yaml（现有配置不会被覆盖）。');
  }
  const config = loadConfig(root);
  const voice = config.voice;
  if (!voice || !localVoiceEnabled(voice)) return { localVoice: false };
  if (!voice.apiKey || !voice.apiSecret) throw new Error('本地语音配置需要 apiKey 和 apiSecret。');
  const local = voice.local || { enabled: true, nodeIp: '127.0.0.1', tcpPort: 7881, udpPort: 7882 };
  const apiUrl = new URL(voice.apiUrl || 'http://127.0.0.1:7880');
  await writeFile(path.join(runtime, 'livekit.yaml'), YAML.stringify({
    port: Number(apiUrl.port || 7880),
    bind_addresses: ['127.0.0.1'],
    rtc: { tcp_port: local.tcpPort, udp_port: local.udpPort, use_external_ip: false, node_ip: local.nodeIp },
    keys: { [voice.apiKey]: voice.apiSecret },
    logging: { level: 'warn' },
  }), { mode: 0o600 });
  if (!existsSync(livekitBinary)) {
    if (!['win32', 'linux'].includes(process.platform)) throw new Error('此平台请自行配置 LiveKit 服务。');
    const platform = process.platform === 'win32' ? 'windows' : process.platform;
    const arch = process.arch === 'x64' ? 'amd64' : process.arch;
    const extension = process.platform === 'win32' ? 'zip' : 'tar.gz';
    const name = `livekit_${LIVEKIT_VERSION}_${platform}_${arch}.${extension}`;
    const base = `https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}`;
    console.log(`下载本地语音服务 LiveKit ${LIVEKIT_VERSION}…`);
    const [archive, sums] = await Promise.all([download(`${base}/${name}`), download(`${base}/checksums.txt`)]);
    const expected = sums.toString('utf8').split('\n').find(line => line.trim().endsWith(name))?.trim().split(/\s+/)[0];
    if (!expected || createHash('sha256').update(archive).digest('hex') !== expected) throw new Error('LiveKit SHA-256 校验失败。');
    const target = path.join(runtime, 'livekit');
    await mkdir(target, { recursive: true });
    const archivePath = path.join(target, name);
    await writeFile(archivePath, archive);
    const unpack = process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:CATPARK_ARCHIVE -DestinationPath $env:CATPARK_TARGET -Force'], { windowsHide: true, stdio: 'inherit', env: { ...process.env, CATPARK_ARCHIVE: archivePath, CATPARK_TARGET: target } })
      : spawnSync('tar', ['-xzf', archivePath, '-C', target], { stdio: 'inherit' });
    if (unpack.status !== 0 || !existsSync(livekitBinary)) throw new Error('LiveKit 解压失败。');
  }
  return { localVoice: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setupLocal().then(() => console.log('本地运行配置已就绪。')).catch(error => { console.error(error.message); process.exitCode = 1; });
}
