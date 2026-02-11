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
- Firefox: in development

## Load Extension Locally

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Unzip to local disk, then select the extracted folder

## Privacy

- Data is stored locally in `chrome.storage`
- Core features do not require an external backend
- Prompts and projects are not proactively uploaded by this extension
