import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Star } from 'lucide-react';
import type { InputState, OfflinePlayer, WorldSnapshot } from '../../shared/protocol.ts';
import { mountGameRenderer, type RenderView } from './renderer.ts';
import './game.css';

interface Props { world: WorldSnapshot | null; selfId: string; onInput: (input: InputState) => void; inputEnabled: boolean; lastSeen: Map<string, number>; offline: OfflinePlayer[] }
const movementKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyA', 'KeyD', 'KeyW', 'KeyS', 'Space']);
const editable = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]');
// A press that moves less than this and ends quickly is a tap; otherwise it drives the joystick.
const DRAG_PIXELS = 12, TAP_MS = 350, STICK_RADIUS = 56;
const ARRIVE_DISTANCE = 30, TARGET_TIMEOUT_MS = 8000;
interface Stick { id: number; x: number; y: number; dx: number; dy: number; started: number; dragging: boolean }

export default function GameCanvas(props: Props) {
  const shell = useRef<HTMLDivElement>(null), host = useRef<HTMLDivElement>(null), latest = useRef(props), keys = useRef(new Set<string>()), jumps = useRef(new Set<number>());
  const stick = useRef<Stick | null>(null), view = useRef<RenderView>({ cameraX: 0, cameraY: 0, zoom: 1, width: 1, height: 1 });
  const target = useRef<{ x: number; y: number; until: number } | null>(null);
  const [knob, setKnob] = useState<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const [loading, setLoading] = useState<string | null>('正在载入公园素材…'), [error, setError] = useState(false), [retry, setRetry] = useState(0);
  latest.current = props;
  // The renderer samples this every fixed tick, predicts locally and sends it to the server.
  const readInput = () => {
    const enabled = latest.current.inputEnabled && !editable(document.activeElement);
    const pressed = keys.current, challenge = latest.current.world?.kind === 'challenge';
    let x = Number(pressed.has('ArrowRight') || pressed.has('KeyD')) - Number(pressed.has('ArrowLeft') || pressed.has('KeyA'));
    let y = Number(pressed.has('ArrowUp') || pressed.has('KeyW')) - Number(pressed.has('ArrowDown') || pressed.has('KeyS'));
    const held = stick.current;
    if (x || y) target.current = null;
    else if (held?.dragging) {
      const length = Math.max(STICK_RADIUS, Math.hypot(held.dx, held.dy));
      x = held.dx / length; y = -held.dy / length;
    } else if (target.current) {
      const self = view.current.self, goal = target.current;
      const dx = self ? goal.x - self.x : 0, dy = challenge || !self ? 0 : goal.y - self.y, distance = Math.hypot(dx, dy);
      if (!self || distance < ARRIVE_DISTANCE || Date.now() > goal.until) target.current = null;
      else { x = dx / distance; y = dy / distance; }
    }
    view.current.target = target.current;
    return { x: enabled ? x : 0, y: enabled && !challenge ? y : 0, jump: enabled && (pressed.has('Space') || jumps.current.size > 0) };
  };
  const reset = () => { keys.current.clear(); jumps.current.clear(); stick.current = null; target.current = null; setKnob(null); };
  useEffect(() => {
    if (!host.current) return;
    setError(false);
    return mountGameRenderer(host.current, () => ({ world: latest.current.world, selfId: latest.current.selfId, readInput, sendInput: input => latest.current.onInput(input), lastSeen: latest.current.lastSeen, offline: latest.current.offline, view: view.current }), (message, failed = false) => { setLoading(previous => previous === message ? previous : message); setError(previous => previous === failed ? previous : failed); });
  }, [retry]);
  useEffect(() => {
    // Mobile browsers treat a downward drag as a page gesture and bring the address bar back even
    // with touch-action:none; a non-passive touchmove that cancels the default keeps the game fullscreen.
    const element = shell.current;
    if (!element) return;
    const block = (event: TouchEvent) => { if (event.cancelable) event.preventDefault(); };
    element.addEventListener('touchmove', block, { passive: false });
    return () => element.removeEventListener('touchmove', block);
  }, []);
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
  // Tap the ground to walk there; press and drag anywhere for a floating joystick.
  const surface = {
    onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
      if (!props.inputEnabled || stick.current || (event.pointerType === 'mouse' && event.button !== 0)) return;
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Pointer already released. */ }
      const box = event.currentTarget.getBoundingClientRect();
      stick.current = { id: event.pointerId, x: event.clientX - box.left, y: event.clientY - box.top, dx: 0, dy: 0, started: performance.now(), dragging: false };
    },
    onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
      const held = stick.current;
      if (!held || held.id !== event.pointerId) return;
      const box = event.currentTarget.getBoundingClientRect();
      held.dx = event.clientX - box.left - held.x; held.dy = event.clientY - box.top - held.y;
      if (!held.dragging && Math.hypot(held.dx, held.dy) > DRAG_PIXELS) { held.dragging = true; target.current = null; }
      if (held.dragging) {
        const scale = Math.min(1, STICK_RADIUS / Math.max(1, Math.hypot(held.dx, held.dy)));
        setKnob({ x: held.x, y: held.y, dx: held.dx * scale, dy: held.dy * scale });
      }
    },
    onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
      const held = stick.current;
      if (!held || held.id !== event.pointerId) return;
      if (!held.dragging && performance.now() - held.started < TAP_MS) {
        const camera = view.current;
        target.current = { x: camera.cameraX + (held.x - camera.width / 2) / camera.zoom, y: -(camera.cameraY + (held.y - camera.height / 2) / camera.zoom), until: Date.now() + TARGET_TIMEOUT_MS };
      }
      stick.current = null; setKnob(null);
    },
    onPointerCancel(event: ReactPointerEvent<HTMLDivElement>) { if (stick.current?.id === event.pointerId) { stick.current = null; setKnob(null); } },
  };
  const release = (event: ReactPointerEvent<HTMLButtonElement>) => { jumps.current.delete(event.pointerId); };
  return <div ref={shell} className="game-canvas-shell" data-testid="game-canvas" data-world={props.world?.kind ?? 'loading'}>
    <div ref={host} className="game-pixi-host" onPointerDown={surface.onPointerDown} onPointerMove={surface.onPointerMove} onPointerUp={surface.onPointerUp} onPointerCancel={surface.onPointerCancel} onLostPointerCapture={surface.onPointerCancel} onContextMenu={event => event.preventDefault()} />
    {knob && <div className="game-stick" aria-hidden="true" style={{ left: knob.x, top: knob.y }}><i style={{ transform: `translate(${knob.dx}px, ${knob.dy}px)` }} /></div>}
    {loading && <div className={`game-load-state ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>
      <span>{loading}</span>{error && <button type="button" onClick={() => setRetry(n => n + 1)}>重新载入</button>}
    </div>}
    {!loading && <div className="game-keyboard-hint">{props.world?.kind === 'challenge' ? 'A / D 移动 · 空格跳跃 · 用绳子接住队友' : 'W A S D / 方向键 · 点击地面走过去'}</div>}
    {!loading && <div className="game-touch-hint" key={props.world?.kind}>{props.world?.kind === 'challenge' ? '按住拖动左右移动 · 点跳跃按钮起跳' : '点一下走过去 · 按住拖动像摇杆一样走'}</div>}
    {props.world?.kind === 'challenge' && <div className="game-stage-status" role="status">{props.world.won ? '一起到达终点了！' : <>{props.world.doorOpen ? '门已打开 · 和队友一起到达出口' : props.world.keyOwnerId ? '钥匙已找到 · 持有者靠近出口开门' : '找到钥匙 · 和队友一起到达出口'}　<Star size={14} aria-label="星星" style={{ display: 'inline', verticalAlign: 'middle' }} /> {props.world.collectedStars.length}/2</>}</div>}
    {props.world?.kind === 'challenge' && <div className="game-touch-controls" aria-label="游戏触摸控制">
      <button type="button" className="game-control game-jump" aria-label="跳跃" disabled={!props.inputEnabled}
        onPointerDown={event => { event.preventDefault(); if (!props.inputEnabled) return; event.currentTarget.setPointerCapture(event.pointerId); jumps.current.add(event.pointerId); }}
        onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}
        onContextMenu={event => event.preventDefault()}>跳跃</button>
    </div>}
  </div>;
}
