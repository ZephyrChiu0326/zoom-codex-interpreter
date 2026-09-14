# Zoom Codex Interpreter

Zoom 网页版实时字幕翻译工具：读取 Zoom 的实时字幕，调用本机 Codex 模型代理翻译，并在 Zoom 页面显示紧凑字幕条。

## 功能

- Zoom 网页版实时字幕监听
- 支持 Zoom 会议 iframe
- 本机 Codex 模型代理翻译
- 自然口语 / 简洁短句 / 逐字准确三种字幕风格
- 会议背景与术语表
- 紧凑字幕条，最多两行译文，点击穿透
- 可调字幕字号、宽度、背景不透明度
- 可选朗读译文
- 字幕区域手动选择与自动检测

## 工作原理

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

扩展不依赖 ChatGPT 登录版 Chrome 插件，可以使用当前 Codex 的 API Key + 本地模型代理。

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

- Codex / ChatGPT 桌面程序正在运行
- 本机 Codex 模型代理可访问，默认 `http://127.0.0.1:15721/v1`
- `~/.codex/config.toml` 中有 `model` 和 `model_providers.custom.base_url`
- `~/.codex/auth.json` 中有 `OPENAI_API_KEY`，或环境变量中有 `OPENAI_API_KEY`
- Python 3.11+
- Chrome 116+

## 启动本地翻译服务

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

```text
dist/ZoomCodexInterpreter-extension-v1.0.5.zip
```

对方解压后：

1. 打开 `chrome://extensions/`
2. 开启开发者模式
3. 点击“加载未打包的扩展程序”
4. 选择解压后的目录

注意：Chrome 可能不允许直接安装 `.crx`，因此推荐分享 ZIP + “加载未打包扩展”。

协作者需要完整项目：

```text
dist/ZoomCodexInterpreter-full-v1.0.5.zip
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
- 每次版本更新使用一个 Git 标签，例如 `v1.0.5`
- 推送标签后，GitHub Actions 会自动创建 Release 并上传 ZIP

### 不使用 GitHub

也可以把自己的 Git 仓库导出成单个 bundle 文件：

```bash
./scripts/release.sh
```

会生成：

```text
dist/ZoomCodexInterpreter-v1.0.5.bundle
```

别人可以这样克隆：

```bash
git clone ZoomCodexInterpreter-v1.0.5.bundle zoom-codex-interpreter
```

以后你提交新版本后重新生成 bundle，对方执行 `git pull` 即可查看更新历史。

## 打包发布

```bash
./scripts/release.sh
```

生成在 `dist/`：

- `ZoomCodexInterpreter-extension-vX.Y.Z.zip`：普通用户加载扩展
- `ZoomCodexInterpreter-full-vX.Y.Z.zip`：完整项目
- `ZoomCodexInterpreter-vX.Y.Z.bundle`：完整 Git 历史
- `SHA256SUMS`：文件校验

## 隐私说明

Zoom 字幕文本会发送到本机 `127.0.0.1:8765` 翻译服务，再由你配置的 Codex 本地代理调用模型。请根据你的 `cc-switch`/Codex 代理后端判断数据是否会离开本机；扩展本身不会把字幕发送到其他第三方服务器。

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
