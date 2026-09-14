# Zoom Codex Interpreter

GitHub 仓库：https://github.com/ZephyrChiu0326/zoom-codex-interpreter

Releases：https://github.com/ZephyrChiu0326/zoom-codex-interpreter/releases

Chrome / Microsoft Edge 兼容的 Zoom 网页版实时字幕翻译工具：读取 Zoom 的实时字幕，可选择浏览器本地翻译或 Codex AI 翻译，并在 Zoom 页面显示紧凑字幕条。

## 功能

- Zoom 网页版实时字幕监听
- 支持 Zoom 会议 iframe
- 本地翻译 / AI 翻译双引擎
- 本机 Codex 模型代理翻译（AI 模式）
- Chrome 内置 Translator API（本地模式）
- 自然口语 / 简洁短句 / 逐字准确三种字幕风格
- 会议背景与术语表
- 紧凑字幕条，最多两行译文，点击穿透
- 可调字幕字号、宽度、背景不透明度
- 可选朗读译文
- 字幕区域手动选择与自动检测

## 工作原理

自动模式：

```text
Zoom 网页实时字幕
        ↓
Chrome 扩展读取字幕文本
        ↓
优先使用浏览器本地翻译
        ↓
本地翻译不可用时回退到 AI 翻译
        ↓
译文显示在 Zoom 页面底部字幕条
```

AI 模式：

```text
Zoom 网页实时字幕
        ↓
Chrome 扩展读取字幕文本
        ↓
本机 server.py（127.0.0.1:8765）
        ↓
Codex / cc-switch 模型代理（默认 127.0.0.1:15721/v1）
        ↓
译文显示在 Zoom 页面底部字幕条
```

本地模式不需要 Codex、API Key 或 `server.py`。

## 目录结构

```text
zoom-codex-interpreter/
├── extension/              Chrome 扩展
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── server.py               本机翻译服务
├── start.command           macOS 双击启动脚本
├── scripts/
│   └── build_release.py    打包发布文件
├── updates/
│   └── update.json         版本与更新说明
├── CHANGELOG.md            版本更新记录
├── LICENSE                 MIT License
└── README.md
```

## 使用前提

本地翻译模式：

- Chrome 138+（推荐，具体可用性取决于浏览器）
- 不需要 Codex、API Key 或 `server.py`

AI 翻译模式：

- Codex / ChatGPT 桌面程序正在运行
- 本机 Codex 模型代理可访问，默认 `http://127.0.0.1:15721/v1`
- `~/.codex/config.toml` 中有 `model` 和 `model_providers.custom.base_url`
- `~/.codex/auth.json` 中有 `OPENAI_API_KEY`，或环境变量中有 `OPENAI_API_KEY`
- Python 3.11+

## 启动 AI 翻译服务（仅 AI 模式需要）

```bash
cd /path/to/zoom-codex-interpreter
python3 server.py
```

macOS 也可以双击 `start.command`。

看到下面内容表示启动成功：

```text
Zoom Codex Interpreter local service
  Listening: http://127.0.0.1:8765
  Codex proxy: http://127.0.0.1:15721/v1
  Model: deepseek-v4-flash
  API key loaded: yes
```

使用同传期间保持这个终端窗口打开。

## 在 Chrome 中加载扩展

1. 打开 `chrome://extensions/`
2. 打开右上角“开发者模式”
3. 点击“加载未打包的扩展程序”
4. 选择 `extension/` 目录
5. 加载后刷新 Zoom 页面

如果 Chrome 中文界面显示“加载未打包的扩展程序”，这就是英文版里的 `Load unpacked`。

## 在 Microsoft Edge 中加载扩展

1. 打开 `edge://extensions/`
2. 打开左侧或页面中的“开发人员模式”
3. 点击“加载解压缩的扩展”
4. 选择解压后的 Edge 扩展目录
5. 加载后刷新 Zoom 页面

Edge 与 Chrome 使用同一套 Chromium 扩展代码。发布包会分别生成 Chrome 版和 Edge 版。

## 翻译引擎设置

在扩展弹窗中选择：

```text
自动（本地优先，AI 兜底）
本地翻译（无需大模型）
Codex AI（质量优先）
```

- 自动：优先使用浏览器本地翻译，准备超时或不可用时自动使用 AI。
- 本地：完全使用浏览器本地翻译，不需要 `server.py`，字幕不会离开浏览器。
- AI：使用 Codex 大模型，翻译质量、术语一致性和上下文更好，需要本机 `server.py`。

Edge 是否支持本地翻译取决于 Edge 版本和系统语言包。如果 Edge 不支持，自动模式会自动回退到 AI 模式。

## 在 Zoom 中使用

1. 打开 Zoom 网页版会议
2. 打开 Zoom 实时字幕
3. 点击 Chrome 工具栏里的 **Zoom Codex Interpreter**
4. 点击“选择字幕区域”
5. 点击 Zoom 显示字幕的区域
6. 页面底部出现字幕条即可

推荐设置：

```text
紧凑字幕条：开启
字幕宽度：600 - 680 px
背景不透明度：45% - 60%
字幕字号：18 - 20
显示原文：关闭
字幕风格：简洁短句
```

## 分享给别人

普通用户只需要扩展文件，不需要服务端代码：

Chrome 用户：

```text
dist/ZoomCodexInterpreter-chrome-v1.0.8.zip
```

Edge 用户：

```text
dist/ZoomCodexInterpreter-edge-v1.0.8.zip
```

对方解压后：

Chrome：

1. 打开 `chrome://extensions/`
2. 开启开发者模式
3. 点击“加载未打包的扩展程序”
4. 选择解压后的目录

Edge：

1. 打开 `edge://extensions/`
2. 开启开发人员模式
3. 点击“加载解压缩的扩展”
4. 选择解压后的目录

注意：Chrome/Edge 可能不允许直接安装 `.crx`，因此推荐分享 ZIP + “加载未打包扩展”。

协作者需要完整项目：

```text
dist/ZoomCodexInterpreter-full-v1.0.8.zip
```

## 共享更新进度

推荐把项目放到 GitHub。仓库自带 `CHANGELOG.md`、Git 标签和 GitHub Actions 发布配置。

### 推送到 GitHub

```bash
git remote add origin git@github.com:YOUR_NAME/zoom-codex-interpreter.git
git push -u origin main --tags
```

之后：

- 其他人可以 `git clone` 仓库并查看提交历史
- 每次版本更新使用一个 Git 标签，例如 `v1.0.8`
- 推送标签后，GitHub Actions 会自动创建 Release 并上传 ZIP

### 不使用 GitHub

也可以把自己的 Git 仓库导出成单个 bundle 文件：

```bash
./scripts/release.sh
```

会生成：

```text
dist/ZoomCodexInterpreter-v1.0.8.bundle
```

别人可以这样克隆：

```bash
git clone ZoomCodexInterpreter-v1.0.8.bundle zoom-codex-interpreter
```

以后你提交新版本后重新生成 bundle，对方执行 `git pull` 即可查看更新历史。

## 自动更新

商店发布详细步骤见 [STORE_PUBLISHING.md](STORE_PUBLISHING.md)。

扩展会定时检查 GitHub Releases，并在发现新版本时：

- 在扩展图标上显示 `NEW` 标记
- 在弹窗里显示新版本号
- 提供 GitHub Release 下载入口

注意：通过“加载未打包扩展”安装时，Chrome/Edge 不允许扩展静默替换自身文件。因此 GitHub Releases 提供的是“自动检查 + 提示更新 + 下载新版本”，用户仍需下载新版本并在扩展页面点击“重新加载”。

如果需要真正静默自动更新，需要发布到：

- Chrome Web Store
- Microsoft Edge Add-ons

发布后，浏览器会自动升级扩展，用户不需要手动重新加载。

## 打包发布

```bash
./scripts/release.sh
```

生成在 `dist/`：

- `ZoomCodexInterpreter-chrome-vX.Y.Z.zip`：Chrome 用户加载扩展
- `ZoomCodexInterpreter-edge-vX.Y.Z.zip`：Edge 用户加载扩展
- `ZoomCodexInterpreter-extension-vX.Y.Z.zip`：兼容旧命名的 Chrome 版
- `ZoomCodexInterpreter-full-vX.Y.Z.zip`：完整项目
- `ZoomCodexInterpreter-vX.Y.Z.bundle`：完整 Git 历史
- `SHA256SUMS`：文件校验

## 隐私说明

- 本地翻译模式：字幕文本在浏览器本地翻译，不会发送到本机服务或外部模型。
- AI 翻译模式：字幕文本会发送到本机 `127.0.0.1:8765` 翻译服务，再由你配置的 Codex 本地代理调用模型。请根据你的 `cc-switch`/Codex 代理后端判断数据是否会离开本机。

## 常见问题

### 找不到“加载已解压的扩展程序”

新版 Chrome 中文翻译是“加载未打包的扩展程序”。

### 端口 8765 已被占用

说明本地服务已经运行。可以先关闭旧终端，或检查：

```bash
lsof -nP -iTCP:8765 -sTCP:LISTEN
```

### 检测不到 Zoom 字幕

1. 确认 Zoom 实时字幕已打开
2. 点击扩展里的“重置字幕区”
3. 还不行就点击“选择字幕区域”手动选择
4. 最后点击“诊断字幕”查看 `counts` 和 `candidates`

### 字幕窗口太大

打开扩展弹窗，启用“紧凑字幕条”，并调小字幕宽度、字号和背景不透明度。
