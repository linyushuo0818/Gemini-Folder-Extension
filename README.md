# Gemini Folders — Projects & Prompt Library

Add local Projects and a Prompt Library to Gemini.

English | [简体中文](README.zh-CN.md)

## What It Does

Gemini Projects helps you organize Gemini chats into local project folders in the sidebar. It is useful when you work across topics, clients, classes, writing projects, research threads, or anything else that needs a cleaner history than one long chat list.

It also includes a local Prompt Library, so you can save prompts you reuse often and insert them quickly while writing in Gemini.

## Highlights

- Create local Projects in the Gemini sidebar
- Move existing chats into Projects
- Remove a chat from a Project without deleting the original Gemini chat
- See when a Project chat is missing because it was deleted from Gemini history on another device
- Choose Project icons and colors
- Use the compact Project menu to pin, edit, or delete a Project. Pinned Projects stay above other Projects after reload; unpinning restores their original order.
- Back up and restore your local Projects and prompts
- Save, search, edit, and reuse prompts from a local Prompt Library
- Keep your organization data in browser-local storage

## Download

Download the latest zip from the [GitHub Releases](https://github.com/linyushuo0818/Gemini-Folder-Extension/releases) page.

For the current release, use:

- `gemini-projects-2.0.4-webstore-*.zip`

## Install Manually

1. Download the zip file from Releases.
2. Extract it to a local folder.
3. Open `chrome://extensions`.
4. Enable `Developer mode`.
5. Click `Load unpacked`.
6. Select the extracted folder that contains `manifest.json`.

Gemini Projects is designed for Chrome and Chromium-based browsers.

## Privacy

- Projects and prompts are stored locally with Chrome extension storage.
- The extension does not require a separate account or backend.
- The extension does not proactively upload your Projects, prompts, or chat organization data.
- Gemini itself still runs on Google's website, so Gemini account activity is governed by Google's own policies.

## Build and package

Run `npm ci`, `npm run lint`, then `npm run package:store`. Packaging uses Node.js and the system `zip` utility on macOS/Linux, or PowerShell on Windows. The release ZIP contains only manifest-referenced runtime scripts and icons; source maps, unused legacy scripts, local data and development notes are excluded. Generated files stay under `release/` and are not committed.

## Current Version

### v2.0.4

- Added persistent Project pinning and compact Project menus with action icons.
- Made chat action menus and Project destinations fit their labels, with viewport bounds and scrolling for large lists.
- Fixed an idle response-folding scan loop caused by repeated DOM writes.

### v2.0.3

- Renamed the extension to `Gemini Folders — Projects & Prompt Library`.
- Added the Conversation Index icon to the Chrome toolbar and extension management page, matching the store listing.

### v2.0.2

- Fixed sidebar jitter caused by Projects being mounted beside Gemini's native navigation.
- Updated chat-history detection for Gemini's current Chat and Spark sidebar layout.
- Kept Projects visible when Recents is collapsed or the account has no chat history.
- Restored Projects reliably after switching from Spark back to Chat.
- Fixed duplicated response-fold controls and Project/chat menus that closed immediately.

### v2.0.1

- Narrowed website access to Gemini only for Chrome Web Store compliance.
- Removed unused ChatGPT and legacy ChatGPT host access from the extension manifest.

### v2.0.0

- Restores Project support for Gemini's updated sidebar.
- Improves the New Project window with icon and color selection.
- Adds clearer handling for chats deleted from Gemini history on another device.
- Marks missing Project chats instead of breaking the Project list.
- Improves Project and chat menus for moving, removing, editing, and deleting items.
- Adds backup and restore controls for local data.
- Polishes the Prompt Library layout and controls.

## Notes

Gemini Projects is an unofficial extension and is not affiliated with Google or Gemini.
