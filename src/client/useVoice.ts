import { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectionState, LocalAudioTrack, Room, RoomEvent, Track } from 'livekit-client';
import type { ClientMessage, MicReport, MicStatus, VoiceGrant } from '../../shared/protocol';
import { diagnosticBreadcrumb, reportClientError } from './diagnostics';
import { observeVoice } from './voice-diagnostics';

export interface VoiceState {
  report: MicReport;
  level: number;
  playbackBlocked: boolean;
  devices: MediaDeviceInfo[];
  deviceId: string;
}
const idleReport: MicReport = {
  status: 'unchecked',
  message: '入队后开启麦克风',
  hasSignal: false,
  voiceConnected: false,
  published: false,
};
const initialState: VoiceState = { report: idleReport, level: 0, playbackBlocked: false, devices: [], deviceId: '' };

class TeamVoice {
  private room: Room | null = null;
  private stream: MediaStream | null = null;
  private track: LocalAudioTrack | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private meter: ReturnType<typeof setInterval> | undefined;
  private generation = 0;
  private captureGeneration = 0;
  private publishing: Promise<void> | null = null;
  private busy = false;
  private connecting = false;
  private published = false;
  private signal = false;
  private samples = 0;
  private playbackBlocked = false;
  private fault: { status: MicStatus; message: string } | null = null;
  private devices: MediaDeviceInfo[] = [];
  private deviceId = '';
  private audioElements = new Set<HTMLMediaElement>();
  private lastReport = '';
  private level = 0;
  private diagnostics?: ReturnType<typeof observeVoice>;
  constructor(private changed: (value: VoiceState) => void) {}

  private emit() {
    const connected = this.room?.state === ConnectionState.Connected;
    let status: MicStatus = 'unchecked';
    let message = '点击开启麦克风，和队友打个招呼';
    if (this.fault) ({ status, message } = this.fault);
    else if (this.busy) {
      status = 'checking';
      message = '请允许浏览器使用麦克风';
    } else if (this.connecting || (this.track && !connected)) {
      status = 'connecting';
      message = '正在连接队伍语音';
    } else if (this.track?.mediaStreamTrack.readyState === 'ended') {
      status = 'missing';
      message = '麦克风已断开，请重新检查';
    } else if (
      this.track?.isMuted ||
      this.track?.mediaStreamTrack.muted ||
      (this.track && !this.track.mediaStreamTrack.enabled)
    ) {
      status = 'muted';
      message = '麦克风已静音';
    } else if (this.track && (this.playbackBlocked || this.context?.state !== 'running')) {
      status = 'error';
      message = '点击开启声音，浏览器暂停了音频';
    } else if (this.track && !this.signal) {
      status = 'silent';
      message = '请说一句话，检测麦克风声音';
    } else if (this.track && connected && this.published && this.signal) {
      status = 'ok';
      message = '队伍语音已连接';
    } else if (this.track) {
      status = 'connecting';
      message = '正在发布麦克风声音';
    }
    const report: MicReport = {
      status,
      message,
      hasSignal: this.signal,
      voiceConnected: connected,
      published: this.published,
    };
    const signature = JSON.stringify(report);
    if (signature !== this.lastReport || this.level !== 0) {
      this.lastReport = signature;
      this.changed({
        report,
        level: this.level,
        playbackBlocked: this.playbackBlocked || (!!this.context && this.context.state !== 'running'),
        devices: this.devices,
        deviceId: this.deviceId,
      });
    }
  }
  /** Everything needed to diagnose a device remotely; attached to a user-triggered debug report. */
  async debugSnapshot() {
    let permission: string | undefined;
    try {
      permission = (await navigator.permissions?.query({ name: 'microphone' as PermissionName }))?.state;
    } catch {
      /* Not supported on every browser. */
    }
    const track = this.track?.mediaStreamTrack;
    return {
      permission,
      secureContext: window.isSecureContext,
      mediaDevices: Boolean(navigator.mediaDevices?.getUserMedia),
      devices: this.devices.map(device => ({
        deviceId: device.deviceId,
        label: device.label,
        groupId: device.groupId,
      })),
      deviceId: this.deviceId,
      track: track && {
        readyState: track.readyState,
        enabled: track.enabled,
        muted: track.muted,
        settings: track.getSettings(),
      },
      audioContext: this.context?.state,
      level: this.level,
      samples: this.samples,
      signal: this.signal,
      published: this.published,
      busy: this.busy,
      connecting: this.connecting,
      fault: this.fault,
      playbackBlocked: this.playbackBlocked,
      room: this.room && {
        state: this.room.state,
        name: this.room.name,
        canPlaybackAudio: this.room.canPlaybackAudio,
        remoteParticipants: this.room.numParticipants,
      },
      transport: this.diagnostics?.snapshot(),
    };
  }
  unavailable() {
    this.fault = { status: 'error', message: '队伍语音暂时不可用，暂不能准备' };
    this.emit();
  }
  private async enumerate() {
    try {
      this.devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
      this.lastReport = '';
      this.emit();
    } catch {
      /* Permissions may hide device labels. */
    }
  }
  private stopCapture() {
    clearInterval(this.meter);
    this.meter = undefined;
    this.stream?.getTracks().forEach(track => track.stop());
    this.track?.stop();
    this.track = null;
    this.stream = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.analyser = null;
    this.published = false;
    this.signal = false;
    this.samples = 0;
    this.level = 0;
  }
  stop() {
    this.generation++;
    this.captureGeneration++;
    this.busy = false;
    this.connecting = false;
    this.diagnostics?.stop();
    this.diagnostics = undefined;
    this.room?.removeAllListeners();
    void this.room?.disconnect();
    this.room = null;
    this.stopCapture();
    this.audioElements.forEach(element => element.remove());
    this.audioElements.clear();
    this.fault = null;
    this.playbackBlocked = false;
    this.lastReport = '';
    this.emit();
  }
  async connect(grant: VoiceGrant) {
    if (this.room && (this.connecting || this.room.state === ConnectionState.Connected)) return;
    const generation = this.generation;
    this.diagnostics?.stop();
    this.room?.removeAllListeners();
    void this.room?.disconnect();
    const room = new Room({ adaptiveStream: false, dynacast: false });
    const diagnostics = (this.diagnostics = observeVoice(room, grant.url, grant.partyId));
    this.room = room;
    this.connecting = true;
    this.fault = null;
    this.emit();
    room.on(RoomEvent.TrackSubscribed, track => {
      if (track.kind !== Track.Kind.Audio) return;
      const element = track.attach();
      element.dataset.teamAudio = 'true';
      element.style.display = 'none';
      document.body.append(element);
      this.audioElements.add(element);
      void element.play().catch(error => {
        diagnostics.fail('voice.playback', error);
        this.playbackBlocked = true;
        this.emit();
      });
    });
    room.on(RoomEvent.TrackUnsubscribed, track =>
      track.detach().forEach(element => {
        element.remove();
        this.audioElements.delete(element);
      }),
    );
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      this.playbackBlocked = !room.canPlaybackAudio;
      this.emit();
    });
    room.on(RoomEvent.Reconnecting, () => {
      this.connecting = true;
      this.emit();
    });
    room.on(RoomEvent.Reconnected, () => {
      this.connecting = false;
      this.fault = null;
      this.emit();
    });
    room.on(RoomEvent.Disconnected, reason => {
      diagnostics.fail('voice.disconnected', '语音连接断开', { reason });
      diagnostics.stop();
      this.connecting = false;
      this.stopCapture();
      this.fault = { status: 'disconnected', message: '队伍语音已断开，点击重新连接' };
      this.emit();
    });
    room.on(RoomEvent.LocalTrackUnpublished, () => {
      this.published = false;
      this.emit();
    });
    room.on(RoomEvent.MediaDevicesChanged, () => void this.enumerate());
    try {
      await room.connect(grant.url, grant.token, { autoSubscribe: true });
      if (generation !== this.generation || this.room !== room) {
        await room.disconnect();
        return;
      }
      this.connecting = false;
      // Joining a team may happen from an invitation callback, outside a user
      // gesture. Connect the SFU room now, but request microphone capture only
      // from the explicit mic-check button so mobile permission/autoplay policy
      // can be satisfied by the click or tap handler.
      if (this.track) await this.publish();
      else this.emit();
      this.emit();
    } catch (error) {
      if (generation !== this.generation) return;
      diagnostics.fail('voice.connect', error);
      diagnostics.stop();
      this.connecting = false;
      this.fault = {
        status: 'disconnected',
        message: `语音连接失败：${error instanceof Error ? error.message : '请重新连接'}`,
      };
      this.stopCapture();
      this.emit();
    }
  }
  private async publish() {
    if (this.publishing) return this.publishing;
    const track = this.track;
    if (!track || !this.room || this.room.state !== ConnectionState.Connected || this.published) return;
    this.publishing = (async () => {
      await this.room!.localParticipant.publishTrack(track, { source: Track.Source.Microphone });
      if (this.track === track) {
        this.published = true;
        this.emit();
      }
    })();
    try {
      await this.publishing;
    } catch (error) {
      this.diagnostics?.fail('voice.publish', error);
      throw error;
    } finally {
      this.publishing = null;
    }
  }
  async enable(deviceId = this.deviceId) {
    // Resume immediately in the click/tap stack, before any permission or network await.
    if (this.context?.state === 'suspended') void this.context.resume().catch(() => undefined);
    void this.room
      ?.startAudio()
      .then(() => {
        this.playbackBlocked = false;
        this.emit();
      })
      .catch(() => {
        this.playbackBlocked = true;
        this.emit();
      });
    if (this.busy) return;
    if (this.track && this.track.mediaStreamTrack.readyState === 'live' && deviceId === this.deviceId) {
      try {
        await this.track.unmute();
        this.fault = null;
        await this.publish();
        this.emit();
      } catch (error) {
        this.fail(error);
      }
      return;
    }
    const generation = ++this.captureGeneration;
    this.busy = true;
    if (this.track && this.room) await this.room.localParticipant.unpublishTrack(this.track).catch(() => undefined);
    this.stopCapture();
    this.fault = null;
    this.busy = true;
    this.emit();
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      reportClientError('voice.microphone', '麦克风 API 不可用或页面不是安全上下文');
      this.busy = false;
      this.fault = { status: 'error', message: '麦克风需要安全连接，请使用 HTTPS 打开公园' };
      this.emit();
      return;
    }
    try {
      const context = new AudioContext();
      this.context = context;
      void context.resume().catch(() => undefined);
      const constraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
      if (generation !== this.captureGeneration) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      const mediaTrack = stream.getAudioTracks()[0];
      if (!mediaTrack) throw new DOMException('未找到麦克风', 'NotFoundError');
      this.stream = stream;
      this.track = new LocalAudioTrack(mediaTrack, constraints, true, context);
      this.deviceId = mediaTrack.getSettings().deviceId || deviceId;
      diagnosticBreadcrumb('voice.microphone-acquired', {
        settings: mediaTrack.getSettings(),
        audioContext: context.state,
      });
      mediaTrack.addEventListener('ended', () => {
        if (generation === this.captureGeneration) {
          this.stopCapture();
          this.fault = { status: 'missing', message: '麦克风已断开，请重新检查' };
          this.emit();
        }
      });
      mediaTrack.addEventListener('mute', () => this.emit());
      mediaTrack.addEventListener('unmute', () => this.emit());
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      this.analyser = analyser;
      const data = new Float32Array(analyser.fftSize);
      this.meter = setInterval(() => {
        analyser.getFloatTimeDomainData(data);
        const rms = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
        this.level = Math.min(1, rms * 8);
        if (context.state === 'running' && mediaTrack.enabled && !mediaTrack.muted && rms > 0.008) this.samples++;
        else if (!this.signal) this.samples = 0;
        if (this.samples >= 3) this.signal = true;
        this.emit();
      }, 100);
      this.busy = false;
      await this.enumerate();
      await this.publish();
      this.emit();
    } catch (error) {
      if (generation === this.captureGeneration) {
        this.busy = false;
        this.stopCapture();
        this.fail(error);
      }
    }
  }
  private fail(error: unknown) {
    reportClientError('voice.microphone', error, {
      deviceId: this.deviceId,
      devices: this.devices.map(d => ({ deviceId: d.deviceId, label: d.label })),
      audioContext: this.context?.state,
      voice: this.diagnostics?.snapshot(),
    });
    const name = error instanceof Error ? error.name : '';
    this.fault =
      name === 'NotAllowedError'
        ? { status: 'denied', message: '麦克风权限被拒绝，请在浏览器地址栏允许后重试' }
        : name === 'NotFoundError' || name === 'OverconstrainedError'
          ? { status: 'missing', message: '没有找到麦克风，请连接设备后重试' }
          : {
              status: 'error',
              message: `麦克风无法使用：${error instanceof Error ? error.message : '请检查设备是否被占用'}`,
            };
    this.emit();
  }
  async toggleMute() {
    if (!this.track) return;
    if (this.track.isMuted) await this.track.unmute();
    else await this.track.mute();
    this.emit();
  }
}

export function useVoice(
  partyId: string | null,
  available: boolean,
  grant: VoiceGrant | null,
  connected: boolean,
  send: (message: ClientMessage) => boolean,
) {
  const [state, setState] = useState<VoiceState>(initialState);
  const controller = useRef<TeamVoice | null>(null);
  if (!controller.current) controller.current = new TeamVoice(setState);
  const currentParty = useRef(partyId);
  currentParty.current = partyId;
  useEffect(() => {
    const voice = controller.current!;
    voice.stop();
    if (partyId && !available) voice.unavailable();
    return () => voice.stop();
  }, [partyId, available]);
  useEffect(() => {
    if (partyId && available && connected) send({ type: 'voice.join' });
  }, [partyId, available, connected, send]);
  useEffect(() => {
    if (grant && grant.partyId === currentParty.current && available) void controller.current!.connect(grant);
  }, [grant, available]);
  const reportSignature = JSON.stringify(state.report);
  useEffect(() => {
    if (partyId && connected) send({ type: 'mic', report: state.report });
  }, [partyId, connected, reportSignature, send]);
  const enable = useCallback(
    (deviceId?: string) => {
      if (!currentParty.current || !available) return;
      void controller.current!.enable(deviceId);
      send({ type: 'voice.join' });
    },
    [send, available],
  );
  const debugSnapshot = useCallback(() => controller.current!.debugSnapshot(), []);
  return { ...state, enable, debugSnapshot, toggleMute: () => void controller.current!.toggleMute() };
}
