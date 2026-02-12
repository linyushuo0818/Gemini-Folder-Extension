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
- Firefox

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

Each GitHub Release publishes both packages:

- `gemini-project-extension-store.zip` (Chrome/Chromium store upload)
- `gemini-project-extension-firefox.zip` (Firefox AMO upload)

To create a release package locally:

- `npm run package:store`
- `npm run package:firefox`

## Recent UI Updates

- `0.1.52` (2026-02-12)
- Create Project modal title switched to bold sans-serif style.
- Template chips now share the same hover feedback language as icon options.
- Primary Create button changed to warm orange and pill radius.

- `0.1.50` (2026-02-12)
- Prompt picker radius tokens aligned to `20 / 14 / 8 / 999`.
- Unified core interaction transitions to `.18s ease`.
- Picker and modal open/close animations switched from scale-based to `opacity + translateY`.
- Folding toggle button styles now use CSS variables for light/dark themes, reducing hard-coded colors.
