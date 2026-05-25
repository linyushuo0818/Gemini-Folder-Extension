# Gemini Projects Extension

A browser extension for `https://gemini.google.com` that adds local **Projects** and **Prompt Library** workflows.

English | [中文](README.zh-CN.md)

## Features

- Organize chats into Projects in the left sidebar
- Add or remove chats from a project
- Create, edit, and delete projects (icon + color)
- Prompt Library entry in the composer area
- Search, create, edit, delete, and insert prompts quickly
- Backup and restore local data via JSON

## Requirements

- Node.js 18+

## Supported Browsers

- Chrome (or other Chromium-based browsers)

## Load Extension Locally

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Unzip to local disk, then select the extracted folder

## Privacy

- Data is stored locally in `chrome.storage`
- Core features do not require an external backend
- Prompts and projects are not proactively uploaded by this extension

## Release Assets

Each GitHub Release publishes:

- `gemini-project-extension-store.zip` (Chrome/Chromium store upload)

To create a release package locally:

- `npm run package:store`

## Recent UI Updates

- `0.1.55` (2026-05-25)
  - New two-pass build pipeline (`build.mjs`): content script → IIFE, background → ES module.
  - Merged `gemini-response-fold-lite.js` into the main content bundle.
  - Added projects interaction bridge for shadow DOM hover/click handling.
  - Improved prompt picker layout and injector anchor detection.
  - Refined message timestamps and context-menu enhancer.

- `0.1.53` (2026-02-12)
  - Added per-message time labels under user prompts in both Gemini and ChatGPT views.

- `0.1.52` (2026-02-12)
  - Create Project modal title switched to bold sans-serif style.
  - Template chips now share the same hover feedback language as icon options.
  - Primary Create button changed to warm orange and pill radius.
