# ⚡️ Tiny Killer

[![tinyjs](https://img.shields.io/badge/tinyjs-%E2%89%A50.65.0-orange)](https://tinyjs.app)
[![macOS](https://img.shields.io/badge/platform-macOS%2015%2B-lightgrey?logo=apple)](https://developer.apple.com/macos/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

⚡️ **Tiny Killer** is the tiny version of [Node Killer](https://github.com/adolfoflores/node-killer). It lives in your Mac's menu bar, shows the **Node.js**, **Vite** and **Bun** dev servers you have running, and stops any of them with one click.

🇪🇸 [Leer en español](./README.es-ES.md)

<p align="center">
  <img src="docs/screenshots/panel.webp" height="440" alt="The Tiny Killer panel open under its menu bar icon, listing six dev servers grouped by project with their port, command, memory and uptime">
  &nbsp;
  <img src="docs/screenshots/settings.webp" height="440" alt="The Tiny Killer settings window">
</p>

## 🪶 Why tiny

Node Killer is built with Electron, which packs a whole web browser into the app. Tiny Killer is built with [tinyjs](https://tinyjs.app) and uses what macOS already has, so the same app takes a fraction of the space.

| | Tiny Killer | Node Killer |
| --- | --- | --- |
| App size | **16 MB** (Intel + Apple Silicon) | 257 MB (Apple Silicon only) |

## ✨ Features
- 📊 **Live count** in the menu bar of the dev servers running, optionally with their total memory or CPU (`⚡️ 4 · 1.4 GB`).
- 🪟 **Panel**: click the icon to see your servers grouped by project, with their port, memory and how long they've been up. Point at one for more detail, and stop it with one click.
- 🖱️ **Classic menu**: right-click the icon for the same list as a regular macOS menu.
- 🔪 **Stops it properly**: the server goes together with the tool that started it (`npm run dev`, `next dev`, …), just like pressing Ctrl-C. If it won't stop, the panel tells you why.
- 💣 **Kill all**, after a quick confirmation.
- 🧰 **Settings** that look at home on macOS: open at login, what the menu bar shows, how often to refresh, and which kinds of server to list.
- 🔄 **Keeps itself up to date**: it looks for a new version once a day, and one click installs it.
- 📦 **Coming from Node Killer?** Tiny Killer brings your settings along the first time it opens.

## 📥 Download

Get the `.dmg` from the [latest release](https://github.com/adolfoflores/tiny-killer/releases/latest), open it and drag Tiny Killer to Applications. It runs on Intel and Apple Silicon Macs with macOS 15 or later, updates itself daily, and installs only an update signed with the project's key.

> The app isn't notarized yet, so macOS blocks the first launch: open **System Settings → Privacy & Security** and click **Open Anyway**.

## ⚠️ Limitations
- Only servers listening on a port show up; scripts and watchers without one don't.
- Servers running inside Docker don't show up.
- The Ctrl-C style stop knows the common tools (npm, pnpm, yarn, bun, next, vite, nodemon, …). With others, like `turbo` or `concurrently`, only the server stops, and the tool may start it again.

## 🛠️ Development

You need the [tinyjs](https://tinyjs.app) CLI (`curl -fsSL https://tinyjs.app/install | sh`). The project has no other dependencies.

```bash
npm run dev            # run it, with live reload
npm run build          # dist/Tiny Killer.app and a .dmg
npm run install:local  # build and install it in /Applications
npm test
```

To release, set `version` in `tinyjs.json` and push a matching tag (`v1.0.0`): GitHub Actions builds a draft release with the `.dmg` and the update files, signing the manifest with the `TINYJS_UPDATE_PRIVATE_KEY` secret. Publishing the draft is what makes installed copies offer the update.

## 🤝 Contributing
Pull requests and feedback are welcome. Run `npm test` before opening one.

## 📝 License
[MIT](./LICENSE)
