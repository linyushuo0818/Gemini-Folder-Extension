# Gemini Projects Extension

A Chrome extension for `https://gemini.google.com` that adds local **Projects** and **Prompt Library** workflows.

## Features

- Organize chats into Projects in the left sidebar
- Add or remove chats from a project
- Create, edit, and delete projects (icon + color)
- Prompt Library entry in the composer area
- Search, create, edit, delete, and insert prompts quickly
- Backup and restore local Projects + Prompt Library data via JSON file

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
npm run package:store
```

Output path:

- `release/store-upload-<timestamp>/unpacked` (for Load unpacked)
- `release/store-upload-<timestamp>/gemini-project-extension-store.zip` (for Web Store upload)

## Project Structure

- `src/background.ts`: background service worker
- `src/content/`: content scripts (UI injection, menus, prompts)
- `src/shared/`: shared types and storage helpers
- `public/manifest.json`: manifest template
- `scripts/package-store.ps1`: one-command store packaging

## Privacy

- Data is stored locally in `chrome.storage`
- Core features do not require an external backend
- Prompts and projects are not proactively uploaded by this extension

## Notes

- This is an unofficial extension and is not affiliated with Google Gemini.

## Gen-5 Strategy Cockpit (Streamlit MVP)

This repository also includes a standalone strategy review dashboard:

- App entry: `cockpit_app.py`
- Python deps: `cockpit_requirements.txt`

Install:

```bash
python -m pip install -r cockpit_requirements.txt
```

Run:

```bash
python -m streamlit run cockpit_app.py -- --runs-root "E:\OneDrive\Desktop"
```

`--runs-root` should point to a folder containing one or more run sub-folders
(for example `wudai_outputs`) with the generated CSV files.

### Cockpit theme note

- The cockpit now uses a warm neutral theme with higher contrast HUD cards.
- If metric text appears too light after updates, clear browser cache and refresh Streamlit page.
