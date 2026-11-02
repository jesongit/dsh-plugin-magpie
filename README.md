# dsh-plugin-magpie

轻量 Magpie → DSH 连接器。**不修改 Magpie 或 DSH、不携带 Magpie 前端、不接管账号策略。**

## 功能

- 设置页填写管理后台 URL、后台登录密钥；可显式允许创建专用网关 Key，也可使用已有 Key。
- 从 Magpie `/v1/models` 自动同步，按供应商/provider 注册独立 DSH 分组；路由组单独展示。
- 所有分组共用一个 Chat Completions 适配器，完整上游模型 ID 原样发送；不发送账号绑定头，账号轮询和回退由 Magpie 决定。
- 支持流式文本、reasoning、工具调用与结果、图片附件、用量、取消；推理档位与上下文来自目录。
- 工作区上方 Magpie 导航项；必须先配置 URL + 密钥并成功连接才加载后台，否则友好引导。
- DSH 桌面受管原生 webview 加载 Magpie 原版后台，无 Browser 工具栏，不另带浏览器内核。首次打开用一次性启动凭证 + POST 自动登录，不再手动输入已配置的密钥；非桌面窗口明确提示，不自动降级 iframe。
- 导航、主面板与状态入口使用 Magpie 仓库原版小尺寸 SVG 喜鹊图标，颜色跟随 DSH；来源与 MIT 许可见 THIRD-PARTY-NOTICES。
- 输入框下方额度入口只在当前会话选中本插件注册的 Magpie 模型时出现，精确按模型路由匹配供应商，不按 GPT/Claude 名称猜测。沿用 Codex 订阅式紧凑按钮 + 锚定弹窗，只列该供应商，不展示全局总览。
- 弹窗仅显示供应商合并额度，不列多账号；异常账号剔除。同名同单位同池窗口才合并：有明确用量/总量时先相加再算比例，只有百分比时等权平均并明示口径，余额数值相加；不同周期/单位不混算，共享或纯文本余额不猜测合计。
- 外部入口如 `Codex · 2h15m | 5h60% · 1w40%`，只给最短已知周期的下一次重置倒计时，各周期剩余比例独立列出，无“剩余”后缀，不再使用最小—最大范围。`5h`/`1w`/`1m` 分别为五小时/周/月额度；倒计时不是整个账号池同时恢复，重置时间不同时弹窗明确各自重置。
- 入口和弹窗使用同一模型额度过滤结果，排除名称、池或单位中明确标为工具、MCP、搜索、浏览器、代码补全、媒体生成或签到的非推理额度。通用推理周期、积分和余额保留；上游快照无模型范围字段，不能保证识别未标注的服务专用额度。
- 上游未暴露模型独立额度范围，合并额度不声称是哪一个账号实际承接请求。当前宿主通过模型目录即时订阅切换，不额外轮询模型；旧宿主无订阅时才回退。
- 仅读 Magpie `kept=1` 快照，Host 共享缓存；当前 Magpie 模型显示期间每分钟低频读缓存，弹窗打开可更新快照，不主动刷新供应商登录态或上游额度。
- 目录每五分钟共享刷新，失败保留上次目录并标记过期；后台页面和模型调用彼此独立。
- 首次打开后台后只保留一个原生网页容器；切到其他面板仅隐藏，不重复加载、登录或丢失后台页签状态。断开、换 URL、成功重新连接或卸载插件时释放。取舍是后台会占用一份保留页面内存，上游页面自身的后台轮询策略不由插件改写。
- 正常运行不发送逐事件阶段诊断、不逐事件写本机日志；页面就绪后的重复加载通知不再反复读取原生地址。

## 安装

要求 DSH `0.2.1-rc.5`+ / Cordis `4.0.5` / Node 24，且需要 DSH **桌面端**（原生后台面板依赖受管 webview；纯 Web 端可用模型与设置，但打开后台会明确提示）。

从 GitHub 安装（Git 直装）：

```powershell
dsh plugin --profile desktop add github:jesongit/dsh-plugin-magpie
```

或克隆后本地安装：

```powershell
git clone https://github.com/jesongit/dsh-plugin-magpie
cd dsh-plugin-magpie
pnpm install
pnpm run build
dsh plugin --profile desktop add link:<仓库绝对路径>
```

使用正在运行的 DSH 对应 CLI 与 profile。桌面安装版自带 CLI 位于应用 resources/runtime/cli/bin；不要误用另一套全局 DSH 安装。插件通过 `dsh.bundle.patch` 自动挂载。添加后重新加载插件或重启 DSH 使服务端生效；没有 dev:web watcher 时，不承诺自动热更新。插件编译好后不需要改 DSH 核心或另起替代 Web 服务。

## 连接

1. 在 Magpie 开启现有的 Browser access，或使用已有 `magpie web` 管理服务。
2. DSH → 设置 → Magpie，填写**管理后台** URL 与页面登录密钥。不是仅模型接口的网关端口，也不是把 API Key 当作后台密钥。
3. 首次选择“允许创建 DSH 专用网关 Key”（有调用模型/消耗额度权限），或在高级设置填写现有网关 Key。
4. 点击连接并同步。高级设置可指定外部可达的网关 URL；远程 Magpie 报告的服务器 loopback 不会被误当成 DSH 本机。
5. 在模型选择器使用 `Magpie · Codex`、`Magpie · WorkBuddy` 等分组。现有手动导入配置不会被修改；默认模型不会被切换。

插件不会开启网络共享、改路由/账号、复制供应商登录态。远程模型访问需已具备 Magpie 所要求的共享与 Key 权限。

## 原生后台及自动登录

桌面 DSH 提供协议版本 1 的受管网页容器。插件申请专属 storage identity/lease，通过宿主固定沙箱创建 webview；没有 Node 集成、自定义 preload 或关闭 webSecurity。Magpie 在 guest 中是顶层站点，避免普通跨站 iframe 的第三方 Cookie 和额外祖先 CSP 问题。DSH 的浏览器 Cookie 不复制给 guest，guest 也不能访问 DSH 应用服务地址。

打开流程：原生 webview 先无密钥 GET 配置后台首页（未登录为 401 登录页、已有会话为 200）；父窗口经已有 owner-auth RPC 签发 32 字节随机、30 秒有效、只能消费一次的内存凭证，再消费得到临时 POST 描述。在精确核对登录页地址后，只运行一次固定登录脚本；脚本再次核对地址，以同源 `fetch` POST key/back 到 `/_magpie/sign-in`，固定 `redirect:'manual'`，让原站设置 Cookie 而不跟随 307/308 将密钥转发。随后原生容器对干净后台首页发 GET；没有代理或改写 Magpie 前端资源。token、后台密钥、网关密钥都不进入 URL。启动凭证不会写磁盘，最多保留 64 个；重配或断开后旧票据无法消费。

为了让网页容器自行建立会话，后台密钥必然短暂经过可信 DSH renderer 的 RPC 返回值和原生 POST 内存；**这不再是“密钥永远只在服务端”**。它不进入状态快照、localStorage、日志、错误正文、模型上下文；网关 Key 不参与网页登录。启动描述不会由未鉴权 guest URL 提取。

后台面板正常状态只显示原版页面，没有插件标题、状态条、操作栏或额外顶部留白；连接管理在 DSH 设置中。失败时在内容区提供错误和重试，不常驻顶部。只实现首次打开/显式重试的登录，不检测会话过期、不自动重登。启动超时或鉴权失败时停止并给提示，没有自动降级 iframe/外部浏览器。非桌面窗口不具备该能力，明确提示使用 DSH 桌面窗口。“在浏览器打开”只是用户主动选择，不会携带密钥。

复用 DSH 已有 Electron，不随插件再分发浏览器；仍可能新增 renderer 进程，不承诺零内存开销。离开主面板/打开连接设置时释放 guest lease，插件使用独立且不持久化的 guest session；同一次插件加载中返回面板会重新 POST。宿主原生 guest 默认禁止下载、权限请求及部分新窗口流程，相关行为仍受宿主策略控制；不删除 CSP、不代理改写原站，不宣称所有 OAuth/插件页面都已验证。

## 安全与存储

- 服务端敏感状态保存在 `$DSH_HOME/plugins/magpie/connection.json`，含后台/网关密钥和最后成功目录。通过原子替换保存，Unix mode 0600；**不是加密存储，Windows 不等于 DPAPI/独占 ACL**。保护 DSH 用户目录和备份。
- 普通状态 RPC 不返回密钥、Cookie、签名登录 URL、原始上游错误正文。启动专用 RPC 仅给已鉴权 owner 返回一次临时登录 POST 描述，全部响应 no-store。RPC 使用 DSH 受保护的 `/api` exact Fetch 路由，不另开未鉴权代理。
- 后台 POST 表单登录；不以 query 参数传 key。管理 Cookie 与网关 Bearer 分离，禁止跟随鉴权请求的重定向。
- 只连接用户明确设置的 HTTP(S) 地址；远程访问优先 HTTPS/可信 LAN/VPN。HTTP 本身不加密传输。
- 创建 Key 仅在显式同意且没有可复用 Key 时执行：先只读创建，再启用用于目录/模型验证；失败撤销本次新 Key，撤销失败会提示手动检查。
- 断开只删除本地连接并撤下模型分组；不会删除用户现有 Key。已创建 Key 可在 Magpie 中手动撤销。
- 本插件不读取 `.env`；真实验证脚本才读取用户指定的测试文件，不写入正式默认值。

## 更新日志

### 0.2.2

- WorkBuddy 紧凑入口简化：`Credits 93% · Extra credits 100% · Free model tokens 86%` → `93% · Extra 100% · Free 86%`。弹窗仍显示上游完整窗口名。

### 0.2.1

- 速度菜单视觉修正：菜单按钮显式左对齐，避免宿主按钮规则导致文字竖排错乱；触发按钮改为带边框小按钮（8px 圆角），与订阅插件一致。
- 选中标记移到行右端（仅选中项显示，主题色 ✓），与 DSH 模型列表样式一致，不再占左侧固定列。

### 0.2.0

- 推理档位过滤 `default`；未选择时默认 `high`，模型不支持时降级为首个声明档位；适配器始终声明默认档，宿主档位菜单不再出现「provider default」。
- 新增 Codex 速度选择（模型选择器旁 标准/快速）：仅当前模型声明 `priority` 服务档时显示，模型切换即时出现/消失（SDK observable，3 秒轮询仅兜底）；快速时请求带 `service_tier: "priority"`，账号拒收由 Magpie 自动回退；按会话记忆并持久化默认（0600）。
- 额度弹窗排除异常账号后合并展示，百分比/计数、余额、文本/不限量三类口径分开；紧凑入口带最短周期倒计时。

### 0.1.0

- 首个版本：供应商分组模型同步、一次性凭证 + 原生 webview 自动登录后台、保留式后台容器、当前模型额度弹窗。

## 构建与测试

```powershell
pnpm run check
pnpm run build
pnpm test
```

离线测试只用 fake fetch/临时目录，覆盖URL和鉴权、目录分组、不可变调用代际、失败回滚、缓存、工具/图片/usage/SSE、取消、DSH真实注册表。

`scripts/probe-real.mjs <本地测试文件>` 为只读连接探测；`scripts/smoke-real.mjs <本地测试文件>` 会创建临时 Key 并发**一次**短调用，再撤销，只有得到明确授权才运行。smoke 内针对本次已记录 NAS 网关/后台端口的映射仅用于该测试，不是插件自动猜端口逻辑。

## 当前验证与限制

见 `docs/verification.md`。协议选择通用 Chat Completions，由 Magpie 翻译上游；不宣称无损保留所有厂商私有 Responses replay/加密推理状态。工具参数完整组装后发出，不逐片实时展示参数。依赖明确的 DSH 扩展接口，Magpie 的管理 API 仍可能随上游版本变化；未知接口失败要提示而非静默修改权限。

## License

MIT，见 LICENSE。Magpie 图标来自 [yetone/magpie](https://github.com/yetone/magpie)（MIT），见 THIRD-PARTY-NOTICES。
