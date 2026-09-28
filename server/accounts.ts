import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { COLORS, type AuthResult, type CharacterOption, type OfflinePlayer, type PlayerProfile } from '../shared/protocol.ts';
import { assert, AppError } from './errors.ts';

interface AccountRow {
  id: string; username: string | null; nickname: string; character_id: string; color: string; password_hash: string; auto_ready: number;
  last_seen_at: number | null; lobby_x: number | null; lobby_y: number | null;
}
export interface Account { profile: PlayerProfile; autoReady: boolean }
/** Letters, digits, `_` and `-`; the length keeps it distinct from a 36-character UUID. */
const USERNAME = /^[\p{L}\p{N}_-]{3,20}$/u;
/** Columns added after the first release, applied in order to existing databases. */
const MIGRATIONS: [string, string][] = [
  ['username', 'ALTER TABLE accounts ADD COLUMN username TEXT'],
  ['last_seen_at', 'ALTER TABLE accounts ADD COLUMN last_seen_at INTEGER'],
  ['lobby_x', 'ALTER TABLE accounts ADD COLUMN lobby_x REAL'],
  ['lobby_y', 'ALTER TABLE accounts ADD COLUMN lobby_y REAL'],
];
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
    const columns = new Set((this.db.prepare('PRAGMA table_info(accounts)').all() as unknown as { name: string }[]).map(column => column.name));
    for (const [column, statement] of MIGRATIONS) if (!columns.has(column)) this.db.exec(statement);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS accounts_username ON accounts(username COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS accounts_last_seen ON accounts(last_seen_at);`);
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
  private session(row: AccountRow): AuthResult {
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(digest(token), row.id, Date.now() + 30 * 86400_000);
    return { profile: profileOf(row), token, username: row.username };
  }
  async guest(): Promise<AuthResult> {
    const userId = randomUUID();
    const password = randomBytes(18).toString('base64url');
    const first = ['快乐', '软软', '薄荷', '星星', '奶糖', '蹦蹦', '橘子', '圆圆'];
    const last = ['小猫', '团子', '布丁', '云朵', '栗子', '饼干', '泡芙', '饭团'];
    const profile = { id: userId, nickname: first[randomInt(first.length)] + last[randomInt(last.length)], characterId: this.characters[randomInt(this.characters.length)].id, color: COLORS[randomInt(COLORS.length)] };
    const passwordHash = await bcrypt.hash(password, this.cost);
    this.db.prepare('INSERT INTO accounts (id, nickname, character_id, color, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(userId, profile.nickname, profile.characterId, profile.color, passwordHash, Date.now());
    return { ...this.session(this.row(userId)!), credentials: { userId, password } };
  }
  /** `account` is either the user ID or the optional username. */
  async login(account: unknown, password: unknown): Promise<AuthResult> {
    assert(typeof account === 'string' && account.length <= 100 && validPassword(password), 'invalid_credentials', '账号或密码不正确', 401);
    const row = this.row(account) ?? this.db.prepare('SELECT * FROM accounts WHERE username = ? COLLATE NOCASE').get(account.trim()) as AccountRow | undefined;
    assert(row && await bcrypt.compare(password, row.password_hash), 'invalid_credentials', '账号或密码不正确', 401);
    // Password changes may finish while bcrypt.compare is pending.
    const current = this.row(row.id);
    assert(current?.password_hash === row.password_hash, 'invalid_credentials', '账号或密码不正确', 401);
    return this.session(current);
  }
  username(userId: string): string | null { return this.row(userId)?.username ?? null; }
  setUsername(userId: string, value: unknown): string {
    assert(typeof value === 'string' && USERNAME.test(value.trim()), 'invalid_username', '用户名须为 3–20 位字母、数字、下划线或短横线');
    const username = value.trim();
    const owner = this.db.prepare('SELECT id FROM accounts WHERE username = ? COLLATE NOCASE').get(username) as { id: string } | undefined;
    assert(!owner || owner.id === userId, 'username_taken', '这个用户名已被使用，换一个试试', 409);
    this.db.prepare('UPDATE accounts SET username = ? WHERE id = ?').run(username, userId);
    return username;
  }
  /** Where the player's cat stood in the lobby when they went offline. */
  setLastSeen(userId: string, at: number, x: number, y: number) {
    this.db.prepare('UPDATE accounts SET last_seen_at = ?, lobby_x = ?, lobby_y = ? WHERE id = ?').run(at, x, y, userId);
  }
  recentlySeen(since: number, limit: number): OfflinePlayer[] {
    const rows = this.db.prepare('SELECT * FROM accounts WHERE last_seen_at >= ? AND lobby_x IS NOT NULL ORDER BY last_seen_at DESC LIMIT ?').all(since, limit) as unknown as AccountRow[];
    return rows.map(row => ({ ...profileOf(row), x: row.lobby_x!, y: row.lobby_y!, lastSeenAt: row.last_seen_at! }));
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
      result = { ...this.session(this.row(userId)!), credentials: { userId, password: newPassword } };
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.emit('password', userId);
    return result;
  }
  close() { this.removeAllListeners(); this.db.close(); }
}
