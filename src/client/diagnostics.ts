import type { ClientDiagnostic } from '../../shared/diagnostics';

const endpoint = '/api/client-errors', storageKey = 'catpark.diagnostics.v1';
const maxQueue = 20, maxEventBytes = 48_000;
const sessionId = crypto.randomUUID();
const context: Record<string, unknown> = {};
const breadcrumbs: ClientDiagnostic['breadcrumbs'] = [];
const duplicates = new Map<string, number>();
let queue: ClientDiagnostic[] = [], authToken = '', installed = false, flushing = false;
let timer: ReturnType<typeof setTimeout> | undefined, retryDelay = 2000;

/** Bounded snapshots avoid circular SDK objects; credentials/audio are never submitted. */
export function diagnosticValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 8000);
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  if (depth > 5) return '[depth limit]';
  seen.add(value);
  if (value instanceof Error) return {
    name: value.name, message: value.message, stack: value.stack,
    ...Object.fromEntries(Object.entries(value).map(([key, item]) => [key, diagnosticValue(item, depth + 1, seen)])),
    cause: diagnosticValue(value.cause, depth + 1, seen),
  };
  if (value instanceof Event) return Object.fromEntries(['type', 'errorCode', 'errorText', 'url', 'address', 'port'].map(key => [key, (value as unknown as Record<string, unknown>)[key]]));
  if (Array.isArray(value)) return value.slice(0, 40).map(item => diagnosticValue(item, depth + 1, seen));
  return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key, diagnosticValue(item, depth + 1, seen)]));
}

export function setDiagnosticContext(values: Record<string, unknown>, token?: string) {
  Object.assign(context, values);
  if (token !== undefined) authToken = token;
}
export function diagnosticBreadcrumb(source: string, details: unknown = {}) {
  try {
    breadcrumbs.push({ at: new Date().toISOString(), source, details: diagnosticValue(details) });
    if (breadcrumbs.length > 30) breadcrumbs.shift();
  } catch { /* A diagnostic snapshot must never interrupt an SDK callback. */ }
}
function environment() {
  const connection = (navigator as Navigator & { connection?: { effectiveType?: string; type?: string; downlink?: number; rtt?: number; saveData?: boolean } }).connection;
  return {
    url: location.href.slice(0, 8000), userAgent: navigator.userAgent, language: navigator.language,
    online: navigator.onLine, secureContext: window.isSecureContext, visibility: document.visibilityState,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    network: connection && { effectiveType: connection.effectiveType, type: connection.type, downlink: connection.downlink, rtt: connection.rtt, saveData: connection.saveData },
  };
}
function persist() { try { localStorage.setItem(storageKey, JSON.stringify(queue)); } catch { /* Memory queue remains usable. */ } }
function schedule(delay = 300) {
  if (timer || !queue.length) return;
  timer = setTimeout(() => { timer = undefined; void flushDiagnostics(); }, delay);
}
export function reportClientError(source: string, error: unknown, details: unknown = {}): string | undefined {
  try {
    const message = (error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(diagnosticValue(error))) || 'Unknown error';
    const target = details && typeof details === 'object' ? (details as { url?: unknown; path?: unknown }).url ?? (details as { path?: unknown }).path ?? '' : '';
    const key = `${source}:${message}:${String(target)}`, now = Date.now();
    if (now - (duplicates.get(key) ?? 0) < 15_000) return;
    duplicates.set(key, now);
    if (duplicates.size > 100) duplicates.delete(duplicates.keys().next().value!);
    const event: ClientDiagnostic = {
      id: crypto.randomUUID(), sessionId, occurredAt: new Date(now).toISOString(),
      build: import.meta.env.VITE_APP_BUILD || 'development', source: source.slice(0, 100), message: message.slice(0, 8000),
      stack: error instanceof Error ? error.stack?.slice(0, 16000) : undefined,
      context: diagnosticValue(context) as Record<string, unknown>, environment: environment(),
      details: { error: diagnosticValue(error), data: diagnosticValue(details) }, breadcrumbs: [...breadcrumbs],
    };
    // Keep the error and current state first when a noisy SDK context exceeds keepalive limits.
    while (new Blob([JSON.stringify(event)]).size > maxEventBytes && event.breadcrumbs.length) event.breadcrumbs.shift();
    if (new Blob([JSON.stringify(event)]).size > maxEventBytes) event.details = { truncated: true, preview: JSON.stringify(event.details).slice(0, 8000) };
    queue.push(event); queue = queue.slice(-maxQueue); persist(); schedule();
    return event.id;
  } catch { return undefined; }
}
/** User-triggered report with the current state; returns a short code the player can pass on. */
export async function sendDebugReport(details: unknown): Promise<string> {
  const code = crypto.randomUUID().slice(0, 6).toUpperCase();
  duplicates.delete(`debug.report:${code}:`);
  reportClientError('debug.report', `用户提交的调试报告 ${code}`, { code, ...(details as object) });
  for (let i = 0; i < 20 && queue.some(item => item.source === 'debug.report'); i++) { await flushDiagnostics(); await new Promise(resolve => setTimeout(resolve, 300)); }
  if (queue.some(item => item.source === 'debug.report')) throw new Error('报告暂未送达，联网后会自动补传');
  return code;
}
export async function flushDiagnostics() {
  if (flushing || !queue.length || !navigator.onLine) return;
  flushing = true;
  const event = queue[0];
  try {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000);
    let response: Response;
    try {
      response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, authToken }), keepalive: true, signal: controller.signal });
    } finally { clearTimeout(timeout); }
    if (response.ok || [400, 413, 422].includes(response.status)) {
      queue = queue.filter(item => item.id !== event.id); persist(); retryDelay = 2000;
    } else retryDelay = Math.min(retryDelay * 2, 60_000);
  } catch { retryDelay = Math.min(retryDelay * 2, 60_000); }
  finally { flushing = false; schedule(retryDelay); }
}
function beacon() {
  if (!queue.length) return;
  try {
    // Keep queued until a later fetch acknowledgement; the server deduplicates beacon retries.
    navigator.sendBeacon(endpoint, new Blob([JSON.stringify({ event: queue[0], authToken })], { type: 'application/json' }));
  } catch { /* Persisted queue retries on the next page load. */ }
}
export function installDiagnostics() {
  if (installed) return;
  installed = true;
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]');
    if (Array.isArray(stored)) queue = stored.filter(item => item && typeof item.id === 'string' && typeof item.source === 'string').slice(-maxQueue);
  } catch { /* Broken/disabled storage must never prevent bootstrap. */ }
  window.addEventListener('error', (event: Event) => {
    if (event instanceof ErrorEvent) reportClientError('window.error', event.error || event.message, { file: event.filename, line: event.lineno, column: event.colno });
    else {
      const element = event.target as HTMLScriptElement | HTMLLinkElement | HTMLImageElement | null;
      if (element && element !== (window as unknown)) reportClientError('resource.error', '资源加载失败', { tag: element.tagName, url: 'src' in element ? element.src : 'href' in element ? element.href : undefined });
    }
  }, true);
  window.addEventListener('unhandledrejection', event => reportClientError('unhandledrejection', event.reason));
  window.addEventListener('online', () => { diagnosticBreadcrumb('network.online'); retryDelay = 2000; void flushDiagnostics(); });
  window.addEventListener('offline', () => diagnosticBreadcrumb('network.offline'));
  window.addEventListener('pagehide', beacon);
  document.addEventListener('visibilitychange', () => { diagnosticBreadcrumb('page.visibility', document.visibilityState); if (document.hidden) beacon(); });
  const consoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    consoleError(...args);
    try { reportClientError('console.error', args.find(arg => arg instanceof Error) ?? args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(diagnosticValue(arg))).join(' '), { arguments: args }); }
    catch { /* Preserve console behavior even for objects with throwing getters. */ }
  };
  diagnosticBreadcrumb('page.start'); schedule();
}
