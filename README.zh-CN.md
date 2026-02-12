# Gemini Projects Extension

面向 `https://gemini.google.com` 的浏览器扩展，提供本地 **Projects** 与 **Prompt Library** 工作流。

[English](README.md) | 中文

## 功能

- 在左侧边栏按项目管理聊天
- 将聊天加入或移出项目
- 创建、编辑、删除项目（图标 + 颜色）
- 在输入区提供 Prompt Library 按钮
- 快速搜索、创建、编辑、删除、插入 prompts
- 支持通过 JSON 备份/恢复本地数据

## 支持浏览器

- Chrome（或其他 Chromium 内核浏览器）
- Firefox（已支持）

## 本地加载扩展

1. 打开 `chrome://extensions`
2. 打开 `Developer mode`
3. 点击 `Load unpacked`
4. 先解压到本地，再选择解压后的文件夹

## 隐私

- 数据保存在本地 `chrome.storage`
- 核心功能不依赖外部后端
- 扩展不会主动上传 prompts 和 projects
