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

const LANGUAGES = [
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

const elements = {
  serverDot: document.querySelector("#server-dot"),
  notice: document.querySelector("#notice"),
  engineStatus: document.querySelector("#engine-status"),
  updateNotice: document.querySelector("#update-notice"),
  checkUpdate: document.querySelector("#check-update"),
  toggle: document.querySelector("#toggle"),
  pick: document.querySelector("#pick"),
  diagnose: document.querySelector("#diagnose"),
  resetSelector: document.querySelector("#reset-selector"),
  test: document.querySelector("#test"),
  sourceLang: document.querySelector("#source-lang"),
  targetLang: document.querySelector("#target-lang"),
  translationEngine: document.querySelector("#translation-engine"),
  serverProvider: document.querySelector("#server-provider"),
  providerHint: document.querySelector("#provider-hint"),
  translationStyle: document.querySelector("#translation-style"),
  fontSize: document.querySelector("#font-size"),
  fontSizeValue: document.querySelector("#font-size-value"),
  compactMode: document.querySelector("#compact-mode"),
  overlayMode: document.querySelector("#overlay-mode"),
  overlayWidth: document.querySelector("#overlay-width"),
  overlayWidthValue: document.querySelector("#overlay-width-value"),
  overlayOpacity: document.querySelector("#overlay-opacity"),
  overlayOpacityValue: document.querySelector("#overlay-opacity-value"),
  showOriginal: document.querySelector("#show-original"),
  speak: document.querySelector("#speak"),
  glossary: document.querySelector("#glossary"),
  meetingContext: document.querySelector("#meeting-context"),
  testResult: document.querySelector("#test-result"),
  diagnosticResult: document.querySelector("#diagnostic-result"),
  health: document.querySelector("#health"),
};

let settings = { ...DEFAULTS };
let activeTabId = null;
let isZoomPage = false;

function fillSelect(select, includeAuto) {
  select.innerHTML = "";
  for (const [value, label] of LANGUAGES) {
    if (!includeAuto && value === "auto") continue;
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }
}

function setNotice(text, state = "") {
  elements.notice.textContent = text;
  elements.notice.className = `notice ${state}`.trim();
}

function setServerState(ok) {
  elements.serverDot.className = `dot ${ok ? "ok" : "error"}`;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function sendToContent(message, options = {}) {
  if (!activeTabId) return null;
  try {
    const target = options.allFrames ? {} : { frameId: 0 };
    return await chrome.tabs.sendMessage(activeTabId, message, target);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function checkHealth() {
  setNotice("正在检查本地翻译服务…");
  const response = await chrome.runtime.sendMessage({ type: "health" });
  if (response?.ok) {
    setServerState(true);
    setNotice(`本地服务已连接，模型：${response.model || "未知"}`, "ok");
    return true;
  }
  setServerState(false);
  setNotice(
    `本地服务未连接：${response?.error || "请先启动 server.py"}。` +
      " 详见 README 的“启动本地服务”。",
    "error",
  );
  return false;
}

async function refreshState() {
  const tab = await getActiveTab();
  activeTabId = tab?.id ?? null;
  isZoomPage = Boolean(tab?.url && /^https?:\/\/([^.]+\.)*zoom\.us\//i.test(tab.url));

  const stored = await chrome.storage.sync.get(DEFAULTS);
  settings = { ...DEFAULTS, ...(stored || {}) };

  if (isZoomPage) {
    const state = await sendToContent({ type: "getState" });
    if (state?.ok) settings = { ...settings, ...state.settings };
    setNotice(state?.connected ? "已检测到 Zoom 字幕区域。" : "请在 Zoom 页面点击“选择字幕区域”。", state?.connected ? "ok" : "");
  } else {
    setNotice("请先打开 Zoom 网页版。设置仍可修改，但字幕悬浮窗只在 Zoom 页面显示。");
  }

  renderSettings();
  await checkHealth();
  await refreshEngineStatus();
  await refreshProviderStatus();
  await checkForUpdates(false);
}

function renderSettings() {
  elements.toggle.textContent = settings.enabled ? "暂停" : "开始";
  elements.toggle.classList.toggle("paused", !settings.enabled);
  elements.sourceLang.value = settings.sourceLang;
  elements.targetLang.value = settings.targetLang;
  elements.translationEngine.value = settings.translationEngine || "auto";
  elements.serverProvider.value = settings.serverProvider || "auto";
  elements.translationStyle.value = settings.translationStyle || "natural";
  elements.fontSize.value = String(settings.fontSize || 22);
  elements.fontSizeValue.textContent = String(settings.fontSize || 22);
  elements.compactMode.checked = settings.compactMode !== false;
  elements.overlayMode.value = settings.overlayMode || "overlap";
  elements.overlayWidth.value = String(settings.overlayWidth || 680);
  elements.overlayWidthValue.textContent = String(settings.overlayWidth || 680);
  elements.overlayOpacity.value = String(Math.round((Number(settings.overlayOpacity) || 0.72) * 100));
  elements.overlayOpacityValue.textContent = String(Math.round((Number(settings.overlayOpacity) || 0.72) * 100));
  elements.showOriginal.checked = Boolean(settings.showOriginal);
  elements.speak.checked = Boolean(settings.speakTranslation);
  elements.glossary.value = settings.glossary || "";
  elements.meetingContext.value = settings.meetingContext || "";
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.sync.set(patch);
  if (isZoomPage) await sendToContent({ type: "updateSettings", patch });
  renderSettings();
}

async function diagnoseCaptions() {
  if (!isZoomPage) {
    setNotice("请先在当前窗口打开 Zoom 网页版。", "error");
    return;
  }
  elements.diagnosticResult.classList.remove("hidden");
  elements.diagnosticResult.textContent = "正在扫描 Zoom 页面字幕 DOM…";
  const response = await sendToContent({ type: "diagnose" });
  if (!response?.ok) {
    elements.diagnosticResult.textContent = `诊断失败：${response?.error || "无法连接到 Zoom 页面内容脚本"}`;
    return;
  }
  elements.diagnosticResult.textContent = JSON.stringify(response, null, 2);
}

function renderUpdateStatus(status) {
  if (!status) {
    elements.updateNotice.className = "update-notice hidden";
    elements.updateNotice.textContent = "";
    return;
  }
  if (status.error) {
    elements.updateNotice.className = "update-notice error";
    elements.updateNotice.textContent = `检查更新失败：${status.error}`;
    return;
  }
  if (!status.updateAvailable) {
    elements.updateNotice.className = "update-notice up-to-date";
    elements.updateNotice.textContent = `已是最新版本 v${status.currentVersion || status.latestVersion || ""}`;
    return;
  }
  elements.updateNotice.className = "update-notice";
  elements.updateNotice.textContent = `发现新版本 v${status.latestVersion}。 `;
  const link = document.createElement("a");
  link.href = status.releaseUrl;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "打开 GitHub Release 下载更新";
  elements.updateNotice.appendChild(link);
}

async function checkForUpdates(force = false) {
  const response = await chrome.runtime.sendMessage({ type: force ? "checkForUpdates" : "getUpdateStatus" });
  if (force && response?.ok === false) {
    elements.updateNotice.className = "update-notice error";
    elements.updateNotice.textContent = `检查更新失败：${response.error || "未知错误"}`;
    return response;
  }
  renderUpdateStatus(response);
  return response;
}

function providerLabel(provider) {
  const labels = {
    auto: "自动选择",
    codex: "Codex AI",
    deepl: "DeepL",
    microsoft: "Microsoft Translator",
    google: "Google Cloud Translation",
    libretranslate: "LibreTranslate",
  };
  return labels[provider] || provider;
}

async function refreshProviderStatus() {
  const response = await chrome.runtime.sendMessage({ type: "providers" });
  const providers = Array.isArray(response?.providers) ? response.providers : [];
  if (providers.length > 0) {
    const current = settings.serverProvider || "auto";
    elements.serverProvider.innerHTML = "";
    for (const provider of providers) {
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = provider.configured
        ? provider.name
        : `${provider.name}（未配置）`;
      option.disabled = provider.id !== "auto" && !provider.configured;
      elements.serverProvider.appendChild(option);
    }
    if ([...elements.serverProvider.options].some((option) => option.value === current)) {
      elements.serverProvider.value = current;
    } else {
      elements.serverProvider.value = "auto";
      settings.serverProvider = "auto";
    }
  }

  const selected = elements.serverProvider.value || "auto";
  const selectedProvider = providers.find((provider) => provider.id === selected);
  if (response?.ok === false) {
    elements.providerHint.className = "engine-status error";
    elements.providerHint.textContent = "本地服务未连接，AI / 云翻译不可用。";
  } else if (selectedProvider && !selectedProvider.configured) {
    elements.providerHint.className = "engine-status error";
    elements.providerHint.textContent = `${providerLabel(selected)} 尚未配置，请编辑 server 的 config.json。`;
  } else if (selectedProvider?.hint) {
    elements.providerHint.className = "engine-status";
    elements.providerHint.textContent = selectedProvider.hint;
  } else {
    elements.providerHint.className = "engine-status ok";
    elements.providerHint.textContent = `${providerLabel(selected)} 已就绪。`;
  }
}

async function refreshEngineStatus() {
  if (!isZoomPage) {
    elements.engineStatus.className = "engine-status";
    elements.engineStatus.textContent = "打开 Zoom 页面后可检测本地翻译能力。";
    return;
  }
  const response = await sendToContent({ type: "localStatus" });
  if (response?.available) {
    elements.engineStatus.className = "engine-status ok";
    elements.engineStatus.textContent = response.availability === "downloadable"
      ? "本地翻译：可用（首次使用会下载语言包）"
      : "本地翻译：可用";
  } else {
    elements.engineStatus.className = "engine-status error";
    elements.engineStatus.textContent = "本地翻译：不可用，将使用 AI 模式";
  }
}

async function testTranslation() {
  if (!isZoomPage) {
    elements.testResult.className = "result error";
    elements.testResult.textContent = "请先在当前窗口打开 Zoom 网页版。";
    return;
  }
  elements.testResult.className = "result";
  elements.testResult.textContent = "正在测试当前翻译引擎…";
  const response = await sendToContent({ type: "testTranslate" });
  if (response?.ok) {
    const engine = response.engine === "local" ? "本地翻译" : "AI 翻译";
    elements.testResult.textContent = `[${engine}] ${response.translation}`;
  } else {
    elements.testResult.className = "result error";
    elements.testResult.textContent = response?.error || "测试失败。";
  }
}

elements.toggle.addEventListener("click", async () => {
  await saveSettings({ enabled: !settings.enabled });
  if (isZoomPage) await sendToContent({ type: "setEnabled", enabled: settings.enabled });
});

elements.pick.addEventListener("click", async () => {
  if (!isZoomPage) {
    setNotice("请先在当前窗口打开 Zoom 网页版。", "error");
    return;
  }
  const response = await sendToContent({ type: "startPicker" }, { allFrames: true });
  if (!response?.ok) setNotice("无法进入字幕选择模式，请刷新 Zoom 页面后重试。", "error");
  window.close();
});

elements.test.addEventListener("click", testTranslation);
elements.diagnose.addEventListener("click", diagnoseCaptions);
elements.resetSelector.addEventListener("click", async () => {
  if (!isZoomPage) {
    setNotice("请先在当前窗口打开 Zoom 网页版。", "error");
    return;
  }
  await saveSettings({ captionSelector: "" });
  const response = await sendToContent({ type: "resetDetection" }, { allFrames: true });
  setNotice(response?.ok ? "已重置字幕区域，正在重新检测。" : "重置失败，请刷新 Zoom 页面。", response?.ok ? "ok" : "error");
});
elements.health.addEventListener("click", checkHealth);
elements.checkUpdate.addEventListener("click", async () => {
  elements.updateNotice.className = "update-notice";
  elements.updateNotice.textContent = "正在检查更新…";
  await checkForUpdates(true);
});
elements.sourceLang.addEventListener("change", () => saveSettings({ sourceLang: elements.sourceLang.value }));
elements.targetLang.addEventListener("change", () => saveSettings({ targetLang: elements.targetLang.value }));
elements.translationEngine.addEventListener("change", async () => {
  await saveSettings({ translationEngine: elements.translationEngine.value });
  await refreshEngineStatus();
});
elements.serverProvider.addEventListener("change", async () => {
  await saveSettings({ serverProvider: elements.serverProvider.value });
  await refreshProviderStatus();
});
elements.translationStyle.addEventListener("change", () => saveSettings({ translationStyle: elements.translationStyle.value }));
elements.fontSize.addEventListener("input", () => {
  elements.fontSizeValue.textContent = elements.fontSize.value;
  window.clearTimeout(elements.fontSize._saveTimer);
  elements.fontSize._saveTimer = window.setTimeout(() => saveSettings({ fontSize: Number(elements.fontSize.value) }), 150);
});
elements.compactMode.addEventListener("change", () => saveSettings({ compactMode: elements.compactMode.checked }));
elements.overlayMode.addEventListener("change", () => saveSettings({ overlayMode: elements.overlayMode.value }));
elements.overlayWidth.addEventListener("input", () => {
  elements.overlayWidthValue.textContent = elements.overlayWidth.value;
  window.clearTimeout(elements.overlayWidth._saveTimer);
  elements.overlayWidth._saveTimer = window.setTimeout(() => saveSettings({ overlayWidth: Number(elements.overlayWidth.value) }), 150);
});
elements.overlayOpacity.addEventListener("input", () => {
  const percent = Number(elements.overlayOpacity.value);
  elements.overlayOpacityValue.textContent = String(percent);
  window.clearTimeout(elements.overlayOpacity._saveTimer);
  elements.overlayOpacity._saveTimer = window.setTimeout(() => saveSettings({ overlayOpacity: percent / 100 }), 150);
});
elements.showOriginal.addEventListener("change", () => saveSettings({ showOriginal: elements.showOriginal.checked }));
elements.speak.addEventListener("change", () => saveSettings({ speakTranslation: elements.speak.checked }));
elements.glossary.addEventListener("input", () => {
  window.clearTimeout(elements.glossary._saveTimer);
  elements.glossary._saveTimer = window.setTimeout(() => saveSettings({ glossary: elements.glossary.value.trim() }), 450);
});
elements.meetingContext.addEventListener("input", () => {
  window.clearTimeout(elements.meetingContext._saveTimer);
  elements.meetingContext._saveTimer = window.setTimeout(() => saveSettings({ meetingContext: elements.meetingContext.value.trim() }), 450);
});

fillSelect(elements.sourceLang, true);
fillSelect(elements.targetLang, false);
refreshState();
