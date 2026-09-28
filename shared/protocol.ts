/** Wire contract. World coordinates use source scene units: X right, Y up. */
export const MIN_PARTY_SIZE = 2;
export const DEFAULT_MAX_PARTY_SIZE = 6;
export const COLORS = ['#f5cb62', '#e79398', '#91baaa', '#98bde0', '#baa6d9', '#edab77'] as const;
export type WorldKind = 'lobby' | 'challenge';
export interface PlayerProfile { id: string; nickname: string; characterId: string; color: string }
export interface Credentials { userId: string; password: string }
export interface AuthResult { profile: PlayerProfile; token: string; credentials?: Credentials }
export type MicStatus = 'unchecked' | 'checking' | 'denied' | 'missing' | 'silent' | 'connecting' | 'disconnected' | 'muted' | 'ok' | 'error';
export interface MicReport { status: MicStatus; message?: string; hasSignal: boolean; voiceConnected: boolean; published: boolean }
export interface Presence extends PlayerProfile { online: boolean; partyId: string | null; world: WorldKind }
export interface PartyMember extends PlayerProfile {
  online: boolean; ready: boolean; autoReady: boolean; mic: MicReport;
}
export interface Party {
  id: string; leaderId: string; members: PartyMember[]; phase: 'forming' | 'playing' | 'won';
  maxMembers: number; inviteCode: string;
}
export interface Invitation { id: string; partyId: string; fromId: string; fromName: string; expiresAt: number }
export interface ChatMessage { id: string; userId: string; nickname: string; text: string; sentAt: number }
export interface SocialState {
  self: PlayerProfile; players: Presence[]; party: Party | null; invitations: Invitation[];
  chat: ChatMessage[]; voiceAvailable: boolean;
}
/** Sent once per 60 Hz client tick; the server simulates one queued input per physics tick. */
export interface InputState { x: number; y: number; jump: boolean; sequence: number }
export interface ActorSnapshot extends PlayerProfile {
  x: number; y: number; vx: number; vy: number; facing: number; grounded: boolean;
}
export interface WorldSnapshot {
  kind: WorldKind; tick: number; elapsed: number; players: ActorSnapshot[];
  ropes: { a: string; b: string }[]; keyOwnerId: string | null;
  collectedStars: string[]; doorOpen: boolean; won: boolean;
  /** Recipient's newest input sequence already simulated in this snapshot; -1 before any. */
  ack?: number;
}
export interface VoiceGrant { partyId: string; url: string; token: string }
export interface ErrorNotice { code: string; message: string }
export interface CharacterOption { id: string; name: string; preview: string }
export type ClientMessage =
  | { type: 'input'; input: InputState }
  | { type: 'chat'; text: string }
  | { type: 'party.create' }
  | { type: 'party.invite'; userId: string }
  | { type: 'party.accept'; invitationId?: string; inviteCode?: string }
  | { type: 'party.decline'; invitationId: string }
  | { type: 'party.leave' }
  | { type: 'party.disband' }
  | { type: 'party.ready'; ready: boolean }
  | { type: 'party.start' }
  | { type: 'party.return' }
  | { type: 'party.restart' }
  | { type: 'mic'; report: MicReport }
  | { type: 'voice.join' };

// Room: park. Client sends "action" with ClientMessage.
// Server sends "social": SocialState, "world": WorldSnapshot,
// "voice": VoiceGrant, "error": ErrorNotice. HTTP errors: {error:string}.
// POST /api/account/guest -> AuthResult (with credentials)
// POST /api/account/login {userId,password} -> AuthResult
// PATCH /api/account/profile {nickname?,characterId?,color?} -> {profile}
// POST /api/account/password {currentPassword,newPassword} -> AuthResult
// GET /api/config -> {characters:CharacterOption[], colors:string[], minPartySize:number,maxPartySize:number,voiceAvailable:boolean}
// Protected HTTP endpoints use Authorization: Bearer token.
