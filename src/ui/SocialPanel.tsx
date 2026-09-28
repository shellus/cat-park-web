import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, ChevronDown, MessageCircle, UserPlus, Users } from 'lucide-react';
import type { CharacterOption, ClientMessage, SocialState } from '../../shared/protocol';
import { Avatar, IconButton } from './primitives';

export function SocialPanel({ state, connected, characters, send, open, setOpen, tab, setTab }: { state: SocialState; connected: boolean; characters: CharacterOption[]; send: (message: ClientMessage) => boolean; open: boolean; setOpen: (value: boolean) => void; tab: 'chat' | 'players'; setTab: (value: 'chat' | 'players') => void }) {
  const [message, setMessage] = useState(''); const chat = useRef<HTMLDivElement>(null); const input = useRef<HTMLInputElement>(null);
  const pending = useRef<{ text: string; sentAt: number } | null>(null);
  const players = state.players.filter(player => player.online); const last = state.chat.at(-1);
  useEffect(() => { if (chat.current) chat.current.scrollTop = chat.current.scrollHeight; }, [state.chat.length, last?.id, open, tab]);
  useEffect(() => {
    const waiting = pending.current;
    if (waiting && state.chat.some(item => item.userId === state.self.id && item.text === waiting.text && item.sentAt >= waiting.sentAt - 1000)) {
      setMessage(current => current.trim() === waiting.text ? '' : current); pending.current = null;
    }
  }, [state.chat, state.self.id]);
  useEffect(() => { if (open && tab === 'chat' && !matchMedia('(pointer: coarse)').matches) input.current?.focus(); }, [open, tab]);
  function submit(event: FormEvent) { event.preventDefault(); if (message.trim() && send({ type: 'chat', text: message.trim() })) pending.current = { text: message.trim(), sentAt: Date.now() }; }
  return <section className={`social-panel ${open ? 'is-open' : ''}`} aria-label="公共聊天与在线玩家">
    {open ? <>
      <header className="panel-heading"><div className="tabs"><button aria-pressed={tab === 'chat'} onClick={() => setTab('chat')}><MessageCircle size={16} />全员聊天</button><button aria-pressed={tab === 'players'} onClick={() => setTab('players')}><Users size={16} />在线 {players.length}</button></div><IconButton icon={ChevronDown} label="收起聊天" onClick={() => setOpen(false)} /></header>
      {tab === 'chat' ? <><div className="chat-messages" ref={chat} role="log" aria-live="polite" aria-label="全员文字频道" aria-relevant="additions">
        {!state.chat.length ? <div className="empty-message"><MessageCircle size={28} /><p>公园里见！</p><span>和所有在线的朋友打个招呼。</span></div> : state.chat.map(item => <div className={`chat-line ${item.userId === state.self.id ? 'own-message' : ''}`} key={item.id}><span className="chat-author">{item.nickname}<time dateTime={new Date(item.sentAt).toISOString()}>{new Date(item.sentAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></span><p>{item.text}</p></div>)}
      </div><form className="chat-form" onSubmit={submit}><input ref={input} data-testid="chat-input" aria-label="发送给所有人的消息" placeholder={connected ? '和大家说点什么…' : '连接恢复后继续聊天'} maxLength={200} value={message} disabled={!connected} onChange={event => setMessage(event.target.value)} /><button className="send-button" data-testid="chat-send" type="submit" aria-label="发送消息" disabled={!connected || !message.trim()}><ArrowUp size={20} /></button></form><span className="channel-note">大厅和游戏中的所有人都能看到</span></> : <div className="player-list">
        {players.map(player => <div className="player-row" key={player.id}><Avatar player={player} characters={characters} /><div className="player-identity"><strong>{player.nickname}{player.id === state.self.id && <span className="you-label">我</span>}</strong><span>{player.world === 'challenge' ? '正在荡秋千' : player.partyId ? '已在队伍中' : '在公园散步'}</span></div>{player.id !== state.self.id && !player.partyId && (!state.party || state.party.leaderId === state.self.id) && <IconButton icon={UserPlus} data-testid={`invite-player-${player.id}`} label={`邀请 ${player.nickname}`} disabled={!connected} onClick={() => send({ type: 'party.invite', userId: player.id })} />}</div>)}
      </div>}
    </> : <>{last && <button className="chat-preview" onClick={() => { setTab('chat'); setOpen(true); }}><strong>{last.nickname}</strong><span>{last.text}</span></button>}<button className="hud-button" onClick={() => { setTab('chat'); setOpen(true); }}><MessageCircle size={19} />聊两句<span className="keyboard-hint">Enter</span></button></>}
  </section>;
}
