# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Bilibili Music - a web app that searches Bilibili for music videos, plays them online, and downloads/converts to MP3. Built with Flask backend + vanilla JS frontend (no frameworks).

## Running the App

```bash
pip install -r requirements.txt          # flask, flask-cors, requests, yt-dlp
python main.py --web --port 5000        # Web mode (default port 5000)
python main.py --web --port 8080        # Custom port
```

Requires **ffmpeg** installed and on PATH for audio conversion.

No build step, bundler, or test suite. Frontend is served directly by Flask as static files.

## Architecture

### Backend (Python)

| File | Role |
|---|---|
| `main.py` | Flask server + CLI entry point. Task manager with background workers, all API routes |
| `searcher.py` | Bilibili API client. Cookie-based session, search via `/x/web-interface/search/all/v2` |
| `downloader.py` | yt-dlp wrapper for video/audio extraction with progress callbacks |
| `converter.py` | ffmpeg wrapper. MP3 conversion at 320kbps, ID3 tag + cover embedding |
| `lyrics.py` | Netease Cloud Music integration. LRC search, fetch, parse for synced lyrics |
| `config.py` | Centralized constants: paths, quality settings, API headers |

### API Endpoints

- `GET /api/search?keyword=&page=` - Search Bilibili
- `POST /api/download/<bvid>` - Start async download task, returns task_id
- `GET /api/progress/<task_id>` - Poll task status/progress
- `GET /api/file/<task_id>` - Download completed MP3
- `GET /api/play/<bvid>` - Stream audio for online playback
- `GET /api/cover/<bvid>` - Proxy cover image (bypasses anti-hotlinking)
- `GET /api/lyrics/<bvid>` - Fetch synced lyrics from Netease

### Frontend (Vanilla JS)

Single file `static/js/app.js` (~700 lines), single HTML template. Key architectural patterns:

- **State**: Global `state` object holds playlist, play mode, search results, current bvid
- **Audio element**: Shared `<audio>` element, controlled by mini player and full player
- **Classes**: `LyricsPanel` (inline single-line lyrics), `FullPlayer` (fullscreen with disc, lyrics, visualizer), `AudioCache` (IndexedDB caching)
- **Theme**: CSS custom properties on `[data-theme="dark"]`. View Transitions API with circular clip-path animation for switching
- **Event delegation**: Click handlers on `document` for play/fav/download buttons via `.closest()`
- **Task polling**: `setInterval` for download progress updates

### Frontend Features

- Mini player bar (bottom) + fullscreen player (disc, scrolling lyrics, canvas visualizer)
- Playlist panel with current queue
- Volume control (synced between mini and full player)
- IndexedDB audio cache (500MB limit, LRU eviction) - first play streams and caches in background, subsequent plays instant
- Favorites stored in localStorage

## Development Notes

- **Cache busting**: Static assets use `?v=N` query string. Increment in `templates/index.html` when changing CSS/JS.
- **No framework**: All JS is vanilla ES6+. No imports, no modules, no TypeScript.
- **Bilibili cookies**: `searcher.py` auto-initializes buvid3/buvid4 cookies. `downloader.py` uses session cookies from yt-dlp.
- **Audio streaming**: `/api/play/<bvid>` extracts audio URL via yt-dlp and proxies it. Range requests supported.
- **Lyrics pipeline**: Bilibili title+author → Netease search → try up to 5 results until lyrics found → return parsed `[time, text]` array.
- **PlayOnline override**: At bottom of `app.js`, `playOnline` is wrapped to sync fullscreen player state when a song changes while the full player is open.

## Key Error Codes

1001: Search failure | 1002: Invalid params | 1003: File not ready | 1004: Download failure | 1005: Stream error | 1006: Not found | 1007: Task not found
