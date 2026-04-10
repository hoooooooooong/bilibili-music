import os
import re
import sys
import threading
import uuid
import argparse
import shutil
import requests as req_lib
from dataclasses import dataclass, field

from flask import Flask, request, jsonify, send_file, render_template, Response
from flask_cors import CORS

from config import (
    TEMP_DIR, OUTPUT_DIR, FLASK_HOST, FLASK_PORT, FLASK_DEBUG,
    SEARCH_HEADERS,
)
from searcher import BilibiliSearcher, SearchError
from downloader import BilibiliDownloader, DownloadError
from converter import AudioConverter, ConvertError
from lyrics import search_song, get_lyric, parse_lrc


# ── Task Manager ────────────────────────────────────────────────

@dataclass
class Task:
    task_id: str
    bvid: str
    status: str = "pending"          # pending | downloading | converting | done | error
    progress: float = 0.0            # 0.0 ~ 100.0
    downloaded_bytes: int = 0
    total_bytes: int = 0
    file_path: str = ""
    file_name: str = ""
    error_message: str = ""
    created_at: float = field(default_factory=lambda: __import__("time").time())


class TaskManager:
    def __init__(self):
        self._tasks: dict = {}
        self._lock = threading.Lock()

    def create(self, bvid: str) -> Task:
        task = Task(task_id=str(uuid.uuid4()), bvid=bvid)
        with self._lock:
            self._tasks[task.task_id] = task
        return task

    def get(self, task_id: str):
        with self._lock:
            return self._tasks.get(task_id)

    def update(self, task_id: str, **kwargs):
        with self._lock:
            task = self._tasks.get(task_id)
            if task:
                for k, v in kwargs.items():
                    if hasattr(task, k):
                        setattr(task, k, v)


# ── Download Worker ─────────────────────────────────────────────

searcher = BilibiliSearcher()
downloader = BilibiliDownloader()
converter = AudioConverter()
task_manager = TaskManager()


def _format_bytes(num: int) -> str:
    """Format bytes to human readable string."""
    if num < 1024:
        return f"{num} B"
    elif num < 1024 * 1024:
        return f"{num / 1024:.1f} KB"
    else:
        return f"{num / (1024 * 1024):.1f} MB"


def _download_and_convert(task: Task):
    """Background worker: download video then convert to MP3."""
    downloaded_file = None
    cover_file = None

    try:
        # Get video info for filename
        results = searcher.search(task.bvid)
        video_info = None
        for r in results:
            if r.bvid == task.bvid:
                video_info = r
                break

        # Phase 1: Download
        task_manager.update(task.task_id, status="downloading")

        def progress_cb(downloaded, total):
            progress = (downloaded / total * 100) if total > 0 else 0
            task_manager.update(
                task.task_id,
                progress=round(progress, 1),
                downloaded_bytes=downloaded,
                total_bytes=total,
            )

        downloaded_file = downloader.download(task.bvid, progress_callback=progress_cb)

        # Phase 1.5: Download cover image
        cover_path = None
        if video_info and video_info.cover_url:
            try:
                resp = req_lib.get(
                    video_info.cover_url,
                    headers=SEARCH_HEADERS,
                    timeout=15,
                )
                if resp.status_code == 200:
                    ext = ".jpg"
                    ct = resp.headers.get("Content-Type", "")
                    if "png" in ct:
                        ext = ".png"
                    elif "webp" in ct:
                        ext = ".webp"
                    cover_file = os.path.join(TEMP_DIR, f"{task.bvid}_cover{ext}")
                    with open(cover_file, "wb") as f:
                        f.write(resp.content)
                    cover_path = cover_file
            except Exception:
                pass  # Cover download failure is non-fatal

        # Phase 2: Convert
        task_manager.update(task.task_id, status="converting", progress=100.0)

        # Build output filename
        if video_info:
            raw_name = f"{video_info.title} - {video_info.author}"
        else:
            raw_name = task.bvid
        safe_name = converter.sanitize_filename(raw_name)

        output_path = os.path.join(OUTPUT_DIR, f"{safe_name}.mp3")
        result_path = converter.to_mp3(
            downloaded_file, output_path,
            cover_path=cover_path,
            title=video_info.title if video_info else None,
            artist=video_info.author if video_info else None,
        )

        # Phase 3: Done
        task_manager.update(
            task.task_id,
            status="done",
            file_path=result_path,
            file_name=f"{safe_name}.mp3",
        )

    except (SearchError, DownloadError, ConvertError) as e:
        task_manager.update(
            task.task_id,
            status="error",
            error_message=str(e),
        )
    except Exception as e:
        task_manager.update(
            task.task_id,
            status="error",
            error_message=f"未知错误: {e}",
        )
    finally:
        # Cleanup temp files
        for f in (downloaded_file, cover_file):
            if f and os.path.exists(f):
                try:
                    os.remove(f)
                except OSError:
                    pass


# ── Flask App ───────────────────────────────────────────────────

app = Flask(__name__)
CORS(app)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/search")
def api_search():
    keyword = request.args.get("keyword", "").strip()
    page = request.args.get("page", 1, type=int)

    if not keyword:
        return jsonify({"code": 1002, "message": "搜索关键词不能为空", "data": None})

    try:
        results, total = searcher.search(keyword, page)
        items = [
            {
                "bvid": r.bvid,
                "title": r.title,
                "author": r.author,
                "duration": r.duration,
                "play_count": r.play_count,
                "play_count_text": r.play_count_text,
                "cover_url": r.cover_url,
            }
            for r in results
        ]
        return jsonify({
            "code": 0,
            "message": "success",
            "data": {"results": items, "page": page, "total": total, "page_size": 10},
        })
    except SearchError as e:
        return jsonify({"code": 1001, "message": f"搜索失败: {e}", "data": None})


@app.route("/api/download/<bvid>", methods=["POST"])
def api_download(bvid):
    # Validate bvid format
    if not re.match(r"^BV[a-zA-Z0-9]+$", bvid):
        return jsonify({"code": 1002, "message": "无效的 BV 号格式", "data": None})

    task = task_manager.create(bvid)

    # Start background thread
    thread = threading.Thread(target=_download_and_convert, args=(task,), daemon=True)
    thread.start()

    return jsonify({"code": 0, "message": "success", "data": {"task_id": task.task_id}})


@app.route("/api/progress/<task_id>")
def api_progress(task_id):
    task = task_manager.get(task_id)
    if task is None:
        return jsonify({"code": 1007, "message": "任务不存在", "data": None})

    data = {
        "task_id": task.task_id,
        "status": task.status,
        "progress": task.progress,
        "downloaded_bytes": task.downloaded_bytes,
        "total_bytes": task.total_bytes,
        "downloaded_text": _format_bytes(task.downloaded_bytes),
        "total_text": _format_bytes(task.total_bytes),
    }

    if task.status == "done":
        data["file_name"] = task.file_name
    if task.status == "error":
        data["error_message"] = task.error_message

    return jsonify({"code": 0, "message": "success", "data": data})


@app.route("/api/file/<task_id>")
def api_file(task_id):
    task = task_manager.get(task_id)
    if task is None:
        return jsonify({"code": 1007, "message": "任务不存在", "data": None}), 404

    if task.status != "done" or not task.file_path or not os.path.exists(task.file_path):
        return jsonify({"code": 1003, "message": "文件尚未生成", "data": None})

    return send_file(
        task.file_path,
        as_attachment=True,
        download_name=task.file_name,
        mimetype="audio/mpeg",
    )


@app.route("/api/play/<bvid>")
def api_play(bvid):
    """Proxy Bilibili audio stream for direct online playback."""
    if not re.match(r"^BV[a-zA-Z0-9]+$", bvid):
        return jsonify({"code": 1002, "message": "无效的 BV 号格式", "data": None}), 400

    try:
        audio_info = downloader.get_audio_url(bvid)
    except DownloadError as e:
        return jsonify({"code": 1004, "message": str(e), "data": None}), 500

    url = audio_info["url"]
    ext = audio_info["ext"]
    filesize = audio_info["filesize"]

    # Determine mime type
    mime_map = {"m4a": "audio/mp4", "mp4": "audio/mp4", "webm": "audio/webm", "opus": "audio/opus", "mp3": "audio/mpeg"}
    mimetype = mime_map.get(ext, "audio/mp4")

    # Handle range request for seeking
    range_header = request.headers.get("Range")

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/131.0.0.0 Safari/537.36"
        ),
        "Referer": "https://www.bilibili.com",
    }
    if range_header:
        headers["Range"] = range_header

    try:
        resp = req_lib.get(url, headers=headers, stream=True, timeout=30)
        resp.raise_for_status()
    except req_lib.RequestException as e:
        return jsonify({"code": 1005, "message": f"音频获取失败: {e}", "data": None}), 502

    def generate():
        try:
            for chunk in resp.iter_content(chunk_size=65536):
                if chunk:
                    yield chunk
        except Exception:
            pass

    response = Response(generate(), mimetype=mimetype)
    response.headers["Accept-Ranges"] = "bytes"

    # Pass through content-length and content-range from upstream
    if "Content-Length" in resp.headers:
        response.headers["Content-Length"] = resp.headers["Content-Length"]
    if "Content-Range" in resp.headers:
        response.headers["Content-Range"] = resp.headers["Content-Range"]
        return response, 206

    if filesize:
        response.headers["Content-Length"] = str(filesize)

    return response


@app.route("/api/cover/<bvid>")
def api_cover(bvid):
    """Proxy cover image with proper Referer to bypass Bilibili anti-hotlinking."""
    try:
        results, _ = searcher.search(bvid)
        cover_url = ""
        for r in results:
            if r.bvid == bvid:
                cover_url = r.cover_url
                break
        if not cover_url:
            return jsonify({"code": 1006, "message": "封面未找到", "data": None}), 404
    except SearchError:
        return jsonify({"code": 1001, "message": "搜索失败", "data": None}), 500

    try:
        resp = req_lib.get(
            cover_url,
            headers=SEARCH_HEADERS,
            timeout=15,
            stream=True,
        )
        resp.raise_for_status()
        content_type = resp.headers.get("Content-Type", "image/jpeg")
        return Response(resp.iter_content(chunk_size=65536), mimetype=content_type)
    except req_lib.RequestException:
        return jsonify({"code": 1005, "message": "封面获取失败", "data": None}), 502


@app.route("/api/stream/<task_id>")
def api_stream(task_id):
    task = task_manager.get(task_id)
    if task is None:
        return jsonify({"code": 1007, "message": "任务不存在", "data": None}), 404

    if task.status != "done" or not task.file_path or not os.path.exists(task.file_path):
        return jsonify({"code": 1003, "message": "文件尚未生成", "data": None})

    response = send_file(
        task.file_path,
        as_attachment=False,
        mimetype="audio/mpeg",
    )
    response.headers["Accept-Ranges"] = "bytes"
    return response


@app.route("/api/lyrics/<bvid>")
def api_lyrics(bvid):
    """Search for synced lyrics on Netease Cloud Music based on song title + author."""
    if not re.match(r"^BV[a-zA-Z0-9]+$", bvid):
        return jsonify({"code": 1002, "message": "无效的 BV 号格式", "data": None}), 400

    try:
        results, _ = searcher.search(bvid)
        song_info = None
        for r in results:
            if r.bvid == bvid:
                song_info = r
                break
        if not song_info:
            return jsonify({"code": 1006, "message": "歌曲信息未找到", "data": None}), 404
    except SearchError:
        return jsonify({"code": 1001, "message": "搜索失败", "data": None}), 500

    # Build keyword from Bilibili title + author
    keyword = f"{song_info.title} {song_info.author}"
    results = search_song(keyword)

    if not results:
        return jsonify({"code": 0, "message": "未找到歌词", "data": {"lyrics": []}})

    # Try each search result until we find one with lyrics
    song_id, song_name, artist = None, None, None
    lrc_text = ""
    for sid, sname, sartist in results:
        lrc = get_lyric(sid)
        if lrc:
            song_id, song_name, artist = sid, sname, sartist
            lrc_text = lrc
            break

    if not lrc_text:
        return jsonify({"code": 0, "message": "暂无歌词", "data": {"lyrics": []}})

    lyrics = parse_lrc(lrc_text)
    return jsonify({
        "code": 0,
        "message": "success",
        "data": {
            "lyrics": lyrics,
            "song": song_name,
            "artist": artist,
        },
    })


@app.route("/api/related/<bvid>")
def api_related(bvid):
    """Get related video recommendations from Bilibili."""
    if not re.match(r"^BV[a-zA-Z0-9]+$", bvid):
        return jsonify({"code": 1002, "message": "无效的 BV 号格式", "data": None}), 400

    try:
        resp = req_lib.get(
            "https://api.bilibili.com/x/web-interface/archive/related",
            params={"bvid": bvid},
            headers=SEARCH_HEADERS,
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        return jsonify({"code": 1001, "message": f"获取推荐失败: {e}", "data": None}), 500

    if data.get("code") != 0:
        return jsonify({"code": 1001, "message": data.get("message", "获取推荐失败"), "data": None}), 500

    items = []
    for v in data.get("data", [])[:10]:
        title = v.get("title", "")
        title = html.unescape(title)
        title = re.sub(r"<[^>]+>", "", title)
        pic = v.get("pic", "")
        if pic.startswith("//"):
            pic = "https:" + pic
        items.append({
            "bvid": v.get("bvid", ""),
            "title": title.strip(),
            "author": v.get("owner", {}).get("name", ""),
            "duration": v.get("duration", ""),
            "play_count": v.get("stat", {}).get("view", 0),
            "play_count_text": _format_play_count(v.get("stat", {}).get("view", 0)),
            "cover_url": pic,
        })

    return jsonify({"code": 0, "data": {"results": items}})


def _format_play_count(count: int) -> str:
    """Format play count to human readable string."""
    if count >= 100_000_000:
        return f"{count / 100_000_000:.1f}亿"
    if count >= 10_000:
        return f"{count / 10_000:.0f}万"
    return str(count)


# ── CLI Mode ────────────────────────────────────────────────────

def cli_mode(keyword: str, output_dir: str):
    """Command-line interactive mode."""
    print(f"\n搜索: {keyword}\n")

    try:
        results = searcher.search(keyword)
    except SearchError as e:
        print(f"搜索失败: {e}")
        sys.exit(1)

    if not results:
        print("未找到相关视频，请尝试其他关键词。")
        sys.exit(0)

    for i, r in enumerate(results, 1):
        print(f"  [{i}] {r.title}")
        print(f"      UP主: {r.author}  |  时长: {r.duration}  |  播放: {r.play_count_text}")
        print()

    choice = input("请输入序号选择视频: ").strip()
    try:
        idx = int(choice) - 1
        if idx < 0 or idx >= len(results):
            print("无效的序号")
            sys.exit(1)
    except ValueError:
        print("请输入数字序号")
        sys.exit(1)

    selected = results[idx]
    print(f"\n正在下载: {selected.title} ...")

    def progress_cb(downloaded, total):
        if total > 0:
            pct = downloaded / total * 100
            print(f"\r  进度: {pct:.1f}%  {_format_bytes(downloaded)} / {_format_bytes(total)}", end="", flush=True)

    try:
        downloaded_file = downloader.download(selected.bvid, progress_callback=progress_cb)
    except DownloadError as e:
        print(f"\n下载失败: {e}")
        sys.exit(1)

    print("\n正在转换为 MP3 ...")
    os.makedirs(output_dir, exist_ok=True)
    safe_name = converter.sanitize_filename(f"{selected.title} - {selected.author}")
    output_path = os.path.join(output_dir, f"{safe_name}.mp3")

    try:
        result_path = converter.to_mp3(downloaded_file, output_path)
    except ConvertError as e:
        print(f"转换失败: {e}")
        sys.exit(1)
    finally:
        if os.path.exists(downloaded_file):
            os.remove(downloaded_file)

    print(f"\n完成! 文件已保存到: {result_path}")


# ── Entry Point ─────────────────────────────────────────────────

def check_environment():
    """Check runtime dependencies before starting."""
    if sys.version_info < (3, 8):
        print("需要 Python 3.8 或更高版本")
        sys.exit(1)

    if not AudioConverter.check_ffmpeg():
        print("[WARNING] 未检测到 ffmpeg，音频转换功能将不可用")
        print("  下载的视频将保留原始格式，请安装 ffmpeg 后重启")
        print("  Windows: winget install ffmpeg  或  https://ffmpeg.org/download.html")
        print()

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    os.makedirs(TEMP_DIR, exist_ok=True)

    # Clean up leftover temp files
    for f in os.listdir(TEMP_DIR):
        fp = os.path.join(TEMP_DIR, f)
        try:
            if os.path.isfile(fp):
                os.remove(fp)
        except OSError:
            pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Bilibili Music Downloader")
    parser.add_argument("--web", action="store_true", help="启动 Web 服务")
    parser.add_argument("--port", type=int, default=FLASK_PORT, help="Web 服务端口")
    parser.add_argument("-o", "--output", default=OUTPUT_DIR, help="输出目录")
    parser.add_argument("keyword", nargs="?", help="搜索关键词（CLI 模式）")

    args = parser.parse_args()

    check_environment()

    if args.web:
        print(f"启动 Web 服务: http://localhost:{args.port}")
        app.run(host=FLASK_HOST, port=args.port, debug=FLASK_DEBUG)
    elif args.keyword:
        cli_mode(args.keyword, args.output)
    else:
        parser.print_help()
