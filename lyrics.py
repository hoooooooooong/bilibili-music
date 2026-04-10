"""Lyrics fetching module — searches Netease Cloud Music for synced lyrics."""

import re
import requests

_SEARCH_URL = "https://music.163.com/api/search/get"
_LYRIC_URL = "https://music.163.com/api/song/lyric"
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Referer": "https://music.163.com",
}


def search_song(keyword: str):
    """Search Netease Cloud Music, return list of (song_id, name, artist) tuples."""
    try:
        resp = requests.get(
            _SEARCH_URL,
            params={"s": keyword, "type": 1, "offset": 0, "limit": 5},
            headers=_HEADERS,
            timeout=8,
        )
        data = resp.json()
        songs = data.get("result", {}).get("songs", [])
        return [
            (
                song["id"],
                song.get("name", ""),
                song.get("artists", [{}])[0].get("name", ""),
            )
            for song in songs
        ] if songs else []
    except Exception:
        return []


def get_lyric(song_id: int) -> str:
    """Return raw LRC text for a Netease song, or empty string."""
    try:
        resp = requests.get(
            _LYRIC_URL,
            params={"id": song_id, "lv": 1},
            headers=_HEADERS,
            timeout=8,
        )
        data = resp.json()
        return data.get("lrc", {}).get("lyric", "") or ""
    except Exception:
        return ""


def parse_lrc(lrc_text: str) -> list:
    """Parse LRC text into a sorted list of [time_seconds, text]."""
    pattern = re.compile(r"\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)")
    lines = []
    for raw in lrc_text.splitlines():
        m = pattern.match(raw.strip())
        if not m:
            continue
        minutes = int(m.group(1))
        seconds = int(m.group(2))
        millis = int(m.group(3).ljust(3, "0")[:3])
        time_sec = minutes * 60 + seconds + millis / 1000
        text = m.group(4).strip()
        if text:
            lines.append([round(time_sec, 3), text])
    lines.sort(key=lambda x: x[0])
    return lines
