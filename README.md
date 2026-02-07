# Gemini Projects Extension

A Chrome extension for `https://gemini.google.com` that adds local **Projects** and **Prompt Library** workflows.

## Features

- Organize chats into Projects in the left sidebar
- Add or remove chats from a project
- Create, edit, and delete projects (icon + color)
- Prompt Library entry in the composer area
- Search, create, edit, delete, and insert prompts quickly

## Tech Stack

- TypeScript
- Vite
- Chrome Extension Manifest V3

## Requirements

- Node.js 18+
- Chrome (or other Chromium-based browsers)

## Development

Install dependencies:

```bash
npm install
```

Build once:

```bash
npm run build
```

Watch build:

```bash
npm run dev
```

Type check:

```bash
npm run lint
```

## Load Extension Locally

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the `dist/` folder

## Build Release Zip

```bash
npm run build
tar -a -c -f gemini-project-extension.zip -C dist .
```

Share the generated `gemini-project-extension.zip`.

## Project Structure

- `src/background.ts`: background service worker
- `src/content/`: content scripts (UI injection, menus, prompts)
- `src/shared/`: shared types and storage helpers
- `public/manifest.json`: manifest template

## Privacy

- Data is stored locally in `chrome.storage`
- Core features do not require an external backend
- Prompts and projects are not proactively uploaded by this extension

## Notes

- This is an unofficial extension and is not affiliated with Google Gemini.
