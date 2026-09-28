import { useCallback, useEffect, useRef, useState } from 'react';
import { Client, type Room } from '@colyseus/sdk';
import type { AuthResult, CharacterOption, ClientMessage, Credentials, ErrorNotice, PlayerProfile, SocialState, VoiceGrant, WorldSnapshot } from '../../shared/protocol';
import { COLORS, DEFAULT_MAX_PARTY_SIZE, MIN_PARTY_SIZE } from '../../shared/protocol';
import { diagnosticBreadcrumb, reportClientError, setDiagnosticContext } from './diagnostics';

const CREDENTIAL_KEY = 'catpark.credentials.v1';
/** Set once the player has dismissed or completed the username prompt for this account. */
const USERNAME_PROMPT_KEY = 'catpark.username-prompt.v1';
export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function api<T>(path: string, body?: unknown, token?: string, method = 'POST'): Promise<T> {
  const started = performance.now();
  try {
    const response = await fetch(path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json().catch(() => null);
    diagnosticBreadcrumb('http.response', { path, method, status: response.status, elapsedMs: Math.round(performance.now() - started) });
    if (!response.ok) throw new ApiError(data?.error || `请求失败（${response.status}），请重试`, response.status);
    if (data === null) throw new Error('服务器返回了无效 JSON');
    return data as T;
  } catch (error) { reportClientError('http.request', error, { path, method, elapsedMs: Math.round(performance.now() - started) }); throw error; }
}
function readCredentials(): Credentials | null {
  try { const value = JSON.parse(localStorage.getItem(CREDENTIAL_KEY) || 'null'); return value && typeof value.userId === 'string' && typeof value.password === 'string' ? value : null; } catch { return null; }
}
export interface ParkConfig { characters: CharacterOption[]; colors: readonly string[]; minPartySize: number; maxPartySize: number; voiceAvailable: boolean }
export function usePark() {
  const [credentials, setCredentials] = useState<Credentials | null>(readCredentials);
  const [auth, setAuth] = useState<AuthResult | null>(null);
  const [status, setStatus] = useState<'loading' | 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'recovery'>('loading');
  const [social, setSocial] = useState<SocialState | null>(null);
  const [world, setWorld] = useState<WorldSnapshot | null>(null);
  const [grant, setGrant] = useState<VoiceGrant | null>(null);
  const [notice, setNotice] = useState('');
  const [authError, setAuthError] = useState('');
  const [username, setUsernameState] = useState<string | null>(null);
  const [usernamePrompt, setUsernamePrompt] = useState(false);
  const [config, setConfig] = useState<ParkConfig>({ characters: [], colors: COLORS, minPartySize: MIN_PARTY_SIZE, maxPartySize: DEFAULT_MAX_PARTY_SIZE, voiceAvailable: false });
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const room = useRef<Room | null>(null);
  const statusRef = useRef(status); statusRef.current = status;
  const mounted = useRef(true);
  const acceptAuth = useCallback((result: AuthResult, saved?: Credentials) => {
    setDiagnosticContext({ userId: result.profile.id, nickname: result.profile.nickname }, result.token);
    const next = result.credentials || saved;
    if (next) {
      setCredentials(next);
      try { localStorage.setItem(CREDENTIAL_KEY, JSON.stringify(next)); } catch { setNotice('浏览器未允许保存账号，请在设置中记下 ID 和密码，以免丢失。'); }
    }
    setAuth(result); setAuthError(''); setStatus('connecting'); setUsernameState(result.username);
    let dismissed: string | null = null;
    try { dismissed = localStorage.getItem(USERNAME_PROMPT_KEY); } catch { /* Prompt again when storage is unavailable. */ }
    setUsernamePrompt(!result.username && dismissed !== result.profile.id);
  }, []);
  const login = useCallback(async (saved: Credentials) => {
    // The login field also accepts a username; the browser always keeps the stable user ID.
    const result = await api<AuthResult>('/api/account/login', saved); acceptAuth(result, { userId: result.profile.id, password: saved.password });
  }, [acceptAuth]);
  const createGuest = useCallback(async () => {
    const result = await api<AuthResult>('/api/account/guest'); acceptAuth(result);
  }, [acceptAuth]);
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try { const saved = readCredentials(); if (saved) await login(saved); else await createGuest(); }
      catch (error) { if (mounted.current) { setAuthError(error instanceof Error ? error.message : '暂时无法进入公园'); setStatus('recovery'); } }
    })();
    void api<ParkConfig>('/api/config', undefined, undefined, 'GET').then(setConfig).catch(() => {
      void fetch('/game/catalog.json').then(r => r.json()).then(data => setConfig(c => ({ ...c, characters: data.characters || [] }))).catch(() => undefined);
    });
    return () => { mounted.current = false; };
  }, [createGuest, login]);
  useEffect(() => {
    if (!auth) return;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let active: Room | null = null;
    let attempts = 0;
    const client = new Client(window.location.origin);
    const connect = async () => {
      try {
        if (disposed) return;
        setStatus(attempts ? 'reconnecting' : 'connecting');
        const joined = await client.joinOrCreate('park', { token: auth.token });
        if (disposed) { void joined.leave(); return; }
        active = joined; room.current = joined; attempts = 0; setStatus('connected');
        diagnosticBreadcrumb('park.connected', { roomId: joined.roomId, connectionId: joined.sessionId });
        joined.onMessage<SocialState>('social', value => { if (!disposed) setSocial(value); });
        joined.onMessage<WorldSnapshot>('world', value => { if (!disposed) setWorld(value); });
        joined.onMessage<VoiceGrant>('voice', value => { if (!disposed) setGrant(value); });
        joined.onMessage<ErrorNotice>('error', value => { if (!disposed) { reportClientError('park.server-error', value.message, value); setNotice(value.message); } });
        joined.onDrop(() => { if (!disposed) setStatus('reconnecting'); });
        joined.onReconnect(() => { if (!disposed) { setStatus('connected'); setGrant(null); } });
        joined.onError((code, message) => { if (!disposed) { reportClientError('park.socket', message || '连接发生错误', { code }); setNotice(message || '连接发生错误，正在尝试恢复'); } });
        joined.onLeave((_code, reason) => {
          if (disposed) return;
          reportClientError('park.disconnected', reason || '游戏连接断开', { code: _code });
          room.current = null; setStatus('offline'); setGrant(null);
          if (reason) setNotice(reason);
          retry = setTimeout(() => { attempts++; void connect(); }, 1600);
        });
      } catch (error) {
        if (disposed) return;
        reportClientError('park.connect', error, { attempts });
        const message = error instanceof Error ? error.message : '公园暂时无法连接';
        setNotice(message); setStatus('offline');
        attempts++; retry = setTimeout(() => void connect(), Math.min(1000 * 2 ** attempts, 10000));
      }
    };
    setSocial(null); setGrant(null); void connect();
    return () => { disposed = true; clearTimeout(retry); room.current = null; active?.removeAllListeners(); void active?.leave(); };
  }, [auth?.token, connectionAttempt]);
  const send = useCallback((message: ClientMessage) => {
    if (room.current && statusRef.current === 'connected') { room.current.send('action', message); return true; }
    if (message.type !== 'input' && message.type !== 'mic') setNotice('正在连接公园，连接恢复后再试一次');
    return false;
  }, []);
  const updateProfile = useCallback(async (profile: Partial<PlayerProfile>) => {
    const result = await api<{ profile: PlayerProfile }>('/api/account/profile', profile, auth?.token, 'PATCH');
    setAuth(old => old ? { ...old, profile: result.profile } : old);
    setDiagnosticContext({ nickname: result.profile.nickname });
    return result.profile;
  }, [auth?.token]);
  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const result = await api<AuthResult>('/api/account/password', { currentPassword, newPassword }, auth?.token);
    acceptAuth(result, { userId: result.profile.id, password: newPassword });
  }, [auth?.token, acceptAuth]);
  const setUsername = useCallback(async (value: string) => {
    const result = await api<{ username: string }>('/api/account/username', { username: value }, auth?.token, 'PUT');
    setUsernameState(result.username);
    return result.username;
  }, [auth?.token]);
  const dismissUsernamePrompt = useCallback(() => {
    setUsernamePrompt(false);
    try { if (auth) localStorage.setItem(USERNAME_PROMPT_KEY, auth.profile.id); } catch { /* Only this session hides the prompt. */ }
  }, [auth?.profile.id]);
  return { auth, credentials, username, setUsername, usernamePrompt, dismissUsernamePrompt, status, social, world, grant, notice, authError, config, send, login, createGuest, updateProfile, changePassword, setNotice, clearNotice: () => setNotice(''), reconnect: () => setConnectionAttempt(n => n + 1) };
}
