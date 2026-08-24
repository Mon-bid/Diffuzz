# Diffuzz 设计文档

> 一个运行在 Chrome DevTools 中的轻量级授权请求变异与响应差异分析工具。
> 无需配置代理、无需启动 Burp，直接复用浏览器登录态。
> **仅用于已获得书面授权的渗透测试场景。**

---

## 1. 产品定位

### 1.1 目标用户

- Web 安全测试人员、渗透测试工程师、甲方安全团队。
- 需要在已登录的浏览器会话中，对少量接口快速做参数变异测试的人。

### 1.2 核心场景（用户故事）

| # | 场景 | Diffuzz 的做法 |
|---|------|---------------|
| U1 | 换个用户名/ID 看响应是否不同 | 从 Network 面板捕获的请求中选一条，标记 `{{FUZZ}}`，粘贴候选值批量发送 |
| U2 | 只测一条请求，不值得开 Burp | DevTools 面板内直接完成，零配置 |
| U3 | 复用现有 Cookie / CSRF Token | 请求从扩展上下文发出，自动携带浏览器 Cookie；原请求中的 CSRF Token 可保留或标记为 FUZZ 位 |
| U4 | 1000 个结果里找出 3 个异常 | 自动基线 + 聚类 + 异常评分，异常置顶 |
| U5 | 低速、低调地测 | 内置令牌桶限速，默认 2 req/s，并发 1 |

### 1.3 非目标（明确不做）

- 不做全站爬虫 / 自动化 Fuzz 探测。
- 不做代理转发（不是 Burp/ZAP 替代品）。
- 不做 payload 字典库（只接收用户粘贴的候选值 + 简单数字区间生成器）。
- 不向任何外部服务发送数据，纯本地。

---

## 2. 页面结构（DevTools Panel UI）

新增一个 DevTools 面板页 `Diffuzz`，单一页面三段式布局，从左到右即工作流：

```
┌──────────────────────────────────────────────────────────────────────┐
│ Diffuzz   [● 未授权测试请止步-仅限已获授权目标]      限速: 2/s ▾  ⚙设置 │
├────────────────┬──────────────────────────────────┬──────────────────┤
│ ① 请求来源      │ ② 模板编辑器                      │ ③ 结果分析        │
│                │                                   │                  │
│ [Network 捕获] │ Method  GET  URL                   │ ▸ 基线: 200, 4.2KB│
│ ┌────────────┐ │ https://a.com/api/user/{{FUZZ}}   │   (3 次校验,稳定) │
│ │GET /api/x █│ │                                   │                  │
│ │POST /api/y │ │ 请求头 (可标记 FUZZ 位)             │ 异常 ▲ 共 1000 条 │
│ │GET /api/z █│ │  Authorization: Bearer ey...█     │ ┌──────────────┐ │
│ │  (搜索框)   │ │                                   │ │▶ 997. 200 4.2K│ │
│ └────────────┘ │ 请求体                             │ │  998. 200 4.2K│ │
│                │ { "uid": "{{FUZZ}}" }             │ │★ 999. 200 9.1K│ │
│ [手动粘贴 cURL] │                                   │ │★1000. 403  1.1K│ │
│                │ FUZZ 位置: ( )URL (•)Body          │ └──────────────┘ │
│                │ Payload (每行一个):                │                  │
│                │ ┌──────────────────────────────┐  │ 点开一条 ↓        │
│                │ │1001                          │  │ ┌──────────────┐ │
│                │ │1002                          │  │ │差异对比视图    │ │
│                │ └──────────────────────────────┘  │ │ 左:基线 右:本条│ │
│                │ 数字区间: 1000..1100 步长1 [替换]   │ │ 忽略规则: ...  │ │
│                │                                   │ │ [导出 CSV/JSON]│ │
│                │ [▶ 开始 (1000 请求, 预计 ~8min)]   │ └──────────────┘ │
├────────────────┴──────────────────────────────────┴──────────────────┤
│ 状态栏: ▶ 运行中 456/1000 │ 速率 1.9/s │ 错误 0 │ [暂停][终止]         │
└──────────────────────────────────────────────────────────────────────┘
```

- **① 请求来源**：监听 `chrome.devtools.network` 的实时请求流 + `getHAR()` 补历史；支持直接粘贴 cURL（M5）。
- **② 模板编辑器**：三个可编辑区（URL / Headers / Body），选中文字点"标记 FUZZ"或手写 `{{FUZZ}}`；FUZZ 位置单选（v1 只有一个活跃替换点，多点位 zip 模式留到 v2）。
- **③ 结果分析**：基线摘要、按异常分排序的结果表（★=异常）、差异对比视图（响应头+正文并排 diff，动态字段自动打码）、导出。
- **状态栏**：进度、实时速率、暂停/终止（暂停时令牌桶清空，终止即丢弃未发送项）。

---

## 3. 技术架构

### 3.1 总体形态

- Chrome 扩展，Manifest V3，`minimum_chrome_version: 116`。
- **零依赖、零构建**：原生 ES Modules + 原生 HTML/CSS/JS，加载未打包扩展即可开发。不引入 React/Vite/打包器（面板 UI 规模小，DOM 直操足够；如后期 UI 复杂再议）。
- **单一运行上下文**（v0.2 架构修订：**无 Service Worker**）：面板页面 = UI + 任务执行（task-runner/sender/ratelimit 全部在 panel 页面内直接运行），请求捕获用 chrome.devtools.network。

> **为什么没有后台 SW**：MV3 后台 Service Worker 会被 Chrome 不定期回收，实测导致任务冻结、终止命令失联、结果丢失。v0.1 曾采用 SW 架构，v0.2 修订为面板页面内执行。代价：关闭 DevTools 即终止任务（面板重开为新任务）。

**职责切分原则**：
- **panel/（DevTools 面板页）**：UI + 任务执行一体。捕获请求列表、编辑模板、发送请求、展示结果。
- **background/（发送链路模块）**：无事件入口，由面板页面 import 直接调用（task-runner/sender/ratelimit）。
- **core/（纯逻辑模块）**：不碰任何 `chrome.*` API，可在普通页面里直接单测。

### 3.2 manifest.json（关键项）

```json
{
  "manifest_version": 3,
  "name": "Diffuzz",
  "version": "0.2.0",
  "description": "授权测试用的请求变异与响应差异分析 DevTools 面板",
  "minimum_chrome_version": "116",
  "devtools_page": "devtools/devtools.html",
  "permissions": ["storage", "declarativeNetRequest"],
  "host_permissions": ["http://*/*", "https://*/*"],
  "icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
}
```

- `host_permissions` 全域是必须的（目标站点未知），安装时会有"读取所有网站数据"提示——在 README 里明说原因。
- `declarativeNetRequest`（DNR）：fetch 无法设置 `Cookie` 等 forbidden header，用**会话级 DNR 规则**对扩展自己发出的请求做头覆盖（见 4.3）。
- 无 `background` 字段：不使用 Service Worker（见 3.1）。结果导出用 Blob URL，无需 downloads 权限。

### 3.3 请求发送路径（核心技术决策）

**决策：请求从 DevTools 面板页面的 `fetch()` 发出，配合 DNR 会话规则覆盖受限头。**
（v0.1 为 SW 发送，v0.2 修订为面板页面发送，原因见 3.1；两者能力等价：host_permissions 免 CORS、`credentials:'include'` 带 Cookie、DNR 覆盖受限头。）

其他备选：

| 方案 | 结论 |
|------|------|
| A. Service Worker fetch + DNR 头覆盖（v0.1 采用，已弃用） | 能力同现行方案，但 MV3 SW 会被 Chrome 回收，任务冻结/终止失联 |
| B. `inspectedWindow.eval` 在页面里发 fetch | 受页面 CSP 限制、可能触发目标站的风控脚本、无法覆盖受限头。不采用 |
| C. chrome.debugger 协议原始重放 | 能力最强（可改任意头），但会挂起"正在被调试"横幅、与其他 DevTools 功能冲突。**不采用** |

发送配置：

```js
fetch(url, {
  method, headers, body,
  credentials: 'include',          // 复用浏览器 Cookie
  redirect: 'follow',              // 默认跟随（opaque-redirect 限制见下）
  cache: 'no-store',
  signal: <AbortController.signal> // 终止任务时立即掐断在途请求
})
```

- `redirect` 提供 `follow / manual` 两种模式，默认 `follow`：fetch 的 `redirect:'manual'` 对跨域请求返回 opaque-redirect，读不到 Location 细节，故默认跟随并通过 `finalUrl != 请求URL` 判定跳转（记录最终 host+path 作为跳转签名）；`manual` 作为可选项用于探测"是否发生跳转"。
- 响应体统一 `response.arrayBuffer()`，≤2MB 截断记录；文本按 charset 解码，二进制只记 SHA-256 与大小。

### 3.4 请求捕获

- 实时：`chrome.devtools.network.onRequestFinished` 有节流地（`filter` 后）写入面板内存列表，上限 2000 条 FIFO。
- 历史：面板打开时 `getHAR()` 一次性导入。
- HAR `entry.request` → `RequestTemplate` 的字段映射：`method/url/headers/postData.text`。HAR 拿不到响应体不影响（我们只关心原始请求）。
- 捕获不到 POST body 的极端情况（如某些流式上传）：在编辑器里显示"请求体缺失，请手动补全"占位。

---

## 4. 模块职责

### 4.1 目录组织

```
diffuzz/
├── manifest.json
├── DESIGN.md                    # 本文档
├── README.md
├── icons/
│   └── icon128.png
├── devtools/
│   ├── devtools.html            # devtools_page 入口
│   └── devtools.js              # chrome.devtools.panels.create("Diffuzz", ...)
├── panel/                       # DevTools 面板（UI + 任务执行）
│   ├── index.html
│   ├── panel.css
│   ├── app.js                   # 主控制器：任务执行、视图编排
│   └── views/
│       ├── request-list.js      # ① 捕获列表 + 搜索 + cURL 导入
│       ├── editor.js            # ② 模板编辑 + FUZZ 标记 + payload 管理
│       ├── results.js           # ③ 结果表 + 排序 + 导出
│       ├── dict-manager.js      # 字典库：保存 / .txt 导入 / 复用
│       └── diff-viewer.js       # 响应查看弹窗（详情 / 基线对比）
├── background/
│   ├── task-runner.js           # 任务状态机：created→baselining→running→done/paused/aborted
│   ├── sender.js                # fetch 发送 + DNR 规则申请/回收
│   └── ratelimit.js             # 限速
├── core/                        # 纯逻辑，零 chrome API 依赖，可独立单测
│   ├── template.js              # {{FUZZ}} 解析、渲染、位置定位
│   ├── har-adapter.js           # HAR entry / cURL → RequestTemplate
│   ├── normalize.js             # 响应归一化（去动态字段）
│   ├── fingerprint.js           # 特征提取 + simhash64
│   ├── diff-engine.js           # 基线统计、聚类、异常评分
│   └── util.js                  # FNV-1a、sha256 hex、格式化
├── test/
│   ├── tests.js + run.mjs          # 单测（Node 与浏览器共用，27 项）
│   ├── runner.html               # 浏览器端跑器
│   └── server.mjs               # 本地靶机（验收用）
└── scripts/
    ├── pack.sh                  # zip 打包发布
    ├── gen-icon.mjs             # 生成扩展图标
    └── smoke.mjs                # 端到端冒烟（Node 模拟完整任务）
```

### 4.2 panel <-> task-runner 交互（v0.2：同页直接调用）

无跨进程消息。面板 `app.js` 持有 TaskRunner 实例，通过一个假 port 对象（`addPort({postMessage})`）接收任务事件流：

| 事件 | 方向 | 载荷 | 说明 |
|------|------|------|------|
| `task/state` | runner->panel | `{task}` | 状态变化（启动/暂停/终止/出错） |
| `task/baseline` | runner->panel | `{baseline, baselineRecords}` | 基线完成 |
| `task/result` | runner->panel | `{records[]}` | 批量结果（每 10 条） |
| `task/progress` | runner->panel | `{stats}` | 进度（每秒聚合） |
| `task/done` | runner->panel | `{snapshot}` | 任务结束（含全量记录与 DiffResult） |

按钮直接调用 `runner.pause()/resume()/abort()`（本地函数调用，终止会经 AbortController 立即掐断在途请求）；面板在 `task/result` 到达时本地重算 `analyze()` 实现实时异常分。

---

## 5. 数据结构

`core/` 内以 JSDoc 注释约定类型（不引入 TS，保持零构建）：

```js
/** 请求模板 —— 从 HAR/cURL 导入或手编 */
RequestTemplate = {
  id: string,              // nanoid 风格短 id
  source: 'har' | 'curl' | 'manual',
  method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'HEAD',
  urlTemplate: string,     // 含 {{FUZZ}} 占位
  headers: [{ name, valueTemplate }],   // valueTemplate 可含 {{FUZZ}}
  bodyTemplate: string | null,
  originHost: string,      // 导入时锁定，任务目标只能在该 host（见 §7）
}

/** FUZZ 位置 */
FuzzPosition = {
  locator:
    | { type: 'url' }
    | { type: 'header', headerName: string }
    | { type: 'body', offset: number, length: number },  // body 内原文切片定位
}

/** 任务配置 */
FuzzConfig = {
  payloads: string[],              // 展开后的候选值，≤1000
  ratePerSec: number,              // 0.2 ~ 5，默认 2
  followRedirect: false,
  baselineRuns: 3,                 // 基线重复次数
  timeoutMs: 15000,
  ignoreRules: [{ pattern: string /*regex*/, flags?: 'g', replacement: '' }], // 用户自定义忽略
}

/** 任务 */
Task = {
  id: string,
  template: RequestTemplate,
  fuzzPosition: FuzzPosition,
  config: FuzzConfig,
  status: 'baselining'|'running'|'paused'|'done'|'aborted'|'error',
  createdAt, finishedAt,
  stats: { total, done, sent, errors, abortReason? },
}

/** 单条响应记录 */
ResponseRecord = {
  seq: number,
  payload: string,
  ok: boolean, networkError?: string,
  status: number, statusText: string,
  finalUrl: string,
  redirectLocation: string | null,   // 3xx 时的 Location（去 query）
  headers: object,                   // 响应头白名单子集（见 §7 隐私）
  bodyBytes: number,
  bodyText: string | null,           // 截断至 2MB；二进制为 null
  bodySha256: string,
  contentType: string,
  timingMs: number,                  // TTFB 近似
  fingerprint: Fingerprint,
}

/** 归一化后的指纹 */
Fingerprint = {
  status: number,
  redirectSig: string,     // `${host}${pathname}`，无跳转为 ''
  lenNorm: number,         // 归一化正文长度
  lenBucket: number,       // floor(log2(lenNorm)) —— 长度聚类用
  simhash64: string,       // 归一化正文的 16 进制 simhash
  contentType: string,
}

/** 差异结果 */
DiffResult = {
  seq: number,
  clusterId: number,
  anomalyScore: number,    // 0~10，见 §6.4
  signals: {
    statusDiff: 0|1,
    redirectDiff: 0|1,
    lenZ: number,          // 鲁棒 z 分
    simhashDist: number,   // 0~64 汉明距
    timingZ: number,
  },
}
```

存储：任务运行态仅存于面板页面内存（关闭 DevTools 即终止，见 3.1）；用户设置与字典库放 `chrome.storage.local`。

---

## 6. 核心算法

### 6.1 模板渲染（core/template.js）

- 解析 `{{FUZZ}}`（允许 `{{FUZZ:urlencode}}` 变体，v1 实现纯文本 + urlencode 两种）。
- URL 中替换时对 payload 做 URL 编码；Header/Body 中按原文替换。
- 校验：占位符必须恰好出现在一个位置（多处出现报错，引导用户明确"哪个位置是活跃 FUZZ 位"）。

### 6.2 响应归一化（core/normalize.js）

目的：把每次响应都会变的噪声（时间戳、nonce、CSRF token）抹掉，只留语义差异。流水线：

1. 用户 `ignoreRules` 逐条应用（最高优先）。
2. 自动打码：
   - 10~13 位纯数字 → `<ts>`（Unix 毫秒/秒级时间戳）；
   - 长度 ≥16 的高熵十六进制/Base64 串 → `<token>`；
   - 形如 `csrf|_xsrf|token|nonce` 的 JSON key，其 value → `<token>`（key 名单内置，可配置）。
3. 压缩连续空白。
4. 二进制（解不出 UTF-8）不做归一化，直接用原始字节的 SHA-256 做指纹。

### 6.3 指纹与 simhash（core/fingerprint.js）

- token 化：归一化正文按行切，每行再切 3-gram shingle（短文本兜底整行为 token）。
- hash：FNV-1a 32 位两段拼 64 位（JS 无原生 64 位整数乘法，用两个 32 位寄存器法实现）。
- simhash：标准加权位投票；权重 = token 出现次数。
- 特征向量即 `Fingerprint` 六元组。

### 6.4 基线、聚类与异常评分（core/diff-engine.js）

**基线**：任务开始先用原始请求（不替换 payload）连发 `baselineRuns`（默认 3）次。若 3 次指纹互相不一致（常见于响应真随机或限流），标记 `baselineUnstable=true`，UI 提示"建议增加忽略规则"，退化为多数投票取众数簇作基线。

**鲁棒统计**：长度与耗时的离群度用 **中位数 + MAD** 的鲁棒 z 分（`0.6745*(x-med)/MAD`），避免少量异常值把均值带偏；MAD=0 时回退标准差，仍为 0 则二值化（同/不同）。

**聚类**：主键 `(status, redirectSig, lenBucket)`；最大簇为"正常簇"，其余簇全组成员直接获得簇级异常分。

**异常分**（0~10，钳位）：

```
score = 3.0·statusDiff
      + 2.5·redirectDiff
      + 1.0·clamp(|lenZ|, 0, 4)
      + 4.0·(simhashDist / 64)
      + 0.5·clamp(|timingZ|, 0, 4)
```

- 同簇成员之间再做簇内排序（simhashDist 优先）。
- `score < 0.5` 视为正常，不打星。
- 权重常量集中在 `diff-engine.js` 顶部一个 `WEIGHTS` 对象，便于调参。

### 6.5 限速（background/ratelimit.js）

- 令牌桶：容量 = `ratePerSec`（即允许瞬间补齐但不超过 1 秒额度），每 `1000/ratePerSec` ms 补 1。
- 并发恒为 1（串行发送），间隔额外加 ±20% 抖动。
- 连续 5 次网络错误或收到 429/503 → **自动暂停**并提示，等用户确认后继续（防止把目标打挂）。

---

## 7. 安全与合规限制

### 7.1 目标限制（硬编码，不可配置关闭）

| 限制 | 实现 |
|------|------|
| **同源锁定** | 任务目标 URL 的 host 必须等于导入时的 `originHost`；`{{FUZZ}}` 渲染后若 host 变化（如 payload 含 `../` 或 `//evil.com`）→ 该条跳过并记 `skipped` |
| **协议白名单** | 仅 `http:` / `https:` |
| **内网保护** | 目标 host 解析为 localhost / 127.0.0.0-8 / 10/8 / 172.16/12 / 192.168/16 / 169.254/16 时默认拒绝，需在设置里显式勾选"允许内网目标"（测试自建靶机用） |
| **规模上限** | 单任务 ≤2000 请求（payload 去重）；请求体 ≤512KB；单响应记录 ≤2MB（持久化正文截断至 32KB） |
| **速率下限** | `ratePerSec` 最低 0.2（5 秒 1 个），UI 不提供更高速度档 |

### 7.2 数据边界

- 全部处理在本地（SW 内存 + storage），无任何外部上报。
- 响应头持久化只保留白名单：`content-type, content-length, location, set-cookie 的"名字列表"`（只记 Cookie 名不记值，防敏感泄漏到导出文件）。
- 导出文件（CSV/JSON）不含 Cookie 值与完整响应头。

### 7.3 DNR 规则最小权限

- 每次需要覆盖受限头时，才创建 session 规则；`condition` 精确到 本次请求 URL + 自定义标记头 `x-diffuzz-task: <taskId>`，发送完成立即删除规则。规则上限触发时降级为"不覆盖该头"并提示。

### 7.4 使用声明

- 面板顶部常驻横幅："仅用于已获授权的目标"。README 首段同样的声明 + 免责。

---

## 8. 开发顺序（里程碑）

每个里程碑结束产出**可加载运行**的扩展，不搞大爆炸集成。

| 里程碑 | 内容 | 工作量估计 |
|--------|------|-----------|
| **M0 骨架** | manifest + devtools 面板空壳 + SW 能互发消息 + 零依赖测试跑器 | 0.5 天 |
| **M1 请求捕获与导入** | onRequestFinished/getHAR → 列表 UI → har-adapter → 模板编辑器（纯编辑，含 FUZZ 标记） | 1 天 |
| **M2 单条重放** | SW fetch 发送（含 DNR 头覆盖）+ Cookie 复用；"原样重放"按钮验证登录态生效 | 1.5 天 |
| **M3 批量任务** | payload 输入/区间生成 + task-runner 状态机 + 限速 + 进度推送 + 暂停/终止 + 自动暂停 | 2 天 |
| **M4 差异引擎** | normalize/fingerprint/diff-engine（含单测）+ 结果表异常排序 + 差异对比视图 | 2.5 天 |
| **M5 完整体验** | cURL 导入、导出 CSV/JSON、忽略规则 UI、字典库（v0.2 新增，替代 SW 时代的"任务恢复"） | 1.5 天 |
| **M6 加固收尾** | §7 安全限制全项落地、二进制响应处理、README、打包脚本、Edge/Chrome 双端冒烟 | 1 天 |

依赖关系：M2 依赖 M1；M3 依赖 M2；M4 的 core/ 三模块（normalize/fingerprint/diff-engine）**不依赖 M1-M3**，可从 M0 起并行开发（先写单测，拿录制样本驱动）。

---

## 9. 验收标准

### 9.1 本地靶机（test/server.mjs，随仓库提供）

Node 原生 `http` 模块的单文件服务器，提供验收用端点：

```
GET /api/user/:id        id∈[1000,1099] → 200 {"id","name","role":"user"}
                         id=1337        → 200 {"id":1337,"role":"admin","secret":"..."}   ← 异常：正文+长度
                         id=1           → 302 Location: /login                              ← 异常：跳转
                         其他            → 404                                                ← 异常：状态码
GET /api/echo?ts=1       响应含每次变化的时间戳与 CSRF token                    ← 验收归一化去噪
GET /api/slow?ms=3000    固定延迟 3s                                        ← 验收耗时信号
GET /api/ratelimit       第 11 个请求起返回 429                              ← 验收自动暂停
```

### 9.2 里程碑验收（对应 §8）

- **M0**：Chrome `chrome://extensions` 加载未打包扩展无报错；打开 DevTools 能看到 Diffuzz 面板；panel↔SW 消息回环测试通过。
- **M1**：浏览靶机若干页面后，面板列表能看到全部请求；选中 GET `/api/user/1001` 后，URL、头、体完整出现在编辑器中。
- **M2**：对需登录的页面（用靶机加一个 Basic/Cookie 校验端点）点"原样重放"，响应 200 且与浏览器内一致；请求头里的自定义 Cookie 覆盖生效（抓包验证 DNR）。
- **M3**：区间 1000..1100 共 101 条、2/s 发送，总耗时 50s±10s；中途暂停/终止有效；打到 `/api/ratelimit` 第 11 条后任务自动暂停。
- **M4**：对 `/api/user/:id` 跑 1000..1400：
  - 404 簇、302 簇、id=1337 均被打星且排在最前；
  - 对 `/api/echo` 跑 20 条，无一条被打星（时间戳/CSRF 已被归一化）；
  - 手工构造的时间权重、长度权重单测全绿（`test/runner.html` 打开即跑，断言数 > 60）。
- **M5**：粘贴一条真实 cURL（含 `-H`/`-d`）能正确生成模板；导出的 CSV 用 Excel 打开列完整；任务运行中关闭再重开 DevTools 面板，进度与结果完整恢复。
- **M6**：§7.1 各限制项逐一构造越界用例（改 host 的 payload、内网地址、>1000 条 payload）均被拦截并给出明确提示；Chrome Stable 与 Edge 最新版均通过 M2/M3/M4 主路径冒烟。

### 9.3 性能底线

- 1000 条结果表滚动不卡顿（分页渲染，每页 100）。
- SW 常驻内存 < 100MB（响应体处理完即转摘要，全文只留最近 50 条用于对比视图）。

---

## 10. 后续版本候选（v2+，本期不做）

- 多 FUZZ 位 zip / 笛卡尔积模式。
- `chrome.debugger` 原始重放作为高级模式（可改 forbidden 头全集）。
- payload 分组标注（如"管理员 ID 组"），组间对比。
- 结果备注与取证导出（Markdown 报告）。
