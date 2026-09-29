import { Download, RotateCw } from 'lucide-react';
import { promptInstall, useInstallState } from '../client/install';

/** Shown only on touch devices held upright (see .rotate-hint); installing removes the browser toolbars for good. */
export function RotateHint() {
  const install = useInstallState();
  return <div className="rotate-hint" data-testid="rotate-hint" role="alert">
    <RotateCw size={42} strokeWidth={1.6} />
    <strong>请把手机横过来</strong>
    <span>萌猫公园只支持横屏游玩</span>
    {install !== 'installed' && <div className="install-hint" data-testid="install-hint">
      <p>在浏览器里横屏仍会留着地址栏和状态栏。{install === 'prompt' ? '安装为应用后从桌面打开，可以全屏游玩。' : '添加到主屏幕后从桌面图标打开，可以全屏游玩。'}</p>
      {install === 'prompt' && <button className="button primary" data-testid="install-app" onClick={() => void promptInstall()}><Download size={16} />安装为应用</button>}
      {install === 'ios' && <small>在 Safari 点底部的“分享”按钮，选择“添加到主屏幕”</small>}
      {install === 'manual' && <small>在浏览器菜单中选择“添加到主屏幕”或“安装应用”</small>}
    </div>}
  </div>;
}
