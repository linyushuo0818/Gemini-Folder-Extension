# Gemini Projects Extension

Add local project folders and a prompt library to Gemini.

English | [简体中文](README.zh-CN.md)

## What It Does

Gemini Projects is a Chrome extension for `https://gemini.google.com`. It adds a lightweight project workflow to the Gemini sidebar, so you can group related chats locally without waiting for a native project feature.

It also includes a local Prompt Library for saving and reusing prompts from the composer.

## Features

- Create local projects for Gemini chats
- Add existing chats to a project from the sidebar
- Remove chats from a project without deleting the chat itself
- Choose project icons and colors
- Edit, delete, back up, and restore project data
- Save reusable prompts in a local Prompt Library
- Search, edit, delete, and insert saved prompts quickly
- Keep extension data in browser-local storage

## Download

The latest packaged extension is available from the [GitHub Releases](https://github.com/linyushuo0818/Gemini-Folder-Extension/releases) page.

For v0.1.67, download:

- `Gemini-Projects-0.1.67-webstore-20260615-142156.zip`

## Install Manually

1. Download the zip file from Releases.
2. Extract it to a local folder.
3. Open `chrome://extensions`.
4. Enable `Developer mode`.
5. Click `Load unpacked`.
6. Select the extracted folder that contains `manifest.json`.

The extension currently targets Chrome and Chromium-based browsers.

## Chrome Web Store

This repository also produces a Web Store-ready package. The zip attached to each release is structured with `manifest.json` at the archive root, so it can be uploaded directly to the Chrome Web Store developer dashboard.

## Development

Requirements:

- Node.js 18+
- npm

Install dependencies:

```bash
npm install
```

Build the extension:

```bash
npm run build
```

Create a store package:

```powershell
npm run package:store
```

Build output is written to `dist/`. Release packages are written under `release/`.

## Privacy

- Projects and prompts are stored locally with `chrome.storage`.
- The extension does not require a separate backend.
- The extension does not proactively upload your projects, prompts, or chat organization data.
- Gemini itself still runs on Google's website, so Gemini's own account and service behavior are governed by Google's policies.

## Current Version

### v0.1.67

- Restored project sidebar support after Gemini's recent UI changes.
- Reworked sidebar detection and interaction handling for the updated Gemini layout.
- Added a page bridge for more reliable click and hover behavior.
- Rebuilt the New Project flow and icon picker.
- Updated the extension package to Manifest V3 with Chrome store-ready output.

## Notes

This is an unofficial extension and is not affiliated with Google or Gemini.
