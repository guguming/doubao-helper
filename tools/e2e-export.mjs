// 端到端验证脚本：在无头 Chromium 里把 content-core.js + content.js 注入真实豆包会话页，
// 走真实的导出链路（含 blob 下载），最后统计导出的 Markdown。
//
// 前置：
//   1. 本机 Chromium 里已经登录过 www.doubao.com；
//   2. 复制一份配置目录，用无头模式启动并开好 CDP 端口：
//        cp -r ~/.config/chromium /tmp/doubao-e2e-profile
//        chromium --headless=new --no-sandbox --disable-gpu \
//          --remote-debugging-port=9333 --user-data-dir=/tmp/doubao-e2e-profile \
//          --disable-background-timer-throttling about:blank
//   3. 运行：
//        node tools/e2e-export.mjs "https://www.doubao.com/chat/<会话ID>"
//
// 说明：脚本通过 chrome.runtime.onMessage 的 DOUBAO_EXPORT_CHAT_V2 通道触发导出，
// 和弹窗点击走的是同一条路径；chrome.storage 用内存 stub 代替。
import fs from "node:fs";
import path from "node:path";

const CHAT_URL = process.argv[2];
if (!CHAT_URL) {
  console.error("用法: node tools/e2e-export.mjs <会话URL> [下载目录]");
  process.exit(1);
}

const PORT = process.env.CDP_PORT || "9333";
const DOWNLOAD_DIR = path.resolve(process.argv[3] || "tmp-e2e-downloads");
const TIMEOUT_MS = Number(process.env.EXPORT_TIMEOUT_MS || 900000);

const config = {
  format: process.env.FORMAT || "markdown",
  exportMode: process.env.EXPORT_MODE || "api-only",
  maxApiPages: Number(process.env.MAX_API_PAGES || 5000),
  apiPageSize: Number(process.env.API_PAGE_SIZE || 50),
  resumeMode: process.env.RESUME_MODE || "off",
  sinceDate: process.env.SINCE_DATE || undefined,
  seedCursor: process.env.SEED_CURSOR === "1",
  seedTime: Number(process.env.SEED_TIME || 0),
  seedIndex: Number(process.env.SEED_INDEX || 0)
};

const chatId = (() => {
  try {
    return new URL(CHAT_URL).pathname.match(/(\d{6,})/)?.[1] || "";
  } catch (_error) {
    return "";
  }
})();

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("没有找到页面 target，检查 Chromium 是否带 --remote-debugging-port 启动");

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const events = [];
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method) {
    events.push(msg);
  }
});
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

const send = (method, params = {}, timeout = 120000) =>
  new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => {
      if (pending.has(myId)) {
        pending.delete(myId);
        reject(new Error(`timeout ${method}`));
      }
    }, timeout);
  });

const evaluate = async (expression, timeout) => {
  const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeout);
  if (res.exceptionDetails) throw new Error("页面执行失败: " + JSON.stringify(res.exceptionDetails).slice(0, 1200));
  return res.result?.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOAD_DIR }).catch(() => {});

console.log("打开会话页:", CHAT_URL);
await send("Page.navigate", { url: CHAT_URL });
const navStart = Date.now();
while (Date.now() - navStart < 60000) {
  if (events.some((e) => e.method === "Page.loadEventFired")) break;
  await new Promise((r) => setTimeout(r, 200));
}
await new Promise((r) => setTimeout(r, 2500));

await evaluate(`
  (() => {
    const store = {};
    globalThis.__logs = [];
    globalThis.__errors = [];
    window.addEventListener("error", (e) => globalThis.__errors.push(String(e.message || e.error)));
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener: (fn) => { globalThis.__msgListener = fn; } },
        sendMessage: async (msg) => { globalThis.__logs.push(msg); return {}; },
        getURL: (p) => "data:text/javascript,",
        lastError: null
      },
      storage: {
        local: {
          get: async (key) => {
            const keys = typeof key === "string" ? [key] : Object.keys(key || {});
            const out = {};
            for (const k of keys) if (store[k] !== undefined) out[k] = store[k];
            return out;
          },
          set: async (obj) => { Object.assign(store, obj); return true; }
        }
      }
    };
    return true;
  })()
`);

const core = fs.readFileSync(path.resolve("content-core.js"), "utf8");
const content = fs.readFileSync(path.resolve("content.js"), "utf8");
await evaluate(`(() => { ${core}; return DoubaoExportCore.version; })()`);
await evaluate(`(() => { ${content}; return true; })()`);

if (config.seedCursor) {
  if (!chatId) throw new Error("无法从 URL 解析会话 ID，不能预置游标");
  await evaluate(
    `chrome.storage.local.set({ ${JSON.stringify(`doubaoExportCursor:${chatId}`)}: ${JSON.stringify({
      conversationId: chatId,
      lastCreateTime: config.seedTime,
      lastIndex: config.seedIndex,
      messageCount: 0,
      exportedAt: new Date().toISOString()
    })} }).then(() => true)`
  );
}

const before = new Set(fs.readdirSync(DOWNLOAD_DIR));
await evaluate(`(() => {
  const listener = globalThis.__msgListener;
  if (!listener) throw new Error("没有安装 DOUBAO_EXPORT_CHAT_V2 监听器");
  listener(${JSON.stringify({
    type: "DOUBAO_EXPORT_CHAT_V2",
    exportId: "e2e-" + Date.now(),
    format: config.format,
    exportMode: config.exportMode,
    autoScroll: false,
    maxApiPages: config.maxApiPages,
    apiPageSize: config.apiPageSize,
    resumeMode: config.resumeMode,
    ...(config.sinceDate ? { sinceDate: config.sinceDate } : {})
  })}, { id: 1 }, (response) => { globalThis.__exportResponse = response; });
  return true;
})()`);

console.log(
  `触发导出：format=${config.format} resumeMode=${config.resumeMode}` +
    (config.sinceDate ? ` sinceDate=${config.sinceDate}` : "")
);

const started = Date.now();
let file = null;
while (Date.now() - started < TIMEOUT_MS) {
  await new Promise((r) => setTimeout(r, 2000));
  const fresh = fs
    .readdirSync(DOWNLOAD_DIR)
    .filter((name) => !before.has(name) && !name.endsWith(".crdownload"));
  if (fresh.length) {
    const candidate = path.join(DOWNLOAD_DIR, fresh[0]);
    const size1 = fs.statSync(candidate).size;
    await new Promise((r) => setTimeout(r, 2000));
    if (fs.statSync(candidate).size === size1 && size1 > 0) {
      file = candidate;
      break;
    }
  }
  const logs = JSON.parse(
    await evaluate(
      `JSON.stringify({ last: (globalThis.__logs || []).slice(-1)[0] || null, done: !!globalThis.__exportResponse })`
    )
  );
  process.stdout.write(
    `\r[${Math.round((Date.now() - started) / 1000)}s] ${logs.last?.message || "等待中"}`.slice(0, 140)
  );
  if (logs.done && !fresh.length) break;
}

console.log("");
if (!file) {
  const response = await evaluate(`JSON.stringify(globalThis.__exportResponse || null)`);
  console.error("没有产生下载文件。导出返回：", response);
  process.exit(2);
}

const text = fs.readFileSync(file, "utf8");
const stat = fs.statSync(file);
const count = (re) => (text.match(re) || []).length;
console.log(
  JSON.stringify(
    {
      file: path.basename(file),
      bytes: stat.size,
      messages: count(/^### (?:用户|豆包) · /gm),
      user: count(/^### 用户 · /gm),
      bot: count(/^### 豆包 · /gm),
      withTimestamp: count(/^### (?:用户|豆包) · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/gm),
      thinkingSections: count(/^\*\*深度思考\*\*$/gm),
      images: count(/^!\[图片\]\(/gm),
      elapsedSec: Math.round((Date.now() - started) / 1000),
      response: JSON.parse(await evaluate(`JSON.stringify(globalThis.__exportResponse || null)`) || "null")
    },
    null,
    2
  )
);

ws.close();
process.exit(0);
