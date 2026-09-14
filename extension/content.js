(() => {
  "use strict";

  const HOST_ID = "codex-zoom-interpreter-host";
  const IS_TOP = window.top === window;
  const MIN_REQUEST_INTERVAL_MS = 650;
  const AUTO_DETECT_MIN_SCORE = 45;
  const DEFAULTS = {
    enabled: true,
    sourceLang: "auto",
    targetLang: "zh-CN",
    translationEngine: "auto",
    serverProvider: "auto",
    translationStyle: "natural",
    showOriginal: true,
    speakTranslation: false,
    glossary: "",
    meetingContext: "",
    captionSelector: "",
    overlayMode: "overlap",
    compactMode: true,
    overlayWidth: 680,
    overlayOpacity: 0.72,
    fontSize: 22,
  };

  const LANGUAGE_OPTIONS = [
    ["auto", "自动检测"],
    ["zh-CN", "简体中文"],
    ["zh-TW", "繁體中文"],
    ["en", "English"],
    ["ja", "日本語"],
    ["ko", "한국어"],
    ["es", "Español"],
    ["fr", "Français"],
    ["de", "Deutsch"],
    ["pt", "Português"],
    ["it", "Italiano"],
    ["ru", "Русский"],
    ["ar", "العربية"],
  ];

  let settings = { ...DEFAULTS };
  let captionElement = null;
  let captionObserver = null;
  let captionPollTimer = null;
  let pageScanTimer = null;
  let translationTimer = null;
  let translationInFlight = false;
  let pendingText = "";
  let lastRawCaption = "";
  let lastTranslation = "";
  let lastRequestAt = 0;
  let lastSpoken = "";
  let recentPairs = [];
  let pickerCleanup = null;
  let overlayHost = null;
  let shadow = null;
  let overlayElements = null;
  let autoDetectionStartedAt = 0;
  let autoHistory = new Map();
  let remoteCaptionActive = false;
  let remoteDiagnostics = [];
  const localTranslatorPromises = new Map();
  const localTranslationCache = new Map();
  const hiddenCaptionElements = new Map();
  let currentCaptionRect = null;
  let currentCaptionSource = null;
  const captionCandidateSelectors = [
    '[aria-live="polite"]',
    '[aria-live="assertive"]',
    '[role="log"]',
    '[class*="live-transcription"]',
    '[class*="live_transcription"]',
    '[class*="live-caption"]',
    '[class*="live_caption"]',
    '[class*="livecaption"]',
    '[class*="closed-caption"]',
    '[class*="closed_caption"]',
    '[class*="caption-text"]',
    '[class*="captionText"]',
    '[class*="caption"]',
    '[class*="subtitle"]',
    '[class*="transcript"]',
    '[class*="transcription"]',
    '[data-testid*="caption"]',
    '[data-testid*="subtitle"]',
    '[data-testid*="transcript"]',
    '[data-test*="caption"]',
    '#live-transcription-subtitle',
    '#live-transcription-subtitle__content',
    '.live-transcription-subtitle',
    '.live-transcription-subtitle__content',
    '.live-transcription-subtitle__text',
    '.zm-live-transcription',
    '.zm-live-transcription-subtitle',
    '[id*="caption"]',
    '[id*="subtitle"]',
    '[id*="transcript"]',
  ];

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULTS, (stored) => {
        settings = { ...DEFAULTS, ...(stored || {}) };
        resolve(settings);
      });
    });
  }

  function saveSettings(patch) {
    settings = { ...settings, ...patch };
    chrome.storage.sync.set(patch);
    applySettingsToOverlay();
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/\u200b/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim();
  }

  function getRawText(element) {
    if (!element) return "";
    return normalizeText(element.innerText || element.textContent || "");
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 12) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0.05;
  }

  function isOverlapMode() {
    return settings.overlayMode === "overlap";
  }

  function rectToObject(rect, fontSize = 16) {
    return {
      left: Number(rect.left || 0),
      top: Number(rect.top || 0),
      width: Number(rect.width || 0),
      height: Number(rect.height || 0),
      fontSize: Number(fontSize || 16),
    };
  }

  function hideCaptionElement(element, hidden) {
    if (!element || element.nodeType !== 1) return;
    if (hidden) {
      if (!hiddenCaptionElements.has(element)) {
        hiddenCaptionElements.set(element, element.style.opacity || "");
      }
      element.style.setProperty("opacity", "0", "important");
      element.style.setProperty("pointer-events", "none", "important");
      return;
    }
    const originalOpacity = hiddenCaptionElements.get(element);
    if (originalOpacity !== undefined) {
      if (originalOpacity) element.style.opacity = originalOpacity;
      else element.style.removeProperty("opacity");
      element.style.removeProperty("pointer-events");
      hiddenCaptionElements.delete(element);
    } else {
      element.style.removeProperty("opacity");
      element.style.removeProperty("pointer-events");
    }
  }

  function findIframeBySource(source) {
    return Array.from(document.querySelectorAll("iframe")).find((frame) => frame.contentWindow === source) || null;
  }

  function computeRemoteRect(source, data) {
    const iframe = findIframeBySource(source);
    if (!iframe || !data?.rect) return null;
    const iframeRect = iframe.getBoundingClientRect();
    return {
      left: iframeRect.left + Number(data.rect.left || 0),
      top: iframeRect.top + Number(data.rect.top || 0),
      width: Number(data.rect.width || 0),
      height: Number(data.rect.height || 0),
      fontSize: Number(data.fontSize || 16),
    };
  }

  function applyOverlayRect(rect) {
    if (!overlayHost || !overlayElements) return;
    if (isOverlapMode() && (!rect || rect.width <= 0 || rect.height <= 0)) {
      overlayHost.style.opacity = "0";
      return;
    }
    if (!isOverlapMode()) {
      overlayHost.style.opacity = "1";
      overlayHost.style.left = "50%";
      overlayHost.style.top = "auto";
      overlayHost.style.bottom = "18px";
      overlayHost.style.width = "min(var(--overlay-width, 680px), 94vw)";
      overlayHost.style.height = "auto";
      overlayHost.style.transform = "translateX(-50%)";
      shadow.host.style.setProperty("--translation-size", `${Number(settings.fontSize) || 22}px`);
      return;
    }

    overlayHost.style.opacity = "1";
    const width = Math.max(120, rect.width);
    const height = Math.max(24, rect.height);
    const fontSize = Math.max(12, Math.min(Number(settings.fontSize) || 20, height / 2.2, width / 18));
    overlayHost.style.left = `${Math.max(0, rect.left)}px`;
    overlayHost.style.top = `${Math.max(0, rect.top)}px`;
    overlayHost.style.bottom = "auto";
    overlayHost.style.width = `${width}px`;
    overlayHost.style.height = `${height}px`;
    overlayHost.style.transform = "none";
    shadow.host.style.setProperty("--translation-size", `${Math.round(fontSize)}px`);
  }

  function applyOverlayMode() {
    if (!overlayElements || !overlayHost) return;
    const overlap = isOverlapMode();
    overlayElements.wrapper.classList.toggle("overlap", overlap);
    overlayHost.style.pointerEvents = overlap ? "none" : (settings.compactMode ? "none" : "auto");

    if (!settings.enabled) {
      hideCaptionElement(captionElement, false);
      if (currentCaptionSource) {
        currentCaptionSource.postMessage({ source: "zoom-codex-interpreter", type: "overlap-active", active: false }, "*");
      }
      return;
    }

    if (overlap) {
      applyOverlayRect(currentCaptionRect);
      if (IS_TOP && captionElement) hideCaptionElement(captionElement, true);
      if (currentCaptionSource) {
        currentCaptionSource.postMessage({ source: "zoom-codex-interpreter", type: "overlap-active", active: true }, "*");
      }
      return;
    }

    overlayHost.style.pointerEvents = settings.compactMode ? "none" : "auto";
    applyOverlayRect(null);
    hideCaptionElement(captionElement, false);
    if (currentCaptionSource) {
      currentCaptionSource.postMessage({ source: "zoom-codex-interpreter", type: "overlap-active", active: false }, "*");
    }
  }

  function reportCaptionFrame(rect) {
    if (!captionElement) return;
    const fontSize = Number.parseFloat(window.getComputedStyle(captionElement).fontSize) || 16;
    window.top.postMessage(
      {
        source: "zoom-codex-interpreter",
        type: "caption-rect",
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        fontSize,
      },
      "*",
    );
  }

  function queryAllDeep(selector, root = document) {
    const found = [];
    const visit = (node) => {
      if (!node || typeof node.querySelectorAll !== "function") return;
      try {
        node.querySelectorAll(selector).forEach((element) => found.push(element));
      } catch {
        return;
      }
      const all = node.querySelectorAll ? node.querySelectorAll("*") : [];
      for (const element of all) {
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    visit(root);
    return found;
  }

  function deepElementFromPoint(x, y) {
    let element = document.elementFromPoint(x, y);
    while (element?.shadowRoot) {
      const inner = element.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === element) break;
      element = inner;
    }
    return element;
  }

  function extractCaptionText(element) {
    let text = getRawText(element);
    if (!text) return "";

    // Zoom usually replaces the caption line, but some modes append transcript
    // text. Keep the newest sentence or the two newest lines to avoid resending
    // the entire meeting transcript.
    const dedupeAdjacent = (items) => items.filter((item, index, all) => item && item !== all[index - 1]);
    const lines = dedupeAdjacent(text.split(/\n+/).map((line) => line.trim()));
    if (lines.length > 2) {
      text = lines.slice(-2).join(" ");
    } else {
      const sentences = dedupeAdjacent(text.split(/(?<=[.!?。！？])\s+/));
      if (sentences.length > 2) text = sentences.slice(-2).join(" ");
    }
    if (text.length > 600) text = text.slice(-600);
    return text.trim();
  }

  function createOverlay() {
    if (overlayHost && document.documentElement.contains(overlayHost)) return;

    overlayHost = document.createElement("div");
    overlayHost.id = HOST_ID;
    overlayHost.style.cssText = [
      "all: initial",
      "display: block",
      "position: fixed",
      "left: 50%",
      "bottom: 18px",
      "transform: translateX(-50%)",
      "z-index: 2147483647",
      "width: min(var(--overlay-width, 680px), 94vw)",
      "pointer-events: auto",
    ].join(";");
    shadow = overlayHost.attachShadow({ mode: "open" });

    const css = `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .panel {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #f4f6f8;
        background: rgba(16, 18, 22, var(--overlay-opacity, .72));
        border: 1px solid rgba(255,255,255,.14);
        box-shadow: 0 14px 45px rgba(0,0,0,.32);
        border-radius: 14px;
        overflow: hidden;
        backdrop-filter: blur(12px);
      }
      .panel.compact {
        background: rgba(0, 0, 0, calc(var(--overlay-opacity, .72) * .45));
        border-color: transparent;
        box-shadow: none;
        border-radius: 10px;
        backdrop-filter: none;
        pointer-events: none;
      }
      .panel.compact .header,
      .panel.compact .controls { display: none; }
      .panel.compact .body { padding: 6px 10px; }
      .panel.compact .translation {
        text-align: center;
        color: #fff;
        font-size: min(var(--translation-size, 20px), 20px);
        text-shadow: 0 1px 3px rgba(0,0,0,.98), 0 0 8px rgba(0,0,0,.94);
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        overflow: hidden;
      }
      .panel.compact .original {
        text-align: center;
        color: rgba(255,255,255,.82);
        text-shadow: 0 1px 3px rgba(0,0,0,.98);
        max-height: 20px;
        font-size: 12px;
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 1;
        overflow: hidden;
      }
      .panel.overlap {
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, calc(var(--overlay-opacity, .72) * .35));
        border: 0;
        box-shadow: none;
        border-radius: 6px;
        backdrop-filter: none;
        pointer-events: none;
        display: flex;
        align-items: center;
      }
      .panel.overlap .header,
      .panel.overlap .controls { display: none; }
      .panel.overlap .body {
        width: 100%;
        max-height: 100%;
        padding: 2px 8px;
        overflow: hidden;
      }
      .panel.overlap .translation {
        text-align: center;
        color: #fff;
        font-size: min(var(--translation-size, 20px), 22px);
        line-height: 1.2;
        font-weight: 700;
        text-shadow: 0 1px 3px rgba(0,0,0,.98), 0 0 8px rgba(0,0,0,.94);
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        overflow: hidden;
      }
      .panel.overlap .original {
        text-align: center;
        color: rgba(255,255,255,.82);
        font-size: min(calc(var(--translation-size, 20px) * .72), 14px);
        line-height: 1.15;
        margin-top: 2px;
        max-height: 1.2em;
        text-shadow: 0 1px 3px rgba(0,0,0,.98);
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 1;
        overflow: hidden;
      }
      .header {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 10px; background: rgba(255,255,255,.055);
        border-bottom: 1px solid rgba(255,255,255,.09);
        font-size: 12px;
      }
      .title { font-weight: 700; letter-spacing: .2px; }
      .status { display: flex; align-items: center; gap: 5px; color: #aeb7c2; min-width: 0; }
      .dot { width: 7px; height: 7px; border-radius: 999px; background: #8a94a2; flex: 0 0 auto; }
      .dot.ok { background: #38d39f; box-shadow: 0 0 0 3px rgba(56,211,159,.13); }
      .dot.busy { background: #f3c969; }
      .dot.error { background: #ff6b6b; }
      .spacer { flex: 1; }
      button, select, input, textarea {
        font: inherit; color: inherit; background: rgba(255,255,255,.08);
        border: 1px solid rgba(255,255,255,.14); border-radius: 8px; padding: 5px 8px;
      }
      button { cursor: pointer; white-space: nowrap; }
      button:hover { background: rgba(255,255,255,.15); }
      button.active { background: rgba(56,211,159,.2); border-color: rgba(56,211,159,.45); }
      .body { padding: 12px 14px 8px; }
      .translation {
        font-size: var(--translation-size, 22px); line-height: 1.35; font-weight: 650;
        min-height: 30px; white-space: pre-wrap; word-break: break-word;
      }
      .original {
        margin-top: 7px; color: #aeb7c2; font-size: 13px; line-height: 1.35;
        white-space: pre-wrap; word-break: break-word; max-height: 58px; overflow: auto;
      }
      .controls {
        display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
        padding: 8px 10px 10px; color: #aeb7c2; font-size: 12px;
      }
      .controls label { display: flex; align-items: center; gap: 4px; }
      .glossary {
        flex: 1 1 240px; min-width: 180px; resize: vertical; min-height: 34px; max-height: 96px;
      }
      .small { color: #8e98a6; font-size: 11px; }
      .hidden { display: none !important; }
      @media (max-width: 640px) {
        .translation { font-size: min(var(--translation-size, 22px), 18px); }
        .header .title { display: none; }
      }
    `;

    if ("adoptedStyleSheets" in ShadowRoot.prototype && "replaceSync" in CSSStyleSheet.prototype) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet];
    } else {
      const style = document.createElement("style");
      style.textContent = css;
      shadow.appendChild(style);
    }

    const wrapper = document.createElement("div");
    wrapper.className = "panel";
    wrapper.innerHTML = `
      <div class="header">
        <span class="title">Codex 同传</span>
        <span class="status"><span class="dot"></span><span class="status-text">正在寻找 Zoom 字幕…</span></span>
        <span class="spacer"></span>
        <button id="pause" title="开始或暂停">暂停</button>
        <button id="pick" title="选择 Zoom 字幕区域">选字幕区</button>
        <button id="hide" title="隐藏悬浮窗">隐藏</button>
      </div>
      <div class="body">
        <div id="translation" class="translation">等待实时字幕…</div>
        <div id="original" class="original hidden"></div>
      </div>
      <div class="controls">
        <label>源语言
          <select id="source-lang"></select>
        </label>
        <label>目标语言
          <select id="target-lang"></select>
        </label>
        <label><input id="show-original" type="checkbox"> 显示原文</label>
        <button id="speak">朗读译文</button>
        <button id="clear">清空</button>
        <textarea id="glossary" class="glossary" placeholder="术语表/人名，一行一个，例如：roadmap = 路线图"></textarea>
      </div>
    `;
    shadow.appendChild(wrapper);

    overlayElements = {
      wrapper,
      statusDot: shadow.querySelector(".dot"),
      statusText: shadow.querySelector(".status-text"),
      translation: shadow.querySelector("#translation"),
      original: shadow.querySelector("#original"),
      pause: shadow.querySelector("#pause"),
      pick: shadow.querySelector("#pick"),
      hide: shadow.querySelector("#hide"),
      sourceLang: shadow.querySelector("#source-lang"),
      targetLang: shadow.querySelector("#target-lang"),
      showOriginal: shadow.querySelector("#show-original"),
      speak: shadow.querySelector("#speak"),
      clear: shadow.querySelector("#clear"),
      glossary: shadow.querySelector("#glossary"),
    };

    fillLanguageSelect(overlayElements.sourceLang, true);
    fillLanguageSelect(overlayElements.targetLang, false);

    overlayElements.pause.addEventListener("click", () => {
      saveSettings({ enabled: !settings.enabled });
      setStatus(settings.enabled ? "已开始" : "已暂停", settings.enabled ? "ok" : "");
    });
    overlayElements.pick.addEventListener("click", startPicker);
    overlayElements.hide.addEventListener("click", () => saveSettings({ enabled: false }));
    overlayElements.sourceLang.addEventListener("change", () => saveSettings({ sourceLang: overlayElements.sourceLang.value }));
    overlayElements.targetLang.addEventListener("change", () => saveSettings({ targetLang: overlayElements.targetLang.value }));
    overlayElements.showOriginal.addEventListener("change", () => saveSettings({ showOriginal: overlayElements.showOriginal.checked }));
    overlayElements.speak.addEventListener("click", () => {
      saveSettings({ speakTranslation: !settings.speakTranslation });
      if (!settings.speakTranslation) window.speechSynthesis?.cancel();
    });
    overlayElements.clear.addEventListener("click", () => {
      lastRawCaption = "";
      lastTranslation = "";
      pendingText = "";
      recentPairs = [];
      renderTranslation("");
      renderOriginal("");
      setStatus("已清空", "ok");
    });
    overlayElements.glossary.addEventListener("input", () => {
      window.clearTimeout(overlayElements.glossary._saveTimer);
      overlayElements.glossary._saveTimer = window.setTimeout(() => {
        saveSettings({ glossary: overlayElements.glossary.value.trim() });
      }, 450);
    });

    document.documentElement.appendChild(overlayHost);
    applySettingsToOverlay();
  }

  function fillLanguageSelect(select, includeAuto) {
    select.innerHTML = "";
    for (const [value, label] of LANGUAGE_OPTIONS) {
      if (!includeAuto && value === "auto") continue;
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
  }

  function applySettingsToOverlay() {
    if (!overlayElements || !overlayHost) return;
    overlayHost.style.display = settings.enabled ? "block" : "none";
    overlayElements.wrapper.classList.toggle("compact", Boolean(settings.compactMode));
    shadow.host.style.setProperty("--overlay-width", `${Number(settings.overlayWidth) || 680}px`);
    shadow.host.style.setProperty("--overlay-opacity", String(Number(settings.overlayOpacity) || 0.72));
    overlayElements.pause.textContent = settings.enabled ? "暂停" : "开始";
    overlayElements.pause.classList.toggle("active", settings.enabled);
    overlayElements.sourceLang.value = settings.sourceLang;
    overlayElements.targetLang.value = settings.targetLang;
    overlayElements.showOriginal.checked = Boolean(settings.showOriginal);
    overlayElements.speak.classList.toggle("active", Boolean(settings.speakTranslation));
    overlayElements.glossary.value = settings.glossary || "";
    overlayElements.original.classList.toggle("hidden", !settings.showOriginal);
    applyOverlayMode();
  }

  function setStatus(text, state = "") {
    if (!overlayElements) return;
    overlayElements.statusText.textContent = text;
    overlayElements.statusDot.className = `dot ${state || ""}`.trim();
  }

  function renderTranslation(text) {
    if (!overlayElements) return;
    overlayElements.translation.textContent = text || "等待实时字幕…";
  }

  function renderOriginal(text) {
    if (!overlayElements) return;
    overlayElements.original.textContent = text || "";
  }

  function baseCandidateScore(element) {
    if (!isVisible(element)) return -1000;
    const text = getRawText(element);
    if (!text || text.length < 2 || text.length > 2500) return -1000;
    const descriptor = `${element.id || ""} ${element.className || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("role") || ""}`.toLowerCase();
    let score = 0;
    if (/caption|subtitle|transcript|live[-_ ]?transcription/.test(descriptor)) score += 55;
    if (element.getAttribute("aria-live")) score += 45;
    if ((element.getAttribute("role") || "").toLowerCase() === "log") score += 25;
    if (/caption|subtitle|transcript/.test(text.toLowerCase()) && text.length < 200) score += 5;
    const rect = element.getBoundingClientRect();
    if (rect.width >= 220) score += 10;
    if (rect.height >= 18) score += 5;
    if (rect.bottom > window.innerHeight * 0.55) score += 15;
    if (element.children.length > 30) score -= 35;
    if (rect.height > window.innerHeight * 0.7) score -= 50;
    return score;
  }

  function autoDetectCaption() {
    const candidates = new Set();
    for (const selector of captionCandidateSelectors) {
      for (const element of queryAllDeep(selector)) {
        if (!overlayHost || !overlayHost.contains(element)) candidates.add(element);
      }
    }

    let best = null;
    let bestScore = -Infinity;
    const now = Date.now();
    for (const element of candidates) {
      const text = getRawText(element);
      const previous = autoHistory.get(element) || { text: "", changes: 0 };
      if (text && previous.text && text !== previous.text) previous.changes += 1;
      previous.text = text;
      autoHistory.set(element, previous);
      const score = baseCandidateScore(element) + Math.min(previous.changes, 5) * 25;
      if (score > bestScore) {
        bestScore = score;
        best = element;
      }
    }

    if (!best) return null;
    const observedLongEnough = now - autoDetectionStartedAt > 2200;
    const hasChangeEvidence = (autoHistory.get(best)?.changes || 0) >= 2;
    return observedLongEnough && (bestScore >= AUTO_DETECT_MIN_SCORE || hasChangeEvidence) ? best : null;
  }

  function findCaptionElement() {
    if (settings.captionSelector) {
      try {
        const selected = document.querySelector(settings.captionSelector);
        if (selected && isVisible(selected)) return selected;
      } catch {
        // Ignore stale selectors after Zoom UI changes.
      }
    }
    return autoDetectCaption();
  }

  function attachCaptionElement(element) {
    if (!element || element === captionElement) return;
    if (captionElement && captionElement !== element) hideCaptionElement(captionElement, false);
    captionObserver?.disconnect();
    if (captionPollTimer) window.clearInterval(captionPollTimer);
    captionElement = element;
    lastRawCaption = "";
    if (element === document.body || element === document.documentElement) {
      captionElement = null;
      if (IS_TOP) setStatus("字幕区域无效，请点击“选字幕区”", "error");
      return;
    }
    captionObserver = new MutationObserver(() => readCaption());
    captionObserver.observe(element, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "aria-live"],
    });
    captionPollTimer = window.setInterval(readCaption, 250);
    if (IS_TOP) {
      setStatus("已连接 Zoom 字幕", "ok");
    } else {
      window.top.postMessage({ source: "zoom-codex-interpreter", type: "caption-detected" }, "*");
    }
    readCaption();
  }

  function readCaption() {
    if (!settings.enabled || !captionElement || !captionElement.isConnected) return;
    const rect = captionElement.getBoundingClientRect();
    const fontSize = Number.parseFloat(window.getComputedStyle(captionElement).fontSize) || 16;
    if (IS_TOP) {
      currentCaptionRect = rectToObject(rect, fontSize);
      currentCaptionSource = null;
      if (isOverlapMode()) {
        applyOverlayRect(currentCaptionRect);
        hideCaptionElement(captionElement, true);
      }
    } else {
      reportCaptionFrame(rect);
    }

    const text = extractCaptionText(captionElement);
    if (!text || text === lastRawCaption) return;
    lastRawCaption = text;
    if (IS_TOP) {
      renderOriginal(text);
      scheduleTranslation(text);
    } else {
      window.top.postMessage(
        {
          source: "zoom-codex-interpreter",
          type: "caption",
          text,
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          fontSize,
        },
        "*",
      );
    }
  }

  function scheduleTranslation(text) {
    pendingText = text;
    if (!settings.enabled || translationInFlight) return;
    const isSentenceEnd = /[.!?。！？]["')\]]?$/.test(text);
    const minInterval = isSentenceEnd ? 250 : MIN_REQUEST_INTERVAL_MS;
    const wait = Math.max(0, minInterval - (Date.now() - lastRequestAt));
    window.clearTimeout(translationTimer);
    translationTimer = window.setTimeout(translatePending, wait);
  }

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
    return globalThis.Translator || window.Translator || self.Translator || null;
  }

  function localLanguageDetectorApi() {
    return globalThis.LanguageDetector || window.LanguageDetector || self.LanguageDetector || null;
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
        return await API.create({
          sourceLanguage,
          targetLanguage,
          monitor(monitor) {
            monitor.addEventListener("downloadprogress", (event) => {
              const loaded = Number(event?.loaded || 0);
              const total = Number(event?.total || 1);
              const percent = Math.max(0, Math.min(100, Math.round((total > 1 ? loaded / total : loaded) * 100)));
              if (IS_TOP) setStatus(`正在下载本地翻译模型… ${percent}%`, "busy");
            });
          },
        });
      } catch (error) {
        localTranslatorPromises.delete(key);
        if (String(error?.message || error).includes("LOCAL_UNAVAILABLE")) throw error;
        throw new Error(`LOCAL_DOWNLOAD_FAILED: ${error?.message || error}`);
      }
    })();
    localTranslatorPromises.set(key, promise);
    return promise;
  }

  function backgroundLocalTranslate(text) {
    const payload = {
      text,
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
    };
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "translateLocal", payload }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.ok) {
          resolve(response.translation);
        } else {
          reject(new Error(response?.error || "LOCAL_UNAVAILABLE"));
        }
      });
    });
  }

  async function localTranslate(text) {
    if (!localTranslatorApi()) {
      return backgroundLocalTranslate(text);
    }

    try {
      const sourceLanguage = settings.sourceLang === "auto"
        ? await detectLocalSourceLanguage(text)
        : normalizeLocalLanguage(settings.sourceLang);
      const targetLanguage = normalizeLocalLanguage(settings.targetLang);
      if (!sourceLanguage || !targetLanguage) throw new Error("LOCAL_NO_LANGUAGE");

      const targets = targetLanguage === "zh" ? ["zh", "zh-Hans"] : [targetLanguage];
      let lastError = null;
      for (const target of targets) {
        const cacheKey = `${sourceLanguage}->${target}:${text}`;
        if (localTranslationCache.has(cacheKey)) return localTranslationCache.get(cacheKey);
        try {
          const translator = await getLocalTranslator(sourceLanguage, target);
          const result = await translator.translate(text);
          const translation = String(result || "").trim();
          if (!translation) throw new Error("LOCAL_EMPTY_RESULT");
          localTranslationCache.set(cacheKey, translation);
          return translation;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error("LOCAL_UNAVAILABLE");
    } catch (error) {
      try {
        return await backgroundLocalTranslate(text);
      } catch {
        throw error;
      }
    }
  }

  function aiTranslate(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "translate", payload }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.ok) {
          resolve(response.translation);
        } else {
          reject(new Error(response?.error || "AI 翻译失败"));
        }
      });
    });
  }

  function translationPayload(text) {
    return {
      text,
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      translationStyle: settings.translationStyle,
      provider: settings.serverProvider,
      glossary: settings.glossary,
      meetingContext: settings.meetingContext,
      context: recentPairs.slice(-4),
    };
  }

  function withTimeout(promise, timeoutMs, code) {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error(code)), timeoutMs);
      promise.then(
        (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async function translateWithEngine(text) {
    const engine = settings.translationEngine || "auto";
    const payload = translationPayload(text);

    if (engine === "local") {
      return { translation: await withTimeout(localTranslate(text), 15000, "LOCAL_TIMEOUT"), engine: "local" };
    }
    if (engine === "ai") {
      return { translation: await aiTranslate(payload), engine: "ai" };
    }

    try {
      return { translation: await withTimeout(localTranslate(text), 1500, "LOCAL_TIMEOUT"), engine: "local" };
    } catch (localError) {
      if (IS_TOP) setStatus("本地翻译不可用，切换到 AI…", "busy");
      const translation = await aiTranslate(payload);
      return { translation, engine: "ai", fallbackReason: localError?.message || String(localError) };
    }
  }

  function friendlyTranslationError(error) {
    const message = String(error?.message || error || "未知错误");
    if (message.includes("LOCAL_UNAVAILABLE")) return "当前浏览器不支持本地翻译，请使用 AI 模式";
    if (message.includes("LOCAL_NO_LANGUAGE")) return "本地模式无法自动检测语言，请设置源语言";
    if (message.includes("LOCAL_DOWNLOAD_FAILED")) return `本地翻译模型下载失败：${message.split(":").slice(1).join(":").trim()}`;
    if (message.includes("LOCAL_EMPTY_RESULT")) return "本地翻译没有返回结果";
    if (message.includes("LOCAL_TIMEOUT")) return "本地翻译准备超时";
    return message;
  }

  async function translatePending() {
    if (!settings.enabled || !pendingText || translationInFlight) return;
    const text = pendingText;
    pendingText = "";
    translationInFlight = true;
    lastRequestAt = Date.now();
    setStatus("翻译中…", "busy");

    try {
      const result = await translateWithEngine(text);
      lastTranslation = result.translation;
      recentPairs = [...recentPairs.slice(-4), { source: text, target: lastTranslation }];
      renderTranslation(lastTranslation);
      setStatus(result.engine === "local" ? "本地翻译" : "AI 翻译", "ok");
      maybeSpeak(lastTranslation);
    } catch (error) {
      setStatus(`翻译失败：${friendlyTranslationError(error)}`, "error");
    } finally {
      translationInFlight = false;
      if (pendingText && pendingText !== text && settings.enabled) {
        scheduleTranslation(pendingText);
      }
    }
  }

  function maybeSpeak(text) {
    if (!settings.speakTranslation || !text || text === lastSpoken) return;
    if (!("speechSynthesis" in window)) return;
    lastSpoken = text;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = settings.targetLang === "auto" ? "zh-CN" : settings.targetLang;
    utterance.rate = 1.05;
    utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
  }

  function selectorFor(element) {
    if (!element || element.nodeType !== 1) return null;
    if (element.id) {
      const escaped = CSS.escape(element.id);
      try {
        if (document.querySelectorAll(`#${escaped}`).length === 1) return `#${escaped}`;
      } catch {
        // Fall through to a structural selector.
      }
    }

    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && node !== document.body) {
      let part = node.tagName.toLowerCase();
      const classes = Array.from(node.classList || [])
        .filter((name) => name.length < 64 && !/^css-/.test(name) && !/\d{5,}/.test(name))
        .slice(0, 2);
      if (classes.length) part += `.${classes.map((name) => CSS.escape(name)).join(".")}`;
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }

    const selector = parts.join(" > ");
    try {
      return document.querySelector(selector) === element ? selector : null;
    } catch {
      return null;
    }
  }

  function chooseCaptionTarget(target) {
    if (!target || target === overlayHost || target.closest?.(`#${HOST_ID}`)) return null;
    let best = target;
    let node = target;
    for (let depth = 0; depth < 3 && node?.parentElement; depth += 1) {
      const nodeText = getRawText(node);
      const parent = node.parentElement;
      const parentText = getRawText(parent);
      const rect = parent.getBoundingClientRect();
      const textGrowthOk = parentText.length <= Math.max(800, nodeText.length * 6);
      if (
        textGrowthOk &&
        parentText.length >= 2 &&
        parentText.length <= 1600 &&
        rect.width >= 160 &&
        rect.height >= 14 &&
        rect.height <= window.innerHeight * 0.62
      ) {
        best = parent;
        node = parent;
      } else {
        break;
      }
    }
    return best;
  }

  function startPicker() {
    pickerCleanup?.();
    const shade = document.createElement("div");
    shade.style.cssText = [
      "all: initial",
      "position: fixed",
      "inset: 0",
      "z-index: 2147483646",
      "background: rgba(0,0,0,.08)",
      "cursor: crosshair",
      "pointer-events: none",
    ].join(";");

    const highlight = document.createElement("div");
    highlight.style.cssText = [
      "all: initial",
      "position: fixed",
      "z-index: 2147483647",
      "border: 2px solid #38d39f",
      "background: rgba(56,211,159,.12)",
      "border-radius: 5px",
      "pointer-events: none",
      "box-shadow: 0 0 0 9999px rgba(0,0,0,.18)",
    ].join(";");

    const tip = document.createElement("div");
    tip.textContent = "点击 Zoom 的实时字幕区域（Esc 取消）";
    tip.style.cssText = [
      "all: initial",
      "position: fixed",
      "left: 50%",
      "top: 18px",
      "transform: translateX(-50%)",
      "z-index: 2147483647",
      "font: 600 13px -apple-system, BlinkMacSystemFont, sans-serif",
      "color: #101216",
      "background: #38d39f",
      "padding: 7px 12px",
      "border-radius: 999px",
      "box-shadow: 0 8px 28px rgba(0,0,0,.28)",
      "pointer-events: none",
    ].join(";");

    document.documentElement.append(shade, highlight, tip);

    const onMove = (event) => {
      const target = deepElementFromPoint(event.clientX, event.clientY);
      const candidate = chooseCaptionTarget(target);
      if (!candidate) return;
      const rect = candidate.getBoundingClientRect();
      highlight.style.left = `${rect.left}px`;
      highlight.style.top = `${rect.top}px`;
      highlight.style.width = `${rect.width}px`;
      highlight.style.height = `${rect.height}px`;
    };

    const cleanup = () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKeyDown, true);
      shade.remove();
      highlight.remove();
      tip.remove();
      pickerCleanup = null;
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") cleanup();
    };

    const onClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const target = deepElementFromPoint(event.clientX, event.clientY);
      const candidate = chooseCaptionTarget(target);
      cleanup();
      if (!candidate) {
        setStatus("没有识别到字幕元素，请重试", "error");
        return;
      }
      const selector = selectorFor(candidate);
      if (!selector) {
        setStatus("无法生成稳定的字幕选择器，请选择更大的字幕容器", "error");
        return;
      }
      saveSettings({ captionSelector: selector, enabled: true });
      attachCaptionElement(candidate);
      setStatus("已保存字幕区域", "ok");
    };

    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKeyDown, true);
    pickerCleanup = cleanup;
  }

  function setupPageWatcher() {
    autoDetectionStartedAt = Date.now();
    pageScanTimer = window.setInterval(() => {
      if (!settings.enabled) return;
      if (captionElement && captionElement.isConnected) return;
      const detected = findCaptionElement();
      if (detected) attachCaptionElement(detected);
      else if (!captionElement && IS_TOP) setStatus("未检测到字幕，请点击“选字幕区”");
    }, 800);
  }

  function collectDiagnostics() {
    const candidateMap = new Map();
    for (const selector of captionCandidateSelectors) {
      for (const element of queryAllDeep(selector)) candidateMap.set(element, selector);
    }
    const candidates = Array.from(candidateMap.entries()).slice(0, 80).map(([element, selector]) => {
      const rect = element.getBoundingClientRect();
      return {
        selector,
        tag: element.tagName,
        id: element.id || "",
        className: typeof element.className === "string" ? element.className.slice(0, 180) : "",
        ariaLive: element.getAttribute("aria-live") || "",
        role: element.getAttribute("role") || "",
        text: getRawText(element).slice(0, 180),
        visible: isVisible(element),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        inShadowRoot: Boolean(element.getRootNode() && element.getRootNode() !== document),
      };
    });
    const shadowRoots = queryAllDeep("*").length;
    return {
      ok: true,
      host: location.hostname,
      title: document.title,
      topFrame: window.top === window,
      readyState: document.readyState,
      translatorApi: typeof globalThis.Translator,
      languageDetectorApi: typeof globalThis.LanguageDetector,
      captionSelector: settings.captionSelector || "",
      connected: Boolean(captionElement && captionElement.isConnected),
      lastRawCaption,
      counts: {
        ariaLive: queryAllDeep("[aria-live]").length,
        video: queryAllDeep("video").length,
        canvas: queryAllDeep("canvas").length,
        iframe: document.querySelectorAll("iframe").length,
        shadowHosts: Array.from(queryAllDeep("*")).filter((element) => element.shadowRoot).length,
        sampleAllElements: shadowRoots,
      },
      candidates,
    };
  }

  async function backgroundLocalStatus() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "localStatus", payload: { sourceLang: settings.sourceLang, targetLang: settings.targetLang } },
        (response) => resolve(response || { ok: true, available: false, reason: "no_response" }),
      );
    });
  }

  async function checkLocalStatus() {
    const API = localTranslatorApi();
    if (!API) return backgroundLocalStatus();
    const source = settings.sourceLang === "auto" ? "en" : normalizeLocalLanguage(settings.sourceLang);
    const target = normalizeLocalLanguage(settings.targetLang) || "zh";
    try {
      let availability = "available";
      if (typeof API.availability === "function") {
        availability = await API.availability({ sourceLanguage: source, targetLanguage: target });
      }
      const ownStatus = {
        ok: true,
        available: availability !== "unavailable",
        availability,
        source,
        target,
        sourceAuto: settings.sourceLang === "auto",
      };
      if (ownStatus.available) return ownStatus;
      const remoteStatus = await backgroundLocalStatus();
      return remoteStatus.available ? remoteStatus : ownStatus;
    } catch (error) {
      const ownStatus = { ok: true, available: false, reason: String(error?.message || error), sourceAuto: settings.sourceLang === "auto" };
      const remoteStatus = await backgroundLocalStatus();
      return remoteStatus.available ? remoteStatus : ownStatus;
    }
  }

  function isFromChildFrame(event) {
    return Array.from(document.querySelectorAll("iframe")).some((frame) => frame.contentWindow === event.source);
  }

  function requestChildDiagnostics(timeoutMs = 800) {
    if (!IS_TOP) return Promise.resolve([]);
    remoteDiagnostics = [];
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const frames = Array.from(document.querySelectorAll("iframe"));
    for (const frame of frames) {
      try {
        frame.contentWindow?.postMessage({ source: "zoom-codex-interpreter", type: "request-diagnostics", requestId }, "*");
      } catch {
        // A frame may be detached or restricted.
      }
    }
    return new Promise((resolve) => {
      window.setTimeout(() => resolve(remoteDiagnostics.slice()), timeoutMs);
    });
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.source !== "zoom-codex-interpreter") return;
    if (IS_TOP) {
      if (!isFromChildFrame(event)) return;
      if ((data.type === "caption" || data.type === "caption-rect") && data.rect) {
        const rect = computeRemoteRect(event.source, data);
        if (rect && rect.width > 0 && rect.height > 0) {
          currentCaptionSource = event.source;
          currentCaptionRect = rect;
          remoteCaptionActive = true;
          if (isOverlapMode()) {
            applyOverlayRect(rect);
            event.source.postMessage({ source: "zoom-codex-interpreter", type: "overlap-active", active: true }, "*");
          } else {
            event.source.postMessage({ source: "zoom-codex-interpreter", type: "overlap-active", active: false }, "*");
          }
        }
      }
      if (data.type === "caption" && typeof data.text === "string" && data.text.trim()) {
        remoteCaptionActive = true;
        lastRawCaption = data.text.trim();
        renderOriginal(lastRawCaption);
        scheduleTranslation(lastRawCaption);
        setStatus("已连接 Zoom 字幕（会议页面）", "ok");
      } else if (data.type === "caption-detected") {
        remoteCaptionActive = true;
        setStatus("已连接 Zoom 字幕（会议页面）", "ok");
      } else if (data.type === "diagnostics" && data.diagnostics) {
        remoteDiagnostics.push({ ...data.diagnostics, relayedFrom: "iframe" });
      }
      return;
    }
    if (data.type === "overlap-active") {
      hideCaptionElement(captionElement, Boolean(data.active));
    }
    if (data.type === "request-diagnostics") {
      window.top.postMessage(
        {
          source: "zoom-codex-interpreter",
          type: "diagnostics",
          requestId: data.requestId,
          diagnostics: collectDiagnostics(),
        },
        "*",
      );
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;
    if (message.type === "getState") {
      sendResponse({
        ok: true,
        settings,
        connected: Boolean(captionElement && captionElement.isConnected) || remoteCaptionActive,
        captionSelector: settings.captionSelector || "",
        lastRawCaption,
        lastTranslation,
        topFrame: IS_TOP,
        remoteCaptionActive,
      });
      return false;
    }
    if (message.type === "diagnose") {
      const ownDiagnostics = collectDiagnostics();
      if (!IS_TOP) {
        sendResponse(ownDiagnostics);
        return false;
      }
      requestChildDiagnostics().then((children) => {
        ownDiagnostics.remoteDiagnostics = children;
        sendResponse(ownDiagnostics);
      });
      return true;
    }
    if (message.type === "localStatus") {
      checkLocalStatus().then(sendResponse);
      return true;
    }
    if (message.type === "testTranslate") {
      translateWithEngine("Thanks for joining today's meeting. Let's review the roadmap.")
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: friendlyTranslationError(error) }));
      return true;
    }
    if (message.type === "setEnabled") {
      saveSettings({ enabled: Boolean(message.enabled) });
      sendResponse({ ok: true, settings });
      return false;
    }
    if (message.type === "updateSettings") {
      saveSettings(message.patch || {});
      sendResponse({ ok: true, settings });
      return false;
    }
    if (message.type === "startPicker") {
      saveSettings({ enabled: true });
      startPicker();
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "resetDetection") {
      saveSettings({ enabled: true, captionSelector: "" });
      captionObserver?.disconnect();
      captionElement = null;
      autoDetectionStartedAt = Date.now();
      autoHistory = new Map();
      const detected = findCaptionElement();
      if (detected) attachCaptionElement(detected);
      else setStatus("正在重新检测 Zoom 字幕…");
      sendResponse({ ok: true, detected: Boolean(detected) });
      return false;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    const patch = {};
    for (const [key, value] of Object.entries(changes)) patch[key] = value.newValue;
    settings = { ...settings, ...patch };
    applySettingsToOverlay();
    if (settings.enabled) {
      if (captionElement && captionElement.isConnected) readCaption();
      else if (captionElement) attachCaptionElement(findCaptionElement());
    }
  });

  async function init() {
    await loadSettings();
    if (IS_TOP) createOverlay();
    setupPageWatcher();
    const detected = findCaptionElement();
    if (detected) attachCaptionElement(detected);
    else if (IS_TOP) setStatus("未检测到字幕，请点击“选字幕区”");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
