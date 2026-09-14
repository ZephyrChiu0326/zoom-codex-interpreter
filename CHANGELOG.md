# Changelog

## v1.0.10

- 将 Google Cloud Translation 设为自动回退首位
- 新增 server 网络代理配置，支持通过本机代理访问 Google API
- 完善 Google Cloud Translation API Key 配置说明
- 未配置 Google Key 时自动回退到下一个可用服务

## v1.0.9

- 新增 DeepL 专业翻译接入
- 新增 Microsoft Translator 接入
- 新增 Google Cloud Translation 接入
- 新增 LibreTranslate 接入
- 支持按顺序自动回退到下一个翻译服务
- 扩展弹窗新增 AI / 云翻译服务选择
- 本地 config.json 保存 API Key，不进入 Git 仓库

## v1.0.8

- 新增 GitHub Release 自动更新检查
- 发现新版本时扩展图标显示 NEW 标记
- 扩展弹窗显示新版本号和下载入口
- 支持定时检查 GitHub Releases

## v1.0.7

- 新增本地翻译 / AI 翻译双引擎
- 默认自动模式：本地翻译优先，不可用时自动回退到 AI
- 支持 Chrome 内置 Translator API
- 本地翻译模式不需要 Codex、API Key 或 server.py
- 更新 Chrome / Edge 双版本发布包

## v1.0.6

- 新增 Microsoft Edge 兼容扩展包
- 新增 Chrome / Edge 双浏览器发布文件
- 新增扩展图标
- 增加 Edge 安装与分享说明

## v1.0.5

- 新增紧凑字幕条模式
- 紧凑模式最多显示两行译文
- 字幕条支持点击穿透
- 新增字幕宽度、背景不透明度、字号设置
- 默认启用紧凑模式

## v1.0.4

- 新增字幕风格：自然口语、简洁短句、逐字准确
- 新增会议背景/领域设置
- 优化字幕提示词和上下文一致性
- 减少重复字幕

## v1.0.3

- 增加 Zoom 会议 iframe 字幕转发
- 主页面统一显示翻译悬浮窗
- 增加 iframe 诊断信息
- 改进 Zoom 字幕选择器

## v1.0.2

- 增加术语表和会议上下文
- 优化字幕翻译提示词
- 降低翻译随机性，提升术语一致性

## v1.0.1

- 增加 Shadow DOM 扫描
- 增加 Zoom 专用字幕选择器
- 增加字幕诊断功能

## v1.0.0

- 初始版本
- Zoom 网页实时字幕读取
- 本机 Codex 模型代理翻译
- 底部翻译悬浮窗
