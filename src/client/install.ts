import { useSyncExternalStore } from 'react';

/** Chromium fires this once per page load when the site is installable; it must be captured before the app mounts. */
interface InstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
const displayMode = matchMedia('(display-mode: fullscreen), (display-mode: standalone)');

export function installInstallPrompt() {
  addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferred = event as InstallPromptEvent; notify(); });
  addEventListener('appinstalled', () => { deferred = null; notify(); });
  displayMode.addEventListener('change', notify);
}

/** Opened from the home screen: no browser toolbars, nothing left to suggest. */
export function isInstalled() { return displayMode.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true; }

export async function promptInstall() {
  const event = deferred; if (!event) return false;
  deferred = null; notify();
  await event.prompt();
  return (await event.userChoice).outcome === 'accepted';
}

export type InstallState = 'installed' | 'prompt' | 'ios' | 'manual';
function snapshot(): InstallState {
  if (isInstalled()) return 'installed';
  if (deferred) return 'prompt';
  // iPadOS reports itself as a Mac but still has touch points.
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'ios' : 'manual';
}
export function useInstallState() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, snapshot);
}
