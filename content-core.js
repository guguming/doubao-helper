(() => {
  const CORE_VERSION = "0.6.0";
  if (globalThis.DoubaoExportCore?.version === CORE_VERSION) return;

  // 豆包 /im/chain/single 返回的 content_block.block_type 常量
  const BLOCK = {
    TEXT: 10000,
    CODE: 10008,
    THINKING: 10040,
    RESEARCH: 10053,
    ATTACHMENT: 10052,
    CREATION: 2074,
    TIPS: 10053,
    SEARCH_RESULT: 10025,
    APPLET: 10017,
    QUICK_REPLY: 10080,
    BUTTON: 10103,
    MEMORY_TAG: 10055
  };

  // 这些块是页面 UI / 提示 / 推荐位，不属于对话正文，只统计不导出
  const AUX_BLOCK_KEYS = new Set([
    "suggest_block",
    "search_text_block",
    "search_engine_block",
    "creation_block",
    "banner_block",
    "header_text_block",
    "search_query_block",
    "search_result_block",
    "link_reader_block",
    "video_read_block",
    "applet_block",
    "quick_reply_block",
    "button_block",
    "memory_tag_block",
    "search_query_result_block",
    "search_resource_block",
    "research_process_block",
    "tips_block",
    "thinking_block",
    "attachment_block",
    "code_block"
  ]);

  function normalizeText(value) {
    return String(value == null ? "" : value)
      .replace(/\r\n?/g, "\n")
      .replace(/\u0000/g, "")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function looksLikeJson(value) {
    const text = String(value || "").trim();
    return (text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"));
  }

  function parseMaybeJson(value) {
    if (!value) return value;
    if (typeof value === "object") return value;
    if (typeof value !== "string" || !looksLikeJson(value)) return null;
    try {
      return JSON.parse(value);
    } catch (_error) {
      return null;
    }
  }

  function toInteger(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.floor(number);
  }

  function toCreateTimeSeconds(raw) {
    const seconds = toInteger(raw?.create_time ?? raw?.create_at ?? raw?.createTime ?? raw?.update_time);
    if (seconds > 0) return seconds > 1e12 ? Math.floor(seconds / 1000) : seconds;
    return 0;
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  // 秒级时间戳 -> 本地时间 "YYYY-MM-DD HH:MM:SS"
  function formatTimestamp(seconds) {
    const value = toInteger(seconds);
    if (!value) return "";
    const date = new Date(value * 1000);
    if (Number.isNaN(date.getTime())) return "";
    return (
      `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
      `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
    );
  }

  function formatDateOnly(seconds) {
    const text = formatTimestamp(seconds);
    return text ? text.slice(0, 10) : "";
  }

  // ---------- 消息解析 ----------

  function getMessageBlocks(raw) {
    const direct = Array.isArray(raw?.content_block) ? raw.content_block.filter(Boolean) : [];
    if (direct.length) return direct;

    const parsed = parseMaybeJson(raw?.content);
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
    if (Array.isArray(parsed?.content_block)) return parsed.content_block.filter(Boolean);
    return [];
  }

  // content_block 的 content 里通常只有一个是非 null 的子块
  function getActiveBlockContent(block) {
    const content = block?.content;
    if (!content || typeof content !== "object") return null;
    for (const key of Object.keys(content)) {
      const value = content[key];
      if (value === null || value === undefined || value === "" || value === false) continue;
      return { key, value };
    }
    return null;
  }

  function collectImageUrls(value, out) {
    if (!value) return;
    if (typeof value === "string") {
      if (/^https?:\/\//i.test(value) && /\.(png|jpe?g|webp|gif|avif)(\?|$)|image[_-]?(ori|thumb)|byteimg|imagex/i.test(value)) {
        out.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collectImageUrls(item, out));
      return;
    }
    if (typeof value === "object") {
      Object.values(value).forEach((item) => collectImageUrls(item, out));
    }
  }

  function collectTextualStrings(value, out, depth = 0) {
    if (value == null || depth > 6) return;
    if (typeof value === "string") {
      const text = normalizeText(value);
      if (text && !/^https?:\/\//i.test(text) && !looksLikeJson(text)) out.push(text);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collectTextualStrings(item, out, depth + 1));
      return;
    }
    if (typeof value === "object") {
      ["text", "markdown", "content", "summary", "paragraph"].forEach((key) => {
        if (value[key] !== undefined) collectTextualStrings(value[key], out, depth + 1);
      });
    }
  }

  function parseResearchProcess(value) {
    const parts = [];
    const visit = (node, depth) => {
      if (node == null || depth > 5) return;
      if (Array.isArray(node)) {
        node.forEach((item) => visit(item, depth + 1));
        return;
      }
      if (typeof node === "string") {
        const text = normalizeText(node);
        if (text && !looksLikeJson(text)) parts.push(text);
        return;
      }
      if (typeof node === "object") {
        const title = node.title || node.name || node.stage;
        const body = node.text || node.content || node.summary || node.detail;
        if (typeof title === "string" && title.trim() && !looksLikeJson(title)) parts.push(`- ${normalizeText(title)}`);
        if (typeof body === "string" && body.trim() && !looksLikeJson(body)) parts.push(normalizeText(body));
        ["steps", "items", "children", "sub_steps", "process", "stages"].forEach((key) => {
          if (node[key]) visit(node[key], depth + 1);
        });
      }
    };
    visit(value, 0);
    return Array.from(new Set(parts)).join("\n\n");
  }

  // thinking_content 可能是纯文本，也可能是 {"thinks":[{"text": "...","text_tags":[...]}]} 这种结构，
  // 后者里的 text_tags 会塞进大量搜索卡片 JSON，必须只取 text。
  function normalizeThinkingValue(value) {
    const direct = normalizeText(value);
    if (!direct) return "";

    const parsed = parseMaybeJson(value);
    if (!parsed || typeof parsed !== "object") return direct;

    if (Array.isArray(parsed.thinks)) {
      // 只有搜索卡片、没有思考正文的情况：thinks[].text 为空，此时应视为"没有思维链"
      const texts = parsed.thinks
        .map((item) => normalizeText(item?.text ?? item?.content ?? item?.thinking ?? ""))
        .filter(Boolean);
      return texts.join("\n\n");
    }
    if (Array.isArray(parsed)) {
      const texts = parsed
        .map((item) => normalizeText(item?.text ?? item?.content ?? (typeof item === "string" ? item : "")))
        .filter(Boolean);
      if (texts.length) return texts.join("\n\n");
    }

    const text = parsed.text || parsed.content || parsed.thinking || parsed.reasoning;
    if (typeof text === "string" && normalizeText(text)) return normalizeText(text);

    return direct;
  }

  // 把一条消息的 content_block 拆成：正文 / 代码 / 思考 / 图片 / 备注
  function classifyBlocks(blocks) {
    const texts = [];
    const thinkings = [];
    const images = [];
    const notes = [];
    const auxTypes = [];

    const pushUnique = (list, text) => {
      const value = normalizeText(text);
      if (value && !list.includes(value)) list.push(value);
    };

    for (const block of blocks) {
      const active = getActiveBlockContent(block);
      if (!active) continue;
      const { key, value } = active;
      const type = toInteger(block?.block_type);

      if (key === "text_block" || key === "markdown_block" || key === "quote_block" || key === "paragraph") {
        const text = typeof value === "string" ? value : value?.text ?? value?.content ?? value?.markdown;
        pushUnique(texts, text);
        continue;
      }

      if (key === "code_block") {
        const code = value?.code ?? value?.text ?? "";
        if (normalizeText(code)) {
          const codeText = String(code).trim();
          pushUnique(texts, codeText.startsWith("```") ? codeText : "```\n" + codeText + "\n```");
        }
        continue;
      }

      if (key === "attachment_block") {
        collectImageUrls(value?.attachments ?? value, images);
        continue;
      }

      if (key === "creation_block" || type === BLOCK.CREATION) {
        collectImageUrls(value, images);
        continue;
      }

      if (key === "thinking_block") {
        // 10040 只是「正在生成图片 / 已完成」这类状态提示，不含正文
        auxTypes.push("thinking_block");
        continue;
      }

      if (key === "research_process_block") {
        const process = parseResearchProcess(value);
        if (process) thinkings.push(process);
        continue;
      }

      if (key === "tips_block") {
        const text = typeof value === "string" ? value : value?.text;
        if (text) pushUnique(notes, text);
        continue;
      }

      if (AUX_BLOCK_KEYS.has(key)) {
        auxTypes.push(key);
        continue;
      }

      // 未知块：能捞出文字就当正文，捞不到就记成辅助块
      const fallback = [];
      collectTextualStrings(value, fallback);
      if (fallback.length) {
        fallback.forEach((text) => pushUnique(texts, text));
      } else {
        auxTypes.push(key || String(type));
      }
    }

    return { texts, thinkings, images, notes, auxTypes };
  }

  function extractLegacyText(raw) {
    const candidates = [
      parseMaybeJson(raw?.content)?.text,
      parseMaybeJson(raw?.content_obj)?.text,
      parseMaybeJson(raw?.message_content)?.text,
      raw?.content,
      raw?.brief,
      raw?.content_obj?.text,
      raw?.message_content,
      raw?.tts_content,
      raw?.text
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && !looksLikeJson(candidate) && normalizeText(candidate)) {
        return normalizeText(candidate);
      }
    }
    return "";
  }

  // 用户发的图片消息（content_type 20）不在 content_block 里，而是 content.entities[].entity_content.image
  function extractContentImages(raw) {
    const parsed = parseMaybeJson(raw?.content);
    if (!parsed || Array.isArray(parsed)) return [];

    const images = [];
    if (Array.isArray(parsed.entities)) {
      for (const entity of parsed.entities) {
        const payload = entity?.entity_content ?? entity?.content ?? entity;
        if (payload?.image || payload?.images) {
          collectImageUrls(payload.image ?? payload.images, images);
        } else {
          collectImageUrls(payload, images);
        }
      }
    }
    collectImageUrls(parsed.images, images);
    collectImageUrls(parsed.image, images);
    return images;
  }

  function extractContentText(raw) {
    const parsed = parseMaybeJson(raw?.content);
    if (parsed && !Array.isArray(parsed) && typeof parsed.text === "string") {
      const text = normalizeText(parsed.text);
      if (text) return text;
    }
    return "";
  }

  function parseApiMessage(raw, options = {}) {
    const blocks = getMessageBlocks(raw);
    const classified = classifyBlocks(blocks);
    const legacyText = classified.texts.length ? "" : extractLegacyText(raw);
    const thinkingFromField = normalizeThinkingValue(raw?.thinking_content);

    const text = normalizeText(classified.texts.join("\n\n") || legacyText || extractContentText(raw));
    const thinking = normalizeText([thinkingFromField, classified.thinkings.join("\n\n")].filter(Boolean).join("\n\n"));
    const images = Array.from(new Set([...classified.images, ...extractContentImages(raw)]));

    return {
      role: String(raw?.user_type) === "1" ? "user" : "assistant",
      index: toInteger(raw?.index_in_conv ?? raw?.index ?? raw?.message_index),
      messageId: String(raw?.message_id || raw?.id || ""),
      createTime: toCreateTimeSeconds(raw),
      sectionName: String(raw?.section_name || ""),
      text,
      thinking,
      images,
      notes: classified.notes,
      auxTypes: Array.from(new Set(classified.auxTypes)),
      isEmpty: !text && !thinking && !images.length,
      ...(options.keepRaw ? { raw } : {})
    };
  }

  // ---------- 分页 ----------

  function getSingleChainBody(data) {
    return (
      data?.downlink_body?.pull_single_chain_downlink_body ||
      data?.downlink_body?.pull_singe_chain_downlink_body ||
      data?.pull_single_chain_downlink_body ||
      data?.pull_singe_chain_downlink_body ||
      data?.data?.downlink_body?.pull_single_chain_downlink_body ||
      data?.data?.downlink_body?.pull_singe_chain_downlink_body ||
      data?.data?.pull_single_chain_downlink_body ||
      data?.data?.pull_singe_chain_downlink_body ||
      null
    );
  }

  function describeApiResponse(data) {
    if (!data || typeof data !== "object") return typeof data;
    const parts = [`keys=${Object.keys(data).slice(0, 12).join(",") || "none"}`];
    ["code", "status", "status_code", "message", "msg", "err_no", "err_msg"].forEach((key) => {
      if (data[key] !== undefined) parts.push(`${key}=${String(data[key]).slice(0, 120)}`);
    });
    return parts.join(" ");
  }

  function getMessageIndex(raw) {
    const ext = parseMaybeJson(raw?.ext);
    const localInfo = parseMaybeJson(raw?.local_info);
    const messageInfo = parseMaybeJson(raw?.message_info);
    const values = [
      raw?.index_in_conv,
      raw?.index,
      raw?.message_index,
      raw?.msg_index,
      raw?.chain_index,
      raw?.conversation_index,
      raw?.item_index,
      raw?.seq_index,
      raw?.sequence_index,
      raw?.sort_index,
      raw?.extra?.index_in_conv,
      raw?.extra?.index,
      ext?.index_in_conv,
      ext?.index,
      localInfo?.index_in_conv,
      localInfo?.index,
      messageInfo?.index_in_conv,
      messageInfo?.index
    ];
    for (const value of values) {
      const number = toInteger(value);
      if (number >= 0 && value !== undefined && value !== null && value !== "") return number;
    }
    return 0;
  }

  function getMessageIdentity(raw) {
    return String(
      raw?.message_id ||
        raw?.id ||
        raw?.server_message_id ||
        `${getMessageIndex(raw)}:${raw?.user_type ?? raw?.role ?? ""}:${raw?.brief || raw?.content || ""}`
    );
  }

  /**
   * 下一页锚点。豆包接口按 index_in_conv 倒序翻页，必须保证严格递减。
   * 优先用接口返回的 next_index，其次用本页最小 index - 1，最后退到当前锚点 - 1。
   */
  function pickNextAnchor({ body, pageIndexes, currentAnchor }) {
    const positive = pageIndexes.map((value) => toInteger(value)).filter((value) => value > 0);
    const minIndex = positive.length ? Math.min(...positive) : 0;
    const candidates = [toInteger(body?.next_index), minIndex > 0 ? minIndex - 1 : 0, minIndex > 0 ? minIndex : 0];

    for (const candidate of candidates) {
      if (candidate > 0 && candidate < currentAnchor) return candidate;
    }

    if (currentAnchor > 1 && currentAnchor < Number.MAX_SAFE_INTEGER) {
      return currentAnchor - 1;
    }
    return 0;
  }

  // ---------- 完整性 ----------

  function buildIntegrity({ messages, rawCount, pageCount, stopReason, truncated, duplicates }) {
    const indexes = messages.map((message) => toInteger(message.index)).filter((value) => value > 0);
    const withTime = messages.filter((message) => message.createTime > 0);
    const times = withTime.map((message) => message.createTime);
    const missingText = messages.filter((message) => !message.text && !message.thinking && !message.images?.length).length;
    const thinkingCount = messages.filter((message) => message.thinking).length;
    const imageCount = messages.reduce((sum, message) => sum + (message.images?.length || 0), 0);

    return {
      messages: messages.length,
      rawCount,
      pageCount,
      stopReason,
      truncated: Boolean(truncated),
      duplicatesDropped: duplicates || 0,
      emptyMessages: missingText,
      thinkingMessages: thinkingCount,
      images: imageCount,
      indexMin: indexes.length ? Math.min(...indexes) : 0,
      indexMax: indexes.length ? Math.max(...indexes) : 0,
      indexSpan: indexes.length ? Math.max(...indexes) - Math.min(...indexes) + 1 : 0,
      firstMessageTime: times.length ? Math.min(...times) : 0,
      lastMessageTime: times.length ? Math.max(...times) : 0,
      messagesWithoutTime: messages.length - withTime.length
    };
  }

  // ---------- 增量（断点续传） ----------

  // 支持 "YYYY-MM-DD"、"YYYY-MM-DDTHH:mm"、"YYYY/MM/DD HH:mm"、毫秒/秒时间戳
  function parseCutoff(value, nowMs = Date.now()) {
    if (value === undefined || value === null || value === "") return 0;
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 1e12 ? value : value * 1000;
    }

    const text = String(value).trim();
    if (!text) return 0;
    if (/^\d{10,13}$/.test(text)) {
      const number = Number(text);
      return number > 1e12 ? number : number * 1000;
    }

    const match = text.match(
      /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[T\s](\d{1,2})[:时](\d{1,2})(?:[:分](\d{1,2}))?)?/
    );
    if (match) {
      const [, year, month, day, hour, minute, second] = match;
      const date = new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour || 0),
        Number(minute || 0),
        Number(second || 0)
      );
      if (!Number.isNaN(date.getTime())) return date.getTime();
    }

    const parsed = Date.parse(text);
    if (!Number.isNaN(parsed)) return parsed;
    return 0;
  }

  /**
   * 依据增量模式算出截断时间（毫秒）。
   * resumeMode: "off" | "last"（从上次导出之后） | "date"（从指定日期）
   */
  function resolveCutoff(options, cursor) {
    const mode = options?.resumeMode || "off";
    if (mode === "off") return { mode, cutoffMs: 0, lastIndex: 0 };

    if (mode === "last") {
      const lastTime = toInteger(cursor?.lastCreateTime);
      if (!lastTime) return { mode, cutoffMs: 0, lastIndex: 0, missingCursor: true };
      return { mode, cutoffMs: lastTime * 1000, lastIndex: toInteger(cursor?.lastIndex) };
    }

    if (mode === "date") {
      const cutoffMs = parseCutoff(options.sinceDate);
      if (!cutoffMs) return { mode, cutoffMs: 0, lastIndex: 0, invalidDate: true };
      return { mode, cutoffMs, lastIndex: 0 };
    }

    return { mode: "off", cutoffMs: 0, lastIndex: 0 };
  }

  function isMessageIncremental(message, cutoffMs, lastIndex) {
    const index = toInteger(message.index);

    // 有上次导出的 index 时以 index 为准：index 是会话内单调递增的，不会因同一秒内多条消息而重复。
    if (lastIndex) {
      if (index > 0) return index > lastIndex;
      if (!message.createTime) return true;
      return message.createTime * 1000 >= cutoffMs;
    }

    if (!cutoffMs) return true;
    if (!message.createTime) return true; // 没有时间戳的消息无法判定，保守保留
    return message.createTime * 1000 >= cutoffMs;
  }

  function filterMessagesIncremental(messages, cutoffMs, lastIndex) {
    return messages.filter((message) => isMessageIncremental(message, cutoffMs, lastIndex));
  }

  // 当前页是否已经全部早于截断时间（可以停止翻页）
  function isPageBeforeCutoff(messages, cutoffMs) {
    if (!cutoffMs || !messages.length) return false;
    const timed = messages.filter((message) => message.createTime > 0);
    if (!timed.length) return false;
    return timed.every((message) => message.createTime * 1000 < cutoffMs);
  }

  // ---------- 输出 ----------

  function buildPayload(messages, meta, context = {}) {
    const range = messages.reduce(
      (acc, message) => {
        if (!message.createTime) return acc;
        if (!acc.from || message.createTime < acc.from) acc.from = message.createTime;
        if (!acc.to || message.createTime > acc.to) acc.to = message.createTime;
        return acc;
      },
      { from: 0, to: 0 }
    );

    return {
      source: "doubao",
      url: context.url || "",
      title: context.title || "豆包对话",
      chatId: context.chatId || "",
      exportedAt: new Date().toISOString(),
      range: {
        from: range.from ? formatTimestamp(range.from) : "",
        to: range.to ? formatTimestamp(range.to) : ""
      },
      meta: meta || {},
      messages: messages.map((message, index) => ({
        index: index + 1,
        role: message.role,
        ...(message.index ? { conversationIndex: message.index } : {}),
        ...(message.createTime
          ? { createTime: message.createTime, createTimeText: formatTimestamp(message.createTime) }
          : {}),
        text: message.text || "",
        ...(message.thinking ? { thinking: message.thinking } : {}),
        ...(message.images?.length ? { images: message.images } : {}),
        ...(message.notes?.length ? { notes: message.notes } : {}),
        ...(message.auxTypes?.length ? { auxBlocks: message.auxTypes } : {}),
        ...(message.messageId ? { messageId: message.messageId } : {}),
        ...(message.raw ? { raw: message.raw } : {})
      }))
    };
  }

  function toBlockquote(text) {
    return String(text)
      .split("\n")
      .map((line) => (line ? `> ${line}` : ">"))
      .join("\n");
  }

  function toMarkdown(payload, options = {}) {
    const meta = payload.meta || {};
    const integrity = meta.integrity || {};
    const isIncremental = Boolean(options.incremental);
    const lines = ["# 豆包对话导出", ""];

    lines.push(`- 标题：${payload.title || "豆包对话"}`);
    lines.push(`- URL：${payload.url || ""}`);
    lines.push(`- 消息条数：${payload.messages.length}`);
    if (payload.range?.from || payload.range?.to) {
      lines.push(`- 消息时间范围：${payload.range.from || "未知"} ~ ${payload.range.to || "未知"}`);
    }
    lines.push(`- 导出时间：${payload.exportedAt}`);
    if (isIncremental) {
      lines.push(`- 导出模式：增量（${options.incrementalLabel || "自上次导出"}）`);
    }
    if (integrity.stopReason) {
      const truncated = integrity.truncated ? "，**本次未导完**" : "";
      lines.push(`- 翻页结束原因：${integrity.stopReason}${truncated}`);
    }
    if (integrity.indexMax) {
      lines.push(`- 会话 index：${integrity.indexMin} ~ ${integrity.indexMax}（原始消息 ${integrity.rawCount} 条，去重后 ${integrity.messages} 条）`);
    }
    if (integrity.messagesWithoutTime) {
      lines.push(`- 无时间戳消息：${integrity.messagesWithoutTime} 条`);
    }
    lines.push("", "## 对话", "");

    for (const message of payload.messages) {
      const who = message.role === "user" ? "用户" : "豆包";
      const stamp = message.createTimeText ? ` · ${message.createTimeText}` : "";
      lines.push(`### ${who}${stamp}`, "");

      if (message.text) {
        lines.push(message.text, "");
      } else if (!message.thinking && !message.images?.length) {
        lines.push("_（该条消息没有文本内容，可能是卡片或系统消息）_", "");
      }

      if (message.thinking) {
        lines.push("**深度思考**", "", toBlockquote(message.thinking), "");
      }

      for (const url of message.images || []) {
        lines.push(`![图片](${url})`, "");
      }

      lines.push("---", "");
    }

    return lines.join("\n");
  }

  globalThis.DoubaoExportCore = {
    version: CORE_VERSION,
    BLOCK,
    normalizeText,
    looksLikeJson,
    parseMaybeJson,
    toInteger,
    formatTimestamp,
    formatDateOnly,
    getMessageBlocks,
    classifyBlocks,
    parseApiMessage,
    getSingleChainBody,
    describeApiResponse,
    getMessageIndex,
    getMessageIdentity,
    pickNextAnchor,
    buildIntegrity,
    parseCutoff,
    resolveCutoff,
    isMessageIncremental,
    filterMessagesIncremental,
    isPageBeforeCutoff,
    buildPayload,
    toMarkdown
  };
})();
