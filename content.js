(() => {
  const SCRIPT_VERSION = "0.6.0";
  const DISPLAY_VERSION = "0.5.0";
  const FLOATING_BUTTON_TEXT = `导出当前会话内容 v${DISPLAY_VERSION}`;
  const Core = globalThis.DoubaoExportCore;
  if (!Core) {
    console.error("[Doubao Export] content-core.js 未加载，导出功能不可用。");
    return;
  }
  if (window.__doubaoExportInstalled === SCRIPT_VERSION) return;
  window.__doubaoExportInstalled = SCRIPT_VERSION;
  const exportControllers = new Map();
  const observedSingleChains = [];
  injectPageHook();
  listenForObservedSingleChains();
  installFloatingExportButton();
  watchFloatingButtonRoute();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "DOUBAO_CANCEL_EXPORT") {
      const controller = exportControllers.get(message.exportId);
      if (controller) {
        controller.cancelled = true;
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "当前没有正在运行的导出任务。" });
      }
      return false;
    }

    if (message?.type === "DOUBAO_INSTALL_FLOATING_BUTTON") {
      installFloatingExportButton();
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type !== "DOUBAO_EXPORT_CHAT_V2") return false;

    exportChat(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

    return true;
  });

  async function exportChat(options) {
    const controller = { cancelled: false };
    if (options.exportId) exportControllers.set(options.exportId, controller);
    const progress = createProgressReporter(options.exportId);

    try {
      progress({ stage: "start", message: "开始读取当前对话", count: 0 });

      const limits = normalizeLimits(options);
      const chatInfo = getDoubaoChatInfo();
      const cursor = await readExportCursor(chatInfo.id);
      const cutoff = Core.resolveCutoff(options, cursor);

      if (cutoff.missingCursor) {
        throw new Error("还没有可用的导出记录，无法“从上次位置续传”。请先做一次完整导出，或改用“从指定日期开始”。");
      }
      if (cutoff.invalidDate) {
        throw new Error("增量起始时间无效，请填写 YYYY-MM-DD 或 YYYY-MM-DD HH:mm。");
      }

      const result = await collectMessages(options, progress, controller, limits, {
        cutoff,
        keepRaw: options.format === "json" && options.includeRaw !== false
      });
      const messages = Array.isArray(result) ? result : result.messages;
      const exportMeta = Array.isArray(result) ? {} : result.meta;

      checkCancelled(controller);
      if (!messages.length) {
        throw new Error(
          cutoff.mode === "off"
            ? "没有识别到聊天内容，确认当前页面是豆包对话页并等待加载完成。"
            : `自 ${formatCutoffLabel(cutoff)} 之后没有新消息，无需导出。`
        );
      }

      const payload = Core.buildPayload(messages, exportMeta, {
        url: location.href,
        title: document.title,
        chatId: chatInfo.id || location.pathname.split("/").filter(Boolean).pop() || ""
      });
      const format = options.format === "json" ? "json" : "markdown";
      const incremental = cutoff.mode !== "off";
      const content =
        format === "json"
          ? JSON.stringify(payload, null, 2)
          : Core.toMarkdown(payload, {
              incremental,
              incrementalLabel: incremental ? formatCutoffLabel(cutoff) : ""
            });
      const mime = format === "json" ? "application/json" : "text/markdown";
      const ext = format === "json" ? "json" : "md";
      const suffix = incremental ? `-incremental-from-${cutoffLabelForFile(cutoff)}` : "";
      const filename = `doubao-chat-${payload.chatId || "export"}${suffix}-${timestampForFile()}.${ext}`;

      downloadText(filename, content, mime);
      await saveExportCursor(chatInfo.id, messages);

      const integrity = exportMeta.integrity || {};
      const warn = integrity.truncated ? "（翻页未到最旧一条，见文件头说明）" : "";
      progress({
        stage: "done",
        message: `已生成 ${messages.length} 条消息${warn}`,
        count: messages.length
      });
      return { count: messages.length, filename, integrity };
    } finally {
      if (options.exportId) exportControllers.delete(options.exportId);
    }
  }

  function formatCutoffLabel(cutoff) {
    if (!cutoff?.cutoffMs) return cutoff?.mode === "last" ? "上次导出位置" : "开始";
    const text = Core.formatTimestamp(Math.floor(cutoff.cutoffMs / 1000));
    return cutoff.mode === "last" ? `上次导出位置（${text}）` : text;
  }

  function cutoffLabelForFile(cutoff) {
    if (!cutoff?.cutoffMs) return "start";
    return Core.formatDateOnly(Math.floor(cutoff.cutoffMs / 1000)).replace(/-/g, "");
  }

  function cursorStorageKey(conversationId) {
    return `doubaoExportCursor:${conversationId || "unknown"}`;
  }

  async function readExportCursor(conversationId) {
    try {
      if (!chrome.storage?.local) return null;
      const key = cursorStorageKey(conversationId);
      const store = await chrome.storage.local.get(key);
      return store?.[key] || null;
    } catch (_error) {
      return null;
    }
  }

  async function saveExportCursor(conversationId, messages) {
    try {
      if (!chrome.storage?.local || !conversationId) return;
      const timed = messages.filter((message) => message.createTime > 0);
      const lastTime = timed.length ? Math.max(...timed.map((message) => message.createTime)) : 0;
      const lastIndex = messages.reduce((max, message) => Math.max(max, Core.toInteger(message.index)), 0);
      const newest = timed.find((message) => message.createTime === lastTime);
      await chrome.storage.local.set({
        [cursorStorageKey(conversationId)]: {
          conversationId,
          lastCreateTime: lastTime,
          lastIndex: lastIndex || Core.toInteger(newest?.index),
          lastMessageId: newest?.messageId || "",
          messageCount: messages.length,
          exportedAt: new Date().toISOString()
        }
      });
    } catch (_error) {}
  }

  function installFloatingExportButton() {
    if (!shouldShowFloatingExportButton()) {
      removeFloatingExportButton();
      return;
    }
    if (document.getElementById("doubao-export-floating-button")) return;

    const button = document.createElement("button");
    button.id = "doubao-export-floating-button";
    button.type = "button";
    button.textContent = FLOATING_BUTTON_TEXT;
    button.title = `导出当前豆包会话为 Markdown，插件版本 v${DISPLAY_VERSION}`;
    button.style.cssText = [
      "position:fixed",
      "top:72px",
      "right:20px",
      "left:auto",
      "z-index:2147483647",
      "height:36px",
      "padding:0 14px",
      "border:0",
      "border-radius:999px",
      "background:#e11d48",
      "color:#fff",
      "box-shadow:0 8px 24px rgba(225,29,72,.28)",
      "font:600 14px/36px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "letter-spacing:0",
      "cursor:pointer",
      "user-select:none",
      "touch-action:none"
    ].join(";");
    applyFloatingButtonPosition(button);
    makeFloatingButtonDraggable(button);

    button.addEventListener("mouseenter", () => {
      if (!button.disabled) button.style.background = "#be123c";
    });
    button.addEventListener("mouseleave", () => {
      if (!button.disabled) button.style.background = "#e11d48";
    });
    button.addEventListener("click", async () => {
      if (button.dataset.dragged === "1") return;
      if (button.disabled) return;
      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = "导出中...";
      button.style.cursor = "wait";
      button.style.background = "#9f1239";

      try {
        const result = await exportChat({
          format: "markdown",
          exportMode: "api-only",
          autoScroll: false,
          maxSeekSteps: 240,
          maxCollectScreens: 300,
          maxApiPages: 5000,
          apiPageSize: 50,
          apiStartAnchor: undefined,
          resumeMode: "off"
        });
        button.textContent = `已导出 ${result.count} 条`;
        button.style.background = "#16a34a";
        await wait(1600);
      } catch (error) {
        button.textContent = "导出失败";
        button.style.background = "#dc2626";
        console.warn("[Doubao Export]", error);
        await wait(1800);
      } finally {
        button.disabled = false;
        button.textContent = originalText;
        button.style.cursor = "pointer";
        button.style.background = "#e11d48";
      }
    });

    const append = () => {
      if (document.body && !document.getElementById(button.id)) {
        document.body.appendChild(button);
      }
    };

    append();
    document.addEventListener("DOMContentLoaded", append, { once: true });
    setTimeout(append, 600);
    setTimeout(append, 1800);
  }

  function injectPageHook() {
    if (!/(^|\.)doubao\.com$/.test(location.hostname)) return;
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-hook.js");
    script.async = false;
    script.onload = () => script.remove();
    (document.documentElement || document.head).appendChild(script);
  }

  function listenForObservedSingleChains() {
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== location.origin) return;
      if (event.data?.type !== "DOUBAO_EXPORT_CHAIN_OBSERVED") return;
      const detail = event.data.detail;
      if (!detail?.conversationId) return;
      observedSingleChains.unshift(detail);
      observedSingleChains.splice(20);
      console.debug("[Doubao Export] observed chain", detail);
    });
  }

  function shouldShowFloatingExportButton() {
    if (!/(^|\.)doubao\.com$/.test(location.hostname)) return false;
    return Boolean(getDoubaoChatIdFromPath(location.pathname));
  }

  function removeFloatingExportButton() {
    document.getElementById("doubao-export-floating-button")?.remove();
  }

  function watchFloatingButtonRoute() {
    if (window.__doubaoExportRouteWatcherInstalled) return;
    window.__doubaoExportRouteWatcherInstalled = true;
    let lastUrl = location.href;

    setInterval(() => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      installFloatingExportButton();
    }, 800);

    window.addEventListener("resize", () => {
      const button = document.getElementById("doubao-export-floating-button");
      if (!button) return;
      const rect = button.getBoundingClientRect();
      moveFloatingButton(button, rect.left, rect.top);
      saveFloatingButtonPosition(button);
    });
  }

  function makeFloatingButtonDraggable(button) {
    let drag = null;

    button.addEventListener("pointerdown", (event) => {
      if (button.disabled || event.button !== 0) return;
      const rect = button.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        moved: false
      };
      button.setPointerCapture?.(event.pointerId);
    });

    button.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance < 4 && !drag.moved) return;
      drag.moved = true;
      event.preventDefault();
      moveFloatingButton(button, event.clientX - drag.offsetX, event.clientY - drag.offsetY);
    });

    button.addEventListener("pointerup", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      button.releasePointerCapture?.(event.pointerId);
      if (drag.moved) {
        button.dataset.dragged = "1";
        saveFloatingButtonPosition(button);
        setTimeout(() => {
          delete button.dataset.dragged;
        }, 0);
      }
      drag = null;
    });

    button.addEventListener("pointercancel", () => {
      drag = null;
    });
  }

  function applyFloatingButtonPosition(button) {
    const saved = readFloatingButtonPosition();
    if (saved) {
      moveFloatingButton(button, saved.left, saved.top);
    }
  }

  function moveFloatingButton(button, left, top) {
    const margin = 8;
    const rect = button.getBoundingClientRect();
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    const nextLeft = Math.min(maxLeft, Math.max(margin, left));
    const nextTop = Math.min(maxTop, Math.max(margin, top));

    button.style.left = `${Math.round(nextLeft)}px`;
    button.style.top = `${Math.round(nextTop)}px`;
    button.style.right = "auto";
  }

  function saveFloatingButtonPosition(button) {
    const rect = button.getBoundingClientRect();
    try {
      localStorage.setItem(
        "doubao-export-floating-position",
        JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) })
      );
    } catch (_error) {}
  }

  function readFloatingButtonPosition() {
    try {
      const value = JSON.parse(localStorage.getItem("doubao-export-floating-position") || "null");
      if (!value || !Number.isFinite(value.left) || !Number.isFinite(value.top)) return null;
      return value;
    } catch (_error) {
      return null;
    }
  }

  async function collectMessages(options, progress, controller, limits, context = {}) {
    const mode = options.exportMode || "api-first";

    if (mode === "api-only") {
      return collectByApi(progress, controller, limits, context);
    }

    if (mode === "api-first") {
      try {
        const apiMessages = await collectByApi(progress, controller, limits, context);
        if (apiMessages.messages.length) return apiMessages;
        throw new Error("接口没有返回可导出的消息。");
      } catch (error) {
        checkCancelled(controller);
        if (Array.isArray(error.partialMessages) && error.partialMessages.length) {
          progress({
            stage: "api",
            message: `接口中途停止，已保留 ${error.partialMessages.length} 条接口数据`,
            count: error.partialMessages.length
          });
          return {
            messages: error.partialMessages,
            meta: { sourceMode: "api", stopReason: error.message || "接口中途停止" }
          };
        }
        progress({
          stage: "fallback",
          message: `接口失败：${error.message || error}`,
          count: 0
        });
        if (!options.autoScroll) throw error;
        return {
          messages: options.autoScroll ? await collectByScrolling(progress, controller, limits) : collectVisibleMessages(),
          meta: { sourceMode: options.autoScroll ? "scroll-fallback" : "visible", stopReason: "api-empty" }
        };
      }
    }

    if (mode === "scroll-only") {
      return {
        messages: await collectByScrolling(progress, controller, limits),
        meta: { sourceMode: "scroll-only" }
      };
    }

    return {
      messages: options.autoScroll ? await collectByScrolling(progress, controller, limits) : collectVisibleMessages(),
      meta: { sourceMode: options.autoScroll ? "scroll" : "visible" }
    };
  }

  async function collectByApi(progress, controller, limits, context = {}) {
    const chatInfo = getDoubaoChatInfo();
    const initialPage = await resolveInitialApiPage(chatInfo, limits, progress, controller);
    const conversationId = initialPage.conversationId;
    if (!conversationId) throw new Error("没有识别到可用 conversation_id。");

    const cutoff = context.cutoff || { cutoffMs: 0, lastIndex: 0, mode: "off" };
    const messages = [];
    const seen = new Set();
    const seenAnchors = new Set();
    let anchorIndex = initialPage.anchorIndex;
    let direction = initialPage.direction;
    let hasMore = true;
    let prefetchedPageData = initialPage.firstPageData || null;
    let pageCount = 0;
    let rawCount = 0;
    let duplicates = 0;
    let noProgressPages = 0;
    let stopReason = "unknown";
    let lastAnchor = anchorIndex;

    while (pageCount < limits.maxApiPages) {
      checkCancelled(controller);
      const currentAnchor = anchorIndex;
      seenAnchors.add(currentAnchor);
      pageCount += 1;

      progress({
        stage: "api",
        message: `接口拉取第 ${pageCount} 页（Anchor ${currentAnchor}），已取 ${messages.length} 条`,
        count: messages.length
      });

      let data;
      if (prefetchedPageData) {
        data = prefetchedPageData;
        prefetchedPageData = null;
      } else {
        try {
          data = await requestSingleChainWithRetry(
            {
              conversationId,
              anchorIndex: currentAnchor,
              direction,
              limit: limits.apiPageSize,
              url: initialPage.url
            },
            controller,
            progress
          );
        } catch (error) {
          throw attachPartialMessages(error, buildApiResult(messages));
        }
      }

      const body = Core.getSingleChainBody(data);
      if (!body) {
        const error = new Error(`接口返回结构异常：${Core.describeApiResponse(data)}`);
        if (!messages.length) throw attachPartialMessages(error, []);
        stopReason = "unexpected-response-body";
        progress({
          stage: "api",
          message: `接口后续页结构异常，已保留 ${messages.length} 条`,
          count: messages.length
        });
        break;
      }

      const pageRaw = Array.isArray(body.messages) ? body.messages : [];
      hasMore = Boolean(body.has_more);

      if (!pageRaw.length) {
        if (hasMore && noProgressPages < 2) {
          const nextAnchor = Core.pickNextAnchor({ body, pageIndexes: [], currentAnchor });
          if (nextAnchor > 0 && nextAnchor < currentAnchor) {
            noProgressPages += 1;
            anchorIndex = nextAnchor;
            lastAnchor = nextAnchor;
            continue;
          }
        }
        stopReason = "empty-page";
        break;
      }

      rawCount += pageRaw.length;
      const pageMessages = pageRaw.map((raw) =>
        Core.parseApiMessage(raw, { keepRaw: Boolean(context.keepRaw) })
      );
      const pageIndexes = pageRaw.map(Core.getMessageIndex);

      let added = 0;
      for (const parsed of pageMessages) {
        const key = parsed.messageId || `${parsed.index}:${parsed.role}:${parsed.text}`;
        if (seen.has(key)) {
          duplicates += 1;
          continue;
        }
        seen.add(key);
        messages.push(parsed);
        added += 1;
      }

      if (Core.isPageBeforeCutoff(pageMessages, cutoff.cutoffMs)) {
        stopReason = "cutoff-reached";
        break;
      }
      if (!hasMore) {
        stopReason = "has-more-false";
        break;
      }
      if (!added) {
        noProgressPages += 1;
        if (noProgressPages >= 3) {
          stopReason = "no-new-messages";
          break;
        }
      } else {
        noProgressPages = 0;
      }

      const nextAnchor = Core.pickNextAnchor({ body, pageIndexes, currentAnchor });
      if (!nextAnchor || nextAnchor >= currentAnchor) {
        stopReason = "anchor-not-advancing";
        progress({
          stage: "api",
          message: `接口仍有更多内容，但无法继续向前翻页（Anchor ${currentAnchor}），已取 ${messages.length} 条`,
          count: messages.length
        });
        break;
      }

      anchorIndex = nextAnchor;
      lastAnchor = nextAnchor;
      direction = 1;
    }

    if (pageCount >= limits.maxApiPages) {
      stopReason = "max-api-pages";
    }

    const ordered = buildApiResult(messages);
    const selected =
      cutoff.cutoffMs || cutoff.lastIndex
        ? Core.filterMessagesIncremental(ordered, cutoff.cutoffMs, cutoff.lastIndex)
        : ordered;

    const integrity = Core.buildIntegrity({
      messages: selected,
      rawCount,
      pageCount,
      stopReason,
      truncated: stopReason === "max-api-pages" || stopReason === "anchor-not-advancing",
      duplicates
    });

    progress({
      stage: "api",
      message: `接口拉取完成，共 ${selected.length} 条（原始 ${rawCount} 条）`,
      count: selected.length
    });

    return {
      messages: selected,
      meta: {
        sourceMode: "api",
        stopReason,
        truncated: integrity.truncated,
        chatPathType: chatInfo.type,
        urlChatId: chatInfo.id,
        conversationId,
        initialAnchor: initialPage.anchorIndex,
        initialDirection: initialPage.direction,
        apiStartAnchorSource: initialPage.source,
        rawCount,
        duplicatesDropped: duplicates,
        pageCount,
        lastAnchor,
        maxApiPages: limits.maxApiPages,
        apiPageSize: limits.apiPageSize,
        resumeMode: cutoff.mode,
        cutoffMs: cutoff.cutoffMs || 0,
        integrity
      }
    };
  }

  async function requestSingleChainWithRetry(payload, controller, progress) {
    const maxAttempts = 3;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      checkCancelled(controller);
      try {
        return await requestSingleChain(payload);
      } catch (error) {
        lastError = error;
        const message = String(error?.message || error);
        if (/HTTP 40[13]/.test(message)) throw error;
        if (attempt < maxAttempts) {
          progress({
            stage: "api",
            message: `第 ${attempt} 次请求失败（${message}），正在重试`,
            count: 0
          });
          await wait(400 * attempt * attempt);
        }
      }
    }
    throw lastError;
  }

  function buildApiResult(messages) {
    return messages
      .sort((a, b) => {
        const ai = Number(a.index || 0);
        const bi = Number(b.index || 0);
        if (ai && bi) return ai - bi;
        if (ai) return -1;
        if (bi) return 1;
        return (a.createTime || 0) - (b.createTime || 0);
      })
      .map((message) => ({ ...message }));
  }

  // 兼容旧调用点：解析与分页判断全部走 content-core.js
  function parseApiMessage(raw, options) {
    return Core.parseApiMessage(raw, options);
  }

  async function requestSingleChain({ conversationId, anchorIndex, direction, limit, url: observedUrl }) {
    const url = buildSingleChainUrl(observedUrl);
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "application/json, text/plain, */*",
        "agw-js-conv": "str",
        "content-type": "application/json; encoding=utf-8"
      },
      body: JSON.stringify({
        cmd: 3100,
        uplink_body: {
          pull_singe_chain_uplink_body: {
            conversation_id: conversationId,
            anchor_index: anchorIndex,
            conversation_type: 3,
            direction,
            limit,
            ext: {},
            filter: { index_list: [] },
            evaluate_ab_params: "",
            evaluate_common_params: ""
          }
        },
        sequence_id: randomId(),
        channel: 2,
        version: "1"
      })
    });

    if (!response.ok) {
      throw new Error(`接口 HTTP ${response.status}`);
    }

    return response.json();
  }

  function buildSingleChainUrl(observedUrl) {
    const url = observedUrl ? new URL(observedUrl, location.origin) : new URL("/im/chain/single", location.origin);
    const current = new URL(location.href);
    const defaults = {
      version_code: "20800",
      language: navigator.language?.startsWith("zh") ? "zh" : "zh",
      device_platform: "web",
      aid: "497858",
      real_aid: "497858",
      pkg_type: "release_version",
      region: "SG",
      sys_region: "SG",
      samantha_web: "1",
      web_platform: "browser",
      "use-olympus-account": "1",
      web_tab_id: randomId()
    };

    Object.entries(defaults).forEach(([key, value]) => {
      if (!url.searchParams.has(key)) {
        url.searchParams.set(key, current.searchParams.get(key) || value);
      }
    });

    return url.toString();
  }
  async function collectByScrolling(progress, controller, limits) {
    const scroller = findScroller();
    if (!scroller) return collectVisibleMessages();

    const startTop = scroller.scrollTop;
    try {
      progress({ stage: "seek-top", message: "正在向上加载历史消息", count: 0 });
      await scrollToTop(scroller, progress, controller, limits);
      checkCancelled(controller);

      const ordered = [];
      mergeMessageWindow(ordered, collectVisibleMessages());

      let idleScreens = 0;
      let lastTop = scroller.scrollTop;
      let lastHeight = scroller.scrollHeight;
      let screen = 0;

      for (let i = 0; i < limits.maxCollectScreens; i += 1) {
        checkCancelled(controller);
        screen += 1;
        const beforeCount = ordered.length;
        mergeMessageWindow(ordered, collectVisibleMessages());

        progress({
          stage: "collect",
          message: `正在收集第 ${screen} 屏`,
          count: ordered.length,
          top: Math.round(scroller.scrollTop),
          total: Math.round(scroller.scrollHeight)
        });

        const beforeTop = scroller.scrollTop;
        scroller.scrollTop = beforeTop + Math.max(360, scroller.clientHeight * 0.75);
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await waitForScrollSettle(scroller, controller);

        const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
        const noMovement = Math.abs(scroller.scrollTop - lastTop) < 3;
        const noHeightChange = Math.abs(scroller.scrollHeight - lastHeight) < 3;
        const noNewMessages = ordered.length === beforeCount;

        idleScreens = noMovement && noHeightChange && noNewMessages ? idleScreens + 1 : 0;
        lastTop = scroller.scrollTop;
        lastHeight = scroller.scrollHeight;

        if (atBottom || idleScreens >= 5) {
          mergeMessageWindow(ordered, collectVisibleMessages());
          progress({ stage: "collect", message: "已到达对话底部", count: ordered.length });
          break;
        }
      }

      return ordered.length ? ordered : collectVisibleMessages();
    } finally {
      scroller.scrollTop = startTop;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
  }

  async function scrollToTop(scroller, progress, controller, limits) {
    let idleSteps = 0;
    let lastTop = scroller.scrollTop;
    let lastHeight = scroller.scrollHeight;

    for (let i = 0; i < limits.maxSeekSteps; i += 1) {
      checkCancelled(controller);
      const beforeTop = scroller.scrollTop;
      scroller.scrollTop = Math.max(0, beforeTop - Math.max(420, scroller.clientHeight * 0.9));
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await waitForScrollSettle(scroller, controller);

      const noMovement = Math.abs(scroller.scrollTop - lastTop) < 3;
      const noHeightChange = Math.abs(scroller.scrollHeight - lastHeight) < 3;
      const atTop = scroller.scrollTop <= 2;

      progress({
        stage: "seek-top",
        message: `正在加载更早消息 ${i + 1}`,
        count: collectVisibleMessages().length,
        top: Math.round(scroller.scrollTop),
        total: Math.round(scroller.scrollHeight)
      });

      if ((atTop || noMovement) && noHeightChange) {
        idleSteps += 1;
      } else {
        idleSteps = 0;
      }

      lastTop = scroller.scrollTop;
      lastHeight = scroller.scrollHeight;
      if (idleSteps >= 5) break;
    }
  }

  function mergeMessageWindow(target, incoming) {
    if (!incoming.length) return;
    if (!target.length) {
      target.push(...incoming);
      return;
    }

    const targetKeys = target.map(messageKey);
    const incomingKeys = incoming.map(messageKey);
    const maxOverlap = Math.min(targetKeys.length, incomingKeys.length);

    for (let size = maxOverlap; size > 0; size -= 1) {
      const targetTail = targetKeys.slice(targetKeys.length - size).join("\n---\n");
      const incomingHead = incomingKeys.slice(0, size).join("\n---\n");
      if (targetTail === incomingHead) {
        target.push(...incoming.slice(size));
        return;
      }
    }

    target.push(...incoming);
  }

  function messageKey(message) {
    return `${message.role}\n${normalizeText(message.text)}`;
  }

  function collectVisibleMessages() {
    const rows = findRows();
    const messages = [];

    rows.forEach((row, index) => {
      const message = extractMessage(row, index);
      if (message) messages.push(message);
    });

    return messages;
  }

  function findRows() {
    const selectors = [
      ".v_list_row",
      "[class*='v_list_row']",
      ".list_items > div",
      "[class*='list_items'] > div"
    ];

    for (const selector of selectors) {
      const rows = Array.from(document.querySelectorAll(selector)).filter((row) => {
        const text = normalizeText(row.innerText || row.textContent || "");
        return text && !row.querySelector("textarea,input,[contenteditable='true']");
      });
      if (rows.length) return rows;
    }

    return [];
  }

  function extractMessage(row, index) {
    const isUser = hasUserLayout(row);
    const assistantNode = findAssistantNode(row);
    const userNode = isUser ? findUserNode(row) : null;
    const role = isUser ? "user" : "assistant";
    const contentNode = userNode || assistantNode || row;
    const text = cleanMessageText(contentNode);

    if (!text || isChromeText(text)) return null;
    return { role, text, index };
  }

  function hasUserLayout(row) {
    return Array.from(row.querySelectorAll("div")).some((node) => {
      const className = ` ${String(node.className || "")} `;
      const text = normalizeText(node.innerText || node.textContent || "");
      return text && className.includes(" justify-end ");
    });
  }

  function findAssistantNode(row) {
    return row.querySelector(
      ".flow-markdown-body,[class*='flow-markdown-body'],.md-box-root,[class*='md-box-root']"
    );
  }

  function findUserNode(row) {
    const candidates = Array.from(
      row.querySelectorAll("[class*='bg-g-send-msg-bubble'],[class*='text-g-send-msg-bubble'],[class*='send-msg-bubble']")
    );

    candidates.sort((a, b) => {
      const aText = normalizeText(a.innerText || a.textContent || "");
      const bText = normalizeText(b.innerText || b.textContent || "");
      return aText.length - bText.length;
    });

    return candidates.find((node) => normalizeText(node.innerText || node.textContent || ""));
  }

  function cleanMessageText(node) {
    return normalizeText(node.innerText || node.textContent || "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function isChromeText(text) {
    const blocked = new Set(["搜索…", "新对话", "聊聊新话题", "发送"]);
    return blocked.has(text);
  }

  function findScroller() {
    const candidates = Array.from(
      document.querySelectorAll(".v_list_scroller,[class*='v_list_scroller'],.scroller,[class*='scroller']")
    );

    return candidates.find(isScrollable) || findLargestScrollable(document.body);
  }

  function isScrollable(element) {
    if (!element) return false;
    return element.scrollHeight > element.clientHeight + 40;
  }

  function findLargestScrollable(root) {
    return Array.from(root.querySelectorAll("*"))
      .filter(isScrollable)
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  }

  function downloadText(filename, content, mime) {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function timestampForFile() {
    const offsetMs = new Date().getTimezoneOffset() * 60 * 1000;
    return new Date(Date.now() - offsetMs).toISOString().slice(0, 19).replace(/[:T]/g, "-");
  }

  async function waitForScrollSettle(scroller, controller) {
    let stable = 0;
    let lastTop = scroller.scrollTop;
    let lastHeight = scroller.scrollHeight;

    for (let i = 0; i < 12; i += 1) {
      checkCancelled(controller);
      await wait(120);
      checkCancelled(controller);
      const top = scroller.scrollTop;
      const height = scroller.scrollHeight;
      if (Math.abs(top - lastTop) < 2 && Math.abs(height - lastHeight) < 2) {
        stable += 1;
      } else {
        stable = 0;
      }
      lastTop = top;
      lastHeight = height;
      if (stable >= 2) break;
    }
  }

  function createProgressReporter(exportId) {
    return (detail) => {
      if (!exportId) return;
      chrome.runtime
        .sendMessage({ type: "DOUBAO_EXPORT_PROGRESS", exportId, ...detail })
        .catch(() => {});
    };
  }

  function normalizeLimits(options) {
    return {
      maxSeekSteps: clampInteger(options.maxSeekSteps, 240),
      maxCollectScreens: clampInteger(options.maxCollectScreens, 300),
      maxApiPages: clampInteger(options.maxApiPages, 5000, 1, 20000),
      apiPageSize: clampInteger(options.apiPageSize, 50, 1, 50),
      apiStartAnchor: optionalInteger(options.apiStartAnchor, 0, Number.MAX_SAFE_INTEGER)
    };
  }

  function clampInteger(value, fallback, min = 10, max = 1000) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(number)));
  }

  function optionalInteger(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    if (!Number.isFinite(number)) return undefined;
    return Math.max(min, Math.min(max, Math.floor(number)));
  }

  function checkCancelled(controller) {
    if (controller?.cancelled) {
      throw new Error("已停止导出。");
    }
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getConversationId() {
    return getDoubaoChatInfo().id;
  }

  function getDoubaoChatIdFromPath(pathname) {
    return getDoubaoChatInfoFromPath(pathname).id;
  }

  function getDoubaoChatInfo() {
    return getDoubaoChatInfoFromPath(location.pathname);
  }

  function getDoubaoChatInfoFromPath(pathname) {
    const path = String(pathname || "");
    const botMatch = path.match(/^\/chat\/bot\/chat\/(\d+)\/?$/);
    if (botMatch) return { id: botMatch[1], type: "bot-chat" };

    const chatMatch = path.match(/^\/chat\/(\d+)\/?$/);
    if (chatMatch) return { id: chatMatch[1], type: "chat" };

    return { id: "", type: "" };
  }

  function getInitialApiPage(limits, chatInfo) {
    if (limits.apiStartAnchor !== undefined) {
      return {
        conversationId: chatInfo.id,
        anchorIndex: limits.apiStartAnchor,
        direction: limits.apiStartAnchor > 0 ? 1 : 3,
        source: "manual"
      };
    }

    if (chatInfo.type === "chat") {
      return {
        conversationId: chatInfo.id,
        anchorIndex: Number.MAX_SAFE_INTEGER,
        direction: 1,
        source: "chat-default"
      };
    }

    return {
      conversationId: chatInfo.id,
      anchorIndex: 0,
      direction: 3,
      source: "bot-chat-default"
    };
  }

  async function resolveInitialApiPage(chatInfo, limits, progress, controller) {
    if (!observedSingleChains.length) {
      progress({ stage: "api", message: "等待页面接口参数", count: 0 });
      await waitForObservedSingleChain(controller, 1500);
    }

    const candidates = buildInitialApiCandidates(chatInfo, limits);
    const errors = [];

    for (const candidate of candidates) {
      checkCancelled(controller);
      if (!candidate.conversationId) continue;
      progress({
        stage: "api",
        message: `探测接口 ${candidate.source}`,
        count: 0
      });

      try {
        const data = await requestSingleChain({
          conversationId: candidate.conversationId,
          anchorIndex: candidate.anchorIndex,
          direction: candidate.direction,
          limit: Math.min(limits.apiPageSize, 50),
          url: candidate.url
        });
        const body = Core.getSingleChainBody(data);
        const pageMessages = Array.isArray(body?.messages) ? body.messages : [];
        if (pageMessages.length) {
          return {
            ...candidate,
            firstPageData: data
          };
        }
        errors.push(`${candidate.source}: ${body ? "empty" : Core.describeApiResponse(data)}`);
      } catch (error) {
        errors.push(`${candidate.source}: ${error.message || error}`);
      }
    }

    throw new Error(`接口探测失败：${errors.join("；") || "没有候选参数"}`);
  }

  async function waitForObservedSingleChain(controller, timeoutMs) {
    const startedAt = Date.now();
    while (!observedSingleChains.length && Date.now() - startedAt < timeoutMs) {
      checkCancelled(controller);
      await wait(100);
    }
  }

  function buildInitialApiCandidates(chatInfo, limits) {
    const ids = getConversationIdCandidates(chatInfo);
    const anchors = getAnchorCandidates(chatInfo);
    const candidates = [];
    const add = (conversationId, anchorIndex, direction, source, url = "") => {
      const key = `${conversationId}:${anchorIndex}:${direction}:${url}`;
      if (!conversationId || candidates.some((item) => item.key === key)) return;
      candidates.push({ key, conversationId, anchorIndex, direction, source, url });
    };

    getObservedChainCandidates().forEach((chain, index) => {
      add(
        chain.conversationId,
        Number.isFinite(chain.anchorIndex) ? chain.anchorIndex : Number.MAX_SAFE_INTEGER,
        Number.isFinite(chain.direction) ? chain.direction : 1,
        index ? "observed-chain-candidate" : "observed-chain",
        chain.url
      );
    });

    if (limits.apiStartAnchor !== undefined) {
      ids.forEach((id, index) => {
        add(id, limits.apiStartAnchor, limits.apiStartAnchor > 0 ? 1 : 3, index ? "manual-page-candidate" : "manual");
      });
      return candidates;
    }

    if (chatInfo.type === "chat") {
      ids.forEach((id, index) => {
        add(id, Number.MAX_SAFE_INTEGER, 1, index ? "chat-page-candidate" : "chat-default");
      });
      ids.forEach((id, index) => {
        add(id, 0, 3, index ? "chat-zero-candidate" : "chat-zero");
      });
      return candidates;
    }

    anchors.forEach((anchor, anchorIndex) => {
      ids.forEach((id, index) => {
        add(id, anchor, 1, index || anchorIndex ? "bot-anchor-candidate" : "bot-anchor");
      });
    });
    ids.forEach((id, index) => {
      add(id, Number.MAX_SAFE_INTEGER, 1, index ? "bot-max-candidate" : "bot-max");
    });
    ids.forEach((id, index) => {
      add(id, 0, 3, index ? "bot-page-candidate" : "bot-chat-default");
    });
    return candidates;
  }

  function getConversationIdCandidates(chatInfo) {
    const ids = new Set();
    if (chatInfo.id) ids.add(chatInfo.id);

    collectConversationIdsFromText(document.documentElement?.innerHTML || "").forEach((id) => ids.add(id));
    collectConversationIdsFromText(document.body?.innerText || "").forEach((id) => ids.add(id));
    collectConversationIdsFromStorage(localStorage).forEach((id) => ids.add(id));
    collectConversationIdsFromStorage(sessionStorage).forEach((id) => ids.add(id));

    return Array.from(ids).slice(0, 12);
  }

  function getObservedChainCandidates() {
    return observedSingleChains
      .filter((chain) => chain?.conversationId)
      .filter((chain) => !chain.response || chain.response.messageCount > 0)
      .slice(0, 8);
  }

  function getAnchorCandidates(chatInfo) {
    const anchors = new Set();
    collectAnchorsFromText(document.documentElement?.innerHTML || "").forEach((anchor) => anchors.add(anchor));
    collectAnchorsFromText(document.body?.innerText || "").forEach((anchor) => anchors.add(anchor));
    collectAnchorsFromStorage(localStorage).forEach((anchor) => anchors.add(anchor));
    collectAnchorsFromStorage(sessionStorage).forEach((anchor) => anchors.add(anchor));

    if (!anchors.size && chatInfo.type === "bot-chat") anchors.add(Number.MAX_SAFE_INTEGER);
    return Array.from(anchors)
      .filter((anchor) => Number.isFinite(anchor) && anchor > 0)
      .sort((a, b) => a - b)
      .slice(0, 12);
  }

  function collectConversationIdsFromStorage(storage) {
    const ids = new Set();
    if (!storage) return [];

    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index) || "";
        const value = storage.getItem(key) || "";
        collectConversationIdsFromText(`${key}\n${value}`).forEach((id) => ids.add(id));
        if (ids.size >= 12) break;
      }
    } catch (_error) {}

    return Array.from(ids);
  }

  function collectAnchorsFromStorage(storage) {
    const anchors = new Set();
    if (!storage) return [];

    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index) || "";
        const value = storage.getItem(key) || "";
        collectAnchorsFromText(`${key}\n${value}`).forEach((anchor) => anchors.add(anchor));
        if (anchors.size >= 12) break;
      }
    } catch (_error) {}

    return Array.from(anchors);
  }

  function collectConversationIdsFromText(text) {
    const ids = new Set();
    const source = String(text || "");
    const patterns = [
      /"conversation_id"\s*:\s*"(\d{8,})"/g,
      /\\"conversation_id\\"\s*:\s*\\"(\d{8,})\\"/g,
      /conversation_id["'=: ]+(\d{8,})/g,
      /"conversationId"\s*:\s*"(\d{8,})"/g,
      /\\"conversationId\\"\s*:\s*\\"(\d{8,})\\"/g,
      /conversationId["'=: ]+(\d{8,})/g
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(source))) {
        ids.add(match[1]);
        if (ids.size >= 12) return Array.from(ids);
      }
    }

    return Array.from(ids);
  }

  function collectAnchorsFromText(text) {
    const anchors = new Set();
    const source = String(text || "");
    const patterns = [
      /"anchor_index"\s*:\s*(\d+)/g,
      /\\"anchor_index\\"\s*:\s*(\d+)/g,
      /"index_in_conv"\s*:\s*"?(\\?\d+)"?/g,
      /\\"index_in_conv\\"\s*:\s*\\"(\d+)\\"/g,
      /"message_index"\s*:\s*"?(\\?\d+)"?/g,
      /\\"message_index\\"\s*:\s*\\"(\d+)\\"/g
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(source))) {
        const value = Number(String(match[1]).replace(/\\/g, ""));
        if (Number.isFinite(value) && value > 0 && value < Number.MAX_SAFE_INTEGER) {
          anchors.add(Math.floor(value));
        }
        if (anchors.size >= 12) return Array.from(anchors);
      }
    }

    return Array.from(anchors);
  }

  function randomId() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
})();
