const statusEl = document.getElementById("status");
const detailEl = document.getElementById("detail");
const progressBarEl = document.getElementById("progressBar");
const autoScrollEl = document.getElementById("autoScroll");
const exportModeEl = document.getElementById("exportMode");
const maxSeekStepsEl = document.getElementById("maxSeekSteps");
const maxCollectScreensEl = document.getElementById("maxCollectScreens");
const maxApiPagesEl = document.getElementById("maxApiPages");
const apiPageSizeEl = document.getElementById("apiPageSize");
const apiStartAnchorEl = document.getElementById("apiStartAnchor");
const resumeModeEl = document.getElementById("resumeMode");
const sinceDateRowEl = document.getElementById("sinceDateRow");
const sinceDateEl = document.getElementById("sinceDate");
const cursorInfoEl = document.getElementById("cursorInfo");
const exportButtons = [document.getElementById("exportMarkdown"), document.getElementById("exportJson")];
const stopButton = document.getElementById("stopExport");
let currentExportId = "";
let currentTabId = 0;

document.getElementById("exportMarkdown").addEventListener("click", () => exportChat("markdown"));
document.getElementById("exportJson").addEventListener("click", () => exportChat("json"));
stopButton.addEventListener("click", stopExport);
installFloatingButtonOnActiveTab();
initIncrementalControls();

resumeModeEl.addEventListener("change", syncResumeControls);
sinceDateEl.addEventListener("change", syncResumeControls);

function syncResumeControls() {
  const mode = resumeModeEl.value;
  sinceDateRowEl.hidden = mode !== "date";
  if (mode === "date" && !sinceDateEl.value) sinceDateEl.value = defaultSinceDate();
}

function defaultSinceDate() {
  const date = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T00:00`;
}

async function initIncrementalControls() {
  const mode = resumeModeEl.value;
  sinceDateRowEl.hidden = mode !== "date";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const chatId = getChatId(tab?.url || "");
    if (!chatId) {
      cursorInfoEl.textContent = "增量续传只支持豆包会话页。";
      return;
    }
    const key = `doubaoExportCursor:${chatId}`;
    const store = await chrome.storage.local.get(key);
    const cursor = store?.[key];
    if (!cursor?.lastCreateTime) {
      cursorInfoEl.textContent = "该会话还没有导出记录，先做一次完整导出才能在“上次位置”续传。";
      return;
    }
    const when = new Date(cursor.lastCreateTime * 1000);
    const pad = (value) => String(value).padStart(2, "0");
    const text =
      `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
      `${pad(when.getHours())}:${pad(when.getMinutes())}`;
    cursorInfoEl.textContent = `上次导出到 ${text}（${cursor.messageCount || 0} 条）`;
    if (!sinceDateEl.value) sinceDateEl.value = defaultSinceDate();
  } catch (_error) {
    cursorInfoEl.textContent = "";
  }
}

function getChatId(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/chat\/(?:bot\/chat\/)?(\d+)\/?$/);
    return match ? match[1] : "";
  } catch (_error) {
    return "";
  }
}

async function exportChat(format) {
  currentExportId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  currentTabId = 0;
  setBusy(true, "正在读取当前标签页...");
  setProgress(8);
  detailEl.textContent = "";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !getChatSite(tab.url || "")) {
      throw new Error("请先打开豆包或 DeepSeek 的对话详情页面。");
    }
    currentTabId = tab.id;

    const response = await sendExportMessage(tab, {
      type: "DOUBAO_EXPORT_CHAT_V2",
      exportId: currentExportId,
      format,
      autoScroll: autoScrollEl.checked,
      exportMode: exportModeEl.value,
      maxSeekSteps: readLimit(maxSeekStepsEl, 240),
      maxCollectScreens: readLimit(maxCollectScreensEl, 300),
      maxApiPages: readLimit(maxApiPagesEl, 5000, 1, 20000),
      apiPageSize: readLimit(apiPageSizeEl, 50, 1, 50),
      apiStartAnchor: readOptionalLimit(apiStartAnchorEl, 0, Number.MAX_SAFE_INTEGER),
      resumeMode: resumeModeEl.value,
      sinceDate: resumeModeEl.value === "date" ? sinceDateEl.value : undefined
    });

    if (!response?.ok) {
      throw new Error(response?.error || "没有拿到导出结果。");
    }

    const label = format === "markdown" ? "Markdown" : "JSON";
    setProgress(100);
    setBusy(false, `已导出 ${response.count} 条消息为 ${label}。`, "success");
    detailEl.textContent = response.filename || "";
  } catch (error) {
    setProgress(0);
    setBusy(false, error.message || String(error), "error");
  } finally {
    currentExportId = "";
    currentTabId = 0;
  }
}

async function stopExport() {
  if (!currentExportId || !currentTabId) return;

  stopButton.disabled = true;
  statusEl.textContent = "正在停止...";

  try {
    await sendExportMessage({ id: currentTabId }, {
      type: "DOUBAO_CANCEL_EXPORT",
      exportId: currentExportId
    });
  } catch (error) {
    setBusy(false, error.message || String(error), "error");
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "DOUBAO_EXPORT_PROGRESS" || message.exportId !== currentExportId) return;

  const count = Number(message.count || 0);
  if (message.stage === "seek-top") {
    setProgress(25);
  } else if (message.stage === "api") {
    setProgress(Math.min(92, 18 + count * 2));
  } else if (message.stage === "fallback") {
    setProgress(12);
  } else if (message.stage === "collect") {
    setProgress(Math.min(92, 35 + count * 2));
  } else if (message.stage === "done") {
    setProgress(100);
  }

  statusEl.textContent = message.message || "正在导出...";
  detailEl.textContent = count ? `已识别 ${count} 条消息` : "";
});

async function sendExportMessage(tab, payload) {
  // 停止导出时不重新注入脚本，直接发给已经在跑的那份。
  const site = tab.url ? getChatSite(tab.url) : null;
  if (site) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: site.scripts
    });
  }
  return chrome.tabs.sendMessage(tab.id, payload);
}

async function installFloatingButtonOnActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !getChatSite(tab.url || "")) return;
    await sendExportMessage(tab, { type: "DOUBAO_INSTALL_FLOATING_BUTTON" });
  } catch (_error) {
    // Ignore: the normal export button still injects the script before exporting.
  }
}

function getChatSite(value) {
  try {
    const url = new URL(value);
    if (/(^|\.)doubao\.com$/.test(url.hostname) && /^\/chat\/(?:bot\/chat\/)?\d+\/?$/.test(url.pathname)) {
      return { name: "doubao", scripts: ["content-core.js", "content.js"] };
    }
    if (url.hostname === "chat.deepseek.com" && /^\/(?:a\/)?chat\/s\/[0-9a-zA-Z-]{8,}\/?$/.test(url.pathname)) {
      return { name: "deepseek", scripts: ["deepseek-content.js"] };
    }
    return null;
  } catch (_error) {
    return null;
  }
}

function setBusy(isBusy, text, tone = "") {
  exportButtons.forEach((button) => {
    button.disabled = isBusy;
  });
  stopButton.disabled = !isBusy;
  statusEl.textContent = text;
  statusEl.className = tone;
}

function setProgress(percent) {
  progressBarEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function readLimit(input, fallback, min = 10, max = 1000) {
  const value = Number(input.value);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function readOptionalLimit(input, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!input.value.trim()) return undefined;
  const value = Number(input.value);
  if (!Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
