# Projects for Gemini™: Projects and Prompt Manager

给 Gemini 添加本地 Projects 和 Prompt Library。

[English](README.md) | 简体中文

## 它是做什么的

Gemini Projects 可以在 Gemini 侧边栏里添加本地项目文件夹，帮你把不同主题、课程、客户、写作、研究或长期任务相关的聊天整理到一起，不用一直在一长串历史记录里找。

它还带有一个本地 Prompt Library，可以保存常用提示词，并在 Gemini 输入框中快速搜索和插入。

## 主要功能

- 在 Gemini 侧边栏创建本地 Projects
- 把已有聊天移动到 Project 中
- 从 Project 中移除聊天，但不删除原始 Gemini 聊天
- 当某个 Project 聊天已在手机或其他设备上从 Gemini 历史记录中删除时，会显示缺失状态
- 为 Project 选择图标和颜色
- 在紧凑的 Project 菜单中置顶、编辑或删除项目；置顶项目刷新后仍排在前面，取消置顶后恢复原来的排序位置
- 备份和恢复本地 Projects 与提示词数据
- 保存、搜索、编辑和复用常用提示词
- 数据保存在浏览器本地存储中

## 下载

请到 [GitHub Releases](https://github.com/linyushuo0818/Gemini-Folder-Extension/releases) 页面下载最新版 zip。

当前版本对应文件：

- `gemini-projects-2.0.6-webstore-*.zip`

## 手动安装

1. 从 Releases 下载 zip 文件。
2. 解压到本地文件夹。
3. 打开 `chrome://extensions`。
4. 开启 `Developer mode`。
5. 点击 `Load unpacked`。
6. 选择解压后包含 `manifest.json` 的文件夹。

Gemini Projects 主要面向 Chrome 和 Chromium 内核浏览器。

## 隐私

- Projects 和提示词使用 Chrome 扩展本地存储保存。
- 扩展不需要额外账号或后端服务。
- 扩展不会主动上传你的 Projects、提示词或聊天整理数据。
- Gemini 本身仍运行在 Google 网站中，Gemini 账号和服务行为以 Google 的政策为准。

## 构建与打包

依次运行 `npm ci`、`npm run lint` 和 `npm run package:store`。打包使用 Node.js，macOS/Linux 需要系统 `zip` 工具，Windows 使用 PowerShell。发布 ZIP 只包含清单引用的运行脚本和图标，不包含 source map、未使用的历史脚本、个人数据或开发笔记。生成文件保存在 `release/`，不提交到源码仓库。

## 当前版本

### v2.0.6

- 修复新版 Gemini 首次渲染时，Prompt Library 入口被误插到 Chat / Task 切换区的问题：优先识别输入工具栏中的 Upload & tools，并排除模式切换按钮。
- 翻新 Prompt Library 与编辑器：亮暗中性色面板、统一加重的衬线主标题、等距留白与较大的同心圆角、完整的两行预览、明确的新建按钮、键盘焦点与保存反馈。同级的新建／编辑提示词及新建／编辑项目弹窗共用主标题样式。
- 入口使用随当前主题变化的原生 hover 圆形背景，编辑按钮增加轻微的底色与边框。
- 搜索结果或窗口尺寸变化时，面板保持在可见视口内。

### v2.0.4

- 新增持久化项目置顶，并为紧凑项目菜单加入操作图标。
- 聊天操作菜单和项目列表按文字自适应宽度，限制在窗口内，大列表支持滚动。
- 修复回复折叠按钮重复写入 DOM 导致的空闲扫描循环。

### v2.0.3

- 扩展更名为 `Gemini Folders — Projects & Prompt Library`。
- 将与商店一致的 Conversation Index 图标接入 Chrome 工具栏和扩展管理页面。

### v2.0.2

- 修复 Projects 错误挂载在 Gemini 原生导航外侧导致的侧栏抽搐。
- 适配 Gemini 当前 Chat 与 Spark 侧栏结构，改进聊天记录区域识别。
- 在 Recents 折叠或账号没有聊天记录时仍保持 Projects 可见。
- 修复从 Spark 切回 Chat 后 Projects 消失的问题。
- 修复回复折叠按钮重复，以及项目/聊天菜单打开后立即关闭的问题。

### v2.0.1

- 将网站访问范围收窄为仅 Gemini，以符合 Chrome Web Store 的最小权限要求。
- 从扩展清单中移除未使用的 ChatGPT 与旧版 ChatGPT 域名权限。

### v2.0.0

- 修复 Gemini 侧边栏更新后 Projects 无法正常使用的问题。
- 优化 New Project 窗口，支持更清晰的图标和颜色选择。
- 改善在手机或其他设备删除 Gemini 聊天后的处理方式。
- 对已缺失的 Project 聊天显示缺失状态，而不是打乱项目列表。
- 优化 Project 和聊天菜单，用于移动、移除、编辑和删除。
- 添加本地数据备份和恢复入口。
- 优化 Prompt Library 的布局和控件。

## 说明

Gemini Projects 是非官方扩展，与 Google 或 Gemini 官方无关。

## 本地测试流程

先构建，再加载包含生成的 `manifest.json` 的目录。本开发工作区将构建结果同步到相邻的 `chrome/` 文件夹；测试前停用商店版，仅启用该本地版，避免双重注入。两者扩展 ID 不同，本地存储相互独立；停用商店版会保留其原有数据。完成本地验证后，再运行 `npm run package:store` 生成独立上传 ZIP。

Prompt Library 的颜色、文字层级和表单结构参考 [MCP Apps for Claude UI Kit](https://www.figma.com/community/file/1597641111449594397/mcp-apps-for-claude)：正文 14px、输入框高 40px、按钮高 36px，文本域内边距 16px；表单使用 Primary 背景，并区分容器、控件和次级按钮的边框强度。Anthropic Sans Text 和 JetBrains Mono 不可用时使用系统回退字体，扩展不附带字体文件。Prompt Library、新建／编辑提示词和新建／编辑项目的同级主标题共用 24px、字重 600 的 Iowan Old Style、Palatino 或 Georgia 等本机衬线字体。统一衬线主标题、28px 面板、16px 列表行和 12px 操作控件圆角是本项目的视觉调整，并非 UI Kit 默认桌面组件规格。
