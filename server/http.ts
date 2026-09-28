import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { COLORS, MIN_PARTY_SIZE } from '../shared/protocol.ts';
import type { AccountStore } from './accounts.ts';
import type { AppConfig } from './config.ts';
import type { GameService } from './game-service.ts';
import { AppError, assert } from './errors.ts';
import { loginSchema, passwordSchema, profileSchema, usernameSchema } from './validation.ts';

export function createApi(accounts: AccountStore, service: GameService, config: AppConfig) {
  const router = express.Router();
  router.use(express.json({ limit: '8kb', strict: true }));
  router.use((_request, response, next) => { response.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/health', (_request, response) => response.json({ ok: true, online: service.onlineCount, parties: service.partyCount, games: service.worldCount, voiceAvailable: service.voice.available }));
  router.get('/config', (_request, response) => response.json({ characters: accounts.characters, colors: COLORS, minPartySize: MIN_PARTY_SIZE, maxPartySize: config.game.maxPartySize, voiceAvailable: service.voice.available }));

  const attempts = new Map<string, { count: number; expires: number }>();
  const authLimit: RequestHandler = (request, _response, next) => {
    const now = Date.now(), key = request.socket.remoteAddress || 'unknown';
    if (attempts.size > 1000) for (const [address, value] of attempts) if (value.expires <= now) attempts.delete(address);
    let value = attempts.get(key);
    if (!value || value.expires <= now) { value = { count: 0, expires: now + 60_000 }; attempts.set(key, value); }
    if (++value.count > 40) return next(new AppError('rate_limited', '账号操作过于频繁，请稍后再试', 429));
    next();
  };
  const requireAuth: RequestHandler = (request, response, next) => {
    const header = request.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    const account = accounts.authenticate(token);
    if (!account) return next(new AppError('unauthorized', '登录已失效，请使用已保存的账号和密码登录', 401));
    response.locals.account = account;
    next();
  };
  router.post('/account/guest', authLimit, async (_request, response) => response.status(201).json(await accounts.guest()));
  router.post('/account/login', authLimit, async (request, response) => {
    const result = loginSchema.safeParse(request.body);
    assert(result.success, 'invalid_request', '请输入账号和密码');
    response.json(await accounts.login(result.data.userId, result.data.password));
  });
  router.put('/account/username', authLimit, requireAuth, (request, response) => {
    const result = usernameSchema.safeParse(request.body);
    assert(result.success, 'invalid_request', '请输入用户名');
    response.json({ username: accounts.setUsername(response.locals.account.profile.id, result.data.username) });
  });
  router.patch('/account/profile', requireAuth, (request, response) => {
    const result = profileSchema.safeParse(request.body);
    assert(result.success, 'invalid_request', '资料字段无效');
    response.json({ profile: accounts.updateProfile(response.locals.account.profile.id, result.data) });
  });
  router.post('/account/password', authLimit, requireAuth, async (request, response) => {
    const result = passwordSchema.safeParse(request.body);
    assert(result.success, 'invalid_request', '请输入当前密码和新密码');
    response.json(await accounts.changePassword(response.locals.account.profile.id, result.data.currentPassword, result.data.newPassword));
  });
  router.use((_request, response) => response.status(404).json({ error: '接口不存在' }));
  const errors: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof AppError) { response.status(error.status).json({ error: error.message }); return; }
    if (error instanceof SyntaxError || error?.type === 'entity.too.large') { response.status(error?.type === 'entity.too.large' ? 413 : 400).json({ error: '请求内容无效或超过大小限制' }); return; }
    console.error('HTTP request failed:', error);
    response.status(500).json({ error: '服务器暂时无法完成操作' });
  };
  router.use(errors);
  return router;
}
