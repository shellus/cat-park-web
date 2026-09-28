import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { MIN_PARTY_SIZE, type ChatMessage, type InputState, type Invitation, type MicReport, type OfflinePlayer, type Party, type PlayerProfile, type SocialState, type WorldSnapshot } from '../shared/protocol.ts';
import type { AccountStore } from './accounts.ts';
import type { AppConfig } from './config.ts';
import { AppError, assert } from './errors.ts';
import type { GameSimulation, SimulationFactory } from './simulation.ts';
import { actionSchema } from './validation.ts';
import type { VoiceService } from './voice.ts';

export interface Connection {
  id: string;
  send(type: 'social' | 'world' | 'voice' | 'error', value: unknown): void;
  close(code: number): void;
}
interface Peer {
  profile: PlayerProfile; connection: Connection | null; lastConnectionId: string;
  partyId: string | null; ready: boolean; autoReady: boolean; mic: MicReport;
  /** Explicitly readied without a working microphone; kept across mic report changes. */
  micless: boolean; lastSeenAt: number;
  micVersion: number; verified: boolean; verifiedAt: number; lastInput: number; sequence: number; serverSequence: number;
  /** Client inputs waiting for their physics tick, and the newest one already simulated. */
  inputs: InputState[]; ack: number;
  lastChat: number; lastGrant: number; actionAt: number; actionCount: number;
  invitations: Map<string, Invitation>; timer?: ReturnType<typeof setTimeout>;
}
interface Team {
  id: string; leaderId: string; members: Set<string>; inviteCode: string;
  phase: Party['phase']; simulation?: GameSimulation; generation: number; starting: boolean;
}
const unchecked = (): MicReport => ({ status: 'unchecked', hasSignal: false, voiceConnected: false, published: false });
const goodMic = (report: MicReport) => report.status === 'ok' && report.hasSignal && report.voiceConnected && report.published;
/** Verified microphone readiness, or an explicit choice to play without one. */
const isReady = (peer: Peer) => Boolean(peer.connection) && (peer.micless || (peer.ready && peer.autoReady && goodMic(peer.mic)));
const zeroInput = { x: 0, y: 0, jump: false, sequence: 0 };
// Clients send one input per 60 Hz tick. A short queue absorbs network jitter; beyond it the
// oldest inputs are merged away so a backlog never turns into permanent input delay.
const MAX_QUEUED_INPUTS = 6;
function shuffled<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export class GameService {
  private peers = new Map<string, Peer>();
  private parties = new Map<string, Team>();
  private chat: ChatMessage[] = [];
  /** Cats left in the lobby by players whose reconnect window expired, newest first. */
  private away = new Map<string, OfflinePlayer>();
  private voiceChecking = false;
  private disposed = false;
  private profileListener = (profile: PlayerProfile) => this.updateProfile(profile);
  private passwordListener = (id: string) => this.invalidateSession(id);
  constructor(
    readonly accounts: AccountStore, readonly config: AppConfig, readonly voice: VoiceService,
    private lobby: GameSimulation, private createSimulation: SimulationFactory,
  ) {
    accounts.on('profile', this.profileListener);
    accounts.on('password', this.passwordListener);
    for (const player of accounts.recentlySeen(Date.now() - config.game.offlineHours * 3600_000, config.game.offlineLimit)) this.away.set(player.id, player);
  }
  get onlineCount() { return [...this.peers.values()].filter(peer => peer.connection).length; }
  get partyCount() { return this.parties.size; }
  get worldCount() { return [...this.parties.values()].filter(party => party.simulation).length; }
  connect(userId: string, connection: Connection) {
    assert(!this.disposed, 'shutdown', '服务器正在关闭', 503);
    const account = this.accounts.get(userId);
    assert(account, 'unauthorized', '请重新登录', 401);
    let peer = this.peers.get(userId);
    if (!peer) {
      assert(this.peers.size < this.config.game.maxPlayers, 'park_full', '大厅暂时满员，请稍后重试', 503);
      peer = { profile: account.profile, connection: null, lastConnectionId: connection.id, partyId: null, ready: false, autoReady: account.autoReady, mic: unchecked(), micless: false, lastSeenAt: 0, micVersion: 0, verified: false, verifiedAt: 0, lastInput: 0, sequence: -1, serverSequence: 0, inputs: [], ack: -1, lastChat: 0, lastGrant: 0, actionAt: 0, actionCount: 0, invitations: new Map() };
      this.peers.set(userId, peer);
      this.away.delete(userId);
      this.lobby.addPlayer(peer.profile);
    }
    const previous = peer.connection;
    clearTimeout(peer.timer);
    peer.profile = account.profile; peer.autoReady = account.autoReady;
    peer.connection = connection; peer.lastConnectionId = connection.id; peer.sequence = -1; peer.inputs = []; peer.ack = -1;
    this.clearReady(peer, unchecked(), true);
    this.applyInput(peer, zeroInput);
    if (previous && previous.id !== connection.id) previous.close(4001);
    this.broadcastSocial();
    connection.send('world', { ...this.simulationFor(peer).snapshot(), ack: peer.ack });
  }
  disconnect(userId: string, connectionId: string, immediate = false) {
    const peer = this.peers.get(userId);
    if (!peer || peer.lastConnectionId !== connectionId) return;
    peer.connection = null; peer.inputs = []; peer.lastSeenAt = Date.now();
    this.applyInput(peer, zeroInput);
    this.clearReady(peer, { ...unchecked(), status: 'disconnected', message: '游戏连接已断开' }, true);
    const party = peer.partyId ? this.parties.get(peer.partyId) : undefined;
    if (party?.simulation) this.endGame(party);
    if (peer.partyId) void this.voice.remove(peer.partyId, userId).catch(() => {});
    clearTimeout(peer.timer);
    if (immediate) this.expire(userId, connectionId);
    else {
      peer.timer = setTimeout(() => this.expire(userId, connectionId), this.config.game.reconnectSeconds * 1000);
      peer.timer.unref();
      this.broadcastSocial();
    }
  }
  private expire(userId: string, connectionId: string) {
    const peer = this.peers.get(userId);
    if (!peer || peer.lastConnectionId !== connectionId || peer.connection) return;
    if (peer.partyId) this.leaveParty(peer);
    this.rememberAway([peer]);
    this.lobby.removePlayer(userId);
    this.peers.delete(userId);
    this.broadcastSocial();
  }
  /** Keeps offline cats standing where they were, both in memory and across restarts. */
  private rememberAway(peers: Peer[]) {
    const positions = new Map(this.lobby.snapshot().players.map(actor => [actor.id, actor]));
    for (const peer of peers) {
      const actor = positions.get(peer.profile.id);
      if (!actor) continue;
      const player = { ...peer.profile, x: actor.x, y: actor.y, lastSeenAt: peer.lastSeenAt || Date.now() };
      this.accounts.setLastSeen(player.id, player.lastSeenAt, player.x, player.y);
      this.away.delete(player.id); this.away.set(player.id, player);
    }
    const newest = [...this.away.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, this.config.game.offlineLimit);
    this.away = new Map(newest.map(player => [player.id, player]));
  }
  private invalidateSession(userId: string) {
    const peer = this.peers.get(userId);
    if (!peer) return;
    const connection = peer.connection;
    this.disconnect(userId, peer.lastConnectionId);
    connection?.send('error', { code: 'session_expired', message: '密码已修改，请使用新凭据重新连接' });
    connection?.close(4003);
  }
  private updateProfile(profile: PlayerProfile) {
    const away = this.away.get(profile.id);
    if (away) this.away.set(profile.id, { ...away, ...profile });
    const peer = this.peers.get(profile.id);
    if (!peer) return;
    peer.profile = profile;
    this.simulationFor(peer).updateProfile(profile);
    this.broadcastSocial();
  }
  private simulationFor(peer: Peer) { return (peer.partyId && this.parties.get(peer.partyId)?.simulation) || this.lobby; }
  private applyInput(peer: Peer, input: typeof zeroInput) {
    // Wire sequence is scoped to a connection. Physics sequence survives browser refreshes.
    this.simulationFor(peer).setInput(peer.profile.id, { ...input, sequence: ++peer.serverSequence });
  }
  socialFor(userId: string): SocialState {
    const peer = this.peers.get(userId);
    assert(peer, 'not_connected', '请重新连接大厅');
    for (const [id, invitation] of peer.invitations) if (invitation.expiresAt <= Date.now() || !this.parties.has(invitation.partyId)) peer.invitations.delete(id);
    const team = peer.partyId ? this.parties.get(peer.partyId) : undefined;
    const party: Party | null = team ? {
      id: team.id, leaderId: team.leaderId, inviteCode: team.inviteCode, phase: team.phase, maxMembers: this.config.game.maxPartySize,
      members: [...team.members].map(id => { const member = this.peers.get(id)!; return { ...member.profile, online: Boolean(member.connection), ready: isReady(member), autoReady: member.autoReady, mic: { ...member.mic }, micless: member.micless && !member.ready }; }),
    } : null;
    return {
      self: { ...peer.profile }, party, invitations: [...peer.invitations.values()], chat: this.chat,
      players: [...this.peers.values()].map(player => ({ ...player.profile, online: Boolean(player.connection), lastSeenAt: player.connection ? null : player.lastSeenAt, partyId: player.partyId, world: player.partyId && this.parties.get(player.partyId)?.simulation ? 'challenge' : 'lobby' })),
      voiceAvailable: this.voice.available,
      offline: [...this.away.values()].filter(player => player.lastSeenAt >= Date.now() - this.config.game.offlineHours * 3600_000),
    };
  }
  private broadcastSocial() {
    if (this.disposed) return;
    for (const [id, peer] of this.peers) peer.connection?.send('social', this.socialFor(id));
  }
  private clearReady(peer: Peer, report: MicReport, keepMicless = false) {
    peer.micVersion++; peer.mic = report; peer.ready = false; peer.verified = false; peer.verifiedAt = 0;
    if (!keepMicless) peer.micless = false;
  }
  private error(peer: Peer, error: unknown) {
    peer.connection?.send('error', error instanceof AppError ? { code: error.code, message: error.message } : { code: 'server_error', message: '操作未完成，请稍后重试' });
  }
  async handle(userId: string, connectionId: string, payload: unknown) {
    const peer = this.peers.get(userId);
    if (!peer?.connection || peer.connection.id !== connectionId || this.disposed) return;
    try {
      const parsed = actionSchema.safeParse(payload);
      assert(parsed.success, 'invalid_message', '请求内容或字段不符合协议');
      const action = parsed.data;
      if (action.type === 'input') {
        if (action.input.sequence <= peer.sequence) return;
        peer.sequence = action.input.sequence;
        peer.lastInput = Date.now();
        peer.inputs.push(action.input);
        while (peer.inputs.length > MAX_QUEUED_INPUTS) {
          // Keep a jump press that would otherwise be dropped with the merged tick.
          const dropped = peer.inputs.shift()!;
          if (dropped.jump) peer.inputs[0] = { ...peer.inputs[0], jump: true };
        }
        return;
      }
      const now = Date.now();
      if (now - peer.actionAt > 1000) { peer.actionAt = now; peer.actionCount = 0; }
      assert(++peer.actionCount <= 20, 'rate_limited', '操作太快，请稍等一下', 429);
      switch (action.type) {
        case 'chat':
          assert(now - peer.lastChat >= 700, 'chat_rate_limited', '消息发送太快，请稍等一下', 429);
          peer.lastChat = now;
          this.chat.push({ id: randomUUID(), userId, nickname: peer.profile.nickname, text: action.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ''), sentAt: now });
          this.chat = this.chat.slice(-50); this.broadcastSocial(); break;
        case 'party.create': this.createParty(peer); this.broadcastSocial(); break;
        case 'party.invite': {
          assert(action.userId !== userId, 'invalid_invitation', '不能邀请自己');
          const target = this.peers.get(action.userId);
          assert(target?.connection, 'player_unavailable', '这位玩家已离线');
          assert(!target.partyId, 'already_in_party', '这位玩家已经在队伍中');
          const party = this.createParty(peer); this.requireLeader(peer, party);
          assert(!party.simulation && !party.starting, 'party_playing', '游戏进行中不能邀请');
          assert(party.members.size < this.config.game.maxPartySize, 'party_full', '队伍已满');
          for (const [id, invitation] of target.invitations) if (invitation.partyId === party.id || invitation.expiresAt <= now) target.invitations.delete(id);
          assert(target.invitations.size < 20, 'too_many_invitations', '对方待处理的邀请过多');
          const invitation = { id: randomUUID(), partyId: party.id, fromId: userId, fromName: peer.profile.nickname, expiresAt: now + 60_000 };
          target.invitations.set(invitation.id, invitation); this.broadcastSocial(); break;
        }
        case 'party.accept': {
          assert(!peer.partyId, 'already_in_party', '请先退出当前队伍');
          const invitation = action.invitationId ? peer.invitations.get(action.invitationId) : undefined;
          if (action.invitationId) assert(invitation && invitation.expiresAt > now, 'invitation_expired', '邀请已失效');
          const party = action.inviteCode ? [...this.parties.values()].find(team => team.inviteCode === action.inviteCode) : this.parties.get(invitation!.partyId);
          assert(party, 'invitation_expired', '队伍已解散或邀请已失效');
          assert(!party.simulation && !party.starting, 'party_playing', '这支队伍已经开始游戏');
          assert(party.members.size < this.config.game.maxPartySize, 'party_full', '队伍已满');
          party.members.add(userId); party.generation++; peer.partyId = party.id;
          peer.autoReady = this.accounts.get(userId)!.autoReady;
          this.clearReady(peer, unchecked()); peer.invitations.clear(); this.broadcastSocial(); break;
        }
        case 'party.decline': peer.invitations.delete(action.invitationId); this.broadcastSocial(); break;
        case 'party.leave': this.leaveParty(peer); this.broadcastSocial(); break;
        case 'party.disband': {
          const party = this.requireParty(peer); this.requireLeader(peer, party);
          for (const id of [...party.members]) this.leaveParty(this.peers.get(id)!);
          this.broadcastSocial(); break;
        }
        case 'party.ready': {
          this.requireParty(peer);
          peer.autoReady = action.ready; this.accounts.setAutoReady(userId, action.ready);
          peer.ready = false; peer.micVersion++; peer.micless = action.ready && Boolean(action.withoutMic);
          if (action.ready) await this.verifyPeer(peer);
          this.broadcastSocial();
          if (action.ready && !isReady(peer)) throw new AppError('microphone_not_ready', '麦克风与队伍语音检查通过后才能准备');
          break;
        }
        case 'mic': {
          const changed = JSON.stringify(peer.mic) !== JSON.stringify(action.report);
          if (changed) this.clearReady(peer, { ...action.report }, true);
          if (peer.partyId && goodMic(peer.mic)) await this.verifyPeer(peer);
          if (changed) this.broadcastSocial();
          break;
        }
        case 'voice.join': {
          const party = this.requireParty(peer);
          assert(now - peer.lastGrant >= 1000, 'voice_rate_limited', '语音正在连接，请稍等', 429);
          peer.lastGrant = now;
          const grant = await this.voice.grant(party.id, peer.profile);
          if (peer.partyId === party.id && peer.connection?.id === connectionId) peer.connection.send('voice', grant);
          break;
        }
        case 'party.start': await this.start(peer, false); break;
        case 'party.restart': await this.start(peer, true); break;
        case 'party.return': this.endGame(this.requireParty(peer)); this.broadcastSocial(); this.sendWorlds(); break;
      }
    } catch (error) { this.error(peer, error); }
  }
  private createParty(peer: Peer): Team {
    if (peer.partyId) return this.requireParty(peer);
    const party: Team = { id: randomUUID(), leaderId: peer.profile.id, members: new Set([peer.profile.id]), inviteCode: randomBytes(12).toString('base64url'), phase: 'forming', generation: 0, starting: false };
    this.parties.set(party.id, party); peer.partyId = party.id;
    peer.autoReady = this.accounts.get(peer.profile.id)!.autoReady;
    this.clearReady(peer, unchecked());
    return party;
  }
  private requireParty(peer: Peer): Team {
    const party = peer.partyId ? this.parties.get(peer.partyId) : undefined;
    assert(party, 'not_in_party', '请先加入队伍');
    return party;
  }
  private requireLeader(peer: Peer, party: Team) { assert(party.leaderId === peer.profile.id, 'leader_only', '只有队长可以执行此操作'); }
  private leaveParty(peer: Peer) {
    if (!peer.partyId) return;
    const party = this.parties.get(peer.partyId)!;
    this.endGame(party);
    party.members.delete(peer.profile.id); party.generation++;
    peer.partyId = null; this.clearReady(peer, unchecked());
    void this.voice.remove(party.id, peer.profile.id).catch(error => this.error(peer, error));
    if (!party.members.size) this.parties.delete(party.id);
    else if (party.leaderId === peer.profile.id) party.leaderId = [...party.members].find(id => Boolean(this.peers.get(id)?.connection)) || [...party.members][0];
  }
  private endGame(party: Team) {
    party.generation++;
    if (!party.simulation) return;
    party.simulation.dispose(); party.simulation = undefined; party.phase = 'forming';
    for (const id of party.members) { const peer = this.peers.get(id)!; this.lobby.addPlayer(peer.profile); this.applyInput(peer, zeroInput); }
  }
  private async verifyPeer(peer: Peer): Promise<boolean> {
    if (!peer.connection || !peer.partyId || !goodMic(peer.mic) || !this.voice.available) {
      peer.ready = false; peer.verified = false;
      return false;
    }
    const partyId = peer.partyId, version = peer.micVersion, connectionId = peer.connection.id;
    const verified = await this.voice.verify(partyId, peer.profile.id).catch(() => false);
    if (this.disposed || peer.partyId !== partyId || peer.micVersion !== version || peer.connection?.id !== connectionId) return false;
    const wasReady = peer.ready;
    peer.verified = verified; peer.verifiedAt = Date.now(); peer.ready = verified && peer.autoReady;
    if (!verified) {
      peer.mic = { ...peer.mic, status: 'disconnected', voiceConnected: false, published: false, message: '语音服务未确认有效麦克风音轨，请重新连接语音' };
      peer.micVersion++;
    }
    if (wasReady !== peer.ready || !verified) this.broadcastSocial();
    return verified;
  }
  private async start(peer: Peer, restart: boolean) {
    const party = this.requireParty(peer); this.requireLeader(peer, party);
    assert(!party.starting, 'start_in_progress', '队伍正在进入地图');
    assert(restart ? Boolean(party.simulation) : !party.simulation, 'invalid_phase', restart ? '当前没有可以重开的对局' : '队伍已经开始游戏');
    assert(party.members.size >= MIN_PARTY_SIZE, 'not_enough_players', `至少 ${MIN_PARTY_SIZE} 人才能开始`);
    const members = shuffled([...party.members].map(id => this.peers.get(id)!));
    assert(members.every(isReady), 'players_not_ready', '所有队员在线并准备后才能开始');
    party.starting = true;
    const generation = party.generation;
    let simulation: GameSimulation | undefined;
    try {
      // Members who chose to play without a microphone have no voice track to verify.
      const checks = await Promise.all(members.filter(member => !member.micless).map(member => this.verifyPeer(member)));
      assert(checks.every(Boolean), 'voice_check_failed', '语音检查未通过，请确认所有队员麦克风与语音连接');
      simulation = await this.createSimulation('challenge');
      assert(this.parties.get(party.id) === party && party.generation === generation && party.leaderId === peer.profile.id && members.every(member => member.partyId === party.id && isReady(member)), 'party_changed', '队伍状态发生变化，请重新准备');
      for (const member of members) simulation.addPlayer(member.profile);
      for (const member of members) this.lobby.removePlayer(member.profile.id);
      party.simulation?.dispose(); party.simulation = simulation; simulation = undefined;
      party.phase = 'playing'; party.generation++;
      this.broadcastSocial(); this.sendWorlds();
    } finally { simulation?.dispose(); party.starting = false; }
  }
  step(dt: number) {
    if (this.disposed) return;
    const now = Date.now();
    for (const peer of this.peers.values()) {
      if (!peer.connection || now - peer.lastInput > 350) { peer.inputs = []; this.applyInput(peer, zeroInput); continue; }
      // One queued input per tick; an empty queue keeps the last input, as the client predicted.
      const next = peer.inputs.shift();
      if (next) { peer.ack = next.sequence; this.applyInput(peer, next); }
    }
    this.lobby.step(dt);
    for (const party of this.parties.values()) if (party.simulation) {
      party.simulation.step(dt);
      if (party.phase !== 'won' && party.simulation.snapshot().won) { party.phase = 'won'; this.broadcastSocial(); }
    }
  }
  sendWorlds() {
    if (this.disposed) return;
    const worlds = new Map<GameSimulation, WorldSnapshot>();
    for (const peer of this.peers.values()) if (peer.connection) {
      const simulation = this.simulationFor(peer);
      if (!worlds.has(simulation)) worlds.set(simulation, simulation.snapshot());
      peer.connection.send('world', { ...worlds.get(simulation)!, ack: peer.ack });
    }
  }
  async checkVoice() {
    if (this.voiceChecking || this.disposed) return;
    this.voiceChecking = true;
    try { await Promise.all([...this.peers.values()].filter(peer => peer.partyId && peer.connection && goodMic(peer.mic)).map(peer => this.verifyPeer(peer))); }
    finally { this.voiceChecking = false; }
  }
  dispose() {
    // Players online at shutdown reappear as offline cats after a restart.
    try { this.rememberAway([...this.peers.values()]); } catch (error) { console.error('Failed to save offline cats:', error); }
    this.disposed = true;
    this.accounts.off('profile', this.profileListener); this.accounts.off('password', this.passwordListener);
    for (const peer of this.peers.values()) clearTimeout(peer.timer);
    for (const party of this.parties.values()) party.simulation?.dispose();
    this.lobby.dispose(); this.voice.close(); this.peers.clear(); this.parties.clear();
  }
}
