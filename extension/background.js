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


const localTranslatorPromises = new Map();
const localTranslationCache = new Map();

function normalizeLocalLanguage(lang) {
  const value = String(lang || "").trim();
  if (!value || value === "auto") return null;
  const map = {
    "zh-CN": "zh",
    "zh-TW": "zh-Hant",
    "zh-HK": "zh-Hant",
    "pt-BR": "pt",
    "pt-PT": "pt",
  };
  return map[value] || value.split("-")[0];
}

function localTranslatorApi() {
  return globalThis.Translator || null;
}

function localLanguageDetectorApi() {
  return globalThis.LanguageDetector || null;
}

async function detectLocalSourceLanguage(text) {
  const API = localLanguageDetectorApi();
  if (!API) return null;
  try {
    const detector = await API.create();
    const results = await detector.detect(text);
    const top = Array.isArray(results) ? results[0] : null;
    return top?.detectedLanguage || null;
  } catch {
    return null;
  }
}

async function getLocalTranslator(sourceLanguage, targetLanguage) {
  const API = localTranslatorApi();
  if (!API) throw new Error("LOCAL_UNAVAILABLE");
  const key = `${sourceLanguage}->${targetLanguage}`;
  if (localTranslatorPromises.has(key)) return localTranslatorPromises.get(key);

  const promise = (async () => {
    try {
      if (typeof API.availability === "function") {
        const availability = await API.availability({ sourceLanguage, targetLanguage });
        if (availability === "unavailable") throw new Error("LOCAL_UNAVAILABLE");
      }
      return await API.create({ sourceLanguage, targetLanguage });
    } catch (error) {
      localTranslatorPromises.delete(key);
      if (String(error?.message || error).includes("LOCAL_UNAVAILABLE")) throw error;
      throw new Error(`LOCAL_DOWNLOAD_FAILED: ${error?.message || error}`);
    }
  })();
  localTranslatorPromises.set(key, promise);
  return promise;
}

async function checkLocalStatus(payload) {
  const API = localTranslatorApi();
  if (!API) return { ok: true, available: false, reason: "no_api" };
  const source = payload?.sourceLang === "auto" ? "en" : normalizeLocalLanguage(payload?.sourceLang);
  const target = normalizeLocalLanguage(payload?.targetLang) || "zh";
  try {
    let availability = "available";
    if (typeof API.availability === "function") {
      availability = await API.availability({ sourceLanguage: source, targetLanguage: target });
    }
    return { ok: true, available: availability !== "unavailable", availability, source, target };
  } catch (error) {
    return { ok: true, available: false, reason: String(error?.message || error) };
  }
}

async function translateLocal(payload) {
  const text = String(payload?.text || "").trim();
  if (!text) return { ok: false, unavailable: true, error: "LOCAL_EMPTY_TEXT" };
  const sourceLanguage = payload?.sourceLang === "auto"
    ? await detectLocalSourceLanguage(text)
    : normalizeLocalLanguage(payload?.sourceLang);
  const targetLanguage = normalizeLocalLanguage(payload?.targetLang);
  if (!sourceLanguage || !targetLanguage) {
    return { ok: false, unavailable: true, error: "LOCAL_NO_LANGUAGE" };
  }

  const targets = targetLanguage === "zh" ? ["zh", "zh-Hans"] : [targetLanguage];
  let lastError = null;
  for (const target of targets) {
    const cacheKey = `${sourceLanguage}->${target}:${text}`;
    if (localTranslationCache.has(cacheKey)) {
      return { ok: true, translation: localTranslationCache.get(cacheKey), local: true };
    }
    try {
      const translator = await getLocalTranslator(sourceLanguage, target);
      const result = await translator.translate(text);
      const translation = String(result || "").trim();
      if (!translation) throw new Error("LOCAL_EMPTY_RESULT");
      localTranslationCache.set(cacheKey, translation);
      return { ok: true, translation, local: true };
    } catch (error) {
      lastError = error;
    }
  }
  return { ok: false, unavailable: true, error: lastError?.message || "LOCAL_UNAVAILABLE" };
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

  if (message.type === "localStatus") {
    checkLocalStatus(message.payload || {}).then(sendResponse);
    return true;
  }

  if (message.type === "translateLocal") {
    translateLocal(message.payload || {}).then(sendResponse);
    return true;
  }

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
