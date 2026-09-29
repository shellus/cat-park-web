import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import compression from 'compression';
import express from 'express';
import { z } from 'zod';
import type { CharacterOption } from '../shared/protocol.ts';
import { AccountStore } from './accounts.ts';
import { loadConfig, PROJECT_ROOT, type AppConfig } from './config.ts';
import { GameService } from './game-service.ts';
import { createApi } from './http.ts';
import { createParkRoom } from './room.ts';
import { loadSimulation, type SimulationFactory } from './simulation.ts';
import { LiveKitVoice, type VoiceService } from './voice.ts';
import { createDiagnosticsApi, diagnosticDirectory, DiagnosticStore } from './diagnostics.ts';

export interface BackendOptions {
  config?: AppConfig;
  characters?: CharacterOption[];
  simulationFactory?: SimulationFactory;
  voice?: VoiceService;
  accounts?: AccountStore;
  root?: string;
  frontend?: 'development' | 'production' | 'none';
  diagnostics?: DiagnosticStore;
}
function readCatalog(root: string): CharacterOption[] {
  const file = resolve(root, 'public/game/catalog.json');
  if (!existsSync(file)) throw new Error('找不到 public/game/catalog.json，请先运行 npm run assets');
  return z
    .object({
      characters: z
        .array(z.object({ id: z.string().min(1), name: z.string().min(1), preview: z.string().min(1) }))
        .min(1),
    })
    .parse(JSON.parse(readFileSync(file, 'utf8'))).characters;
}
export async function createBackend(options: BackendOptions = {}) {
  const root = options.root || PROJECT_ROOT;
  const config = options.config || loadConfig(root);
  const accounts = options.accounts || new AccountStore(config.database.path, options.characters || readCatalog(root));
  const voice = options.voice || new LiveKitVoice(config.voice);
  const simulationFactory = options.simulationFactory || loadSimulation;
  let lobby;
  try {
    lobby = await simulationFactory('lobby');
  } catch (error) {
    voice.close();
    if (!options.accounts) accounts.close();
    throw error;
  }
  const service = new GameService(accounts, config, voice, lobby, simulationFactory);
  const app = express();
  app.disable('x-powered-by');
  // content.json and scripts are text-heavy; images and audio are already compressed and skipped.
  app.use(compression());
  const diagnostics =
    options.diagnostics ||
    new DiagnosticStore(
      diagnosticDirectory(
        config.database.path === ':memory:' ? resolve(root, '.runtime/game.sqlite') : config.database.path,
      ),
    );
  app.use('/api/client-errors', createDiagnosticsApi(accounts, diagnostics));
  app.use('/api', createApi(accounts, service, config));
  const httpServer = createServer(app);
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer, maxPayload: 8192, pingInterval: 5000, pingMaxRetries: 2 }),
    gracefullyShutdown: false,
    greet: false,
  });
  gameServer.define('park', createParkRoom(service));
  let vite: { close(): Promise<void> } | undefined;
  if (options.frontend === 'development') {
    const { createServer: createViteServer } = await import('vite');
    // Colyseus owns the HTTP server's WebSocket upgrade path. Keep Vite's
    // browser HMR socket disabled in this integrated dev server; otherwise
    // HMR frames can be consumed by the game WebSocket transport and crash
    // the process. Source edits still take effect after a browser refresh.
    const dev = await createViteServer({
      root,
      server: { middlewareMode: true, hmr: false, allowedHosts: config.server.allowedHosts },
      appType: 'spa',
    });
    vite = dev;
    app.use(dev.middlewares);
  } else if (options.frontend === 'production') {
    const dist = resolve(root, 'dist');
    if (!existsSync(resolve(dist, 'index.html'))) throw new Error('找不到 dist/index.html，请先运行 npm run build');
    // Vite bundles and generated game assets are content-hashed and never change in place.
    app.use(
      express.static(dist, {
        setHeaders(response, file) {
          response.setHeader(
            'Cache-Control',
            /[\\/](assets|game[\\/]assets)[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
          );
        },
      }),
    );
    app.get('/{*path}', (_request, response) => response.sendFile(resolve(dist, 'index.html')));
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  let voiceTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  return {
    app,
    accounts,
    service,
    config,
    httpServer,
    gameServer,
    async listen() {
      await gameServer.listen(config.server.port, config.server.host);
      await matchMaker.createRoom('park', {});
      let previous = performance.now(),
        accumulator = 0,
        networkElapsed = 0;
      timer = setInterval(() => {
        const now = performance.now();
        accumulator += Math.min((now - previous) / 1000, 0.1);
        previous = now;
        while (accumulator >= 1 / 60) {
          service.step(1 / 60);
          accumulator -= 1 / 60;
          networkElapsed += 1 / 60;
        }
        if (networkElapsed >= 1 / 20) {
          service.sendWorlds();
          networkElapsed = 0;
        }
      }, 1000 / 60);
      voiceTimer = setInterval(() => {
        void service.checkVoice();
      }, 3000);
      const address = httpServer.address();
      return typeof address === 'object' && address ? address.port : config.server.port;
    },
    async close() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clearInterval(voiceTimer);
      await vite?.close();
      await gameServer.gracefullyShutdown(false);
      service.dispose();
      await diagnostics.close();
      if (!options.accounts) accounts.close();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const backend = await createBackend({
      frontend: process.argv.includes('--production') ? 'production' : 'development',
    });
    const port = await backend.listen();
    console.log(
      `萌猫公园已启动：http://${backend.config.server.host}:${port}，语音${backend.config.voice ? '已配置' : '未配置'}`,
    );
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      await backend.close();
    };
    process.once('SIGINT', () => {
      void shutdown();
    });
    process.once('SIGTERM', () => {
      void shutdown();
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
