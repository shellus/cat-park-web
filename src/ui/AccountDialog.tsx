import { useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, Eye, EyeOff, Moon, Sun } from 'lucide-react';
import type { Credentials, PlayerProfile } from '../../shared/protocol';
import type { ParkConfig } from '../client/usePark';
import { Avatar, IconButton, InlineError, Modal } from './primitives';

interface Props { open: boolean; onOpenChange: (value: boolean) => void; tab?: 'appearance' | 'account'; profile: PlayerProfile; credentials: Credentials | null; username: string | null; setUsername: (value: string) => Promise<string>; config: ParkConfig; updateProfile: (profile: Partial<PlayerProfile>) => Promise<PlayerProfile>; changePassword: (current: string, next: string) => Promise<void>; dark: boolean; onTheme: () => void }
export function AccountDialog({ open, onOpenChange, tab: initialTab = 'appearance', profile, credentials, username, setUsername, config, updateProfile, changePassword, dark, onTheme }: Props) {
  const [tab, setTab] = useState<'appearance' | 'account'>('appearance');
  const [draft, setDraft] = useState(profile);
  const [error, setError] = useState(''); const [success, setSuccess] = useState(''); const [busy, setBusy] = useState(false);
  const [usernameDraft, setUsernameDraft] = useState('');
  const [showPassword, setShowPassword] = useState(false); const [newPassword, setNewPassword] = useState(''); const [currentPassword, setCurrentPassword] = useState('');
  useEffect(() => { if (open) { setTab(initialTab); setUsernameDraft(username || ''); setDraft(profile); setError(''); setSuccess(''); setCurrentPassword(credentials?.password || ''); setNewPassword(''); } }, [open, profile.id]);
  async function saveAppearance(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setSuccess('');
    try { await updateProfile({ nickname: draft.nickname.trim(), characterId: draft.characterId, color: draft.color }); setSuccess('外观已保存，公园里的朋友也能看到。'); } catch (error) { setError(error instanceof Error ? error.message : '保存失败，请重试'); } finally { setBusy(false); }
  }
  async function saveUsername(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setSuccess('');
    try { const saved = await setUsername(usernameDraft.trim()); setUsernameDraft(saved); setSuccess(`以后可以用“${saved}”和密码登录。`); } catch (error) { setError(error instanceof Error ? error.message : '保存失败，请重试'); } finally { setBusy(false); }
  }
  async function savePassword(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setSuccess('');
    try { await changePassword(currentPassword, newPassword); setCurrentPassword(newPassword); setNewPassword(''); setSuccess('密码已修改，新密码也已保存在这个浏览器。'); } catch (error) { setError(error instanceof Error ? error.message : '修改失败，请重试'); } finally { setBusy(false); }
  }
  async function copyAccount() { try { await navigator.clipboard.writeText(`${username ? `用户名：${username}\n` : ''}用户 ID：${profile.id}\n密码：${credentials?.password || ''}`); setSuccess('账号和密码已复制。'); } catch { setError('无法复制，请手动选择账号和密码保存。'); } }
  return <Modal open={open} onOpenChange={onOpenChange} title="我的小猫" description="换个样子，继续和朋友一起玩。">
    <div className="tabs" role="tablist" aria-label="个人设置"><button role="tab" aria-selected={tab === 'appearance'} onClick={() => setTab('appearance')}>昵称与外观</button><button role="tab" aria-selected={tab === 'account'} onClick={() => setTab('account')}>账号与密码</button><IconButton icon={dark ? Sun : Moon} label={dark ? '切换浅色界面' : '切换深色界面'} onClick={onTheme} /></div>
    {tab === 'appearance' ? <form onSubmit={saveAppearance}>
      <div className="profile-preview"><Avatar player={draft} characters={config.characters} size="large" /><label className="field">昵称<input value={draft.nickname} maxLength={20} minLength={1} required onChange={event => setDraft(value => ({ ...value, nickname: event.target.value }))} /></label></div>
      <fieldset><legend>选择角色</legend><div className="character-grid">{config.characters.map(character => <button className="character-option" type="button" key={character.id} aria-pressed={draft.characterId === character.id} onClick={() => setDraft(value => ({ ...value, characterId: character.id }))}><img src={character.preview} alt="" /><span>{character.name}</span>{draft.characterId === character.id && <Check size={14} />}</button>)}</div>{!config.characters.length && <p className="muted">角色预览正在加载，当前角色会保留。</p>}</fieldset>
      <fieldset><legend>配色</legend><div className="color-options">{config.colors.map((color, index) => <button key={color} type="button" style={{ backgroundColor: color }} aria-label={`配色 ${index + 1}`} aria-pressed={draft.color === color} onClick={() => setDraft(value => ({ ...value, color }))}>{draft.color === color && <Check size={20} />}</button>)}</div></fieldset>
      <button className="button primary full-width" disabled={busy || !draft.nickname.trim()}>{busy ? '正在保存…' : '保存外观'}</button>
    </form> : <>
      <p className="muted">账号已保存在当前浏览器。换设备时，用用户名或 ID 加密码即可找回。</p>
      <form className="username-form" onSubmit={saveUsername}><label className="field">用户名<div className="input-action"><input data-testid="username-input" autoComplete="username" required minLength={3} maxLength={20} placeholder="3–20 位字母、数字、_ 或 -" value={usernameDraft} onChange={event => setUsernameDraft(event.target.value)} /><button className="button subtle" data-testid="username-submit" disabled={busy || usernameDraft.trim().length < 3 || usernameDraft.trim() === username}>{username ? '修改' : '设置'}</button></div></label></form>
      <label className="field">用户 ID<input readOnly value={profile.id} onFocus={event => event.target.select()} /></label>
      <label className="field">浏览器保存的密码<div className="input-action"><input readOnly type={showPassword ? 'text' : 'password'} value={credentials?.password || ''} onFocus={event => event.target.select()} /><IconButton icon={showPassword ? EyeOff : Eye} label={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword(value => !value)} /></div></label>
      <button className="button subtle full-width" onClick={() => void copyAccount()}><Copy size={16} />复制账号和密码</button>
      <form className="password-form" onSubmit={savePassword}><h3>{username ? '修改密码' : '设置好记的密码'}</h3><label className="field">当前密码<input data-testid="password-current" type="password" autoComplete="current-password" required value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} /></label><label className="field">新密码<input data-testid="password-new" type="password" autoComplete="new-password" required minLength={8} maxLength={128} placeholder="至少 8 个字符" value={newPassword} onChange={event => setNewPassword(event.target.value)} /></label><button data-testid="password-submit" className="button primary full-width" disabled={busy || newPassword.length < 8}>{busy ? '正在修改…' : '修改并保存新密码'}</button></form>
    </>}
    <InlineError message={error} />{success && <p className="inline-success" role="status"><Check size={16} />{success}</p>}
  </Modal>;
}
