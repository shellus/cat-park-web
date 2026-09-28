import { AccessToken, ParticipantInfo_State, RoomServiceClient, TrackSource, TrackType } from 'livekit-server-sdk';
import type { PlayerProfile, VoiceGrant } from '../shared/protocol.ts';
import type { AppConfig } from './config.ts';
import { AppError } from './errors.ts';

export interface VoiceService {
  readonly available: boolean;
  grant(partyId: string, profile: PlayerProfile): Promise<VoiceGrant>;
  verify(partyId: string, userId: string): Promise<boolean>;
  remove(partyId: string, userId: string): Promise<void>;
  close(): void;
}

export class LiveKitVoice implements VoiceService {
  readonly available: boolean;
  private client?: RoomServiceClient;
  private pendingRemoval = new Map<string, { partyId: string; userId: string; revokeAt: bigint }>();
  private retryTimer: ReturnType<typeof setInterval>;
  private retrying = false;
  constructor(private config: AppConfig['voice']) {
    this.available = Boolean(config);
    if (config) this.client = new RoomServiceClient(config.apiUrl || config.url.replace(/^ws/, 'http'), config.apiKey, config.apiSecret, { requestTimeout: 3, failover: false });
    this.retryTimer = setInterval(() => { void this.retryRemovals(); }, 3000);
    this.retryTimer.unref();
  }
  private room(partyId: string) { return `party-${partyId}`; }
  async grant(partyId: string, profile: PlayerProfile): Promise<VoiceGrant> {
    if (!this.config) throw new AppError('voice_unavailable', '语音服务尚未配置，暂时不能准备', 503);
    const key = `${partyId}:${profile.id}`;
    // Complete old removal before issuing a replacement grant for the same membership.
    const pending = this.pendingRemoval.get(key);
    if (pending) await this.remove(partyId, profile.id);
    const token = new AccessToken(this.config.apiKey, this.config.apiSecret, { identity: profile.id, name: profile.nickname, ttl: 60 });
    token.addGrant({ roomJoin: true, room: this.room(partyId), canPublish: true, canPublishSources: [TrackSource.MICROPHONE], canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false });
    return { partyId, url: this.config.url, token: await token.toJwt() };
  }
  async verify(partyId: string, userId: string): Promise<boolean> {
    if (!this.client) return false;
    try {
      const participant = await this.client.getParticipant(this.room(partyId), userId);
      return participant.state === ParticipantInfo_State.ACTIVE && participant.tracks.some(track => track.type === TrackType.AUDIO && track.source === TrackSource.MICROPHONE && !track.muted);
    } catch { return false; }
  }
  async remove(partyId: string, userId: string): Promise<void> {
    if (!this.client) return;
    const key = `${partyId}:${userId}`;
    const entry = this.pendingRemoval.get(key) || { partyId, userId, revokeAt: BigInt(Math.floor(Date.now() / 1000)) };
    this.pendingRemoval.set(key, entry);
    try {
      await this.client.removeParticipant(this.room(partyId), userId, { revokeTokenTs: entry.revokeAt });
      this.pendingRemoval.delete(key);
    } catch (error) {
      if ((error as { code?: string }).code === 'not_found' || (error as { status?: number }).status === 404) { this.pendingRemoval.delete(key); return; }
      throw new AppError('voice_remove_failed', '语音服务暂不可达，正在重试移除旧连接', 503);
    }
  }
  private async retryRemovals() {
    if (this.retrying) return;
    this.retrying = true;
    try { await Promise.all([...this.pendingRemoval.values()].map(entry => this.remove(entry.partyId, entry.userId).catch(() => {}))); }
    finally { this.retrying = false; }
  }
  close() { clearInterval(this.retryTimer); }
}
