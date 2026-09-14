#!/usr/bin/env python3
"""Local translation service for the Zoom Codex Interpreter Chrome extension.

The service reads the current Codex model/provider configuration and API key,
then exposes a tiny localhost HTTP API that the extension can call.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import sys
import threading
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_BASE_URL = "http://127.0.0.1:15721/v1"
DEFAULT_MODEL = "deepseek-v4-flash"
MAX_TEXT_CHARS = 2000
CACHE_SIZE = 512

_LANGUAGE_NAMES = {
    "auto": "the source language detected from the caption",
    "zh-CN": "Simplified Chinese",
    "zh-TW": "Traditional Chinese",
    "en": "English",
    "ja": "Japanese",
    "ko": "Korean",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "pt": "Portuguese",
    "it": "Italian",
    "ru": "Russian",
    "ar": "Arabic",
}


class TranslationError(RuntimeError):
    pass


class TranslationCache:
    def __init__(self, max_size: int = CACHE_SIZE) -> None:
        self._max_size = max_size
        self._items: OrderedDict[str, str] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> str | None:
        with self._lock:
            value = self._items.get(key)
            if value is not None:
                self._items.move_to_end(key)
            return value

    def put(self, key: str, value: str) -> None:
        with self._lock:
            self._items[key] = value
            self._items.move_to_end(key)
            while len(self._items) > self._max_size:
                self._items.popitem(last=False)


PROVIDER_NAMES = {
    "auto": "自动选择",
    "codex": "Codex AI",
    "deepl": "DeepL",
    "microsoft": "Microsoft Translator",
    "google": "Google Cloud Translation",
    "libretranslate": "LibreTranslate",
}

PROVIDER_HINTS = {
    "deepl": "需要 DeepL API Key",
    "microsoft": "需要 Azure Translator Key 和区域",
    "google": "需要 Google Cloud Translation API Key",
    "libretranslate": "需要本地或远程 LibreTranslate 地址",
}

DEEPL_LANGUAGE_MAP = {
    "auto": None,
    "zh-CN": "ZH",
    "zh-TW": "ZH-HANT",
    "zh-HK": "ZH-HANT",
    "en": "EN",
    "ja": "JA",
    "ko": "KO",
    "de": "DE",
    "fr": "FR",
    "es": "ES",
    "pt": "PT-BR",
    "it": "IT",
    "ru": "RU",
    "ar": "AR",
}

MICROSOFT_LANGUAGE_MAP = {
    "auto": None,
    "zh-CN": "zh-Hans",
    "zh-TW": "zh-Hant",
    "zh-HK": "zh-Hant",
}

LIBRETRANSLATE_LANGUAGE_MAP = {
    "auto": None,
    "zh-CN": "zh",
    "zh-TW": "zt",
    "zh-HK": "zt",
}


def default_provider_config() -> dict[str, Any]:
    return {
        "defaultProvider": "auto",
        "fallbackOrder": ["deepl", "microsoft", "google", "libretranslate", "codex"],
        "providers": {
            "codex": {},
            "deepl": {
                "apiKey": "",
                "pro": False,
                "endpoint": "https://api-free.deepl.com/v2/translate",
            },
            "microsoft": {
                "apiKey": "",
                "region": "eastasia",
                "endpoint": "https://api.cognitive.microsofttranslator.com",
            },
            "google": {
                "apiKey": "",
                "endpoint": "https://translation.googleapis.com/language/translate/v2",
            },
            "libretranslate": {
                "url": "",
                "apiKey": "",
            },
        },
    }


def load_provider_config(path: Path) -> dict[str, Any]:
    config = default_provider_config()
    try:
        user_config = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return config
    except Exception as exc:
        print(f"[warn] 读取翻译服务配置 {path} 失败：{exc}", file=sys.stderr)
        return config

    if isinstance(user_config.get("defaultProvider"), str):
        config["defaultProvider"] = user_config["defaultProvider"]
    if isinstance(user_config.get("fallbackOrder"), list):
        config["fallbackOrder"] = [str(item) for item in user_config["fallbackOrder"]]
    providers = user_config.get("providers")
    if isinstance(providers, dict):
        for name, values in providers.items():
            if isinstance(values, dict):
                config["providers"].setdefault(str(name), {}).update(values)
    return config


def provider_configured(name: str, config: dict[str, Any], codex_api_key: str | None) -> bool:
    if name == "codex":
        return bool(codex_api_key)
    if name == "libretranslate":
        return bool(config.get("url"))
    if name == "microsoft":
        return bool(config.get("apiKey") and config.get("region"))
    return bool(config.get("apiKey"))


def map_language(value: str, mapping: dict[str, str | None], fallback: str | None = None) -> str | None:
    value = (value or "").strip()
    if value in mapping:
        return mapping[value]
    base = value.split("-")[0]
    if base in mapping:
        return mapping[base]
    return fallback if fallback is not None else (value or None)


class TranslationRuntime:
    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        api_key: str | None,
        timeout: float,
        provider_config: dict[str, Any] | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.timeout = timeout
        self.cache = TranslationCache()
        self.provider_config = provider_config or default_provider_config()

    @property
    def responses_url(self) -> str:
        if self.base_url.endswith("/responses"):
            return self.base_url
        return f"{self.base_url}/responses"

    def provider_settings(self, name: str) -> dict[str, Any]:
        providers = self.provider_config.get("providers") or {}
        values = providers.get(name) or {}
        return values if isinstance(values, dict) else {}

    def providers(self) -> dict[str, Any]:
        provider_ids = ["auto", "codex", "deepl", "microsoft", "google", "libretranslate"]
        providers = []
        for provider_id in provider_ids:
            configured = True if provider_id == "auto" else provider_configured(
                provider_id,
                self.provider_settings(provider_id),
                self.api_key,
            )
            providers.append(
                {
                    "id": provider_id,
                    "name": PROVIDER_NAMES.get(provider_id, provider_id),
                    "configured": configured,
                    "hint": PROVIDER_HINTS.get(provider_id, ""),
                }
            )
        return {
            "ok": True,
            "defaultProvider": self.provider_config.get("defaultProvider") or "auto",
            "fallbackOrder": self.provider_config.get("fallbackOrder") or [],
            "providers": providers,
        }

    def health(self) -> dict[str, Any]:
        configured = [item["id"] for item in self.providers()["providers"] if item["configured"]]
        return {
            "ok": True,
            "service": "zoom-codex-interpreter",
            "model": self.model,
            "base_url": self.base_url,
            "api_key_loaded": bool(self.api_key),
            "configured_providers": configured,
        }

    def translate(
        self,
        text: str,
        *,
        source_lang: str,
        target_lang: str,
        glossary: str = "",
        meeting_context: str = "",
        style: str = "natural",
        context: list[dict[str, str]] | None = None,
        provider: str = "auto",
    ) -> str:
        text = normalize_caption(text)
        if not text:
            raise TranslationError("没有可翻译的字幕文本。")
        if len(text) > MAX_TEXT_CHARS:
            raise TranslationError(f"字幕片段过长（{len(text)} 字符），最多支持 {MAX_TEXT_CHARS} 字符。")

        context = context or []
        glossary = (glossary or "").strip()[:2000]
        meeting_context = (meeting_context or "").strip()[:1200]
        style = (style or "natural").strip().lower()
        if style not in {"natural", "concise", "literal"}:
            style = "natural"

        requested = (provider or self.provider_config.get("defaultProvider") or "auto").strip().lower()
        if requested in {"auto", "server"}:
            candidates = [str(item).lower() for item in (self.provider_config.get("fallbackOrder") or [])]
            if "codex" not in candidates:
                candidates.append("codex")
        else:
            candidates = [requested]
        if not candidates:
            candidates = ["codex"]

        errors: list[str] = []
        for candidate in candidates:
            if candidate in {"local", "browser"}:
                errors.append("本地浏览器翻译由扩展处理")
                continue
            if not provider_configured(candidate, self.provider_settings(candidate), self.api_key):
                errors.append(f"{PROVIDER_NAMES.get(candidate, candidate)} 未配置")
                continue
            cache_key = self._cache_key(
                provider=candidate,
                text=text,
                source_lang=source_lang,
                target_lang=target_lang,
                glossary=glossary,
                meeting_context=meeting_context,
                style=style,
                context=context,
            )
            cached = self.cache.get(cache_key)
            if cached is not None:
                return cached
            try:
                translation = self._translate_with_provider(
                    candidate,
                    text,
                    source_lang=source_lang,
                    target_lang=target_lang,
                    glossary=glossary,
                    meeting_context=meeting_context,
                    style=style,
                    context=context,
                )
                translation = clean_translation(translation)
                if not translation:
                    raise TranslationError("翻译服务没有返回可用文本")
                self.cache.put(cache_key, translation)
                return translation
            except TranslationError as exc:
                errors.append(f"{PROVIDER_NAMES.get(candidate, candidate)}：{exc}")

        raise TranslationError("所有翻译服务都失败：" + "；".join(errors or ["没有可用服务"]))

    def _translate_with_provider(
        self,
        provider: str,
        text: str,
        *,
        source_lang: str,
        target_lang: str,
        glossary: str,
        meeting_context: str,
        style: str,
        context: list[dict[str, str]],
    ) -> str:
        if provider == "codex":
            return self._translate_codex(
                text,
                source_lang=source_lang,
                target_lang=target_lang,
                glossary=glossary,
                meeting_context=meeting_context,
                style=style,
                context=context,
            )
        if provider == "deepl":
            return self._translate_deepl(text, source_lang=source_lang, target_lang=target_lang)
        if provider == "microsoft":
            return self._translate_microsoft(text, source_lang=source_lang, target_lang=target_lang)
        if provider == "google":
            return self._translate_google(text, source_lang=source_lang, target_lang=target_lang)
        if provider == "libretranslate":
            return self._translate_libretranslate(text, source_lang=source_lang, target_lang=target_lang)
        raise TranslationError(f"不支持的翻译服务：{provider}")

    def _cache_key(self, *, provider: str, text: str, source_lang: str, target_lang: str, glossary: str, meeting_context: str, style: str, context: list[dict[str, str]]) -> str:
        return sha256_text(
            "\x1f".join(
                [
                    provider,
                    self.model,
                    source_lang,
                    target_lang,
                    glossary,
                    meeting_context,
                    style,
                    text,
                    json.dumps(context, ensure_ascii=False, sort_keys=True),
                ]
            )
        )

    def _translate_codex(
        self,
        text: str,
        *,
        source_lang: str,
        target_lang: str,
        glossary: str,
        meeting_context: str,
        style: str,
        context: list[dict[str, str]],
    ) -> str:
        if not self.api_key:
            raise TranslationError(
                "没有找到 Codex API Key。请确认 ~/.codex/auth.json 存在，"
                "或设置 OPENAI_API_KEY 环境变量。"
            )
        source_name = _LANGUAGE_NAMES.get(source_lang, source_lang or "the source language")
        target_name = _LANGUAGE_NAMES.get(target_lang, target_lang or "Simplified Chinese")
        system_prompt = build_system_prompt(
            source_name=source_name,
            target_name=target_name,
            glossary=glossary,
            meeting_context=meeting_context,
            style=style,
            context=context,
        )
        payload = {
            "model": self.model,
            "input": [
                {"role": "system", "content": [{"type": "input_text", "text": system_prompt}]},
                {"role": "user", "content": [{"type": "input_text", "text": text}]},
            ],
            "reasoning": {"effort": "none"},
            "temperature": 0.2,
            "max_output_tokens": 360,
            "stream": False,
        }
        data = self._http_json("POST", self.responses_url, payload, headers={"Authorization": f"Bearer {self.api_key}"}, provider_name="Codex")
        return extract_output_text(data)

    def _translate_deepl(self, text: str, *, source_lang: str, target_lang: str) -> str:
        settings = self.provider_settings("deepl")
        api_key = str(settings.get("apiKey") or "")
        endpoint = str(settings.get("endpoint") or "https://api-free.deepl.com/v2/translate")
        target = map_language(target_lang, DEEPL_LANGUAGE_MAP)
        source = map_language(source_lang, DEEPL_LANGUAGE_MAP)
        if not target:
            raise TranslationError("DeepL 不支持该目标语言")
        payload: dict[str, Any] = {
            "text": [text],
            "target_lang": target,
            "preserve_formatting": True,
        }
        if source:
            payload["source_lang"] = source
        data = self._http_json(
            "POST",
            endpoint,
            payload,
            headers={"Authorization": f"DeepL-Auth-Key {api_key}"},
            provider_name="DeepL",
        )
        return str(data["translations"][0]["text"])

    def _translate_microsoft(self, text: str, *, source_lang: str, target_lang: str) -> str:
        settings = self.provider_settings("microsoft")
        api_key = str(settings.get("apiKey") or "")
        region = str(settings.get("region") or "")
        endpoint = str(settings.get("endpoint") or "https://api.cognitive.microsofttranslator.com").rstrip("/")
        target = map_language(target_lang, MICROSOFT_LANGUAGE_MAP)
        source = map_language(source_lang, MICROSOFT_LANGUAGE_MAP)
        if not target:
            raise TranslationError("Microsoft Translator 不支持该目标语言")
        params = {"api-version": "3.0", "to": target}
        if source:
            params["from"] = source
        url = f"{endpoint}/translate?{urllib.parse.urlencode(params)}"
        data = self._http_json(
            "POST",
            url,
            [{"Text": text}],
            headers={
                "Ocp-Apim-Subscription-Key": api_key,
                "Ocp-Apim-Subscription-Region": region,
            },
            provider_name="Microsoft Translator",
        )
        return str(data[0]["translations"][0]["text"])

    def _translate_google(self, text: str, *, source_lang: str, target_lang: str) -> str:
        settings = self.provider_settings("google")
        api_key = str(settings.get("apiKey") or "")
        endpoint = str(settings.get("endpoint") or "https://translation.googleapis.com/language/translate/v2")
        params = {"key": api_key}
        separator = "&" if "?" in endpoint else "?"
        url = f"{endpoint}{separator}{urllib.parse.urlencode(params)}"
        payload: dict[str, Any] = {
            "q": text,
            "target": target_lang,
            "format": "text",
        }
        if source_lang and source_lang != "auto":
            payload["source"] = source_lang
        data = self._http_json("POST", url, payload, provider_name="Google Cloud Translation")
        return html.unescape(str(data["data"]["translations"][0]["translatedText"]))

    def _translate_libretranslate(self, text: str, *, source_lang: str, target_lang: str) -> str:
        settings = self.provider_settings("libretranslate")
        base_url = str(settings.get("url") or "").rstrip("/")
        api_key = str(settings.get("apiKey") or "")
        if not base_url:
            raise TranslationError("LibreTranslate 地址为空")
        source = map_language(source_lang, LIBRETRANSLATE_LANGUAGE_MAP) or "auto"
        target = map_language(target_lang, LIBRETRANSLATE_LANGUAGE_MAP)
        if not target:
            raise TranslationError("LibreTranslate 不支持该目标语言")
        payload: dict[str, Any] = {
            "q": text,
            "source": source,
            "target": target,
            "format": "text",
        }
        if api_key:
            payload["api_key"] = api_key
        data = self._http_json("POST", f"{base_url}/translate", payload, provider_name="LibreTranslate")
        return str(data["translatedText"])

    def _http_json(
        self,
        method: str,
        url: str,
        payload: dict[str, Any] | list[Any] | None = None,
        headers: dict[str, str] | None = None,
        provider_name: str = "翻译服务",
    ) -> Any:
        body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request_headers = {"Accept": "application/json", **(headers or {})}
        if body is not None:
            request_headers.setdefault("Content-Type", "application/json")
        request = urllib.request.Request(url, data=body, headers=request_headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:800]
            raise TranslationError(f"{provider_name} 返回 HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise TranslationError(f"无法连接 {provider_name}：{exc}") from exc
        except TimeoutError as exc:
            raise TranslationError(f"{provider_name} 响应超时") from exc
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise TranslationError(f"{provider_name} 返回了非 JSON 响应：{raw[:500]}") from exc

def build_system_prompt(
    *,
    source_name: str,
    target_name: str,
    glossary: str,
    meeting_context: str,
    style: str,
    context: list[dict[str, str]],
) -> str:
    lines = [
        "You are a professional simultaneous interpreter producing live subtitles for a Zoom meeting.",
        f"Translate the user's {source_name} live caption into {target_name}.",
        "",
        "Subtitle style:",
        "- Keep each subtitle concise and easy to read at a glance.",
        "- Prefer short clauses and natural punctuation; avoid semicolons.",
        "- Preserve names, numbers, product names, acronyms, and technical terms.",
        "- Keep terminology consistent with the glossary and recent context.",
        "- If the caption is an incomplete fragment, translate only the meaning present; never invent missing content.",
        "- If the source is already in the target language, lightly clean it without changing meaning.",
        "- Output ONLY the translation. No explanations, labels, quotes, or markdown.",
    ]
    if style == "concise":
        lines += [
            "- Be extra concise, like high-quality TV subtitles.",
            "- Remove filler words and repetition while preserving the speaker's meaning.",
        ]
    elif style == "literal":
        lines += [
            "- Stay close to the source wording while keeping the result grammatical.",
            "- Preserve technical precision and qualifications; do not paraphrase aggressively.",
        ]
    else:
        lines += [
            "- Sound natural and spoken, not word-for-word.",
        ]
    if meeting_context:
        lines += [
            "",
            "Meeting context / domain (use it to disambiguate terminology):",
            meeting_context,
        ]
    if glossary:
        lines += ["", "Glossary (use these exact translations when relevant):", glossary]
    if context:
        lines += ["", "Recent source/translation pairs (for continuity only):"]
        for pair in context[-4:]:
            source = normalize_caption(pair.get("source", ""))
            target = normalize_caption(pair.get("target", ""))
            if source or target:
                lines.append(f"- SOURCE: {source}")
                lines.append(f"  TARGET: {target}")
    return "\n".join(lines)


def extract_output_text(data: dict[str, Any]) -> str:
    texts: list[str] = []

    # OpenAI Responses API shape.
    for item in data.get("output", []) or []:
        if item.get("type") == "message":
            for content in item.get("content", []) or []:
                if content.get("type") == "output_text" and isinstance(content.get("text"), str):
                    texts.append(content["text"])
    if texts:
        return "".join(texts)

    # Some compatible proxies expose output_text directly.
    if isinstance(data.get("output_text"), str):
        return data["output_text"]

    # Chat Completions-compatible fallback.
    for choice in data.get("choices", []) or []:
        message = choice.get("message") or {}
        content = message.get("content")
        if isinstance(content, str):
            texts.append(content)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and isinstance(part.get("text"), str):
                    texts.append(part["text"])
    if texts:
        return "".join(texts)

    # Last-resort fallback for simple proxy responses.
    if isinstance(data.get("text"), str):
        return data["text"]
    return ""


def clean_translation(text: str) -> str:
    text = (text or "").strip()
    text = re.sub(r"^(?:翻译|译文|中文|Translation)\s*[:：]\s*", "", text, flags=re.IGNORECASE)
    text = text.strip().strip('"').strip("'").strip("“”").strip("「」")
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def normalize_caption(text: str) -> str:
    text = (text or "").replace("\u200b", " ").replace("\ufeff", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{2,}", "\n", text)
    return text.strip()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_codex_settings(
    *,
    codex_home: Path,
    model_override: str | None,
    base_url_override: str | None,
) -> tuple[str, str, str | None]:
    config_path = codex_home / "config.toml"
    model = model_override or DEFAULT_MODEL
    base_url = base_url_override or DEFAULT_BASE_URL

    try:
        config = tomllib.loads(config_path.read_text(encoding="utf-8"))
        model = model_override or str(config.get("model") or model)
        providers = config.get("model_providers") or {}
        custom = providers.get("custom") or {}
        base_url = base_url_override or str(custom.get("base_url") or base_url)
    except FileNotFoundError:
        pass
    except Exception as exc:
        print(f"[warn] 读取 {config_path} 失败，将使用默认值：{exc}", file=sys.stderr)

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        auth_path = codex_home / "auth.json"
        try:
            auth = json.loads(auth_path.read_text(encoding="utf-8"))
            api_key = auth.get("OPENAI_API_KEY")
            tokens = auth.get("tokens") or {}
            if not api_key:
                api_key = tokens.get("access_token")
        except FileNotFoundError:
            pass
        except Exception as exc:
            print(f"[warn] 读取 {auth_path} 失败：{exc}", file=sys.stderr)

    return model, base_url, api_key


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "ZoomCodexInterpreter/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep normal logs quiet; the extension shows actionable errors.
        if self.path not in {"/health", "/config"}:
            print(f"[{self.log_date_time_string()}] {self.address_string()} {fmt % args}")

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _is_web_origin(self) -> bool:
        origin = (self.headers.get("Origin") or "").strip().lower()
        return origin == "null" or origin.startswith("http://") or origin.startswith("https://")

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        if self._is_web_origin():
            self._send_json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "Only local extension requests are allowed."})
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        runtime: TranslationRuntime = self.server.runtime  # type: ignore[attr-defined]
        if self.path.startswith("/health"):
            self._send_json(HTTPStatus.OK, runtime.health())
            return
        if self.path.startswith("/providers"):
            self._send_json(HTTPStatus.OK, runtime.providers())
            return
        if self.path.startswith("/config"):
            self._send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "model": runtime.model,
                    "base_url": runtime.base_url,
                    "source_lang_default": "auto",
                    "target_lang_default": "zh-CN",
                    "providers": runtime.providers(),
                },
            )
            return
        self._send_json(
            HTTPStatus.OK,
            {
                "ok": True,
                "name": "Zoom Codex Interpreter local service",
                "endpoints": ["GET /health", "GET /config", "GET /providers", "POST /translate"],
            },
        )

    def do_POST(self) -> None:  # noqa: N802
        if self._is_web_origin():
            self._send_json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "Only local extension requests are allowed."})
            return
        if not self.path.startswith("/translate"):
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or "0")
            if length <= 0 or length > 1_000_000:
                raise TranslationError("请求体为空或过大。")
            raw = self.rfile.read(length).decode("utf-8", "replace")
            payload = json.loads(raw)
        except Exception as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": f"无效请求：{exc}"})
            return

        runtime: TranslationRuntime = self.server.runtime  # type: ignore[attr-defined]
        try:
            translation = runtime.translate(
                str(payload.get("text") or ""),
                source_lang=str(payload.get("sourceLang") or payload.get("source_lang") or "auto"),
                target_lang=str(payload.get("targetLang") or payload.get("target_lang") or "zh-CN"),
                glossary=str(payload.get("glossary") or ""),
                meeting_context=str(payload.get("meetingContext") or payload.get("meeting_context") or ""),
                style=str(payload.get("translationStyle") or payload.get("style") or "natural"),
                context=payload.get("context") if isinstance(payload.get("context"), list) else None,
                provider=str(payload.get("provider") or payload.get("translationProvider") or "auto"),
            )
            self._send_json(HTTPStatus.OK, {"ok": True, "translation": translation})
        except TranslationError as exc:
            self._send_json(HTTPStatus.BAD_GATEWAY, {"ok": False, "error": str(exc)})
        except Exception as exc:  # defensive: never crash the service loop
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": f"服务异常：{exc}"})


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local translation service for Zoom Codex Interpreter")
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"监听地址，默认 {DEFAULT_HOST}")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"监听端口，默认 {DEFAULT_PORT}")
    parser.add_argument("--model", default=None, help="覆盖 Codex 配置中的模型名")
    parser.add_argument("--base-url", default=None, help="覆盖 Codex 配置中的模型代理地址")
    parser.add_argument("--timeout", type=float, default=30.0, help="调用模型代理的超时秒数")
    parser.add_argument("--codex-home", default=str(Path.home() / ".codex"), help="Codex 配置目录")
    parser.add_argument(
        "--config",
        default=str(Path.home() / "Library" / "Application Support" / "ZoomCodexInterpreter" / "config.json"),
        help="翻译服务配置文件；默认 ~/Library/Application Support/ZoomCodexInterpreter/config.json",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    codex_home = Path(args.codex_home).expanduser()
    model, base_url, api_key = load_codex_settings(
        codex_home=codex_home,
        model_override=args.model,
        base_url_override=args.base_url,
    )
    config_path = Path(args.config).expanduser()
    provider_config = load_provider_config(config_path)
    runtime = TranslationRuntime(
        base_url=base_url,
        model=model,
        api_key=api_key,
        timeout=args.timeout,
        provider_config=provider_config,
    )
    httpd = ThreadingHTTPServer((args.host, args.port), RequestHandler)
    httpd.runtime = runtime  # type: ignore[attr-defined]
    print("Zoom Codex Interpreter local service")
    print(f"  Listening: http://{args.host}:{args.port}")
    print(f"  Codex proxy: {runtime.base_url}")
    print(f"  Model: {runtime.model}")
    print(f"  API key loaded: {'yes' if api_key else 'no'}")
    print(f"  Provider config: {config_path}")
    print("  Keep this window open while using the Chrome extension.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping...")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
