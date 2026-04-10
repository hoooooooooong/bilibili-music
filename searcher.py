import html
import re
import uuid
from dataclasses import dataclass

import requests

from config import SEARCH_HEADERS, SEARCH_PAGE_SIZE

# Use the all/v2 endpoint which doesn't require WBI signing
BILIBILI_SEARCH_URL = "https://api.bilibili.com/x/web-interface/search/all/v2"


class SearchError(Exception):
    pass


@dataclass
class SearchResult:
    bvid: str
    title: str
    author: str
    duration: str
    play_count: int
    play_count_text: str
    cover_url: str
    description: str


class BilibiliSearcher:
    def __init__(self):
        self._session = requests.Session()
        self._session.headers.update(SEARCH_HEADERS)
        self._init_cookies()

    def _init_cookies(self):
        """Visit bilibili homepage to obtain required cookies."""
        try:
            self._session.get(
                "https://www.bilibili.com",
                timeout=10,
                allow_redirects=True,
            )
        except requests.RequestException:
            pass

        if "buvid3" not in self._session.cookies:
            self._session.cookies.set(
                "buvid3", uuid.uuid4().hex + uuid.uuid4().hex[:8],
                domain=".bilibili.com", path="/",
            )
        if "buvid4" not in self._session.cookies:
            self._session.cookies.set(
                "buvid4", uuid.uuid4().hex + "infoc",
                domain=".bilibili.com", path="/",
            )

    def search(self, keyword: str, page: int = 1) -> tuple:
        """
        Search Bilibili videos by keyword.

        Args:
            keyword: Search keyword
            page: Page number, starting from 1

        Returns:
            Tuple of (list of SearchResult, total result count)

        Raises:
            SearchError: On API failure
        """
        params = {
            "keyword": keyword,
            "page": page,
        }

        try:
            resp = self._session.get(
                BILIBILI_SEARCH_URL,
                params=params,
                timeout=10,
            )
            resp.raise_for_status()
            data = resp.json()
        except requests.exceptions.Timeout:
            raise SearchError("搜索请求超时，请检查网络连接")
        except requests.exceptions.ConnectionError:
            raise SearchError("网络连接失败，请检查网络")
        except requests.exceptions.RequestException as e:
            raise SearchError(f"搜索请求失败: {e}")

        if data.get("code") != 0:
            raise SearchError(data.get("message", "搜索失败"))

        # Extract video results from the grouped response
        result_groups = data.get("data", {}).get("result", [])
        video_results = []
        for group in result_groups:
            if group.get("result_type") == "video":
                video_results = group.get("data", [])
                break

        num_results = data.get("data", {}).get("numResults", 0) or len(video_results)
        if not video_results:
            return [], num_results

        return [self._parse_item(item) for item in video_results[:SEARCH_PAGE_SIZE]], num_results

    def _parse_item(self, item: dict) -> SearchResult:
        """Parse a single Bilibili search result item."""
        title = item.get("title", "")
        # Decode HTML entities and remove HTML tags
        title = html.unescape(title)
        title = re.sub(r"<[^>]+>", "", title)

        cover_url = item.get("pic", "")
        if cover_url.startswith("//"):
            cover_url = "https:" + cover_url

        play_count = int(item.get("play", 0) or 0)
        play_count_text = self._format_play_count(play_count)

        return SearchResult(
            bvid=item.get("bvid", ""),
            title=title.strip(),
            author=item.get("author", ""),
            duration=item.get("duration", ""),
            play_count=play_count,
            play_count_text=play_count_text,
            cover_url=cover_url,
            description=item.get("description", ""),
        )

    @staticmethod
    def _format_play_count(count: int) -> str:
        """Format play count to human readable string."""
        if count >= 100_000_000:
            return f"{count / 100_000_000:.1f}亿"
        if count >= 10_000:
            return f"{count / 10_000:.0f}万"
        return str(count)
