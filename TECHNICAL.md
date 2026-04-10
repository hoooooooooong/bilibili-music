# Bilibili Music Downloader - 技术设计文档

## 1. 系统架构

### 1.1 整体架构图

```
┌─────────────────────────────────────────────────────────┐
│                      Browser (前端)                      │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ 搜索输入  │  │ 结果列表渲染  │  │  下载进度展示     │   │
│  └────┬─────┘  └──────┬───────┘  └────────┬─────────┘   │
│       │  Fetch API    │                    │             │
│       └───────────────┴────────────────────┘             │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTP (JSON / File Download)
                       ▼
┌─────────────────────────────────────────────────────────┐
│                   Flask Server (后端)                     │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ API 路由  │  │  任务管理器   │  │  静态文件服务     │   │
│  │ (routes) │  │  TaskManager │  │  (templates/     │   │
│  │          │  │              │  │   static/)       │   │
│  └────┬─────┘  └──────┬───────┘  └──────────────────┘   │
│       │               │                                 │
│  ┌────┴───────────────┴──────────────┐                   │
│  │           业务模块层               │                   │
│  │  ┌──────────┐ ┌──────────┐ ┌────────────┐           │
│  │  │ Searcher │ │Downloader│ │ Converter  │           │
│  │  └────┬─────┘ └────┬─────┘ └─────┬──────┘           │
│  └───────┼────────────┼────────────┼────────────────────┘
└──────────┼────────────┼────────────┼─────────────────────┘
           │            │            │
           ▼            ▼            ▼
    ┌──────────┐  ┌──────────┐  ┌──────────┐
    │ Bilibili │  │ yt-dlp   │  │ ffmpeg   │
    │ Search   │  │ 视频下载  │  │ 音频转换  │
    │   API    │  │  Library  │  │  (CLI)   │
    └──────────┘  └──────────┘  └──────────┘
```

### 1.2 技术栈

| 层级 | 技术 | 版本要求 | 用途 |
|------|------|---------|------|
| 前端 | HTML5 + CSS3 + ES6+ | - | 页面结构、样式、交互逻辑 |
| 后端框架 | Flask | 2.0+ | REST API、模板渲染、静态文件服务 |
| HTTP 客户端 | requests | 2.28+ | 调用 Bilibili 搜索 API |
| 视频下载 | yt-dlp | 2023.01+ | Bilibili 视频下载与音视频流处理 |
| 音频处理 | ffmpeg | 5.0+ | 音频提取与 MP3 编码 |
| 运行时 | Python | 3.8+ | 后端运行环境 |

---

## 2. 后端详细设计

### 2.1 模块职责划分

#### `config.py` — 全局配置

```python
# Bilibili API
BILIBILI_SEARCH_URL = "https://api.bilibili.com/x/web-interface/search/type"
BILIBILI_VIDEO_URL = "https://www.bilibili.com/video/"

# 搜索参数
SEARCH_TYPE = "video"
SEARCH_PAGE_SIZE = 10

# 下载与转换
TEMP_DIR = "./temp"           # 临时文件目录
OUTPUT_DIR = "./output"       # MP3 输出目录
AUDIO_BITRATE = "320k"        # MP3 码率
AUDIO_SAMPLE_RATE = 44100     # 采样率

# 服务配置
FLASK_HOST = "0.0.0.0"
FLASK_PORT = 5000
FLASK_DEBUG = False
```

#### `searcher.py` — 搜索模块

**职责：** 封装 Bilibili 搜索 API 的调用与结果解析。

**核心类：**

```python
class BilibiliSearcher:
    def search(self, keyword: str, page: int = 1) -> list[SearchResult]:
        """
        调用 Bilibili 搜索 API，返回解析后的结果列表。

        参数:
            keyword: 搜索关键词
            page: 页码，默认第1页

        返回:
            SearchResult 对象列表

        异常:
            SearchError: 搜索失败时抛出
        """
```

**数据结构：**

```python
@dataclass
class SearchResult:
    bvid: str              # 视频 BV 号，唯一标识
    title: str             # 视频标题（需 HTML 实体解码）
    author: str            # UP 主名称
    duration: str          # 时长，格式 "MM:SS"
    play_count: int        # 播放量
    cover_url: str         # 封面图 URL
    description: str       # 视频简介
```

**Bilibili API 交互细节：**

- 请求地址：`GET https://api.bilibili.com/x/web-interface/search/type`
- 请求参数：

| 参数 | 类型 | 说明 |
|------|------|------|
| `search_type` | string | 固定值 `video` |
| `keyword` | string | 搜索关键词（需 URL 编码） |
| `page` | int | 页码，从 1 开始 |

- 请求头（模拟浏览器访问，降低被风控概率）：

```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ...
Referer: https://www.bilibili.com
```

- 响应 JSON 路径：`data.result[]` 中提取字段映射：

| Bilibili 字段 | SearchResult 字段 | 说明 |
|---------------|-------------------|------|
| `bvid` | `bvid` | 直接映射 |
| `title` | `title` | 含 HTML 标签，需用 `html.unescape()` + 正则清除 |
| `author` | `author` | 直接映射 |
| `duration` | `duration` | 格式 "MM:SS" |
| `play` | `play_count` | 整数，需格式化为"万"等单位 |
| `pic` | `cover_url` | 需拼接 `https:` 前缀（API 返回 `//` 开头） |
| `description` | `description` | 直接映射 |

- 错误处理：当 `code != 0` 时抛出 `SearchError`，携带 Bilibili 返回的 `message` 字段。

#### `downloader.py` — 下载模块

**职责：** 通过 yt-dlp 下载 Bilibili 视频音频流，支持进度回调。

**核心类：**

```python
class BilibiliDownloader:
    def download(self, bvid: str, progress_callback: Callable) -> str:
        """
        下载指定 BV 号的视频，返回下载文件路径。

        参数:
            bvid: 视频 BV 号
            progress_callback: 进度回调函数 fn(downloaded_bytes, total_bytes)

        返回:
            下载后的文件绝对路径

        异常:
            DownloadError: 下载失败时抛出
        """
```

**yt-dlp 配置项：**

```python
YTDLP_OPTIONS = {
    "format": "bestaudio/best",        # 优先选择最佳音质
    "outtmpl": f"{TEMP_DIR}/%(id)s.%(ext)s",
    "quiet": True,
    "no_warnings": True,
    "noplaylist": True,                # 不下载播放列表
    "retries": 3,                      # 重试次数
    "fragment_retries": 3,             # 分片重试次数
    "http_headers": {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...",
        "Referer": "https://www.bilibili.com",
    },
}
```

**进度回调机制：**

```python
def _progress_hook(self, d: dict, callback: Callable):
    """yt-dlp 内部进度钩子，提取下载进度并回调。"""
    if d["status"] == "downloading":
        downloaded = d.get("downloaded_bytes", 0)
        total = d.get("total_bytes") or d.get("total_bytes_estimate", 0)
        callback(downloaded, total)
    elif d["status"] == "finished":
        callback(d.get("total_bytes", 0), d.get("total_bytes", 0))
    elif d["status"] == "error":
        raise DownloadError(f"下载失败: {d.get('error', '未知错误')}")
```

#### `converter.py` — 音频转换模块

**职责：** 调用 ffmpeg 将下载的视频/音频文件转换为 MP3。

**核心类：**

```python
class AudioConverter:
    def to_mp3(self, input_path: str, output_path: str) -> str:
        """
        将输入文件转换为 MP3 格式。

        参数:
            input_path: 输入文件路径（视频或音频）
            output_path: 输出 MP3 文件路径

        返回:
            输出文件的绝对路径

        异常:
            ConvertError: 转换失败时抛出
        """

    def check_ffmpeg(self) -> bool:
        """检测系统中 ffmpeg 是否可用。"""
```

**ffmpeg 命令：**

```bash
ffmpeg -i "{input_path}" \
       -vn \
       -ab 320k \
       -ar 44100 \
       -ac 2 \
       -y \
       "{output_path}"
```

| 参数 | 说明 |
|------|------|
| `-i` | 输入文件路径 |
| `-vn` | 忽略视频轨道（no video） |
| `-ab 320k` | 音频码率 320kbps |
| `-ar 44100` | 采样率 44.1kHz |
| `-ac 2` | 双声道（立体声） |
| `-y` | 覆盖已存在的输出文件 |

**实现方式：** 使用 Python `subprocess.run()` 调用 ffmpeg，设置 `timeout=300`（5分钟超时），捕获 `stderr` 用于错误诊断。

**ffmpeg 检测逻辑：**

```python
def check_ffmpeg(self) -> bool:
    try:
        result = subprocess.run(
            ["ffmpeg", "-version"],
            capture_output=True, text=True, timeout=10
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
```

#### `main.py` — 入口与 API 路由

**职责：** Flask 应用初始化、路由定义、任务管理、CLI 入口。

**任务管理器（内存实现）：**

```python
@dataclass
class Task:
    task_id: str               # UUID 格式
    bvid: str                  # 视频 BV 号
    status: str                # pending | downloading | converting | done | error
    progress: float            # 0.0 ~ 100.0
    downloaded_bytes: int      # 已下载字节数
    total_bytes: int           # 总字节数
    file_path: str             # 生成的 MP3 文件路径（完成后填充）
    error_message: str         # 错误信息（失败时填充）
    created_at: float          # 创建时间戳

class TaskManager:
    def __init__(self):
        self._tasks: dict[str, Task] = {}

    def create(self, bvid: str) -> Task: ...
    def get(self, task_id: str) -> Task | None: ...
    def update(self, task_id: str, **kwargs): ...
```

### 2.2 API 接口详细设计

#### `GET /api/search`

搜索 Bilibili 视频。

**请求参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `keyword` | string | 是 | 搜索关键词 |
| `page` | int | 否 | 页码，默认 1 |

**响应示例：**

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "results": [
      {
        "bvid": "BV1xx411c7mD",
        "title": "晴天 - 周杰伦 官方MV",
        "author": "周杰伦官方频道",
        "duration": "04:52",
        "play_count": 12850000,
        "play_count_text": "1285万",
        "cover_url": "https://i0.hdslb.com/bfs/archive/xxx.jpg"
      }
    ],
    "total": 580,
    "page": 1
  }
}
```

**错误响应：**

```json
{
  "code": 1001,
  "message": "搜索失败：网络请求异常",
  "data": null
}
```

#### `POST /api/download/<bvid>`

触发下载任务。

**路径参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `bvid` | string | 视频 BV 号 |

**响应示例：**

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "task_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
  }
}
```

**后端处理流程：**

1. 校验 bvid 格式（正则 `^BV[a-zA-Z0-9]+$`）
2. TaskManager 创建新任务（status=pending）
3. 启动后台线程执行下载 → 转换流程
4. 立即返回 task_id，不阻塞请求

**后台线程执行流程：**

```
创建任务 (pending)
    │
    ▼
更新状态为 downloading
    │
    ▼
yt-dlp 下载 (回调更新进度)
    │
    ├── 失败 → 更新状态为 error，记录 error_message
    │
    ▼
更新状态为 converting
    │
    ▼
ffmpeg 转换 MP3
    │
    ├── 失败 → 更新状态为 error，保留下载文件供排查
    │
    ▼
清理临时文件
    │
    ▼
更新状态为 done，填充 file_path
```

#### `GET /api/progress/<task_id>`

查询任务进度。

**路径参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `task_id` | string | 任务 ID |

**响应示例（下载中）：**

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "task_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "status": "downloading",
    "progress": 68.5,
    "downloaded_bytes": 3355443,
    "total_bytes": 4898940,
    "downloaded_text": "3.2 MB",
    "total_text": "4.7 MB"
  }
}
```

**响应示例（完成）：**

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "task_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "status": "done",
    "progress": 100.0,
    "file_name": "晴天 - 周杰伦官方频道.mp3"
  }
}
```

#### `GET /api/file/<task_id>`

下载生成的 MP3 文件。

**响应：** 直接返回文件流（`application/octet-stream`），浏览器触发文件下载。

```http
HTTP/1.1 200 OK
Content-Type: application/octet-stream
Content-Disposition: attachment; filename="晴天 - 周杰伦官方频道.mp3"
Content-Length: 8345210
```

**错误场景：**
- task_id 不存在 → 404
- 任务未完成 → 返回 JSON `{"code": 1003, "message": "文件尚未生成"}`

### 2.3 错误码定义

| 错误码 | HTTP 状态码 | 说明 |
|--------|-----------|------|
| 0 | 200 | 成功 |
| 1001 | 500 | 搜索失败（Bilibili API 错误/网络异常） |
| 1002 | 400 | 参数错误（关键词为空/bvid 格式无效） |
| 1003 | 400 | 任务状态错误（如文件未生成时请求下载） |
| 1004 | 500 | 下载失败 |
| 1005 | 500 | 音频转换失败 |
| 1006 | 500 | ffmpeg 不可用 |
| 1007 | 404 | 任务不存在 |

---

## 3. 前端详细设计

### 3.1 文件结构

```
templates/
└── index.html          # 单页面 HTML，包含全部结构
static/
├── css/
│   └── style.css       # 全部样式
└── js/
    └── app.js          # 全部交互逻辑
```

### 3.2 HTML 结构设计（index.html）

```html
<body>
  <!-- 顶部导航栏 -->
  <header class="header">
    <h1 class="logo">Bilibili Music Downloader</h1>
  </header>

  <main class="container">
    <!-- 搜索区域 -->
    <section class="search-section">
      <div class="search-bar">
        <input type="text" id="searchInput" placeholder="请输入歌曲名称...">
        <button id="searchBtn">搜索</button>
      </div>
    </section>

    <!-- 搜索结果列表 -->
    <section id="resultSection" class="result-section hidden">
      <div id="resultList" class="result-list">
        <!-- 动态渲染的搜索结果卡片 -->
      </div>
    </section>

    <!-- 下载任务队列 -->
    <section id="taskSection" class="task-section hidden">
      <h2>下载任务</h2>
      <div id="taskList" class="task-list">
        <!-- 动态渲染的下载任务卡片 -->
      </div>
    </section>
  </main>

  <!-- Toast 通知容器 -->
  <div id="toastContainer" class="toast-container"></div>
</body>
```

### 3.3 搜索结果卡片 HTML 模板

```html
<div class="result-card" data-bvid="BV1xx411c7mD">
  <img class="cover" src="https://i0.hdslb.com/bfs/archive/xxx.jpg" alt="封面">
  <div class="info">
    <h3 class="title">晴天 - 周杰伦 官方MV</h3>
    <p class="meta">
      <span class="author">UP主: 周杰伦官方频道</span>
      <span class="duration">04:52</span>
      <span class="play">播放: 1285万</span>
    </p>
  </div>
  <button class="download-btn" onclick="startDownload('BV1xx411c7mD')">
    下载
  </button>
</div>
```

### 3.4 下载任务卡片 HTML 模板

```html
<div class="task-card" data-task-id="a1b2c3d4-...">
  <div class="task-info">
    <span class="task-name">晴天 - 周杰伦官方频道.mp3</span>
    <span class="task-status">下载中...</span>
  </div>
  <!-- 状态: downloading -->
  <div class="progress-bar">
    <div class="progress-fill" style="width: 68%"></div>
  </div>
  <span class="progress-text">68%  3.2MB / 4.7MB</span>

  <!-- 状态: done 时替换为 -->
  <a class="save-btn" href="/api/file/{task_id}">下载 MP3</a>
</div>
```

### 3.5 CSS 设计规范（style.css）

**设计令牌（Design Tokens）：**

```css
:root {
  /* 哔哩哔哩品牌色 */
  --color-primary: #00A1D6;
  --color-primary-hover: #0094C6;
  --color-primary-light: #E3F6FD;

  /* 语义色 */
  --color-success: #52C41A;
  --color-error: #FF4D4F;
  --color-warning: #FAAD14;
  --color-text: #18191C;
  --color-text-secondary: #9499A0;
  --color-bg: #F4F5F7;
  --color-bg-card: #FFFFFF;
  --color-border: #E3E5E7;

  /* 圆角 */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;

  /* 阴影 */
  --shadow-card: 0 1px 4px rgba(0, 0, 0, 0.08);

  /* 字体 */
  --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                 "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  --font-size-sm: 12px;
  --font-size-base: 14px;
  --font-size-lg: 16px;
  --font-size-xl: 20px;

  /* 布局 */
  --container-width: 900px;
  --header-height: 56px;
}
```

**布局规则：**

- 页面居中布局，最大宽度 `900px`，水平 padding `24px`
- 搜索栏：输入框与按钮水平排列，输入框 `flex: 1`，按钮固定宽度 `80px`
- 搜索结果卡片：水平排列（封面左 + 信息中 + 按钮右），垂直间距 `12px`
- 下载任务卡片：垂直排列，进度条高度 `6px`

**响应式断点：**

| 断点 | 宽度 | 调整 |
|------|------|------|
| 桌面端 | ≥1024px | 默认布局 |
| 平板端 | 768px~1023px | 容器宽度 95%，卡片间距缩小 |
| 移动端 | <768px | 卡片改为纵向排列，封面宽度 100% |

### 3.6 JavaScript 模块设计（app.js）

**全局状态：**

```javascript
const state = {
  tasks: {},          // { taskId: { bvid, status, progress, ... } }
  pollingTimers: {},  // { taskId: intervalId }  — 轮询定时器
};
```

**核心函数：**

```javascript
// === 搜索 ===
async function search(keyword) { ... }
function renderResults(results) { ... }
function showEmptyState() { ... }
function showError(message) { ... }

// === 下载 ===
async function startDownload(bvid) { ... }
function addTaskCard(taskId, bvid) { ... }

// === 进度轮询 ===
function startPolling(taskId) { ... }
function stopPolling(taskId) { ... }
function updateTaskUI(taskId, data) { ... }

// === 工具 ===
function formatFileSize(bytes) { ... }    // 1024 → "1.0 KB"
function showToast(message, type) { ... }  // type: "success" | "error" | "info"
function setLoading(isLoading) { ... }     // 搜索按钮 loading 状态
```

**搜索函数实现逻辑：**

```javascript
async function search(keyword) {
  setLoading(true);
  try {
    const resp = await fetch(`/api/search?keyword=${encodeURIComponent(keyword)}`);
    const json = await resp.json();
    if (json.code === 0 && json.data.results.length > 0) {
      renderResults(json.data.results);
    } else {
      showEmptyState();
    }
  } catch (err) {
    showToast("网络错误，请检查连接", "error");
  } finally {
    setLoading(false);
  }
}
```

**下载函数实现逻辑：**

```javascript
async function startDownload(bvid) {
  try {
    const resp = await fetch(`/api/download/${bvid}`, { method: "POST" });
    const json = await resp.json();
    if (json.code === 0) {
      const taskId = json.data.task_id;
      state.tasks[taskId] = { bvid, status: "downloading", progress: 0 };
      addTaskCard(taskId, bvid);
      startPolling(taskId);
    } else {
      showToast(json.message, "error");
    }
  } catch (err) {
    showToast("下载请求失败", "error");
  }
}
```

**进度轮询函数实现逻辑：**

```javascript
function startPolling(taskId) {
  state.pollingTimers[taskId] = setInterval(async () => {
    try {
      const resp = await fetch(`/api/progress/${taskId}`);
      const json = await resp.json();
      if (json.code === 0) {
        updateTaskUI(taskId, json.data);
        // 任务结束（成功或失败）时停止轮询
        if (json.data.status === "done" || json.data.status === "error") {
          stopPolling(taskId);
        }
      }
    } catch (err) {
      // 网络抖动不中断轮询，静默重试
    }
  }, 1000);  // 每秒轮询一次
}
```

**DOM 操作方式：** 使用 `document.createElement()` + `classList` 操作，不引入任何框架或模板引擎。所有动态内容通过 `innerHTML` 或 `createElement` 渲染。

---

## 4. 数据流

### 4.1 搜索数据流

```
[用户输入] → search("晴天")
     │
     ▼ fetch GET /api/search?keyword=晴天
[Flask 路由] → searcher.search("晴天")
     │
     ▼ requests.get(BILIBILI_SEARCH_URL, params={...})
[Bilibili API] → JSON 响应
     │
     ▼ 解析 JSON → [SearchResult, ...]
[Flask] → JSON 响应 {"code":0, "data":{"results":[...]}}
     │
     ▼ resp.json()
[前端] → renderResults(results) → DOM 更新
```

### 4.2 下载数据流

```
[用户点击下载] → startDownload("BV1xx...")
     │
     ▼ fetch POST /api/download/BV1xx...
[Flask 路由] → TaskManager.create(bvid) → task_id
     │
     ▼ threading.Thread(target=download_and_convert, args=(task,))
[后台线程] → downloader.download(bvid, progress_cb)
     │         progress_cb → TaskManager.update(progress=...)
     │
     ▼ 下载完成
[后台线程] → converter.to_mp3(input_path, output_path)
     │
     ▼ 转换完成
[后台线程] → 清理临时文件 → TaskManager.update(status="done", file_path=...)
     │
[Flask] → {"code":0, "data":{"task_id":"..."}}

[前端] → startPolling(task_id)
     │
     ▼ 每1秒 fetch GET /api/progress/{task_id}
[Flask] → TaskManager.get(task_id) → JSON
     │
     ▼
[前端] → updateTaskUI() → 进度条/状态更新
```

---

## 5. 目录与文件管理

### 5.1 目录结构

```
bilibili-music/
├── main.py                # Flask 应用 + CLI 入口
├── searcher.py            # 搜索模块
├── downloader.py          # 下载模块
├── converter.py           # 转换模块
├── config.py              # 配置常量
├── requirements.txt       # Python 依赖
├── templates/
│   └── index.html         # 前端页面
├── static/
│   ├── css/
│   │   └── style.css      # 样式
│   └── js/
│       └── app.js         # 交互逻辑
├── temp/                  # 临时文件（.gitignore）
│   ├── BV1xx.webm         # yt-dlp 下载的原始文件
│   └── BV1xx.mp3          # ffmpeg 转换中间文件
└── output/                # MP3 最终输出目录
    └── 晴天 - 周杰伦官方频道.mp3
```

### 5.2 文件命名规则

| 文件类型 | 命名规则 | 示例 |
|---------|---------|------|
| 临时下载文件 | `{bvid}.{ext}` | `BV1xx411c7mD.webm` |
| 输出 MP3 | `{歌曲名} - {UP主}.mp3` | `晴天 - 周杰伦官方频道.mp3` |
| 文件名清理 | 移除文件名中的 `\ / : * ? " < > \|` | |

### 5.3 临时文件清理

- 转换成功后，删除 `temp/` 目录下对应的原始下载文件
- 应用启动时，清理 `temp/` 目录下的所有残留文件
- 文件名中的特殊字符使用正则替换为下划线 `_`

---

## 6. 启动与部署

### 6.1 依赖安装

```bash
pip install -r requirements.txt
```

`requirements.txt` 内容：

```
flask>=2.0
flask-cors>=3.0
requests>=2.28
yt-dlp>=2023.1
```

### 6.2 环境检查

应用启动时执行以下检查，任一不满足则打印提示并退出：

| 检查项 | 方式 | 失败提示 |
|--------|------|---------|
| Python 版本 | `sys.version_info >= (3, 8)` | "需要 Python 3.8 或更高版本" |
| ffmpeg | `subprocess.run(["ffmpeg", "-version"])` | "未检测到 ffmpeg，请安装并加入 PATH" |
| 输出目录 | `os.makedirs(OUTPUT_DIR, exist_ok=True)` | 自动创建，不提示 |
| 临时目录 | `os.makedirs(TEMP_DIR, exist_ok=True)` | 自动创建，不提示 |

### 6.3 启动命令

```bash
# Web 模式（默认）
python main.py --web
python main.py --web --port 8080

# CLI 模式
python main.py 晴天
python main.py -o ./my_music 晴天
```

### 6.4 main.py 入口逻辑

```python
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Bilibili Music Downloader")
    parser.add_argument("--web", action="store_true", help="启动 Web 服务")
    parser.add_argument("--port", type=int, default=5000, help="Web 服务端口")
    parser.add_argument("-o", "--output", default="./output", help="输出目录")
    parser.add_argument("keyword", nargs="?", help="搜索关键词（CLI 模式）")

    args = parser.parse_args()

    if args.web:
        # 检查环境 → 初始化 Flask → 启动服务
        app.run(host="0.0.0.0", port=args.port, debug=False)
    elif args.keyword:
        # CLI 模式：搜索 → 选择 → 下载 → 转换
        cli_mode(args.keyword, args.output)
    else:
        parser.print_help()
```

---

## 7. 安全考虑

| 风险 | 措施 |
|------|------|
| 命令注入（ffmpeg/yt-dlp） | bvid 使用正则校验 `^BV[a-zA-Z0-9]+$`，文件名经过 sanitize |
| 路径遍历 | task_id 使用 UUID，文件名清理特殊字符，不拼接用户输入到路径中 |
| Bilibili 风控 | 使用标准浏览器 User-Agent 和 Referer，避免高频请求 |
| 临时文件堆积 | 每次转换成功后清理，启动时清理残留 |
| 大文件下载耗尽磁盘 | 可选：在下载前检查可用磁盘空间（后续版本） |

---

## 8. 测试方案

### 8.1 后端单元测试

| 模块 | 测试内容 | 方法 |
|------|---------|------|
| `searcher` | API 响应解析正确性 | Mock `requests.get`，验证 SearchResult 字段映射 |
| `searcher` | 网络异常处理 | Mock 抛出异常，验证 SearchError |
| `converter` | ffmpeg 命令生成 | Mock `subprocess.run`，验证命令参数 |
| `converter` | ffmpeg 不可用 | Mock `FileNotFoundError`，验证 `check_ffmpeg` 返回 False |
| API 路由 | `/api/search` 请求响应 | Flask test_client，验证 JSON 结构和状态码 |
| API 路由 | `/api/download` 任务创建 | 验证返回 task_id，验证 TaskManager 状态 |
| API 路由 | 参数校验 | 传入空关键词/无效 bvid，验证错误码 |

### 8.2 前端测试

| 测试内容 | 方法 |
|---------|------|
| 搜索渲染 | Mock API 响应，验证结果卡片 DOM 结构 |
| 进度轮询 | Mock `/api/progress` 响应，验证进度条更新 |
| 错误提示 | Mock API 返回错误，验证 Toast 显示 |
| 空状态 | Mock 返回空列表，验证空状态提示显示 |
| 输入校验 | 提交空关键词，验证按钮禁用态 |

### 8.3 集成测试

| 测试场景 | 方法 |
|---------|------|
| 完整下载流程 | 搜索 → 点击下载 → 等待完成 → 下载 MP3，验证文件存在且可播放 |
| 多任务并发 | 同时触发 2 个下载，验证互不干扰 |
| 服务异常恢复 | 下载中途杀进程重启，验证残留文件被清理 |
