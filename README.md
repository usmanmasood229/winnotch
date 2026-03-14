# 🖤 WinNotch

A macOS Dynamic Island–style notch for Windows.  
Sits pinned at the top-centre of your screen, always above every window.

```
┌────────────────────────────────────────────────────────────────┐
│  12:34 PM  │  ◀  ▶▶  Starboy · The Weeknd  ──── │  ⛅ 22°C  CPU 34%  RAM 61%  │
└────────────────────────────────────────────────────────────────┘
```

**Hover** → the notch fades to near-invisible glass so you see what's behind.

---

## Features

| Zone   | What's inside                                      |
|--------|----------------------------------------------------|
| Left   | Live clock (12 h) + date                           |
| Center | Music controls — play/pause, prev, next, progress  |
| Right  | Live weather (auto-location) + CPU % + RAM %       |

- Always on top — above all windows and taskbar  
- Zero taskbar entry — lives only in the system tray  
- Right-click tray → Show / Hide / Quit  
- Weather updates every 10 minutes (free, no API key)  

---

## Quick Start (Windows)

### 1 — Install Node.js
Download from https://nodejs.org  (LTS, v18 or newer)

### 2 — Run
```bat
cd winnotch
npm install
npm start
```

That's it.  The notch appears at the top-centre of your primary monitor.

### 3 — Build a standalone .exe (optional)
```bat
npm run build
```
Installer lands in `dist\`.

---

## Customise

| Thing to change                  | Where                          |
|----------------------------------|--------------------------------|
| Notch width / height             | `src/main.js`  → `W` / `H`    |
| Hover transparency               | `src/index.html` → `--bg-hover`|
| Stats refresh rate               | `src/index.html` → `setInterval(refreshStats, …)` |
| Weather refresh rate             | `src/index.html` → `setInterval(loadWeather, …)`  |

---

## How weather works
Uses [Open-Meteo](https://open-meteo.com) (completely free, no key needed).  
Location is auto-detected via your IP using [ip-api.com](https://ip-api.com).

## How media works
The player reads the **Web Media Session API** — if a browser tab (YouTube, Spotify Web, etc.) is playing music it will show that track automatically.  
Otherwise it shows a built-in demo mode with play/pause/skip controls.
