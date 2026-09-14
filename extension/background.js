const SERVER_BASE = "http://127.0.0.1:8765";
const MAX_CACHE_ENTRIES = 200;

const translationCache = new Map();
const inFlightRequests = new Map();

function cacheKey(payload) {
  return JSON.stringify({
    text: payload.text,
    sourceLang: payload.sourceLang || "auto",
    targetLang: payload.targetLang || "zh-CN",
    translationStyle: payload.translationStyle || "natural",
    glossary: payload.glossary || "",
    meetingContext: payload.meetingContext || "",
    context: payload.context || [],
  });
}

function remember(key, value) {
  translationCache.set(key, value);
  if (translationCache.size > MAX_CACHE_ENTRIES) {
    const first = translationCache.keys().next().value;
    translationCache.delete(first);
  }
}

async function translate(payload) {
  const key = cacheKey(payload);
  if (translationCache.has(key)) {
    return { ok: true, translation: translationCache.get(key), cached: true };
  }
  if (inFlightRequests.has(key)) {
    return inFlightRequests.get(key);
  }

  const request = (async () => {
    try {
      const response = await fetch(`${SERVER_BASE}/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        throw new Error(data.error || `本地翻译服务返回 HTTP ${response.status}`);
      }
      const translation = String(data.translation || "").trim();
      if (!translation) {
        throw new Error("本地翻译服务没有返回译文。");
      }
      remember(key, translation);
      return { ok: true, translation };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: `${message}。请确认 server.py 已启动，并监听 127.0.0.1:8765。`,
      };
    } finally {
      inFlightRequests.delete(key);
    }
  })();

  inFlightRequests.set(key, request);
  return request;
}

async function health() {
  try {
    const response = await fetch(`${SERVER_BASE}/health`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok && data.ok !== false, ...data };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.type === "translate") {
    translate(message.payload || {}).then(sendResponse);
    return true;
  }

  if (message.type === "health") {
    health().then(sendResponse);
    return true;
  }

  if (message.type === "clearTranslationCache") {
    translationCache.clear();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
