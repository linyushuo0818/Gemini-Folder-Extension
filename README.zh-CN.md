# Gemini Projects Extension

给 Gemini 增加本地项目文件夹和提示词库。

[English](README.md) | 简体中文

## 它是做什么的

Gemini Projects 是一个用于 `https://gemini.google.com` 的 Chrome 扩展。它会在 Gemini 侧边栏里增加一个轻量的 Projects 工作流，让你可以把相关聊天整理到本地项目里，不用等官方原生项目功能。

扩展也包含一个本地 Prompt Library，方便保存、搜索和复用常用提示词。

## 功能

- 为 Gemini 聊天创建本地项目
- 从侧边栏把已有聊天加入项目
- 将聊天移出项目，但不删除原聊天
- 为项目选择图标和颜色
- 编辑、删除、备份和恢复项目数据
- 在本地提示词库中保存常用 prompts
- 快速搜索、编辑、删除和插入已保存 prompts
- 数据保存在浏览器本地存储中

## 下载

最新打包版本可以在 [GitHub Releases](https://github.com/linyushuo0818/Gemini-Folder-Extension/releases) 页面下载。

v0.1.67 对应文件：

- `Gemini-Projects-0.1.67-webstore-20260615-142156.zip`

## 手动安装

1. 从 Releases 下载 zip 文件。
2. 解压到本地文件夹。
3. 打开 `chrome://extensions`。
4. 开启 `Developer mode`。
5. 点击 `Load unpacked`。
6. 选择解压后包含 `manifest.json` 的文件夹。

目前主要支持 Chrome 和其他 Chromium 内核浏览器。

## Chrome Web Store

每个 Release 附带的 zip 都是 Chrome Web Store 可上传结构，`manifest.json` 位于压缩包根目录，可以直接上传到 Chrome Web Store 开发者后台。

## 开发

环境要求：

- Node.js 18+
- npm

安装依赖：

```bash
npm install
```

构建扩展：

```bash
npm run build
```

生成商店上传包：

```powershell
npm run package:store
```

构建产物会输出到 `dist/`，发布包会输出到 `release/`。

## 隐私

- Projects 和 prompts 使用 `chrome.storage` 保存在本地。
- 扩展核心功能不依赖额外后端服务。
- 扩展不会主动上传你的项目、提示词或聊天整理数据。
- Gemini 本身仍运行在 Google 网站上，因此 Gemini 账号和服务相关行为仍以 Google 的政策为准。

## 当前版本

### v0.1.67

- 修复 Gemini UI 更新后 Project 侧边栏失效的问题。
- 重新处理新版 Gemini 页面里的侧边栏识别和交互逻辑。
- 增加 page bridge，让点击和 hover 行为更稳定。
- 重做 New Project 创建流程和图标选择器。
- 更新 Manifest V3 打包流程，生成可上传 Chrome Web Store 的压缩包。

## 说明

这是一个非官方扩展，与 Google 或 Gemini 官方无关。
