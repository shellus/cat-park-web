import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { COLORS, type AuthResult, type CharacterOption, type PlayerProfile } from '../shared/protocol.ts';
import { assert, AppError } from './errors.ts';

interface AccountRow { id: string; nickname: string; character_id: string; color: string; password_hash: string; auto_ready: number }
export interface Account { profile: PlayerProfile; autoReady: boolean }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const profileOf = (row: AccountRow): PlayerProfile => ({ id: row.id, nickname: row.nickname, characterId: row.character_id, color: row.color });
export function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && Buffer.byteLength(value, 'utf8') <= 72;
}
export class AccountStore extends EventEmitter {
  private db: DatabaseSync;
  constructor(path: string, public readonly characters: CharacterOption[], private cost = 12) {
    super();
    assert(characters.length > 0, 'assets_missing', '角色目录为空，请先运行素材准备命令', 503);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, nickname TEXT NOT NULL, character_id TEXT NOT NULL, color TEXT NOT NULL,
        password_hash TEXT NOT NULL, auto_ready INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);`);
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  }
  private row(userId: string) { return this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(userId) as AccountRow | undefined; }
  get(userId: string): Account | null {
    const row = this.row(userId);
    return row ? { profile: profileOf(row), autoReady: Boolean(row.auto_ready) } : null;
  }
  authenticate(token: unknown): Account | null {
    if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
    const row = this.db.prepare('SELECT accounts.* FROM sessions JOIN accounts ON accounts.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?').get(digest(token), Date.now()) as AccountRow | undefined;
    return row ? { profile: profileOf(row), autoReady: Boolean(row.auto_ready) } : null;
  }
  private session(profile: PlayerProfile): AuthResult {
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(digest(token), profile.id, Date.now() + 30 * 86400_000);
    return { profile, token };
  }
  async guest(): Promise<AuthResult> {
    const userId = randomUUID();
    const password = randomBytes(18).toString('base64url');
    const first = ['快乐', '软软', '薄荷', '星星', '奶糖', '蹦蹦', '橘子', '圆圆'];
    const last = ['小猫', '团子', '布丁', '云朵', '栗子', '饼干', '泡芙', '饭团'];
    const profile = { id: userId, nickname: first[randomInt(first.length)] + last[randomInt(last.length)], characterId: this.characters[randomInt(this.characters.length)].id, color: COLORS[randomInt(COLORS.length)] };
    const passwordHash = await bcrypt.hash(password, this.cost);
    this.db.prepare('INSERT INTO accounts (id, nickname, character_id, color, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(userId, profile.nickname, profile.characterId, profile.color, passwordHash, Date.now());
    return { ...this.session(profile), credentials: { userId, password } };
  }
  async login(userId: unknown, password: unknown): Promise<AuthResult> {
    assert(typeof userId === 'string' && userId.length <= 100 && validPassword(password), 'invalid_credentials', '用户 ID 或密码不正确', 401);
    const row = this.row(userId);
    assert(row && await bcrypt.compare(password, row.password_hash), 'invalid_credentials', '用户 ID 或密码不正确', 401);
    // Password changes may finish while bcrypt.compare is pending.
    assert(this.row(userId)?.password_hash === row.password_hash, 'invalid_credentials', '用户 ID 或密码不正确', 401);
    return this.session(profileOf(this.row(userId)!));
  }
  updateProfile(userId: string, update: Partial<Omit<PlayerProfile, 'id'>>): PlayerProfile {
    const row = this.row(userId);
    assert(row, 'unauthorized', '请重新登录', 401);
    const profile = { ...profileOf(row), ...update };
    assert(profile.nickname.trim().length >= 1 && [...profile.nickname.trim()].length <= 12 && !/[\p{C}]/u.test(profile.nickname), 'invalid_profile', '昵称须为 1–12 个字符且不含控制字符');
    assert(this.characters.some(character => character.id === profile.characterId), 'invalid_profile', '请选择已有角色');
    assert((COLORS as readonly string[]).includes(profile.color), 'invalid_profile', '请选择已有配色');
    profile.nickname = profile.nickname.trim();
    this.db.prepare('UPDATE accounts SET nickname = ?, character_id = ?, color = ? WHERE id = ?').run(profile.nickname, profile.characterId, profile.color, userId);
    this.emit('profile', profile);
    return profile;
  }
  setAutoReady(userId: string, value: boolean) {
    this.db.prepare('UPDATE accounts SET auto_ready = ? WHERE id = ?').run(value ? 1 : 0, userId);
  }
  async changePassword(userId: string, currentPassword: unknown, newPassword: unknown): Promise<AuthResult> {
    assert(validPassword(currentPassword), 'invalid_credentials', '当前密码不正确', 401);
    assert(validPassword(newPassword), 'invalid_password', '新密码至少 8 个字符，且 UTF-8 长度不能超过 72 字节');
    const row = this.row(userId);
    assert(row && await bcrypt.compare(currentPassword, row.password_hash), 'invalid_credentials', '当前密码不正确', 401);
    const hash = await bcrypt.hash(newPassword, this.cost);
    this.db.exec('BEGIN IMMEDIATE');
    let result: AuthResult;
    try {
      const changed = this.db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ? AND password_hash = ?').run(hash, userId, row.password_hash);
      if (Number(changed.changes) !== 1) throw new AppError('password_changed', '密码已被其他请求修改，请重新登录', 409);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      result = { ...this.session(profileOf(this.row(userId)!)), credentials: { userId, password: newPassword } };
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.emit('password', userId);
    return result;
  }
  close() { this.removeAllListeners(); this.db.close(); }
}
