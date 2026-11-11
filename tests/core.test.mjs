// node --test tests/
// 用真实 /im/chain/single 返回样本验证解析层：时间戳、思维链、块分类、分页锚点、增量过滤。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const coreSource = fs.readFileSync(path.join(here, "..", "content-core.js"), "utf8");

function loadCore() {
  const sandbox = { console, Date, Math, JSON, Number, String, Set, Map, Array, Object };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(coreSource, sandbox);
  return sandbox.DoubaoExportCore;
}

const Core = loadCore();
const pullPage = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "pull-page.json"), "utf8"));
const messageSamples = JSON.parse(
  fs.readFileSync(path.join(here, "fixtures", "message-samples.json"), "utf8")
);

test("content-core 版本可加载", () => {
  assert.ok(Core);
  assert.equal(typeof Core.parseApiMessage, "function");
  assert.equal(Core.version, "0.6.0");
});

test("getSingleChainBody 能在真实返回里定位 messages", () => {
  const body = Core.getSingleChainBody(pullPage);
  assert.ok(body);
  assert.ok(Array.isArray(body.messages));
  assert.equal(body.has_more, true);
  assert.ok(body.next_index);
});

test("真实消息解析出时间戳和角色", () => {
  const body = Core.getSingleChainBody(pullPage);
  const parsed = body.messages.map((raw) => Core.parseApiMessage(raw));
  assert.equal(parsed.length, 3);
  for (const message of parsed) {
    assert.ok(message.createTime > 0, "create_time 应该被解析");
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(Core.formatTimestamp(message.createTime)));
    assert.ok(message.index > 0, "index_in_conv 应该被解析");
    assert.ok(["user", "assistant"].includes(message.role));
  }
  assert.equal(parsed.filter((m) => m.role === "user").length, 1);
  assert.ok(parsed.some((m) => m.text.length > 20), "正文应被提取出来");
});

test("思维链只来自 thinking_content，不与正文混在一起", () => {
  const thinkRaw = messageSamples["50399"];
  const message = Core.parseApiMessage(thinkRaw);
  assert.ok(message.thinking.length > 0, "thinking_content 应被抓出");
  assert.ok(!message.text.includes(message.thinking.slice(0, 30)), "正文不应包含思维链内容");
  assert.equal(message.role, "assistant");
});

test("thinking_content 是 thinks JSON 时只取 text，不带搜索卡片", () => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(here, "fixtures", "thinking-message.json"), "utf8")
  );
  const message = Core.parseApiMessage(raw);
  assert.ok(message.thinking.includes("出差清单"));
  assert.ok(!message.thinking.includes("text_tags"), "不应把 text_tags 的 JSON 当正文");
  assert.ok(!/^\{/.test(message.thinking), "思考内容不应以 JSON 开头");
  assert.ok(message.text.includes("你看这样安排行不行"));
});

test("只有搜索卡片、没有思考正文时不应输出 JSON", () => {
  const raw = {
    message_id: "t1",
    user_type: 2,
    index_in_conv: "9",
    create_time: "1700000000",
    content: JSON.stringify({ text: "答案" }),
    thinking_content: JSON.stringify({
      thinks: [{ text: "", position: 0, is_finish: true, text_tags: [{ type: 102, tag_info: "{}" }] }]
    })
  };
  const message = Core.parseApiMessage(raw);
  assert.equal(message.thinking, "");
  assert.equal(message.text, "答案");
});

test("空正文但有思考的消息不会被丢弃", () => {
  const raw = messageSamples["49543"];
  const message = Core.parseApiMessage(raw);
  assert.equal(message.text, "");
  assert.ok(message.thinking.length > 0);
});

test("UI 块（tips / applet / quick_reply）不进正文", () => {
  const raw = messageSamples["51401"];
  const message = Core.parseApiMessage(raw);
  assert.ok(message.text.length > 0);
  assert.ok(!message.text.includes("本回答由AI生成"), "免责提示不应混进正文");
  assert.ok(message.auxTypes.length > 0 || message.text.length > 0);
});

test("图片附件块被识别成 images", () => {
  const raw = {
    message_id: "x1",
    user_type: 2,
    index_in_conv: "7",
    create_time: "1700000000",
    content: JSON.stringify({ text: "看图" }),
    content_block: [
      {
        block_type: 10052,
        content: {
          attachment_block: {
            attachments: [
              { image: { image_ori: { url: "https://p11-flow-imagex-sign.byteimg.com/a.png" } } }
            ]
          }
        }
      },
      { block_type: 10000, content: { text_block: { text: "看图" } } }
    ]
  };
  const message = Core.parseApiMessage(raw);
  assert.deepEqual(message.images, ["https://p11-flow-imagex-sign.byteimg.com/a.png"]);
});

test("用户图片消息（content_type 20）的图片能被抓出来", () => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(here, "fixtures", "image-message.json"), "utf8")
  );
  const message = Core.parseApiMessage(raw);
  assert.ok(message.images.length > 0, "entities 里的图片 URL 应该被识别");
  assert.match(message.images[0], /^https:\/\//);
});

test("pickNextAnchor 始终严格递减且优先用 next_index", () => {
  const anchor = Core.pickNextAnchor({
    body: { next_index: "51280" },
    pageIndexes: [51408, 51407, 51403],
    currentAnchor: 9007199254740991
  });
  assert.equal(anchor, 51280);

  const fallback = Core.pickNextAnchor({
    body: {},
    pageIndexes: [120, 80, 40],
    currentAnchor: 200
  });
  assert.equal(fallback, 39);

  const decrement = Core.pickNextAnchor({ body: {}, pageIndexes: [], currentAnchor: 5 });
  assert.equal(decrement, 4);

  assert.equal(Core.pickNextAnchor({ body: {}, pageIndexes: [], currentAnchor: 1 }), 0);
});

test("parseCutoff 支持日期、日期时间与时间戳", () => {
  const dateOnly = Core.parseCutoff("2026-11-01");
  const expected = new Date(2026, 10, 1, 0, 0, 0).getTime();
  assert.equal(dateOnly, expected);

  const withTime = Core.parseCutoff("2026-11-01 08:30");
  assert.equal(withTime, new Date(2026, 10, 1, 8, 30, 0).getTime());
  assert.equal(Core.parseCutoff(""), 0);
  assert.ok(Core.parseCutoff("1794385068") > 1e12);
});

test("resolveCutoff 的三种模式", () => {
  assert.equal(Core.resolveCutoff({ resumeMode: "off" }, null).cutoffMs, 0);
  assert.equal(Core.resolveCutoff({ resumeMode: "last" }, null).missingCursor, true);
  const fromLast = Core.resolveCutoff({ resumeMode: "last" }, { lastCreateTime: 1794385068, lastIndex: 51408 });
  assert.equal(fromLast.cutoffMs, 1794385068000);
  assert.equal(fromLast.lastIndex, 51408);
  assert.equal(Core.resolveCutoff({ resumeMode: "date" }, null).invalidDate, true);
});

test("增量过滤与停止判断", () => {
  const cutoffMs = new Date(2026, 10, 11, 0, 0, 0).getTime();
  const old = { createTime: Math.floor(cutoffMs / 1000) - 3600, index: 100 };
  const edge = { createTime: Math.floor(cutoffMs / 1000), index: 101 };
  const fresh = { createTime: Math.floor(cutoffMs / 1000) + 60, index: 102 };

  assert.deepEqual(Core.filterMessagesIncremental([old, edge, fresh], cutoffMs, 0), [edge, fresh]);
  assert.equal(Core.isPageBeforeCutoff([old], cutoffMs), true);
  assert.equal(Core.isPageBeforeCutoff([old, fresh], cutoffMs), false);
  assert.equal(Core.isPageBeforeCutoff([old], 0), false, "未开启增量时不应提前停止");
});

test("buildIntegrity 统计完整性与时间范围", () => {
  const messages = [
    { index: 1, createTime: 100, text: "a", thinking: "", images: [] },
    { index: 2, createTime: 200, text: "", thinking: "思考", images: [] },
    { index: 4, createTime: 0, text: "c", thinking: "", images: [] }
  ];
  const integrity = Core.buildIntegrity({
    messages,
    rawCount: 5,
    pageCount: 2,
    stopReason: "has-more-false",
    truncated: false,
    duplicates: 2
  });
  assert.equal(integrity.messages, 3);
  assert.equal(integrity.indexMin, 1);
  assert.equal(integrity.indexMax, 4);
  assert.equal(integrity.thinkingMessages, 1);
  assert.equal(integrity.messagesWithoutTime, 1);
  assert.equal(integrity.duplicatesDropped, 2);
  assert.equal(Core.formatTimestamp(integrity.firstMessageTime).length, 19);
});

test("Markdown 输出带时间戳与深度思考分区", () => {
  const messages = [
    { role: "user", index: 1, createTime: 1794385066, text: "问题", thinking: "", images: [] },
    {
      role: "assistant",
      index: 2,
      createTime: 1794385068,
      text: "回答",
      thinking: "先想一下\n再回答",
      images: []
    }
  ];
  const payload = Core.buildPayload(
    messages,
    {
      stopReason: "has-more-false",
      integrity: {
        messages: 2,
        rawCount: 2,
        stopReason: "has-more-false",
        indexMin: 1,
        indexMax: 2,
        truncated: false
      }
    },
    { url: "https://www.doubao.com/chat/1", title: "主对话", chatId: "1" }
  );
  const markdown = Core.toMarkdown(payload, { incremental: true, incrementalLabel: "2026-11-01" });

  assert.match(markdown, /^### 用户 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/m);
  assert.match(markdown, /^### 豆包 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/m);
  assert.match(markdown, /^\*\*深度思考\*\*$/m);
  assert.match(markdown, /^> 先想一下$/m);
  assert.match(markdown, /- 导出模式：增量/);
  assert.match(markdown, /- 消息条数：2/);
});
