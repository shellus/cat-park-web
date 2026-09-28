# 开发与本地运行

目标平台为电脑浏览器、Android Chrome 和 iOS Safari。应用内置浏览器暂不专项支持。

## 前置条件

- Node.js 24 或更新版本。
- 当前工作副本具有另行取得的素材包；Git 不携带游戏资源。
- Windows 或 Linux 上可下载 LiveKit 1.13.7 官方发行版，或者在 `config.yaml` 配置已运行的 LiveKit。

```sh
npm ci
npm start
```

`npm start` 先从素材包生成 `public/game/` 并构建前端，再准备本地配置，以生产模式启动语音与游戏服务：静态文件启用压缩，内容哈希命名的脚本和素材设置一年不可变缓存。首次缺少 `config.yaml` 时生成随机本地语音密钥；配置存在时不会覆盖。LiveKit 下载先核对官方 SHA-256 再解压到 `.runtime/`，不安装系统服务。

本地默认网页入口为 `http://localhost:3000`。使用 `localhost` 才能在未配置 HTTPS 的本地环境中申请麦克风；局域网 IP 的普通 HTTP 不满足麦克风安全上下文要求。手机访问需要实际可达的 HTTPS 页面和语音地址，不能直接使用另一台设备的 localhost。

`npm run start:dev` 同样启动本地语音，但网页由 Vite 开发服务提供，改前端源码刷新即可生效；`npm run dev` 只启动 Vite 模式的游戏服务，适合语音已单独运行或配置远端语音时使用。开发模式不压缩、不做长缓存，外网预览应使用 `npm start`。服务端源码或运行配置变化需要重启进程。

## 素材打包

素材包目录在私有 `config.yaml` 的 `assets.package` 中配置（相对项目根目录），包含素材清单、角色动画、场景、地图和精灵几何 JSON，以及清单引用的 PNG、音频和字体。缺少素材包时无法生成游戏画面；本仓库不提供素材下载或分发入口。

临时使用其他素材包时，可执行 `npm run assets -- --source <素材包目录>`。之后执行 `npx tsc --noEmit`、`npx vite build` 和 `npm run prod`，并自行配置可用的 LiveKit；`npm start` 会按 `config.yaml` 重新准备素材。

`npm run assets` 把精灵按加载边界打包为 WebP 图集：大厅（有损色彩、无损透明度）、每个角色、关卡物件（无损）以及单独的平铺背景。网页先加载当前场景与在场角色的图集，其他角色出现时再加载。字体按客户端源码用到的字符裁剪为 WOFF2。素材到素材包文件的对应关系写入 `.runtime/game-sources.json`，不随网页发布；每次运行会删除 `public/game/` 中不再引用的旧文件。

素材包必须包含 `sprite-geometry.json`：精灵 PNG 可能已裁掉透明边缘，打包前按原画布尺寸及裁切偏移补回透明边距，再进行图集边缘扩展。禁止直接把裁后尺寸当成原始尺寸，或拉伸 PNG 填满格子，否则树木、长凳、围墙、建筑、阴影以及角色分层会错位。大厅七个 Tilemap 图层的完整精灵画布均为 128×128；世界坐标、碰撞与地图矩阵保持来源定义。

素材包必须包含完整的 `sprite-geometry.json`，否则应先由素材提供方补齐。

待核验的素材质量问题：部分草地、水面 PNG 的边缘像素存在色差，平铺后仍可能出现细色线；浏览器抗锯齿开关对照未消除该现象。此问题区别于裁切偏移丢失导致的几何空隙，后续应对照来源纹理校验采样边界，不能通过移动格子或放大图片掩盖。

## 外网预览与语音

外网网页入口可以通过 HTTPS 反向代理到游戏服务，且必须允许 Colyseus WebSocket 升级。以 Vite 开发模式通过外网域名访问时，需在 `config.yaml` 的 `server.allowedHosts` 中加入该域名，否则 Vite 会拒绝请求。网页入口和 LiveKit 入口是两个不同的协议端点：`voice.url` 填浏览器访问的 `wss://` 地址，`voice.apiUrl` 填游戏服务访问 LiveKit 管理 API 的 `http://` 或 `https://` 地址。不能把网页首页的 `https://` URL 直接当成 LiveKit 地址，也不能让外网浏览器使用 `localhost`。

自托管 LiveKit 还需要公开其 WebSocket/API 端口、WebRTC TCP/UDP 端口；受限网络应配置 TURN/TLS。通过隧道把公网媒体端口转发到本机 `127.0.0.1` 时，LiveKit 默认不在回环地址上监听 UDP，会导致公网 UDP 包无人接收、ICE 一直停在 checking；`npm start` 生成的配置已开启 `rtc.enable_loopback_candidate`，自行编写 LiveKit 配置时也需开启。网页能打开只代表 HTTP 入口正常，不代表队伍语音已经可用，必须用两个真实浏览器完成入队、麦克风检查和队内通话验收。

## 配置与数据

配置采用 `config.yaml`，样例为项目根 `config.example.yaml`。账号与会话保存在 SQLite 中，浏览器保存用户 ID 和密码以便自动恢复。删除浏览器数据后需要用户名或原 ID 加密码才能回到原账号。账号表在启动时自动补充新增列，无需手动迁移。

LiveKit 未配置或无法连接时，用户仍可进大厅、聊天和组队，但只能经确认后不开麦准备。不得将开发模式当作跳过麦克风要求的理由。

默认队伍上限为六人，可在配置中调整；这是初版产品假设。开局最少两人，全员通过语音检测并准备。取消准备意图按账号保存，之后需主动准备。

`.runtime/`、`config.yaml`、`data/`、`public/game/` 和构建/测试产物均不进入 Git。素材准备保持来源到发布路径的映射，不修改素材包。

## 构建与验证

```sh
npm run typecheck
npm test
npm run build
npm run prod
```

生产运行需要独立保证 LiveKit 可达。常驻物理模拟、SQLite 和 WebRTC 媒体服务采用自托管模型；前端可作为普通静态产物分发，但当前不引入 Cloudflare 运行时依赖。

浏览器联调使用 Playwright 与独立浏览器上下文；环境变量 `PLAYWRIGHT_BASE_URL` 可指向独立测试实例，避免测试账号进入实际使用的数据库；测试媒体设备产生的音频仅用于验证采集、发布和状态流转，不能当成手机真实麦克风/蓝牙耳机的验收。

Linux 开发可用 `./tmux-dev-manager.sh start|stop|restart|status|attach|health` 管理 `cat-park-dev` 会话。Windows 可直接使用终端 `npm start`，停止时结束该命令；需要常驻时执行 `powershell -ExecutionPolicy Bypass -File scripts/windows-supervisor.ps1 -Register` 注册当前用户登录后自动启动的计划任务 `CatParkWeb`，进程退出后自动重启，输出写入 `.runtime/start.*.log`。`Stop-ScheduledTask CatParkWeb` 只停止监管进程，需同时结束其启动的 node 与 LiveKit；`-Unregister` 移除任务。

## 行为与验证边界

临时物理、碰撞和通关行为见 [游戏行为说明](./game-behavior.md)。素材齐全不代表玩法逻辑已全部校准。语音、移动端后台、蓝牙切换、蜂窝网络和公网部署应按实际设备与网络单独验收。

## README 截图

在具有素材和可用 LiveKit 的独立本地实例上执行：

```sh
npx playwright install chromium
npx tsx scripts/capture-screenshots.ts
```

默认连接 `http://localhost:3000`；环境变量 `SCREENSHOT_URL` 可指定独立实例入口。脚本创建四个临时访客账号，经真实组队和麦克风 / LiveKit 检查后开局，输出 `docs/screenshots/` 的四张 PNG。只在专用实例执行，避免演示账号和聊天进入实际使用的数据。手机截图使用 Chromium 触摸视口模拟，不代表 iOS Safari 或真实手机网络验收。

已知构建限制：Vite 报告部分压缩前模块超过 500 kB，主要包含渲染、语音与物理依赖。当前可构建运行；后续应基于加载测量评估进一步拆分，不仅调整告警阈值。

## 前端异常自动上报

浏览器自动捕获全局脚本错误、未处理 Promise、React 错误、资源加载失败、`console.error`，并在 API、游戏连接、素材/物理加载和语音捕获异常的边界主动上报。新增会吞掉异常的业务代码应调用 `reportClientError(source, error, details)`；新操作的上下文使用 `diagnosticBreadcrumb`，不得把每帧输入和音量采样写入日志。

每条记录包含事件 ID、页面会话 ID、构建版本、用户与队伍上下文、浏览器/视口/网络信息、发生与接收时间、错误堆栈及最近 30 条运行记录。语音失败额外保留连接尝试 ID、WSS 地址、信令/媒体阶段、publisher/subscriber 状态、最近 ICE 统计和 SDK 错误；候选地址与端口保留真实值。`verifiedUserId` 是服务端验证过的提交账号，`context.userId` 是事件发生时的前端账号；离线补传跨账号时两者可能不同。`forwardedFor` 保留代理头原值，只作线索，不作为可信身份。

同类错误 15 秒去重，队列最多 20 条；断网、服务器暂不可用时指数退避重试，队列保存在浏览器本地。页面隐藏/离开时用 `sendBeacon` 尝试发送首条，收到正常 HTTP 确认前仍保留队列，服务端按事件 ID 去重。诊断失败不递归上报。关闭页面且此后不再访问、清理浏览器存储或浏览器进程直接崩溃时不能保证送达；这套机制能减少复现依赖，不承诺捕获所有浏览器崩溃。

接口为 `POST /api/client-errors`，允许登录前上报；身份令牌仅用于验证提交账号，不写进日志，也不采集密码请求体或麦克风音频。接口最多接收 64 KiB，按直连来源地址每分钟限制 240 次。日志写入 SQLite 所在目录的 `client-errors/YYYY-MM-DD.jsonl`，单日上限 10 MiB，写入时清理超过 14 天的文件。诊断接口不提供公网读取能力。

```sh
npm run diagnostics -- --limit 20
npm run diagnostics -- --source voice --user 用户ID
npm run diagnostics -- --since 2026-09-28 --source http
```

查询命令按接收时间从新到旧输出原始记录。构建时生成唯一版本号，将 source map 留在 `.runtime/client-sourcemaps/<build>/`，不放入公开 `dist/`；查询会用事件版本对应的映射补充源码文件、行列。构建时删除早于 14 天（与诊断日志保留期一致）的旧映射目录；发布到其他机器时保留对应映射目录，不能用新构建映射解释旧日志。开发构建使用 `development` 标识。

公网部署的真实地址、Tunnel 服务归属和媒体端口映射记录于 Git 忽略的根目录 `README.local.md`。具体手机失败先按用户、时间和 `voice` 来源读取日志，核对信令是否已连接、媒体候选是否指向既定公网端口，再判断 NAT、防火墙、UDP/TCP 可达性或 TURN 回退需求。
