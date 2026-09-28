# 首版实现契约

网络类型的唯一入口是 `shared/protocol.ts`。服务器发送权威位置，客户端只上报输入不回传坐标；自己的小猫本地预测并按快照 `ack` 回滚重放，其他玩家按快照插值，详见 [游戏行为说明](./game-behavior.md#网络同步)。公共聊天和队伍保持独立于物理世界。

## 准备规则

至少两人且全员准备才可开局。入队开启自动准备意图，但只有麦克风采集到有效输入、语音连接与发布成功后才实际准备。手动取消设置 `autoReady=false`，后续检测、重连或重新加入队伍不自动将其改回；手动点击准备才表达新的准备意图。该偏好按账号保存。设备故障撤销实际准备，不抹去用户的取消偏好。

## 并行接口

- `shared/world.ts` 的 `createWorld` 是服务器与浏览器共用的模拟实现；`shared/simulation.ts` 导出服务器入口 `createSimulation(kind: WorldKind): Promise<GameSimulation>`，读取 `public/game/content.json`。实例提供 `addPlayer(profile)`、`removePlayer(id)`、`updateProfile(profile)`、`setInput(id,input)`、`step(dt)`、`snapshot()`、`dispose()`。一个实例只管理一个大厅或一场挑战。
- `scripts/prepare-assets.ts` 只消费现有素材包，生成被 Git 忽略的 `public/game/`，精灵以图集帧引用。`public/game/catalog.json` 提供 `{characters: CharacterOption[]}` 给服务器和网页。
- `src/game/GameCanvas.tsx` 默认导出 React 组件，props 为 `{world: WorldSnapshot|null,selfId:string,onInput:(input:InputState)=>void,inputEnabled:boolean}`。组件负责 PixiJS、键盘、移动端触摸控制、尺寸变化及销毁；`onInput` 在每个 60 Hz 固定步调用一次。
- 网页只通过协议规定的 HTTP 和 `park` Colyseus 房间 `action/social/world/voice/error` 消息联机，不直接访问服务端模块。
- LiveKit 配置缺失必须显示语音不可用，不能用假通过绕开准备门槛。自动准备在客户端与服务端同时落实；开局必须由服务端重新校验。

## 临时行为边界

队伍上限默认六人且可配置；断线保留席位三十秒，取消实际准备，队长超时退出时转交仍在线成员。对局掉线暂停对应输入，保留世界；成员退出或回大厅时结束当前队伍对局。手感、临时碰撞与关卡判定由物理模块集中维护并在已知限制文档说明。
