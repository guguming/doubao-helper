# 相对上游 v0.4.0 的改动说明

本文档说明这个 fork 相对上游 [`chensanle/doubao-helper`](https://github.com/chensanle/doubao-helper) 默认分支做了哪些改动、为什么这么改、以及怎么验证。上游基线是 `34d39b5`（2026-11-04，版本号 0.4.0），本 fork 版本号 0.5.0。

## 一句话概括

上游只导出「当前会话页能开到的那部分历史」，且不输出时间戳、把思维链和正文混在一起、没有任何续传概念。本 fork 把导出的完整性对齐到接口本身，并补上时间戳、思维链分区和增量导出。

## 上游实测暴露的问题

用一个 51408 个会话 index 的真实主对话做基线（用登录态直接请求 `/im/chain/single` 逐页翻到 `has_more=false` 独立数了一遍）：

| 指标 | 上游接口真值 | 上游 v0.4.0 导出 | 本 fork 0.5.0 |
| --- | --- | --- | --- |
| 消息条数 | 20693 | 19566 | 20693 |
| 用户消息 | 10283 | 9634 | 10283 |
| 豆包消息 | 10410 | 9932 | 10410 |
| 带时间戳的消息 | — | 0 | 20693 |
| 深度思考段 | 661 条消息有 `thinking_content` | 与正文混排 | 645 段（16 条只有搜索卡片、无思考正文） |
| 图片 | — | 374 | 690 |
| 文件里裸 JSON 转储 | — | 有（思维链里的搜索卡片） | 0 |

少掉的 1127 条不是接口丢的，而是撞上了 `maxApiPages(1000) × apiPageSize(20) = 20000` 这条硬上限：翻到第 1000 页就 `break`，只把 `stopReason=max-api-pages` 写进 JSON 的 meta，Markdown 里看不出来。

## 文件级改动清单

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `content-core.js` | 新增（704 行） | 纯逻辑层：消息解析、内容块分类、锚点选择、完整性统计、增量过滤、Markdown 渲染。不依赖 DOM。 |
| `content.js` | 重写核心路径 | 只保留页面交互、接口请求、下载、游标存取；分页循环重写，删除约 310 行已迁移到 core 的解析代码。 |
| `manifest.json` | 修改 | 版本 0.5.0；`content_scripts.js` 改为 `["content-core.js", "content.js"]`（顺序加载）；`permissions` 增加 `storage`。 |
| `popup.html` | 修改 | 新增「增量导出」下拉框（关闭 / 从上次位置 / 从指定日期）与起始日期输入；接口页数默认 1000 → 5000，每页条数 20 → 50。 |
| `popup.js` | 修改 | 读取增量选项并传给内容脚本；展示上次导出位置；注入脚本改为按序注入两个文件。 |
| `README.md` | 修改 | 版本与安装说明更新，新增增量导出用法、开发与测试说明。 |
| `CHANGELOG.md` | 新增 | 面向使用者的变更记录（含实测数字）。 |
| `tests/core.test.mjs` | 新增 | 16 项单元测试，fixture 是真实接口返回。 |
| `tests/fixtures/*.json` | 新增 | 4 份真实样本：整页返回、消息样本、用户图片消息、思维链 JSON。 |
| `tools/e2e-export.mjs` | 新增 | 无头 Chromium 端到端验证脚本（见 `tools/README.md`）。 |
| `docs/UPSTREAM-DIFF.md` | 新增 | 本文档。 |

DeepSeek 相关的 `deepseek-content.js`、`deepseek-page-hook.js`、`page-hook.js` 未改动。

## 逐项功能说明

### 1. 分页与完整性

上游的循环有三个会提前结束的点：`has_more` 为假就停、锚点「见过」就停、请求失败直接抛出（后面的历史全丢）。本 fork 改成：

- 分页上限 `5000 页 × 50 条`，默认每页 50 条（接口实测支持，上游探测页仍固定 20 条的行为一并改成 `min(apiPageSize, 50)`）；
- 单页请求失败重试 3 次（400ms / 1600ms 退避），HTTP 401/403 立即失败，不浪费 3 次；
- 锚点按「接口返回的 `next_index` → 本页最小 index − 1 → 当前锚点 − 1」三级取，并要求严格递减，避免原地打转；
- 连续 3 页没有新增消息才判定卡住；
- 结束原因写入文件头：`has-more-false`（正常到底）/ `cutoff-reached`（增量到界）/ `max-api-pages`（撞上限，会额外标注「本次未导完」）/ `anchor-not-advancing` / `no-new-messages` / `empty-page` / `unexpected-response-body`；
- 文件头输出 index 范围、原始条数、去重后条数、无时间戳条数，方便自行核对。

消息去重仍按 `message_id`，但去重逻辑与「本页是否有新增」解耦，重复页不再被误判成结束。

### 2. 时间戳

接口每条消息自带 `create_time`（秒级字符串或数字）。上游解析时把字段丢掉了。本 fork：

- 消息模型增加 `createTime`（秒）与派生字段，Markdown 标题行变成 `### 用户 · 2026-11-11 16:17:48`；
- JSON 每条消息增加 `createTime` / `createTimeText`，文件级增加 `range.from` / `range.to`；
- 文件头增加「消息时间范围」；
- 时间字段做了一次兼容：`create_time` / `create_at` / `createTime` / `update_time`，毫秒与秒自动识别。

### 3. 用户发的图片消息

`content_type = 20` 的图片消息既没有正文也没有 `content_block`，图片藏在 `content.entities[].entity_content.image`（含 `image_ori` / `image_thumb`）。上游直接丢弃；本 fork 会解析成 `![图片](url)`。同时兼容 `content_block` 里的附件块（10052）和生成块（2074）。

### 4. 思维链与正文分离

上游把所有块里的 `text` / `content` / `markdown` 塞进一个数组再 `Set` 去重，结果是：思维链、正文、免责提示、卡片 JSON 全混在一起，正文里重复的段落还会被误删。

本 fork 按块类型分类：

| `block_type` | 内容键 | 处理方式 |
| --- | --- | --- |
| 10000 | `text_block.text` | 正文 |
| 10008 | `code_block.code` | 正文（补围栏） |
| 10052 | `attachment_block.attachments[].image` | 图片 |
| 2074 | `creation_block.creations[]` | 图片 |
| 10053 | `research_process_block` | 归入深度思考 |
| 10040 | `thinking_block` | 状态提示（「正在生成图片」），忽略 |
| 10017 / 10080 / 10103 / 10055 / 10025 | 小程序卡 / 快捷回复 / 按钮 / 记忆标签 / 搜索卡 | 忽略，仅统计 |

思维链本体来自消息的 `thinking_content`。这个字段有两种形态：纯文本，以及 `{"thinks":[{"text":"…","text_tags":[搜索卡片 JSON]}]}`。上游会把后者整段写进 Markdown——上游那份 15.5MB 的文件里有一大截就是这些卡片 JSON。本 fork 只取 `thinks[].text`；当 `thinks[].text` 为空（只有搜索卡片、没有思考正文）时输出空，不再输出 JSON。

Markdown 里思维链单独成段：

```markdown
### 豆包 · 2026-11-11 16:17:48

正文……

**深度思考**

> 用户要整理出差清单和穿搭建议，我需确认其行程为……
```

JSON 里是独立字段 `thinking`，与 `text` 并列。

正文为空但带思维链、或只有图片的消息不再被丢弃（上游的 `if (parsed.text && ...)` 会整条跳过）。确实没有文本的卡片/系统消息会保留位置并输出一行说明，保证条数与 index 不断裂。

### 5. 增量导出（断点续传）

上游没有任何持久化。本 fork：

- 每次导出成功后，把 `{conversationId, lastCreateTime, lastIndex, lastMessageId, messageCount, exportedAt}` 写到 `chrome.storage.local`，键为 `doubaoExportCursor:<conversationId>`；
- 弹窗新增「增量导出」：`off` / `last`（从上次导出位置继续）/ `date`（从指定日期开始，支持 `YYYY-MM-DD`、`YYYY-MM-DD HH:mm`、秒/毫秒时间戳）；
- 增量模式仍然从最新一条往回翻，但每页解析后先判断「本页是否全部早于截断时间」，是就立即停（`stopReason=cutoff-reached`），不会白跑 416 页；
- 过滤规则：有上次 index 时以 index 为准（`index > lastIndex`，同秒消息不会重复），没有 index 时才退回时间比较；无时间戳的消息保守保留；
- 输出是独立文件，文件名带 `-incremental-from-YYYYMMDD`，文件头写明「导出模式：增量（起始时间）」；
- 没有历史游标时选「从上次位置继续」会报错并提示先做一次完整导出。

实测：以 `lastIndex=51360` 续传取到 19 条（预测 19）；以 `2026-11-09` 为界取到 82 条（预测 82），只翻 3 页，单次约 10 秒；全量 416 页约 4 分钟。

## 导出格式契约变化

### Markdown

上游：

```markdown
# 豆包对话导出

- 标题：主对话 - 豆包
- URL：https://www.doubao.com/chat/119275693619458
- 导出时间：2026-11-11T08:34:58.295Z

## 对话

### 豆包

（正文）
```

本 fork：

```markdown
# 豆包对话导出

- 标题：主对话 - 豆包
- URL：https://www.doubao.com/chat/119275693619458
- 消息条数：20693
- 消息时间范围：2024-08-10 20:46:16 ~ 2026-11-11 16:17:48
- 导出时间：2026-11-11T10:10:06.630Z
- 翻页结束原因：has-more-false
- 会话 index：1 ~ 51408（原始消息 20693 条，去重后 20693 条）

## 对话

### 豆包 · 2024-08-10 20:46:16

（正文）

---
```

变化点：标题行带时间戳；每条之间用 `---` 分隔；新增消息条数、时间范围、翻页结束原因、index 范围；思维链以 `**深度思考**` + 引用块出现；图片以 `![图片](url)` 出现；无文本消息有一行占位说明。

### JSON

上游每条消息：`{ index, role, text, messageId?, raw? }`，其中 `index` 是导出时重新编的 1..N，原始会话 index 丢失。

本 fork：

```jsonc
{
  "source": "doubao",
  "url": "…",
  "title": "主对话 - 豆包",
  "chatId": "119275693619458",
  "exportedAt": "2026-11-11T10:10:06.630Z",
  "range": { "from": "2024-08-10 20:46:16", "to": "2026-11-11 16:17:48" },
  "meta": {
    "sourceMode": "api", "stopReason": "has-more-false", "truncated": false,
    "rawCount": 20693, "duplicatesDropped": 0, "pageCount": 416,
    "resumeMode": "off", "cutoffMs": 0,
    "integrity": { "messages": 20693, "thinkingMessages": 645, "images": 690,
                   "indexMin": 1, "indexMax": 51408, "messagesWithoutTime": 0 }
  },
  "messages": [
    {
      "index": 1,
      "role": "assistant",
      "conversationIndex": 1,
      "createTime": 1723293976,
      "createTimeText": "2024-08-10 20:46:16",
      "text": "…",
      "thinking": "…",          // 有思维链时才有
      "images": ["https://…"],  // 有图片时才有
      "notes": ["…"],           // 免责提示等
      "auxBlocks": ["applet_block"], // 被忽略的 UI 块类型，便于排查
      "messageId": "…"
    }
  ]
}
```

变化点：新增 `conversationIndex`（原始会话 index）、`createTime` / `createTimeText`、`thinking`、`images`、`notes`、`auxBlocks`、`range`，以及完整的 `meta.integrity`。`raw` 只在导出 JSON 时保留（Markdown 导出不再把每条原始消息挂在内存里，减少长会话的内存压力）。

## 代码结构变化

上游 `content.js` 是单一 IIFE，解析、分页、UI 混在一起且无法单独测试。本 fork 拆出一个无 DOM 依赖的 `content-core.js`，通过 `globalThis.DoubaoExportCore` 暴露：

| 从 `content.js` 移除 | 位置 |
| --- | --- |
| `parseApiMessage` / `inferApiRole` / `extractApiText` / `extractContentBlockText` | 迁到 core，接口更严格 |
| `getApiMessageIndex` / `getApiMessageIdentity` / `getFirstPositiveInteger` | 迁到 core |
| `getNextApiAnchor` / `getFallbackApiAnchor` | 合并为 `pickNextAnchor` |
| `getSingleChainBody` / `describeApiResponse` | 迁到 core |
| `buildPayload` / `toMarkdown` | 迁到 core，输出格式升级 |
| `parseMaybeJson` / `looksLikeJson` | 迁到 core（DOM 路径仍用 `content.js` 自己的 `normalizeText`） |

| 在 `content.js` 新增 | 说明 |
| --- | --- |
| `requestSingleChainWithRetry` | 3 次退避重试，401/403 快速失败 |
| `readExportCursor` / `saveExportCursor` / `cursorStorageKey` | `chrome.storage.local` 游标读写 |
| `formatCutoffLabel` / `cutoffLabelForFile` | 增量区间的文案与文件名后缀 |
| `buildApiResult`（重写） | 保留解析出的全部字段并稳定排序，不再只留 5 个字段 |

`manifest.json` 里 `content_scripts` 的顺序很重要：`content-core.js` 必须先于 `content.js` 注入；弹窗里的 `chrome.scripting.executeScript` 也改成了按序注入两个文件。

## 兼容性与风险

- **不影响 DeepSeek 导出**：`deepseek-content.js` 自带一套解析与渲染，未改动，也未引用 core。
- **滚动兜底路径保留**：`scroll-only` / `api-first` 仍然可用；它们产出的消息没有 `createTime`，Markdown 会省略时间戳，文件头会标注「无时间戳消息：N 条」。
- **新增 `storage` 权限**：只用于本地游标，不上传任何内容。
- **接口变更风险**：分页与字段解析依赖 `/im/chain/single` 的 `has_more`、`next_index`、`index_in_conv`、`content_block`、`thinking_content`。接口改结构时优先看文件头的 `翻页结束原因` 和 JSON 的 `meta.integrity`，再对照 `content-core.js` 里的解析函数。
- **导出体积**：长会话全量 Markdown 仍在 16MB 量级；JSON 因保留 `raw` 会明显更大。需要小体积归档时用 Markdown，或者导出 JSON 前把 `includeRaw` 关掉（接口字段已预留）。
- **回滚**：上游 0.4.0 只需 `git checkout 34d39b5`；0.5.0 的导出文件与旧版不冲突，但字段更全。

## 验证方式与结果

### 单元测试

```bash
node --test tests/     # 16 项全过
```

覆盖：页面返回定位、时间戳解析与格式化、思维链（纯文本 / `thinks` JSON / 空 `thinks`）、用户图片消息、UI 块不进正文、锚点严格递减、日期截断解析、增量过滤与停止判断、完整性统计、Markdown 渲染。

### 端到端

用真实登录态在无头 Chromium 里跑（`tools/e2e-export.mjs`，不干扰桌面窗口）：

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| 全量导出 | 20693 条 | 20693 条（用户 10283 / 豆包 10410），20693 条带时间戳，645 段深度思考，690 张图片，0 处裸 JSON |
| 从上次位置续传（`lastIndex=51360`） | 19 条 | 19 条 |
| 从指定日期（`2026-11-09`） | 82 条 | 82 条，`stopReason=cutoff-reached`，3 页 |

一个已知的数据现象：导出里有 1 处时间戳倒挂（用户消息比紧随其后的回复晚 27 秒），那是服务端 `create_time` 本身如此，排序按会话 index，不按时间。

## 未做的事

- 没做多文件合并（把增量文件拼成全量）——按需求只输出独立增量文件；
- 没做「账号下全部会话批量导出」；
- 没改 DeepSeek 导出的时间戳/思维链——它的接口里没有等价字段，不在本次范围；
- 没做图片本地化（图片仍是远端 URL）。
