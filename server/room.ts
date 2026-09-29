import { Room, ServerError, type Client } from '@colyseus/core';
import type { GameService } from './game-service.ts';
import { AppError } from './errors.ts';

interface ClientAuth {
  userId: string;
  token: string;
}
export function createParkRoom(service: GameService) {
  let activeRoom: string | undefined;
  return class ParkRoom extends Room {
    autoDispose = false;
    maxMessagesPerSecond = 120;
    onCreate() {
      if (activeRoom) throw new ServerError(503, '公共大厅已经存在，请重新连接');
      activeRoom = this.roomId;
      // Capacity is checked by account identity in GameService, including reserved seats.
      // Setting maxClients would make joinOrCreate spawn an unwanted second park.
      this.onMessage('action', (client, message) => {
        const auth = client.auth as ClientAuth;
        void service.handle(auth.userId, client.sessionId, message);
      });
    }
    onAuth(_client: Client, options: unknown) {
      const token = (options as { token?: unknown } | null)?.token;
      const account = service.accounts.authenticate(token);
      if (!account) throw new ServerError(401, '登录已失效，请重新登录');
      return { userId: account.profile.id, token };
    }
    onJoin(client: Client) {
      this.attach(client);
    }
    private attach(client: Client) {
      const auth = client.auth as ClientAuth;
      if (!service.accounts.authenticate(auth.token)) {
        client.leave(4003);
        return;
      }
      try {
        service.connect(auth.userId, {
          id: client.sessionId,
          send: (type, value) => client.send(type, value),
          close: code => client.leave(code),
        });
      } catch (error) {
        client.send(
          'error',
          error instanceof AppError
            ? { code: error.code, message: error.message }
            : { code: 'connection_failed', message: '大厅连接失败' },
        );
        client.leave(4002);
      }
    }
    onDrop(client: Client) {
      service.disconnect((client.auth as ClientAuth).userId, client.sessionId);
      void this.allowReconnection(client, service.config.game.reconnectSeconds).catch(() => {});
    }
    onReconnect(client: Client) {
      this.attach(client);
    }
    onLeave(client: Client) {
      service.disconnect((client.auth as ClientAuth).userId, client.sessionId, true);
    }
    onDispose() {
      if (activeRoom === this.roomId) activeRoom = undefined;
    }
  };
}
