import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowRight, Check, KeyRound, LoaderCircle, Maximize, Minimize, RotateCw, Settings2, Trees, Trophy, Users, WifiOff, X } from 'lucide-react';
import GameCanvas from './game/GameCanvas';
import { usePark } from './client/usePark';
import { useVoice } from './client/useVoice';
import { sendDebugReport, setDiagnosticContext } from './client/diagnostics';
import { AccountDialog } from './ui/AccountDialog';
import { PartyPanel } from './ui/PartyPanel';
import { SocialPanel } from './ui/SocialPanel';
import { Avatar, IconButton, InlineError, Modal } from './ui/primitives';
import type { InputState } from '../shared/protocol';

export default function App() {
  const park = usePark(); const social = park.social; const self = social?.self || park.auth?.profile; const party = social?.party || null;
  const connected = park.status === 'connected';
  const voice = useVoice(party?.id || null, social?.voiceAvailable || false, park.grant, connected, park.send);
  useEffect(() => { setDiagnosticContext({ partyId: party?.id ?? null, scene: park.world?.kind ?? null, gameConnection: park.status }); }, [party?.id, park.world?.kind, park.status]);
  const [settings, setSettings] = useState<false | 'appearance' | 'account'>(false); const [dialogOpen, setDialogOpen] = useState(false);
  const [socialOpen, setSocialOpen] = useState(() => matchMedia('(min-width: 701px) and (pointer: fine)').matches); const [socialTab, setSocialTab] = useState<'chat' | 'players'>('chat');
  const [focused, setFocused] = useState(false);
  const [inviteCode, setInviteCode] = useState(() => new URL(location.href).searchParams.get('invite'));
  const [invitePending, setInvitePending] = useState(false);
  const [dark, setDark] = useState(() => { try { return localStorage.getItem('catpark.theme') === 'dark'; } catch { return false; } });
  const [recoveryId, setRecoveryId] = useState(park.credentials?.userId || ''); const [recoveryPassword, setRecoveryPassword] = useState(''); const [recoveryBusy, setRecoveryBusy] = useState(false); const [recoveryError, setRecoveryError] = useState('');
  const [newAccountConfirmation, setNewAccountConfirmation] = useState(false);
  const lastSeen = useMemo(() => new Map([...(social?.offline || []).map(player => [player.id, player.lastSeenAt] as const), ...(social?.players || []).flatMap(player => player.lastSeenAt === null ? [] : [[player.id, player.lastSeenAt] as const])]), [social?.offline, social?.players]);
  const offline = useMemo(() => social?.offline || [], [social?.offline]);
  const debugReport = useCallback(async () => sendDebugReport({ voice: await voice.debugSnapshot(), report: voice.report, party, status: park.status, world: park.world?.kind ?? null }), [voice.debugSnapshot, voice.report, party, park.status, park.world?.kind]);
  const sendInput = useCallback((input: InputState) => { park.send({ type: 'input', input }); }, [park.send]);
  const modal = settings || dialogOpen || (!!inviteCode && !!social) || park.status === 'recovery';
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; try { localStorage.setItem('catpark.theme', dark ? 'dark' : 'light'); } catch { /* Theme remains usable without local storage. */ } }, [dark]);
  useEffect(() => {
    const checkFocus = () => { const el = document.activeElement; setFocused(el instanceof HTMLElement && (!!el.closest('input, textarea, select, [contenteditable="true"]') || el.getAttribute('role') === 'textbox')); };
    document.addEventListener('focusin', checkFocus); document.addEventListener('focusout', checkFocus);
    const keyboard = (event: KeyboardEvent) => { if (event.key === 'Enter' && !event.repeat && !modal && !(event.target instanceof HTMLElement && event.target.closest('input,textarea,select,button,[contenteditable="true"]'))) { event.preventDefault(); setSocialTab('chat'); setSocialOpen(true); } };
    window.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('focusin', checkFocus); document.removeEventListener('focusout', checkFocus); window.removeEventListener('keydown', keyboard); };
  }, [modal]);
  useEffect(() => { const pop = () => setInviteCode(new URL(location.href).searchParams.get('invite')); window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop); }, []);
  function closeInvite() { setInviteCode(null); setInvitePending(false); const url = new URL(location.href); url.searchParams.delete('invite'); history.replaceState(null, '', url); }
  useEffect(() => { if (invitePending && party?.inviteCode === inviteCode) closeInvite(); }, [invitePending, party?.inviteCode, inviteCode]);
  useEffect(() => { if (park.notice && invitePending) setInvitePending(false); }, [park.notice]);
  async function recover(event: FormEvent) { event.preventDefault(); setRecoveryBusy(true); setRecoveryError(''); try { await park.login({ userId: recoveryId.trim(), password: recoveryPassword }); } catch (error) { setRecoveryError(error instanceof Error ? error.message : '账号恢复失败，请重试'); } finally { setRecoveryBusy(false); } }
  async function newAccount() { setRecoveryBusy(true); setRecoveryError(''); try { await park.createGuest(); setNewAccountConfirmation(false); } catch (error) { setRecoveryError(error instanceof Error ? error.message : '暂时无法创建账号'); } finally { setRecoveryBusy(false); } }
  const onlineCount = social?.players.filter(player => player.online).length || 0;
  const [fullscreen, setFullscreen] = useState(() => !!document.fullscreenElement);
  useEffect(() => { const change = () => setFullscreen(!!document.fullscreenElement); document.addEventListener('fullscreenchange', change); return () => document.removeEventListener('fullscreenchange', change); }, []);
  const canFullscreen = typeof document.documentElement.requestFullscreen === 'function' && document.fullscreenEnabled;
  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    // Some browsers reject navigationUI; retry plainly so the tap still works.
    else void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => document.documentElement.requestFullscreen()).then(lockLandscape, () => park.setNotice('浏览器没有允许全屏，可以从浏览器菜单添加到主屏幕后打开'));
  }
  // Only fullscreen pages may lock orientation, and iOS has no lock at all; the portrait overlay covers the rest.
  function lockLandscape() { void (screen.orientation as ScreenOrientation & { lock?: (orientation: string) => Promise<void> }).lock?.('landscape').catch(() => undefined); }
  return <main className={`park-app ${park.world?.kind === 'challenge' ? 'in-challenge' : ''}`}>
    <div className="game-surface"><GameCanvas world={park.world} selfId={self?.id || ''} onInput={sendInput} inputEnabled={connected && !modal && !focused} lastSeen={lastSeen} offline={offline} /></div>
    <header className="park-header"><div className="park-name"><Trees size={23} strokeWidth={1.6} /><div><h1>萌猫公园</h1><span>{park.world?.kind === 'challenge' ? '绳子挑战 · 荡秋千' : '散散步，交个朋友'}</span></div></div>
      {self && <div className="identity"><button className="identity-button" data-testid="settings" aria-label="打开我的小猫设置" onClick={() => setSettings('appearance')}><Avatar player={self} characters={park.config.characters} /><span><strong data-testid="self-name">{self.nickname}</strong><small>我的小猫 <Settings2 size={11} /></small></span></button><span className="self-id" data-testid="self-id">{self.id}</span><button className="online-button" aria-label={`查看 ${onlineCount} 位在线玩家`} onClick={() => { setSocialTab('players'); setSocialOpen(value => socialTab !== 'players' || !value); }}><Users size={17} /><span>{onlineCount}</span><i /></button>{canFullscreen && <button className="online-button" data-testid="fullscreen" aria-label={fullscreen ? '退出全屏' : '全屏'} onClick={toggleFullscreen}>{fullscreen ? <Minimize size={17} /> : <Maximize size={17} />}</button>}</div>}
    </header>
    {social && self && <><PartyPanel debugReport={debugReport} party={party} selfId={self.id} characters={park.config.characters} connected={connected} minPartySize={park.config.minPartySize} send={park.send} voice={voice} onInvite={() => { setSocialTab('players'); setSocialOpen(true); }} notify={park.setNotice} onDialog={setDialogOpen} /><SocialPanel state={social} connected={connected} characters={park.config.characters} send={park.send} open={socialOpen} setOpen={setSocialOpen} tab={socialTab} setTab={setSocialTab} />
      {social.invitations.length > 0 && !party && <aside className="invitations" aria-label="收到的队伍邀请">{social.invitations.map(invite => <div className="invitation" key={invite.id}><span><strong>{invite.fromName}</strong> 邀请你一起荡秋千</span><div><button className="button primary" data-testid={`accept-invite-${invite.id}`} disabled={!connected} onClick={() => park.send({ type: 'party.accept', invitationId: invite.id })}><Check size={15} />加入</button><IconButton icon={X} label={`拒绝 ${invite.fromName} 的邀请`} onClick={() => park.send({ type: 'party.decline', invitationId: invite.id })} /></div></div>)}</aside>}
    </>}
    {(!social || !connected) && park.status !== 'recovery' && <div className={`connection-state ${social ? 'compact' : ''}`} role="status">{park.status === 'offline' ? <WifiOff size={26} /> : <LoaderCircle size={26} className="spin" />}<strong>{park.status === 'loading' ? '给你找一只小猫…' : park.status === 'reconnecting' || park.status === 'offline' ? '正在回到公园…' : '正在推开公园的门…'}</strong><span>{park.status === 'offline' ? '网络恢复后会自动重连。' : '账号会自动保存在这个浏览器。'}</span>{park.status === 'offline' && <button className="button subtle" onClick={park.reconnect}>立即重试</button>}</div>}
    {park.world?.won && party && <div className="win-banner" role="status"><Trophy size={27} /><div><strong>一起到终点啦！</strong><span>每只小猫都很重要。</span></div></div>}
    {park.usernamePrompt && connected && !modal && <div className="account-prompt" role="status"><KeyRound size={18} /><span>设置用户名和密码，换设备也能找回这只小猫</span><button className="button subtle" data-testid="username-prompt-open" onClick={() => { park.dismissUsernamePrompt(); setSettings('account'); }}>去设置</button><IconButton icon={X} label="以后再说" onClick={park.dismissUsernamePrompt} /></div>}
    {park.notice && <div className="notice" role="status"><span>{park.notice}</span><IconButton icon={X} label="关闭提示" onClick={park.clearNotice} /></div>}
    {self && <AccountDialog open={!!settings} onOpenChange={value => setSettings(value ? settings || 'appearance' : false)} tab={settings || 'appearance'} profile={self} credentials={park.credentials} username={park.username} setUsername={park.setUsername} config={park.config} updateProfile={park.updateProfile} changePassword={park.changePassword} dark={dark} onTheme={() => setDark(value => !value)} debugReport={debugReport} />}
    <Modal open={!!inviteCode && !!social} onOpenChange={value => { if (!value) closeInvite(); }} title="朋友在等你，一起荡秋千？" description={party ? '当前已经在队伍中。离开当前队伍后，可以接受这个邀请。' : '加入后会开启队伍语音。请允许麦克风，并说一句话完成准备检查。'}><div className="dialog-actions"><button className="button subtle" onClick={closeInvite}>先逛逛公园</button><button className="button primary" disabled={!connected || !!party || invitePending} onClick={() => { if (inviteCode && park.send({ type: 'party.accept', inviteCode })) setInvitePending(true); }}>{invitePending ? '正在加入…' : '加入朋友的队伍'}<ArrowRight size={16} /></button></div></Modal>
    <Modal open={park.status === 'recovery'} onOpenChange={() => undefined} title="找回你的那只小猫" description={park.authError || '输入用户名或用户 ID 和密码，继续使用之前的账号。'} className="recovery-dialog"><form onSubmit={recover}><label className="field">用户名或用户 ID<input autoComplete="username" required value={recoveryId} onChange={event => setRecoveryId(event.target.value)} /></label><label className="field">密码<input type="password" autoComplete="current-password" required value={recoveryPassword} onChange={event => setRecoveryPassword(event.target.value)} /></label><button className="button primary full-width" disabled={recoveryBusy}><KeyRound size={17} />{recoveryBusy ? '正在恢复…' : '恢复账号'}</button></form><InlineError message={recoveryError} />{park.credentials && <button className="button subtle full-width" disabled={recoveryBusy} onClick={() => { setRecoveryPassword(park.credentials!.password); setRecoveryId(park.credentials!.userId); }}>填入浏览器保存的凭据</button>}{newAccountConfirmation ? <div className="new-account-confirm"><p>创建新账号会替换浏览器里保存的凭据。原账号仍可用 ID 和密码登录。</p><button className="button danger" disabled={recoveryBusy} onClick={() => void newAccount()}>确认创建新小猫</button><button className="text-button" onClick={() => setNewAccountConfirmation(false)}>取消</button></div> : <button className="text-button recovery-new" onClick={() => setNewAccountConfirmation(true)}>创建一只新的小猫</button>}</Modal>
    <div className="rotate-hint" data-testid="rotate-hint" role="alert"><RotateCw size={42} strokeWidth={1.6} /><strong>请把手机横过来</strong><span>萌猫公园只支持横屏游玩</span></div>
  </main>;
}
