# Projects for Gemini™: Projects and Prompt Manager

给 Gemini 添加本地 Projects 和 Prompt Library。

[English](README.md) | 简体中文

## 它是做什么的

Gemini Projects 可以在 Gemini 侧边栏里添加本地项目文件夹，帮你把不同主题、课程、客户、写作、研究或长期任务相关的聊天整理到一起，不用一直在一长串历史记录里找。

它还带有一个本地 Prompt Library，可以保存常用提示词，并在 Gemini 输入框中快速搜索和插入。

## 主要功能

- 在 Gemini 侧边栏创建项目文件夹（Projects）
- 把已有聊天移动到 Project 中（支持菜单与拖拽整理）
- 从 Project 中移除聊天，但不删除原始 Gemini 聊天
- 当某个 Project 聊天已在手机或其他设备上从 Gemini 历史记录中删除时，会显示缺失状态
- 为 Project 选择图标，使用多彩配色或预设色
- 为每个项目单独选择线条（Outline）、实心（Solid）或双色（Duotone）图标
- 在紧凑的 Project 菜单中置顶、编辑或删除项目；置顶项目刷新后仍排在前面，取消置顶后恢复原来的排序位置
- 支持在 Projects 标题栏菜单中按需连接 **Google Drive**，在多设备与不同浏览器（Chrome、Edge、Brave、Aside、Arc 等）间同步 Projects、已归属聊天与 Prompt Library；数据仅保存在你的 Google Drive 隐藏应用数据目录（`appDataFolder`）。默认关闭，不连接即纯本地使用
- 备份和恢复本地 Projects 与提示词 JSON 文件
- 保存、搜索、编辑和复用常用提示词
- 本地优先存储：所有数据默认仅保存在浏览器本地

## Google Drive 同步与备份说明

Google Drive 同步**默认关闭**——如果不连接，扩展完全纯本地运行，不会发起任何同步网络请求。

### 如何开启跨浏览器同步

1. 在 Gemini 侧边栏 **Projects** 标题右侧点击 **`⋮`** 按钮。
2. 点击 **Google Drive · Connect** 并登录你的 Google 账号完成授权。
3. 在其他需要同步的电脑或浏览器（Chrome、Edge、Brave、Aside、Arc 等）上同样点击连接同一 Google 账号即可互通。

### 同步与本地备份机制

- **同步范围**：Projects、已归属聊天和 Prompt Library 通过你 Google Drive 隐藏应用数据目录（`appDataFolder`）中的单个文件 `gemini-projects-sync-v1.json` 同步；扩展无法看到或访问你的普通网盘文件。
- **同步时机**：本地编辑会立即同步；前台打开 Gemini 时约每 15 秒自动轻量检查远端变化（切回标签页或断网重连也会自动触发），也可随时点 **Sync now** 立即同步。
- **随时断开**：点击 **Disconnect** 会清除本地授权令牌并停止同步，不会删除本地或 Google Drive 里的已有数据。
- **本地 Backup / Restore**：**Backup** 会将本地数据导出为电脑上的 `.json` 文件（不包含任何授权令牌）；**Restore** 从本地 `.json` 校验恢复，若当前已连接 Google Drive，恢复结果会自动同步覆盖到云端及其他已连接设备。

## 安装

### Chrome 应用商店（推荐）

直接前往 [Chrome Web Store](https://chromewebstore.google.com/detail/projects-for-gemini-proje/okjjhdoncledadkchbbbcddpopbbgbic) 一键安装。

### 手动安装（GitHub Releases）

已发布的最新版 ZIP 可在 [GitHub Releases](https://github.com/linyushuo0818/Gemini-Folder-Extension/releases/latest) 下载。如需安装当前源码版本，请按下文步骤构建 ZIP。

1. 从 Releases 下载 zip 文件。
2. 解压到本地文件夹。
3. 打开 `chrome://extensions`。
4. 开启 `Developer mode`。
5. 点击 `Load unpacked`。
6. 选择解压后包含 `manifest.json` 的文件夹。

Gemini Projects 主要面向 Chrome 和 Chromium 内核浏览器。

## 隐私

- Projects 和提示词默认仅保存在浏览器本地扩展存储（`chrome.storage.local`）中；未连接 Google Drive 时不会发起任何云同步网络请求。
- 可选的 **Google Drive 同步**（默认关闭，需手动授权）仅请求最小权限范围 `drive.appdata`，通过 Google OAuth 将单个同步文件（`gemini-projects-sync-v1.json`）保存在你自己的 Google Drive 隐藏应用数据目录（`appDataFolder`）中。连接时，扩展会通过同一 `drive.appdata` 权限下的 Google Drive `about` 接口读取你的 Google 账号邮箱（不请求额外权限），并**仅保存在本地** `gp_drive_auth_v1` 中作为 OAuth `login_hint`，以保证多账号环境下的静默续签可靠性；该邮箱绝不会写入 Drive 同步数据或导出备份。扩展无法访问你的普通网盘文件，断开连接会清除本地授权令牌和 `login_hint`，不会删除本地或云端数据。
- 未归属的普通聊天记录、侧边栏折叠状态、提示词使用统计以及 Google Drive 授权令牌与同步元数据均不会写入 **Google Drive 同步**内容；本地 JSON 备份会导出本地 Projects 与 Prompts 数据（包含本地偏好设置与使用统计），同时严格排除授权令牌和同步元数据。
- 扩展不连接任何第三方后端服务；启用 Google Drive 同步时数据直接在你的浏览器与 Google 官方接口间传输。
- 扩展对从 Google API 接收信息的使用与传输遵守《[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)》（包括 Limited Use 有限使用要求）；Google Drive 存储与 Gemini 网站上的账号行为均以 Google 的相关政策为准。

## 构建与打包

依次运行 `npm ci`、`npm run lint` 和 `npm run package:store`。打包使用 Node.js，macOS/Linux 需要系统 `zip` 工具，Windows 使用 PowerShell。发布 ZIP 只包含清单引用的运行脚本和图标，不包含 source map、未使用的历史脚本、个人数据或开发笔记。生成文件保存在 `release/`，不提交到源码仓库。

## 当前版本

### v3.0.0

- 新增可选的 **Google Drive 同步**（基于私密隐藏目录 `appDataFolder`），支持在 Chrome、Edge、Brave、Aside、Arc 等多设备与跨浏览器之间同步 Projects、已归属聊天与 Prompt Library；默认纯本地运行，按需开启。
- 将 Google Drive 控制项（连接、立即同步、重连、断开）、点击展开的行内 `?` 说明与本地 Backup / Restore 统一收敛至 Projects 标题栏 `⋮` 菜单。
- 加固多端同步可靠性：支持实体级冲突合并与 30 天删除墓碑、内置默认提示词固定 ID 与历史重复项自动去重、多账号静默续签与账号绑定校验、本地冷启动非阻塞读取、请求超时/瞬时重试与离线退避自愈。
- 优化本地恢复（Restore）：原子写入本地状态与删除墓碑，并在已连接 Google Drive 时联动同步至其他设备。
- 修复从 **Move to Project** 子菜单移入聊天后，Gemini 原生菜单短暂残留在页面上的问题。

### v2.0.11

- 将线条（Outline）与实心（Solid）项目图标统一替换为 Kubai Icons（`icons-line/`，默认 `1.75` 描边宽度），使三种图标风格保持一致的视觉语言与比例。
- 同步将扩展界面控件图标（提示词库入口与编辑按钮、侧边栏与聊天菜单、备份/恢复按钮及长回复折叠箭头等）全部统一替换为 Kubai Icons。
- 为所有含蒙版/裁切路径的 Kubai 图标补充实例级 ID 以避免同页渲染冲突，并同步更新第三方许可与致谢说明。

### v2.0.10

- 统一项目弹窗、Prompt Library、提示词编辑器与右键菜单的胶囊曲率和同心外圆角比例。
- 用柔和的明暗层级与暖石底托替代生硬外圈，全面优化输入框聚焦态、色盘与图标选中态以及图标风格切换开关的对比度。
- 打磨多项交互细节：修复关闭提示词编辑器返回 Prompt Library 时的过渡衔接，新增编辑器 `Enter` 跳焦与 `Cmd/Ctrl+Enter` 快捷保存、列表底部滚动渐隐、侧边栏项目对话计数以及长回复折叠箭头动画。

### v2.0.9

- 新增双色图标，并支持为每个项目独立保存图标样式。
- 新建项目默认使用多彩图标配色，也可选择原有预设色。

### v2.0.8

- 新增线条与实心项目图标，颜色选择的圆环跟随色点。
- 支持拖拽整理聊天，并完善项目菜单的键盘操作。
- 更新提示词库快捷键，插入时保留草稿和有效选区。
- 改进跨标签页同步，备份恢复前完整校验文件。

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

## 致谢

线条、实心、双色项目图标以及界面控件图标均来自 Kubai（@kubai087）的 Kubai Icons，采用 MIT 许可。[官网](https://icons.kubai.design/) · [GitHub](https://github.com/kubai087/kubai-icons) · [第三方许可](THIRD_PARTY_NOTICES.md)
