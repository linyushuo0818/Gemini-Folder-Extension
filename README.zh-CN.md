# Gemini Projects Extension

面向 `https://gemini.google.com` 的浏览器扩展，提供本地 **Projects** 和 **Prompt Library** 工作流。

[English](README.md) | 中文

## 功能

- 在左侧边栏按项目管理聊天
- 将聊天加入或移出项目
- 创建、编辑、删除项目（图标 + 颜色）
- 在输入区提供 Prompt Library 按钮
- 快速搜索、创建、编辑、删除、插入 prompts
- 支持通过 JSON 备份/恢复本地数据

## 技术栈

- TypeScript
- Vite
- Chrome Extension Manifest V3

## 环境要求

- Node.js 18+
- Chrome（或其他 Chromium 内核浏览器）

## 开发命令

安装依赖：

```bash
npm install
```

构建：

```bash
npm run build
```

监听构建：

```bash
npm run dev
```

类型检查：

```bash
npm run lint
```

## 本地加载扩展

1. 打开 `chrome://extensions`
2. 打开 `Developer mode`
3. 点击 `Load unpacked`
4. 二选一：
5. 本地开发构建：选择 `dist/` 目录
6. 从 Release 下载 ZIP：先解压，再选择解压后的目录（目录内应直接包含 `manifest.json`）

## 打包（Chrome 商店/分享）

```bash
npm run package:store
```

输出目录：

- `release/store-upload-<timestamp>/unpacked`
- `release/store-upload-<timestamp>/gemini-project-extension-store.zip`

## Build Firefox Zip

```bash
npm run package:firefox
```

输出目录：

- `release/firefox-upload-<timestamp>/unpacked`（Firefox 临时本地测试）
- `release/firefox-upload-<timestamp>/gemini-project-extension-firefox.zip`（AMO 上传/测试）

## 隐私

- 数据保存在本地 `chrome.storage`
- 核心功能不依赖外部后端
- 扩展不会主动上传 prompts 和 projects
