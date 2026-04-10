import os

import requests
import yt_dlp

from config import TEMP_DIR, DOWNLOAD_HEADERS


class DownloadError(Exception):
    pass


class BilibiliDownloader:
    def __init__(self):
        self._session = requests.Session()
        self._session.headers.update(DOWNLOAD_HEADERS)
        self._init_cookies()

    def _init_cookies(self):
        """Visit bilibili to get required cookies."""
        try:
            self._session.get(
                "https://www.bilibili.com",
                timeout=10,
                allow_redirects=True,
            )
        except requests.RequestException:
            pass

    def download(self, bvid: str, progress_callback=None) -> str:
        """
        Download video by bvid using yt-dlp.

        Args:
            bvid: Video BV id
            progress_callback: fn(downloaded_bytes, total_bytes) for progress updates

        Returns:
            Absolute path of the downloaded file

        Raises:
            DownloadError: On download failure
        """
        os.makedirs(TEMP_DIR, exist_ok=True)

        output_template = os.path.join(TEMP_DIR, "%(id)s.%(ext)s")

        # Convert session cookies to cookie string for yt-dlp
        cookie_str = "; ".join(
            f"{k}={v}" for k, v in self._session.cookies.items()
        )

        ydl_opts = {
            "format": "bestaudio/best",
            "outtmpl": output_template,
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "retries": 3,
            "fragment_retries": 3,
            "http_headers": DOWNLOAD_HEADERS,
            "cookie": cookie_str,
            "verbose": False,
            "extractor_args": {
                "bilibili": {
                    "prefer_multi_flv_audio": False,
                }
            },
            "progress_hooks": [lambda d: self._progress_hook(d, progress_callback)],
        }

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(
                    f"https://www.bilibili.com/video/{bvid}", download=True
                )
                if info is None:
                    raise DownloadError("无法获取视频信息")
                filepath = ydl.prepare_filename(info)
                if not os.path.exists(filepath):
                    # yt-dlp may use a different extension
                    base = os.path.splitext(filepath)[0]
                    for ext in ["webm", "m4a", "mp4", "flv", "opus"]:
                        candidate = base + "." + ext
                        if os.path.exists(candidate):
                            filepath = candidate
                            break
                if not os.path.exists(filepath):
                    raise DownloadError("下载文件未找到")
                return os.path.abspath(filepath)
        except DownloadError:
            raise
        except Exception as e:
            raise DownloadError(f"下载失败: {e}")

    def get_audio_url(self, bvid: str) -> dict:
        """
        Extract direct audio stream URL without downloading.

        Returns:
            dict with keys: url, ext, filesize
        """
        cookie_str = "; ".join(
            f"{k}={v}" for k, v in self._session.cookies.items()
        )

        ydl_opts = {
            "format": "bestaudio/best",
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "http_headers": DOWNLOAD_HEADERS,
            "cookie": cookie_str,
            "extractor_args": {
                "bilibili": {
                    "prefer_multi_flv_audio": False,
                }
            },
        }

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(
                    f"https://www.bilibili.com/video/{bvid}", download=False
                )
                if info is None:
                    raise DownloadError("无法获取视频信息")

                # Find the best audio format
                url = info.get("url") or ""
                ext = info.get("ext", "m4a")
                filesize = info.get("filesize") or info.get("filesize_approx", 0)

                if not url and info.get("formats"):
                    for fmt in info["formats"]:
                        if fmt.get("vcodec") == "none" or (
                            fmt.get("acodec") != "none" and
                            (fmt.get("vcodec") is None or fmt.get("vcodec") == "none")
                        ):
                            url = fmt.get("url", "")
                            ext = fmt.get("ext", ext)
                            filesize = fmt.get("filesize") or fmt.get("filesize_approx", 0) or filesize
                            if url:
                                break

                if not url:
                    # Fallback: take first format with audio
                    for fmt in info.get("formats", []):
                        acodec = fmt.get("acodec", "none")
                        if acodec and acodec != "none":
                            url = fmt.get("url", "")
                            ext = fmt.get("ext", ext)
                            filesize = fmt.get("filesize") or fmt.get("filesize_approx", 0) or filesize
                            break

                if not url:
                    raise DownloadError("无法提取音频地址")

                return {"url": url, "ext": ext, "filesize": filesize}
        except DownloadError:
            raise
        except Exception as e:
            raise DownloadError(f"获取音频地址失败: {e}")

    @staticmethod
    def _progress_hook(d: dict, callback):
        """yt-dlp progress hook that calls the progress callback."""
        if callback is None:
            return
        if d["status"] == "downloading":
            downloaded = d.get("downloaded_bytes", 0)
            total = d.get("total_bytes") or d.get("total_bytes_estimate", 0)
            callback(downloaded, total)
        elif d["status"] == "finished":
            total = d.get("total_bytes", 0)
            callback(total, total)
        elif d["status"] == "error":
            raise DownloadError(f"下载失败: {d.get('error', '未知错误')}")
