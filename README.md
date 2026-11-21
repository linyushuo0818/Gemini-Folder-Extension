# Projects for Gemini™: Projects and Prompt Manager

Add local project folders and a Prompt Library to Gemini.

English | [简体中文](README.zh-CN.md)

## What It Does

Gemini Projects adds project folders to the Gemini sidebar. Group chats by topic, class, client, writing project, or research so you can find related conversations in one place.

The built-in Prompt Library lets you save prompts you use often, then search for and insert them directly in Gemini's message box.

## Key Features

- Create local projects in the Gemini sidebar
- Move existing chats into projects
- Remove chats from a project while keeping them in Gemini
- See when a project chat is missing because it was deleted from Gemini history on another device
- Pick a project icon and choose a multicolor palette or a preset color
- Set each project's icon style to Outline, Solid, or Duotone
- Pin, edit, or delete projects from the project menu. Pinned projects stay at the top after a refresh. Unpin a project to return it to its original position.
- Back up and restore projects and prompts
- Save, search, edit, and reuse prompts in the Prompt Library
- Keep project and prompt data in your browser's local storage

## Download

Download the latest available ZIP from [GitHub Releases](https://github.com/linyushuo0818/Gemini-Folder-Extension/releases/latest). To install the current source version, build a ZIP using the steps below.

## Manual Installation

1. Download the ZIP from GitHub Releases.
2. Extract it to a local folder.
3. Open `chrome://extensions`.
4. Turn on **Developer mode**.
5. Click **Load unpacked**.
6. Select the extracted folder containing `manifest.json`.

Gemini Projects is built for Chrome and other Chromium-based browsers.

## Privacy

- Projects and prompts use Chrome's local extension storage.
- The extension uses your existing Gemini session and runs entirely in your browser.
- Your projects, prompts, and chat organization data stay on your device.
- Google's policies govern your Gemini account and activity on the Gemini website.

## Build and Package

Run `npm ci`, `npm run lint`, and `npm run package:store` in that order. Packaging uses Node.js and the system `zip` utility on macOS and Linux, or PowerShell on Windows. The ZIP contains only the runtime files listed in the manifest, keeping source maps, unused legacy scripts, personal data, and development notes outside the archive. Generated files stay in `release/`, outside version control.

## Changelog

### v2.0.9

- Added Duotone icons and let each project save its own icon style.
- Made the multicolor palette the default for new projects. Preset colors are still available.

### v2.0.8

- Added Outline and Solid icons. The selection ring now matches the chosen color swatch.
- Added drag-and-drop for chats and improved keyboard navigation in project menus.
- Updated Prompt Library shortcuts and preserved drafts and active selections when inserting a prompt.
- Improved syncing across tabs and added full validation before restoring a backup.

### v2.0.6

- Fixed the Prompt Library button appearing in Gemini's Chat / Task switch on initial load. The extension now looks for **Upload & tools** and skips the mode switch.
- Updated the Prompt Library and its editor with neutral light and dark surfaces, consistent serif headings, larger concentric corner radii, and even spacing around controls. Added full two-line previews, a dedicated **New Prompt** button, clearer keyboard focus, and save feedback. Project and prompt dialogs now share the same heading style.
- Gave the Prompt Library button a circular hover state that follows Gemini's theme, and added a subtle background and border to the edit button.
- Kept the picker within the viewport when search results or window dimensions change.

### v2.0.4

- Saved pinned projects across sessions and added icons to the compact project menu.
- Sized chat menus and project destination lists to fit their labels. Long lists scroll within the viewport.
- Fixed a loop where folding responses repeatedly updated the page while idle.

### v2.0.3

- Renamed the extension to `Gemini Folders — Projects & Prompt Library`.
- Used the same Conversation Index icon in the Chrome toolbar, on the extensions page, and in the store listing.

### v2.0.2

- Fixed sidebar jitter when the Projects panel was inserted outside Gemini's main navigation.
- Updated chat history detection for Gemini's Chat and Spark sidebars.
- Kept Projects visible when Recents is collapsed or the account has no chat history.
- Fixed Projects disappearing when switching from Spark back to Chat.
- Fixed duplicate response-fold buttons and project and chat menus that closed as soon as they opened.

### v2.0.1

- Limited website access to Gemini to meet Chrome Web Store requirements.
- Removed permissions for ChatGPT and its legacy domain from the extension manifest.

### v2.0.0

- Restored Projects after the Gemini sidebar update.
- Made it easier to choose icons and colors in the **New Project** dialog.
- Improved how projects handle chats deleted from Gemini history on another device.
- Marked missing chats so the rest of the project list stays intact.
- Improved menus for moving, removing, editing, and deleting projects or chats.
- Added controls for backing up and restoring local data.
- Refined the Prompt Library layout and controls.

## About

Gemini Projects is an independent, unofficial extension.

## Credits

Kubai (@kubai087) provides the Duotone project icons through Kubai Icons under the MIT License. [Website](https://icons.kubai.design/) · [GitHub](https://github.com/kubai087/kubai-icons) · [Third-party notices](THIRD_PARTY_NOTICES.md)

## Local Testing

Build the extension, then load the folder containing the generated `manifest.json`. In this development workspace, the build is copied to the sibling `chrome/` folder. Disable the Web Store installation before enabling the unpacked build so only one copy runs on Gemini. The two installations have separate IDs and local storage. Disabling the store installation preserves its data. After testing, run `npm run package:store` to create a separate ZIP for upload.

The Prompt Library borrows its colors, type scale, and form layout from the [MCP Apps for Claude UI Kit](https://www.figma.com/community/file/1597641111449594397/mcp-apps-for-claude). It uses 14px body text, 40px inputs, 36px buttons, and 16px textarea padding. Forms use the Primary background, with different border strengths for panels, inputs, and secondary buttons. The extension uses system fallbacks when Anthropic Sans Text or JetBrains Mono is unavailable. Headings in the Prompt Library and project and prompt editors use a 24px serif at weight 600, with fonts such as Iowan Old Style, Palatino, and Georgia. The shared heading style and the corner radii of 28px for panels, 16px for rows, and 12px for controls are specific to this project.
