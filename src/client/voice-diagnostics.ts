import { LoggerNames, LogLevel, Room, RoomEvent, setLogExtension, setLogLevel } from 'livekit-client';
import { diagnosticBreadcrumb, diagnosticValue, reportClientError } from './diagnostics';

let loggingInstalled = false;
function installVoiceLogging() {
  if (loggingInstalled) return;
  loggingInstalled = true;
  // ICE debug is small and useful before getStats exists; do not enable SDP/token-heavy signalling debug.
  setLogLevel(LogLevel.debug, LoggerNames.ICE);
  setLogExtension((level, message, details) => {
    diagnosticBreadcrumb('voice.sdk', { level, message, details });
    if (level >= LogLevel.warn) reportClientError('voice.sdk', message, details);
  });
}

/** Isolate SDK transport inspection here; never replace native WebRTC or SDK callbacks. */
export function observeVoice(room: Room, url: string, partyId: string) {
  installVoiceLogging();
  const attemptId = crypto.randomUUID(),
    startedAt = performance.now();
  let stage = 'connecting',
    stopped = false,
    sampling = false;
  let latest: unknown = null;
  const history: unknown[] = [];
  const snapshot = () => ({
    attemptId,
    url,
    partyId,
    stage,
    roomState: room.state,
    roomName: room.name,
    elapsedMs: Math.round(performance.now() - startedAt),
    latest,
    history: [...history],
  });
  const sample = async () => {
    if (stopped || sampling) return;
    sampling = true;
    try {
      const manager = room.engine?.pcManager;
      if (!manager) return;
      const transports = await Promise.all(
        (['publisher', 'subscriber'] as const).map(async kind => {
          const transport = manager[kind];
          if (!transport) return { kind, available: false };
          const state = {
            kind,
            connection: transport.getConnectionState(),
            ice: transport.getICEConnectionState(),
            signalling: transport.getSignallingState(),
          };
          const report = await transport.getStats();
          const stats: unknown[] = [];
          report?.forEach(value => {
            if (['transport', 'candidate-pair', 'local-candidate', 'remote-candidate'].includes(value.type))
              stats.push(value);
          });
          return { ...state, stats: stats.slice(0, 40) };
        }),
      );
      if (stopped) return;
      latest = diagnosticValue({ at: new Date().toISOString(), transports });
      history.push({
        at: new Date().toISOString(),
        states: transports.map(({ kind, ...item }) => ({
          kind,
          ...('connection' in item
            ? { connection: item.connection, ice: item.ice, signalling: item.signalling }
            : item),
        })),
      });
      if (history.length > 8) history.shift();
    } catch (error) {
      diagnosticBreadcrumb('voice.stats-unavailable', error);
    } finally {
      sampling = false;
    }
  };
  const change = (next: string, details: unknown = {}) => {
    stage = next;
    diagnosticBreadcrumb(`voice.${next}`, { attemptId, partyId, details });
    void sample();
  };
  const signal = () => change('signal-connected');
  const connected = () => change('media-connected');
  const reconnecting = () => change('reconnecting');
  const state = (value: unknown) => {
    diagnosticBreadcrumb('voice.state', { attemptId, value });
    void sample();
  };
  room
    .on(RoomEvent.SignalConnected, signal)
    .on(RoomEvent.Connected, connected)
    .on(RoomEvent.Reconnecting, reconnecting)
    .on(RoomEvent.ConnectionStateChanged, state);
  diagnosticBreadcrumb('voice.connect-start', { attemptId, url, partyId });
  const timer = setInterval(() => void sample(), 1000);
  return {
    snapshot,
    fail(source: string, error: unknown, details: unknown = {}) {
      return reportClientError(source, error, { ...snapshot(), details });
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      room
        .off(RoomEvent.SignalConnected, signal)
        .off(RoomEvent.Connected, connected)
        .off(RoomEvent.Reconnecting, reconnecting)
        .off(RoomEvent.ConnectionStateChanged, state);
    },
  };
}
