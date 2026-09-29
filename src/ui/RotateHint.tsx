import { useState } from 'react';
import { Download, MonitorSmartphone, RotateCw, X } from 'lucide-react';
import { promptInstall, useInstallState, type InstallState } from '../client/install';
import { IconButton } from './primitives';

const INSTALL_TIP_KEY = 'catpark.install-tip.v1';
/** Short text for the landscape tip; the portrait overlay explains why before it. */
const advice: Record<Exclude<InstallState, 'app'>, string> = {
  installed: '已安装，从桌面图标打开可全屏游玩',
  prompt: '安装为应用后从桌面打开，可全屏游玩',
  ios: 'Safari“分享”→“添加到主屏幕”，可全屏游玩',
  manual: '浏览器菜单“添加到主屏幕”后打开，可全屏游玩',
};
function InstallButton({ state }: { state: InstallState }) {
  return state === 'prompt' ? (
    <button className="button primary" data-testid="install-app" onClick={() => void promptInstall()}>
      <Download size={16} />
      安装为应用
    </button>
  ) : null;
}

/** Shown only on touch devices held upright (see .rotate-hint); installing removes the browser toolbars for good. */
export function RotateHint() {
  const install = useInstallState();
  return (
    <div className="rotate-hint" data-testid="rotate-hint" role="alert">
      <RotateCw size={42} strokeWidth={1.6} />
      <strong>请把手机横过来</strong>
      <span>萌猫公园只支持横屏游玩</span>
      {install !== 'app' && (
        <div className="install-hint" data-testid="install-hint">
          <p>在浏览器里横屏仍会留着地址栏和状态栏。{advice[install]}。</p>
          <InstallButton state={install} />
        </div>
      )}
    </div>
  );
}

/** Landscape browser tabs on touch devices (see .install-tip) still carry toolbars; suggest installing until dismissed. */
export function InstallTip() {
  const install = useInstallState();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(INSTALL_TIP_KEY) === 'dismissed';
    } catch {
      return false;
    }
  });
  if (install === 'app' || dismissed) return null;
  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(INSTALL_TIP_KEY, 'dismissed');
    } catch {
      /* Dismissal lasts for this page only. */
    }
  }
  return (
    <div className="install-tip" data-testid="install-tip" role="status">
      <MonitorSmartphone size={18} />
      <span>{advice[install]}</span>
      <InstallButton state={install} />
      <IconButton icon={X} label="不再提示" onClick={dismiss} />
    </div>
  );
}
