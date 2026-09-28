import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Star } from 'lucide-react';
import type { InputState, WorldSnapshot } from '../../shared/protocol.ts';
import { mountGameRenderer } from './renderer.ts';
import './game.css';

interface Props { world: WorldSnapshot | null; selfId: string; onInput: (input: InputState) => void; inputEnabled: boolean }
const movementKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyA', 'KeyD', 'KeyW', 'KeyS', 'Space']);
const editable = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]');

export default function GameCanvas(props: Props) {
  const host = useRef<HTMLDivElement>(null), latest = useRef(props), keys = useRef(new Set<string>()), pointers = useRef(new Map<number, string>());
  const [loading, setLoading] = useState<string | null>('正在载入公园素材…'), [error, setError] = useState(false), [retry, setRetry] = useState(0);
  latest.current = props;
  // The renderer samples this every fixed tick, predicts locally and sends it to the server.
  const readInput = () => {
    const pressed = new Set([...keys.current, ...pointers.current.values()]);
    const enabled = latest.current.inputEnabled && !editable(document.activeElement);
    return { x: enabled ? Number(pressed.has('ArrowRight') || pressed.has('KeyD')) - Number(pressed.has('ArrowLeft') || pressed.has('KeyA')) : 0,
      y: enabled ? Number(pressed.has('ArrowUp') || pressed.has('KeyW')) - Number(pressed.has('ArrowDown') || pressed.has('KeyS')) : 0,
      jump: enabled && pressed.has('Space') };
  };
  const reset = () => { keys.current.clear(); pointers.current.clear(); };
  useEffect(() => {
    if (!host.current) return;
    setError(false);
    return mountGameRenderer(host.current, () => ({ world: latest.current.world, selfId: latest.current.selfId, readInput, sendInput: input => latest.current.onInput(input) }), (message, failed = false) => { setLoading(previous => previous === message ? previous : message); setError(previous => previous === failed ? previous : failed); });
  }, [retry]);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (!movementKeys.has(event.code) || !latest.current.inputEnabled || editable(event.target)) return;
      event.preventDefault(); keys.current.add(event.code);
    };
    const up = (event: KeyboardEvent) => { if (movementKeys.has(event.code)) keys.current.delete(event.code); };
    const focus = (event: FocusEvent) => { if (editable(event.target)) reset(); };
    const visibility = () => { if (document.hidden) reset(); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', visibility); document.addEventListener('focusin', focus);
    return () => {
      reset(); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', visibility); document.removeEventListener('focusin', focus);
    };
  }, []);
  useEffect(() => { reset(); }, [props.inputEnabled, props.world?.kind, props.selfId]);
  const labels: Record<string, string> = { ArrowLeft: '向左', ArrowRight: '向右', ArrowUp: '向上', ArrowDown: '向下', Space: '跳跃' };
  const icons: Record<string, React.ReactNode> = { ArrowLeft: <ArrowLeft aria-hidden="true" />, ArrowRight: <ArrowRight aria-hidden="true" />, ArrowUp: <ArrowUp aria-hidden="true" />, ArrowDown: <ArrowDown aria-hidden="true" /> };
  const button = (key: string, label: string, className = '') => <button type="button" className={`game-control ${className}`} aria-label={labels[key]} disabled={!props.inputEnabled}
    onPointerDown={event => { event.preventDefault(); if (!props.inputEnabled) return; event.currentTarget.setPointerCapture(event.pointerId); pointers.current.set(event.pointerId, key); }}
    onPointerUp={event => { pointers.current.delete(event.pointerId); }}
    onPointerCancel={event => { pointers.current.delete(event.pointerId); }}
    onLostPointerCapture={event => { pointers.current.delete(event.pointerId); }}
    onContextMenu={event => event.preventDefault()}>{icons[key] ?? label}</button>;
  return <div className="game-canvas-shell" data-testid="game-canvas" data-world={props.world?.kind ?? 'loading'}>
    <div ref={host} className="game-pixi-host" />
    {loading && <div className={`game-load-state ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>
      <span>{loading}</span>{error && <button type="button" onClick={() => setRetry(n => n + 1)}>重新载入</button>}
    </div>}
    {!loading && <div className="game-keyboard-hint">{props.world?.kind === 'challenge' ? 'A / D 移动 · 空格跳跃 · 用绳子接住队友' : 'W A S D / 方向键 · 在公园里走走'}</div>}
    {props.world?.kind === 'challenge' && <div className="game-stage-status" role="status">{props.world.won ? '一起到达终点了！' : <>{props.world.doorOpen ? '门已打开 · 和队友一起到达出口' : props.world.keyOwnerId ? '钥匙已找到 · 持有者靠近出口开门' : '找到钥匙 · 和队友一起到达出口'}　<Star size={14} aria-label="星星" style={{ display: 'inline', verticalAlign: 'middle' }} /> {props.world.collectedStars.length}/2</>}</div>}
    <div className="game-touch-controls" aria-label="游戏触摸控制">
      <div className="game-dpad">
        {props.world?.kind !== 'challenge' && button('ArrowUp', '↑', 'game-up')}
        {button('ArrowLeft', '←', 'game-left')}{button('ArrowRight', '→', 'game-right')}
        {props.world?.kind !== 'challenge' && button('ArrowDown', '↓', 'game-down')}
      </div>
      {props.world?.kind === 'challenge' && button('Space', '跳跃', 'game-jump')}
    </div>
  </div>;
}
