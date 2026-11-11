# 端到端验证脚本

`e2e-export.mjs` 用无头 Chromium 在真实豆包会话页里跑一遍完整导出，用来核对「条数、时间戳、思维链、图片、增量截断」是否符合预期。

它不是扩展的一部分，只在开发/回归时使用。

## 准备

1. 本机 Chromium 已经登录过 `www.doubao.com`。
2. 复制一份配置目录，用无头模式启动并打开 CDP 端口（用副本以免和正在用的浏览器抢锁）：

```bash
cp -r ~/.config/chromium /tmp/doubao-e2e-profile
chromium --headless=new --no-sandbox --disable-gpu \
  --remote-debugging-port=9333 --user-data-dir=/tmp/doubao-e2e-profile \
  --disable-background-timer-throttling about:blank
```

3. 在扩展根目录执行：

```bash
node tools/e2e-export.mjs "https://www.doubao.com/chat/<会话ID>" /tmp/doubao-e2e-downloads
```

脚本会把 `content-core.js` 与 `content.js` 注入页面，用 `chrome` 的内存 stub 替换 `chrome.storage`，然后通过 `DOUBAO_EXPORT_CHAT_V2` 消息通道触发导出（和弹窗点按钮是同一条路径），最后统计下载到的文件。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CDP_PORT` | `9333` | Chromium 调试端口 |
| `FORMAT` | `markdown` | `markdown` 或 `json` |
| `EXPORT_MODE` | `api-only` | `api-only` / `api-first` / `scroll-only` |
| `MAX_API_PAGES` | `5000` | 翻页上限 |
| `API_PAGE_SIZE` | `50` | 每页条数 |
| `RESUME_MODE` | `off` | `off` / `last` / `date` |
| `SINCE_DATE` | — | `RESUME_MODE=date` 时的起始日期，如 `2026-11-09` |
| `SEED_CURSOR` | — | `1` 时在导出前写入一条假游标，用于测「从上次位置续传」 |
| `SEED_TIME` / `SEED_INDEX` | `0` | 假游标的最后消息时间（秒）与会话 index |

## 示例

```bash
# 全量导出
node tools/e2e-export.mjs "https://www.doubao.com/chat/119275693619458" /tmp/out

# 从指定日期开始（只翻到该日期就停）
RESUME_MODE=date SINCE_DATE=2026-11-09 node tools/e2e-export.mjs "https://www.doubao.com/chat/119275693619458" /tmp/out

# 模拟「从上次导出位置继续」
SEED_CURSOR=1 SEED_TIME=1794380000 SEED_INDEX=51360 RESUME_MODE=last \
  node tools/e2e-export.mjs "https://www.doubao.com/chat/119275693619458" /tmp/out
```
