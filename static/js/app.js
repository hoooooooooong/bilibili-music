// ── Theme Logic ──────────────────────────────────
const $themeToggle = document.getElementById("themeToggle");
const currentTheme = localStorage.getItem("theme") || "light";

if (currentTheme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
}

function toggleTheme(e) {
    const theme = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    localStorage.setItem("theme", theme);

    // 浏览器支持 View Transitions API 时使用圆形动画
    if (document.startViewTransition) {
        const transition = document.startViewTransition(() => {
            document.documentElement.setAttribute("data-theme", theme);
        });

        transition.ready.then(() => {
            const { clientX, clientY } = e;
            const radius = Math.hypot(
                Math.max(clientX, innerWidth - clientX),
                Math.max(clientY, innerHeight - clientY)
            );

            if (theme === "dark") {
                // 深色：new（深色）在上层，从点击处向外扩张
                document.documentElement.animate(
                    {
                        clipPath: [
                            `circle(0% at ${clientX}px ${clientY}px)`,
                            `circle(${radius}px at ${clientX}px ${clientY}px)`,
                        ],
                    },
                    {
                        duration: 500,
                        easing: "ease-out",
                        fill: "forwards",
                        pseudoElement: "::view-transition-new(root)",
                    }
                );
            } else {
                // 浅色：需要 old（深色）在上层收缩，露出 new（浅色）
                const style = document.createElement("style");
                style.id = "vt-z-index-fix";
                style.textContent = `
                    ::view-transition-old(root) { z-index: 9999 !important; }
                    ::view-transition-new(root) { z-index: 1 !important; }
                `;
                document.head.appendChild(style);

                document.documentElement.animate(
                    {
                        clipPath: [
                            `circle(${radius}px at ${clientX}px ${clientY}px)`,
                            `circle(0% at ${clientX}px ${clientY}px)`,
                        ],
                    },
                    {
                        duration: 500,
                        easing: "ease-in",
                        fill: "forwards",
                        pseudoElement: "::view-transition-old(root)",
                    }
                );

                transition.finished.then(() => style.remove());
            }
        });
    } else {
        document.documentElement.setAttribute("data-theme", theme);
    }

    showToast(`已切换至${theme === "dark" ? "深色" : "浅色"}模式`, "info");
}

$themeToggle.addEventListener("click", toggleTheme);

// ── Skeleton Loader ──────────────────────────────
const $skeletonLoader = document.getElementById("skeletonLoader");

function toggleSkeleton(show) {
    if (show) {
        $skeletonLoader.classList.remove("hidden");
        $resultSection.classList.add("hidden");
    } else {
        $skeletonLoader.classList.add("hidden");
    }
}

// ── Audio Cache (IndexedDB) ──────────────────
class AudioCache {
    constructor() {
        this.db = null;
        this.maxSize = 500 * 1024 * 1024; // 500MB
        this.DB_NAME = "bili_music_cache";
        this.STORE = "audio";
    }

    init() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.DB_NAME, 1);
            req.onupgradeneeded = (e) => {
                e.target.result.createObjectStore(this.STORE, { keyPath: "bvid" });
            };
            req.onsuccess = (e) => { this.db = e.target.result; resolve(); };
            req.onerror = () => reject(req.error);
        });
    }

    get(bvid) {
        return new Promise((resolve) => {
            try {
                const req = this.db.transaction(this.STORE, "readonly").objectStore(this.STORE).get(bvid);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            } catch { resolve(null); }
        });
    }

    async put(bvid, blob, title) {
        await this.evictIfNeeded(blob.size);
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.STORE, "readwrite");
            tx.objectStore(this.STORE).put({ bvid, blob, title, size: blob.size, ts: Date.now() });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async evictIfNeeded(needed) {
        const all = await this.getAll();
        const total = all.reduce((s, i) => s + i.size, 0);
        if (total + needed <= this.maxSize) return;
        all.sort((a, b) => a.ts - b.ts);
        for (const item of all) {
            if (total + needed <= this.maxSize) break;
            await this.remove(item.bvid);
            total -= item.size;
        }
    }

    remove(bvid) {
        return new Promise((resolve) => {
            try {
                const tx = this.db.transaction(this.STORE, "readwrite");
                tx.objectStore(this.STORE).delete(bvid);
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            } catch { resolve(); }
        });
    }

    getAll() {
        return new Promise((resolve) => {
            try {
                const req = this.db.transaction(this.STORE, "readonly").objectStore(this.STORE).getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => resolve([]);
            } catch { resolve([]); }
        });
    }

    async getSize() {
        const all = await this.getAll();
        return all.reduce((s, i) => s + i.size, 0);
    }

    url(blob) {
        return URL.createObjectURL(blob);
    }

    async clear() {
        return new Promise((resolve) => {
            try {
                const tx = this.db.transaction(this.STORE, "readwrite");
                tx.objectStore(this.STORE).clear();
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            } catch { resolve(); }
        });
    }
}

const audioCache = new AudioCache();
audioCache.init().catch(() => {});

// ── State ────────────────────────────────────────
const state = {
    tasks: {},
    pollingTimers: {},
    currentBvid: null,
    playMode: "sequential", // sequential | loop | random
    playlist: [],           // current visible bvid list
    activeTab: "search",
    searchResults: [],      // raw search results for fav toggle
    searchKeyword: "",
    searchPage: 1,
    searchHasMore: true,
    favPage: 1,
    favPageSize: 10,
};

// ── Audio Element ────────────────────────────────
const audio = new Audio();
audio.preload = "metadata";

// ── Volume ──────────────────────────────────────
const savedVolume = localStorage.getItem("bili_volume");
if (savedVolume !== null) audio.volume = savedVolume / 100;
const $volumeBtn = document.getElementById("volumeBtn");
const $volumeSlider = document.getElementById("volumeSlider");
const $volumeWrap = document.getElementById("volumeWrap");

function setVolume(val, syncSlider) {
    val = Math.max(0, Math.min(100, val));
    audio.volume = val / 100;
    localStorage.setItem("bili_volume", val);
    $volumeSlider.value = val;
    if (syncSlider !== false) $volumeSlider.value = val;
    const $fpVolSlider = document.getElementById("fpVolumeSlider");
    if ($fpVolSlider) $fpVolSlider.value = val;
    // 更新静音图标
    const muted = val === 0;
    $volumeWrap.classList.toggle("muted", muted);
    // 更新滑块背景渐变
    const grad = `linear-gradient(to right, var(--primary) ${val}%, var(--border) ${val}%)`;
    $volumeSlider.style.background = grad;
    if ($fpVolSlider) {
        const fpGrad = `linear-gradient(to right, #fff ${val}%, rgba(255,255,255,0.15) ${val}%)`;
        $fpVolSlider.style.background = fpGrad;
    }
}

// 初始化音量显示
setVolume(savedVolume !== null ? parseInt(savedVolume) : 100);

$volumeSlider.addEventListener("input", (e) => setVolume(parseInt(e.target.value)));

$volumeBtn.addEventListener("click", () => {
    if (audio.volume > 0) {
        $volumeBtn._prevVol = Math.round(audio.volume * 100);
        setVolume(0);
    } else {
        setVolume($volumeBtn._prevVol || 80);
    }
});

// 全屏播放器音量
const $fpVolumeRow = document.getElementById("fpVolumeRow");
const $fpVolumeBtn = document.getElementById("fpVolumeBtn");

document.getElementById("fpVolumeSlider").addEventListener("input", (e) => setVolume(parseInt(e.target.value)));

$fpVolumeBtn.addEventListener("click", () => {
    if ($fpVolumeRow.classList.contains("show")) {
        $fpVolumeRow.classList.remove("show");
        $fpVolumeRow.classList.add("hidden");
    } else {
        $fpVolumeRow.classList.remove("hidden");
        $fpVolumeRow.classList.add("show");
    }
});

// ── SVG Icons ────────────────────────────────────
const ICONS = {
    play: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
    heart: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    heartFill: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    delete: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    download: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    modeSeq: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
    modeLoop: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
    modeRandom: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>',
};

const MODE_ICONS = { sequential: ICONS.modeSeq, loop: ICONS.modeLoop, random: ICONS.modeRandom };
const MODE_TITLES = { sequential: "顺序播放", loop: "单曲循环", random: "随机播放" };

// ── DOM References ───────────────────────────────
const $searchInput = document.getElementById("searchInput");
const $resultSection = document.getElementById("resultSection");
const $welcomeSection = document.getElementById("welcomeSection");
const $resultList = document.getElementById("resultList");
const $resultCount = document.getElementById("resultCount");
const $toastContainer = document.getElementById("toastContainer");
const $favList = document.getElementById("favList");
const $favEmpty = document.getElementById("favEmpty");
const $favTotal = document.getElementById("favTotal");
const $favCount = document.getElementById("favCount");

// Player
const $playerBar = document.getElementById("playerBar");
const $playerInfo = document.querySelector(".player-info");
const $playerName = document.getElementById("playerName");
const $playerCover = document.getElementById("playerCover");
const $playerToggleBtn = document.getElementById("playerToggleBtn");
const $playerPrevTrackBtn = document.getElementById("playerPrevTrackBtn");
const $playerNextTrackBtn = document.getElementById("playerNextTrackBtn");
const $playerCurrent = document.getElementById("playerCurrent");
const $playerDuration = document.getElementById("playerDuration");
const $playerCloseBtn = document.getElementById("playerCloseBtn");
const $playerProgressFill = document.getElementById("playerProgressFill");
const $playerProgressBg = document.getElementById("playerProgressBg");
const $playerModeBtn = document.getElementById("playerModeBtn");

// ── Event Delegation (play, fav, download) ───────
document.addEventListener("click", (e) => {
    const playBtn = e.target.closest(".play-btn");
    if (playBtn) {
        const card = playBtn.closest(".result-card");
        if (!card) return;
        const bvid = card.dataset.bvid;
        // Use the current tab's bvid list as playlist
        const bvids = getCurrentBvids();
        playOnline(bvid, bvids);
        return;
    }

    const favBtn = e.target.closest(".fav-btn");
    if (favBtn) {
        const card = favBtn.closest(".result-card");
        if (!card) return;
        const bvid = card.dataset.bvid;
        // Find song data from search results or favorites
        const song = findSongData(bvid);
        if (song) toggleFavorite(song);
        return;
    }

    const delBtn = e.target.closest(".del-btn");
    if (delBtn) {
        const card = delBtn.closest(".result-card");
        if (!card) return;
        removeFavorite(card.dataset.bvid);
        return;
    }

    const dlBtn = e.target.closest(".download-btn");
    if (dlBtn && !dlBtn.disabled) {
        const card = dlBtn.closest(".result-card");
        if (!card) return;
        startDownload(card.dataset.bvid);
        return;
    }
});

function getCurrentBvids() {
    if (state.activeTab === "favorites") {
        return getFavorites().map(f => f.bvid);
    }
    return state.searchResults.map(r => r.bvid);
}

function findSongData(bvid) {
    // Search in search results first, then favorites
    let song = state.searchResults.find(r => r.bvid === bvid);
    if (!song) song = getFavorites().find(f => f.bvid === bvid);
    return song;
}

// ── Favorites (localStorage) ─────────────────────
function getFavorites() {
    try {
        return JSON.parse(localStorage.getItem("bili_favorites") || "[]").reverse();
    } catch { return []; }
}

function saveFavorites(list) {
    localStorage.setItem("bili_favorites", JSON.stringify(list));
}

function isFavorited(bvid) {
    return getFavorites().some(f => f.bvid === bvid);
}

function toggleFavorite(song) {
    let favs = getFavorites();
    const idx = favs.findIndex(f => f.bvid === song.bvid);
    if (idx >= 0) {
        favs.splice(idx, 1);
        saveFavorites(favs);
        showToast("已取消收藏", "info");
    } else {
        favs.push(song);
        saveFavorites(favs);
        showToast("已添加到收藏", "success");
    }
    updateFavCount();
    updateAllFavButtons();
    if (state.activeTab === "favorites") renderFavorites();
}

function removeFavorite(bvid) {
    let favs = getFavorites();
    favs = favs.filter(f => f.bvid !== bvid);
    saveFavorites(favs);
    updateFavCount();
    updateAllFavButtons();
    renderFavorites();
    showToast("已取消收藏", "info");
}

function updateFavCount() {
    const count = getFavorites().length;
    if (count > 0) {
        $favCount.textContent = count;
        $favCount.classList.remove("hidden");
    } else {
        $favCount.classList.add("hidden");
    }
}

function updateAllFavButtons() {
    document.querySelectorAll(".fav-btn").forEach(btn => {
        const bvid = btn.dataset.bvid;
        if (isFavorited(bvid)) {
            btn.innerHTML = ICONS.heartFill;
            btn.classList.add("is-fav");
            btn.title = "取消收藏";
        } else {
            btn.innerHTML = ICONS.heart;
            btn.classList.remove("is-fav");
            btn.title = "收藏";
        }
    });
}

// ── Header Fav Button ────────────────────────────
const $favTabBtn = document.getElementById("favTabBtn");

$favTabBtn.addEventListener("click", () => {
    if (state.activeTab === "favorites") {
        goHome();
    } else {
        switchTab("favorites");
    }
});

function goHome() {
    state.searchKeyword = "";
    state.searchResults = [];
    $searchInput.value = "";
    $resultList.innerHTML = "";
    $resultSection.classList.add("hidden");
    $welcomeSection.classList.remove("hidden");
    $favTabBtn.classList.remove("is-active");
    if ($historyTabBtn) $historyTabBtn.classList.remove("is-active");
    document.getElementById("searchTab").classList.add("hidden");
    document.getElementById("favoritesTab").classList.add("hidden");
    if ($historyTab) $historyTab.classList.add("hidden");
    state.activeTab = "search";
}

// ── Play Mode ────────────────────────────────────
const MODES = ["sequential", "loop", "random"];

$playerModeBtn.addEventListener("click", () => {
    const idx = MODES.indexOf(state.playMode);
    state.playMode = MODES[(idx + 1) % MODES.length];
    $playerModeBtn.innerHTML = MODE_ICONS[state.playMode];
    $playerModeBtn.title = MODE_TITLES[state.playMode];
    $playerModeBtn.classList.toggle("mode-active", state.playMode !== "sequential");
    showToast(MODE_TITLES[state.playMode], "info");
});

// ── Event Bindings ───────────────────────────────
$searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        const keyword = $searchInput.value.trim();
        if (!keyword) {
            $searchInput.classList.add("shake");
            setTimeout(() => $searchInput.classList.remove("shake"), 350);
            return;
        }
        search(keyword);
    }
});

// Player events
$playerToggleBtn.addEventListener("click", togglePlay);
$playerPrevTrackBtn.addEventListener("click", playPrevTrack);
$playerNextTrackBtn.addEventListener("click", playNextTrack);
$playerCloseBtn.addEventListener("click", closePlayer);

// ── Draggable Progress Seek ──────────────────
function enableDragSeek(barEl, fillEl, onSeek) {
    let dragging = false;
    let startX = 0;
    let moved = false;

    function getPct(e) {
        const rect = barEl.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    }

    function onStart(e) {
        if (!audio.duration) return;
        dragging = true;
        moved = false;
        startX = e.touches ? e.touches[0].clientX : e.clientX;
        barEl.classList.add("seeking");
        fillEl.classList.add("seeking");
        const pct = getPct(e);
        onSeek(pct, true);
    }

    function onMove(e) {
        if (!dragging) return;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        if (Math.abs(clientX - startX) > 3) moved = true;
        const pct = getPct(e);
        onSeek(pct, true);
    }

    function onEnd(e) {
        if (!dragging) return;
        dragging = false;
        barEl.classList.remove("seeking");
        fillEl.classList.remove("seeking");
        if (!moved) {
            // 点击：用动画 seek
            const pct = getPct(e.changedTouches ? e.changedTouches[0] || e : e);
            onSeek(pct, false);
        } else {
            // 拖拽结束：seek 到最终位置
            const clientX = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
            const rect = barEl.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            onSeek(pct, false);
        }
    }

    barEl.addEventListener("mousedown", onStart);
    barEl.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("mousemove", onMove);
    document.addEventListener("touchmove", onMove, { passive: true });
    document.addEventListener("mouseup", onEnd);
    document.addEventListener("touchend", onEnd);
}

enableDragSeek($playerProgressBg, $playerProgressFill, (pct, preview) => {
    $playerProgressFill.style.width = (pct * 100) + "%";
    if (!preview) audio.currentTime = audio.duration * pct;
});

audio.addEventListener("timeupdate", () => {
    if (!audio.duration) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    $playerProgressFill.style.width = pct + "%";
    $playerCurrent.textContent = formatTime(audio.currentTime);
    lyricsPanel.updateTime(audio.currentTime);
});

audio.addEventListener("loadedmetadata", () => {
    $playerDuration.textContent = formatTime(audio.duration);
    $playerName.textContent = $playerName.dataset.title || $playerName.textContent;
    showToast("正在播放", "success");
});

audio.addEventListener("ended", () => {
    playNext();
});

audio.addEventListener("error", () => {
    setPlayerPlayIcon(false);
    $playerName.textContent = ($playerName.dataset.title || "未在播放") + " (加载失败)";
    showToast("音频加载失败，请检查网络后重试", "error");
});

// ── Player Functions ─────────────────────────────
function setPlayerPlayIcon(isPlaying) {
    $playerToggleBtn.querySelector(".icon-play").style.display = isPlaying ? "none" : "block";
    $playerToggleBtn.querySelector(".icon-pause").style.display = isPlaying ? "block" : "none";
}

async function playOnline(bvid, playlist) {
    if (playlist) state.playlist = playlist;

    if (state.currentBvid === bvid && audio.src && !audio.ended) {
        togglePlay();
        return;
    }

    state.currentBvid = bvid;

    const card = document.querySelector(`.result-card[data-bvid="${bvid}"]`);
    const title = card ? card.querySelector(".title").textContent : bvid;
    const cover = card ? card.querySelector(".cover") : null;
    const coverSrc = cover ? cover.src : "";

    $playerName.textContent = "加载中...";
    $playerName.dataset.title = title;
    $playerName.title = title;
    $playerCover.src = coverSrc;
    $playerCover.style.display = coverSrc ? "block" : "none";
    $playerBar.classList.remove("hidden");
    setPlayerPlayIcon(true);
    $playerCurrent.textContent = "0:00";
    $playerDuration.textContent = "...";
    $playerProgressFill.style.width = "0%";

    // 尝试从缓存加载
    const cached = await audioCache.get(bvid);
    if (cached) {
        audio.src = audioCache.url(cached.blob);
    } else {
        audio.src = `/api/play/${bvid}`;
        // 后台缓存
        fetch(`/api/play/${bvid}`)
            .then(r => r.blob())
            .then(blob => audioCache.put(bvid, blob, title))
            .catch(() => {});
    }

    lyricsPanel.load(bvid);
    updateMediaSession(title, card ? (card.querySelector(".author")?.textContent || "") : "", `/api/cover/${bvid}`);
    audio.play().catch(() => {
        setPlayerPlayIcon(false);
        $playerName.textContent = title + " (加载失败)";
        showToast("播放失败，请检查网络后重试", "error");
    });
    updatePlayingHighlight(bvid);
}

function playNext() {
    if (!state.currentBvid || state.playlist.length === 0) return;

    const idx = state.playlist.indexOf(state.currentBvid);
    let next;

    switch (state.playMode) {
        case "loop":
            audio.currentTime = 0;
            audio.play();
            return;
        case "sequential":
            next = idx + 1;
            if (next >= state.playlist.length) next = 0;
            break;
        case "random":
            if (state.playlist.length === 1) {
                audio.currentTime = 0;
                audio.play();
                return;
            }
            do { next = Math.floor(Math.random() * state.playlist.length); } while (next === idx);
            break;
    }

    playOnline(state.playlist[next]);
}

function playPrevTrack() {
    if (!state.currentBvid || state.playlist.length === 0) return;

    const idx = state.playlist.indexOf(state.currentBvid);

    // If played more than 3 seconds, restart current song
    if (audio.currentTime > 3) {
        audio.currentTime = 0;
        return;
    }

    let prev;
    switch (state.playMode) {
        case "random":
            if (state.playlist.length === 1) {
                audio.currentTime = 0;
                return;
            }
            do { prev = Math.floor(Math.random() * state.playlist.length); } while (prev === idx);
            break;
        default:
            prev = idx - 1;
            if (prev < 0) prev = state.playlist.length - 1;
            break;
    }

    playOnline(state.playlist[prev]);
}

function playNextTrack() {
    playNext();
}

function togglePlay() {
    if (!audio.src) return;
    if (audio.paused) {
        audio.play();
        setPlayerPlayIcon(true);
        updatePlayingHighlight(state.currentBvid);
    } else {
        audio.pause();
        setPlayerPlayIcon(false);
        // Clear card playing state but keep highlight on current song
        document.querySelectorAll(".result-card .play-btn").forEach(btn => {
            btn.classList.remove("is-playing");
            btn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
        });
    }
}

function closePlayer() {
    audio.pause();
    audio.src = "";
    state.currentBvid = null;
    $playerCover.src = "";
    $playerBar.classList.add("hidden");
    lyricsPanel.reset();
    updatePlayingHighlight(null);
}

function updatePlayingHighlight(bvid) {
    const playSvg = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    const pauseSvg = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
    document.querySelectorAll(".result-card").forEach(c => {
        c.classList.remove("playing");
        const btn = c.querySelector(".play-btn");
        if (btn) {
            btn.classList.remove("is-playing");
            btn.innerHTML = playSvg;
        }
    });
    if (bvid) {
        const card = document.querySelector(`.result-card[data-bvid="${bvid}"]`);
        if (card) {
            card.classList.add("playing");
            const btn = card.querySelector(".play-btn");
            if (btn) {
                btn.classList.add("is-playing");
                btn.innerHTML = pauseSvg;
            }
        }
    }
}

function formatTime(sec) {
    if (!sec || isNaN(sec)) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── Search ───────────────────────────────────────
async function search(keyword, page) {
    if (page === undefined) page = 1;
    state.searchKeyword = keyword;
    state.searchPage = page;
    setLoading(true);
    if (page === 1) {
        $resultList.innerHTML = "";
        toggleSkeleton(true);
    }
    
    try {
        const resp = await fetch(`/api/search?keyword=${encodeURIComponent(keyword)}&page=${page}`);
        const json = await resp.json();

        if (json.code === 0 && json.data.results.length > 0) {
            renderResults(json.data.results, page, json.data.total, json.data.page_size);
            switchTab("search");
        } else if (json.code === 0 && page === 1) {
            showEmptyState();
            switchTab("search");
        } else if (json.code === 0) {
            state.searchPage = page - 1;
            showToast("没有更多结果了", "info");
        } else {
            showToast(json.message || "搜索失败", "error");
        }
    } catch (err) {
        showToast("网络错误，请检查连接", "error");
    } finally {
        setLoading(false);
        toggleSkeleton(false);
    }
}

function renderResults(results, page, total, pageSize) {
    state.searchResults = results;
    $welcomeSection.classList.add("hidden");
    $resultSection.classList.remove("hidden");
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    $resultCount.textContent = `共 ${total} 条`;

    $resultList.innerHTML = results.map(renderCard).join("");
    renderSearchPagination(page, totalPages);
}

function renderSearchPagination(currentPage, totalPages) {
    const $pag = document.getElementById("searchPagination");

    if (totalPages <= 1) {
        $pag.classList.add("hidden");
        return;
    }

    $pag.classList.remove("hidden");
    let pages = buildPageNumbers(currentPage, totalPages);
    let html = `<button class="page-btn" ${currentPage > 1 ? "" : "disabled"} data-search-page="${currentPage - 1}">&lsaquo;</button>`;

    for (const p of pages) {
        if (p === "...") {
            html += `<span class="page-dots">...</span>`;
        } else {
            html += `<button class="page-btn ${p === currentPage ? "active" : ""}" data-search-page="${p}">${p}</button>`;
        }
    }

    html += `<button class="page-btn" ${currentPage < totalPages ? "" : "disabled"} data-search-page="${currentPage + 1}">&rsaquo;</button>`;
    $pag.innerHTML = html;
}

// Handle search pagination clicks
document.addEventListener("click", (e) => {
    const pageBtn = e.target.closest("[data-search-page]");
    if (pageBtn && !pageBtn.disabled) {
        search(state.searchKeyword, parseInt(pageBtn.dataset.searchPage));
    }
});

function showEmptyState() {
    $welcomeSection.classList.add("hidden");
    $resultSection.classList.remove("hidden");
    $resultCount.textContent = "";
    $resultList.innerHTML = `
        <div class="state-message">
            <span class="icon">&#128269;</span>
            未找到相关视频，请尝试其他关键词
        </div>`;
}

// ── Favorites Render ─────────────────────────────
function renderFavorites() {
    const favs = getFavorites();
    const total = favs.length;
    const pageSize = state.favPageSize;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    // Clamp current page
    if (state.favPage > totalPages) state.favPage = totalPages;

    if (total === 0) {
        $favList.innerHTML = "";
        document.getElementById("favPagination").classList.add("hidden");
        $favEmpty.classList.remove("hidden");
        $favTotal.textContent = "";
        return;
    }

    $favEmpty.classList.add("hidden");
    $favTotal.textContent = `共 ${total} 首`;

    const start = (state.favPage - 1) * pageSize;
    const pageItems = favs.slice(start, start + pageSize);

    $favList.innerHTML = pageItems.map(r => {
        const coverSrc = r.bvid ? `/api/cover/${r.bvid}` : r.cover_url;
        return `
        <div class="result-card" data-bvid="${r.bvid}">
            <div class="card-cover">
                <img class="cover" src="${escapeAttr(coverSrc)}" alt="" loading="lazy"
                     onerror="this.parentElement.style.display='none'">
                <button class="play-btn" title="播放">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </button>
                <span class="card-duration">${escapeHtml(r.duration)}</span>
            </div>
            <div class="card-body">
                <h3 class="title" title="${escapeAttr(r.title)}">${escapeHtml(r.title)}</h3>
                <p class="author">${escapeHtml(r.author)}</p>
                <div class="card-meta"></div>
                <div class="card-actions">
                    <button class="fav-btn is-fav" data-bvid="${r.bvid}" title="取消收藏">
                        ${ICONS.heartFill}
                    </button>
                    <button class="del-btn" title="移除">${ICONS.delete}</button>
                </div>
            </div>
        </div>`;
    }).join("");

    // Render pagination
    renderFavPagination(state.favPage, totalPages);
    updatePlayingHighlight(state.currentBvid);
}

function renderFavPagination(currentPage, totalPages) {
    const $pag = document.getElementById("favPagination");

    if (totalPages <= 1) {
        $pag.classList.add("hidden");
        return;
    }

    $pag.classList.remove("hidden");
    let pages = buildPageNumbers(currentPage, totalPages);
    let html = `<button class="page-btn" ${currentPage > 1 ? "" : "disabled"} data-fav-page="${currentPage - 1}">&lsaquo;</button>`;

    for (const p of pages) {
        if (p === "...") {
            html += `<span class="page-dots">...</span>`;
        } else {
            html += `<button class="page-btn ${p === currentPage ? "active" : ""}" data-fav-page="${p}">${p}</button>`;
        }
    }

    html += `<button class="page-btn" ${currentPage < totalPages ? "" : "disabled"} data-fav-page="${currentPage + 1}">&rsaquo;</button>`;
    $pag.innerHTML = html;
}

// Handle fav pagination clicks
document.addEventListener("click", (e) => {
    const pageBtn = e.target.closest("[data-fav-page]");
    if (pageBtn && !pageBtn.disabled) {
        state.favPage = parseInt(pageBtn.dataset.favPage);
        renderFavorites();
    }
});

// ── Shared Card Template ────────────────────────
function renderCard(r) {
    const coverSrc = r.bvid ? `/api/cover/${r.bvid}` : r.cover_url;
    const favClass = isFavorited(r.bvid) ? "is-fav" : "";
    const favIcon = isFavorited(r.bvid) ? ICONS.heartFill : ICONS.heart;
    const favTitle = isFavorited(r.bvid) ? "取消收藏" : "收藏";
    return `
        <div class="result-card" data-bvid="${r.bvid}">
            <div class="card-cover">
                <img class="cover" src="${escapeAttr(coverSrc)}" alt="" loading="lazy"
                     onerror="this.parentElement.style.display='none'">
                <button class="play-btn" title="播放">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </button>
                <span class="card-duration">${escapeHtml(r.duration)}</span>
            </div>
            <div class="card-body">
                <h3 class="title" title="${escapeAttr(r.title)}">${escapeHtml(r.title)}</h3>
                <p class="author">${escapeHtml(r.author)}</p>
                <div class="card-meta">
                    <span>${ICONS.eye} ${escapeHtml(r.play_count_text)}</span>
                </div>
                <div class="card-progress hidden">
                    <div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>
                    <span class="progress-text">准备下载...</span>
                </div>
                <div class="card-actions">
                    <button class="fav-btn ${favClass}" data-bvid="${r.bvid}" title="${favTitle}">${favIcon}</button>
                    <button class="download-btn">${ICONS.download}</button>
                </div>
            </div>
        </div>`;
}

// ── Page Number Builder ─────────────────────────
function buildPageNumbers(current, total) {
    if (total <= 7) {
        return Array.from({ length: total }, (_, i) => i + 1);
    }
    const pages = [];
    pages.push(1);
    if (current > 3) pages.push("...");
    for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) {
        pages.push(i);
    }
    if (current < total - 2) pages.push("...");
    pages.push(total);
    return pages;
}

// ── Download ─────────────────────────────────────
async function startDownload(bvid) {
    const card = document.querySelector(`.result-card[data-bvid="${bvid}"]`);
    if (!card) return;

    const btn = card.querySelector(".download-btn");
    const progressWrap = card.querySelector(".card-progress");
    const progressFill = card.querySelector(".progress-fill");
    const progressText = card.querySelector(".progress-text");

    btn.disabled = true;
    btn.innerHTML = `${ICONS.download} 等待中`;
    progressWrap.classList.remove("hidden");
    progressFill.style.width = "0%";
    progressFill.classList.remove("error", "converting");
    progressText.textContent = "准备下载...";

    try {
        const resp = await fetch(`/api/download/${bvid}`, { method: "POST" });
        const json = await resp.json();

        if (json.code === 0) {
            const taskId = json.data.task_id;
            state.tasks[taskId] = { bvid };
            startPolling(taskId);
            showToast("下载任务已创建", "success");
        } else {
            showToast(json.message || "下载请求失败", "error");
            resetCardButton(card);
        }
    } catch (err) {
        showToast("下载请求失败", "error");
        resetCardButton(card);
    }
}

function resetCardButton(card) {
    const btn = card.querySelector(".download-btn");
    const progressWrap = card.querySelector(".card-progress");
    if (btn) {
        btn.disabled = false;
        btn.innerHTML = `${ICONS.download} 下载`;
        btn.classList.remove("is-done");
    }
    if (progressWrap) {
        progressWrap.classList.add("hidden");
    }
}

// ── Progress Polling ─────────────────────────────
function startPolling(taskId) {
    state.pollingTimers[taskId] = setInterval(async () => {
        try {
            const resp = await fetch(`/api/progress/${taskId}`);
            const json = await resp.json();

            if (json.code === 0) {
                updateCardUI(taskId, json.data);

                if (json.data.status === "done" || json.data.status === "error") {
                    stopPolling(taskId);
                }
            }
        } catch (err) {
            // Silent retry
        }
    }, 1000);
}

function stopPolling(taskId) {
    if (state.pollingTimers[taskId]) {
        clearInterval(state.pollingTimers[taskId]);
        delete state.pollingTimers[taskId];
    }
}

function updateCardUI(taskId, data) {
    const taskInfo = state.tasks[taskId];
    if (!taskInfo) return;

    const card = document.querySelector(`.result-card[data-bvid="${taskInfo.bvid}"]`);
    if (!card) return;

    const btn = card.querySelector(".download-btn");
    const progressFill = card.querySelector(".progress-fill");
    const progressText = card.querySelector(".progress-text");

    switch (data.status) {
        case "pending":
            btn.innerHTML = `${ICONS.download} 等待中`;
            break;

        case "downloading":
            btn.innerHTML = `${ICONS.download} ${data.progress.toFixed(0)}%`;
            btn.disabled = true;
            progressFill.style.width = `${data.progress}%`;
            progressFill.classList.remove("error", "converting");
            progressText.textContent = `${data.downloaded_text} / ${data.total_text}`;
            break;

        case "converting":
            btn.innerHTML = `${ICONS.download} 转换中`;
            btn.disabled = true;
            progressFill.style.width = "100%";
            progressFill.classList.remove("error");
            progressFill.classList.add("converting");
            progressText.textContent = "正在转换为 MP3 ...";
            break;

        case "done":
            btn.disabled = false;
            btn.classList.add("is-done");
            btn.innerHTML = `${ICONS.download} 保存文件`;
            btn.onclick = () => { window.location.href = `/api/file/${taskId}`; };
            progressFill.style.width = "100%";
            progressFill.classList.remove("converting");
            progressText.textContent = "转换完成";
            showToast(`${data.file_name} 转换完成`, "success");
            break;

        case "error":
            btn.innerHTML = `${ICONS.download} 重试`;
            btn.disabled = false;
            btn.classList.remove("is-done");
            btn.onclick = () => startDownload(taskInfo.bvid);
            progressFill.classList.add("error");
            progressFill.classList.remove("converting");
            progressText.textContent = data.error_message || "未知错误";
            showToast(data.error_message || "任务失败", "error");
            break;
    }
}

// ── Utilities ────────────────────────────────────
function setLoading(isLoading) {
    $searchInput.disabled = isLoading;
}

function showToast(message, type = "info") {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    $toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transition = "opacity 0.3s";
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

function escapeAttr(str) {
    return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Lyrics (inline in player bar) ────────────
const $playerLyricsBtn = document.getElementById("playerLyricsBtn");
const $lyricsArea = document.getElementById("lyricsArea");
const $lyricsLine = document.getElementById("lyricsLine");
const $lyricsLineNext = document.getElementById("lyricsLineNext");

class LyricsPanel {
    constructor() {
        this.visible = false;
        this.lyrics = [];
        this.currentIndex = -1;
        this.bvid = null;
    }

    toggle() {
        this.visible ? this.hide() : this.show();
    }

    show() {
        $lyricsArea.classList.add("show");
        $playerLyricsBtn.classList.add("lyrics-active");
        this.visible = true;
        if (this.lyrics.length > 0 && audio.currentTime > 0) {
            this.updateTime(audio.currentTime);
        }
    }

    hide() {
        $lyricsArea.classList.remove("show");
        $playerLyricsBtn.classList.remove("lyrics-active");
        this.visible = false;
    }

    async load(bvid) {
        if (this.bvid === bvid) return;
        this.bvid = bvid;
        this.lyrics = [];
        this.currentIndex = -1;
        $lyricsLine.textContent = "歌词加载中...";

        try {
            const resp = await fetch(`/api/lyrics/${bvid}`);
            const json = await resp.json();
            if (json.code === 0 && json.data.lyrics && json.data.lyrics.length > 0) {
                this.lyrics = json.data.lyrics;
                if (this.visible) {
                    this.updateTime(audio.currentTime);
                }
            } else {
                $lyricsLine.textContent = "暂无歌词";
            }
        } catch (err) {
            $lyricsLine.textContent = "歌词加载失败";
        }
    }

    updateTime(currentTime) {
        if (!this.visible || this.lyrics.length === 0) return;

        let low = 0, high = this.lyrics.length - 1;
        let idx = 0;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (this.lyrics[mid][0] <= currentTime) {
                idx = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        if (idx !== this.currentIndex) {
            this.showLine(idx);
        }
    }

    showLine(idx) {
        this.currentIndex = idx;
        const text = this.lyrics[idx][1];

        // 当前行向上滚出，新行从下方滚入
        $lyricsLineNext.textContent = text;
        $lyricsLine.classList.add("scroll-out");
        $lyricsLineNext.classList.add("scroll-in");

        setTimeout(() => {
            $lyricsLine.textContent = text;
            $lyricsLine.classList.remove("scroll-out");
            $lyricsLineNext.classList.remove("scroll-in");
        }, 400);
    }

    reset() {
        this.bvid = null;
        this.lyrics = [];
        this.currentIndex = -1;
        this.visible = false;
        $lyricsArea.classList.remove("show");
        $playerLyricsBtn.classList.remove("lyrics-active");
        $lyricsLine.textContent = "暂无歌词";
        $lyricsLineNext.textContent = "";
    }
}

const lyricsPanel = new LyricsPanel();

$playerLyricsBtn.addEventListener("click", () => lyricsPanel.toggle());

// ── Full Player ──────────────────────────────
const $fullPlayer = document.getElementById("fullPlayer");
const $fpBg = document.getElementById("fpBg");
const $fpSongName = document.getElementById("fpSongName");
const $fpDisc = document.getElementById("fpDisc");
const $fpCoverImg = document.getElementById("fpCoverImg");
const $fpLyricsScroll = document.getElementById("fpLyricsScroll");
const $fpCanvas = document.getElementById("fpCanvas");
const $fpCurTime = document.getElementById("fpCurTime");
const $fpDurTime = document.getElementById("fpDurTime");
const $fpListPanel = document.getElementById("fpListPanel");
const $fpListContent = document.getElementById("fpListContent");
const $fpPlayBtn = document.getElementById("fpPlayBtn");
const $fpBarFill = document.getElementById("fpBarFill");
const $fpBar = document.getElementById("fpBar");

class FullPlayer {
    constructor() {
        this.isOpen = false;
        this.audioCtx = null;
        this.analyser = null;
        this.dataArray = null;
        this.rafId = null;
        this.fpLyrics = [];
        this.fpCurrentIndex = -1;
        this.canvasCtx = null;
    }

    open() {
        if (!state.currentBvid) return;
        this.isOpen = true;

        // Sync UI
        const title = $playerName.dataset.title || "未在播放";
        $fpSongName.textContent = title;
        $fpCoverImg.src = $playerCover.src || "";
        $fpBg.style.backgroundImage = $playerCover.src ? `url(${$playerCover.src})` : "none";

        this.syncPlayState();
        this.syncProgress();
        this.syncMode();

        $fullPlayer.classList.add("open");
        document.body.style.overflow = "hidden";

        this.initAudioContext();
        if (this.audioCtx && this.audioCtx.state === "suspended") {
            this.audioCtx.resume();
        }
        this.startVisualizer();
        this.loadLyrics();
        if ($fpListPanel.classList.contains("show")) this.renderList();
    }

    close() {
        this.isOpen = false;
        $fullPlayer.classList.remove("open");
        $fpListPanel.classList.remove("show");
        $fpListPanel.classList.add("hidden");
        $fpVolumeRow.classList.remove("show");
        document.body.style.overflow = "";
        this.stopVisualizer();
    }

    toggleList() {
        const isShow = $fpListPanel.classList.contains("show");
        if (isShow) {
            $fpListPanel.classList.remove("show");
            setTimeout(() => $fpListPanel.classList.add("hidden"), 350);
        } else {
            $fpListPanel.classList.remove("hidden");
            this.renderList();
            requestAnimationFrame(() => $fpListPanel.classList.add("show"));
        }
    }

    renderList() {
        if (state.playlist.length === 0) {
            $fpListContent.innerHTML = '<p style="text-align:center;color:rgba(255,255,255,0.3);padding:30px 0;font-size:13px;">播放列表为空</p>';
            return;
        }
        $fpListContent.innerHTML = state.playlist.map(bvid => {
            const song = findSongData(bvid);
            const title = song ? song.title : bvid;
            const author = song ? song.author : "";
            const coverSrc = bvid ? `/api/cover/${bvid}` : "";
            const isActive = bvid === state.currentBvid;
            return `<div class="fp-list-item${isActive ? " active" : ""}" data-bvid="${bvid}">
                <div class="fp-list-item-cover"><img src="${escapeAttr(coverSrc)}" alt="" onerror="this.style.display='none'"></div>
                <div class="fp-list-item-info">
                    <div class="fp-list-item-title">${escapeHtml(title)}</div>
                    <div class="fp-list-item-author">${escapeHtml(author)}</div>
                </div>
                <svg class="fp-list-item-playing" viewBox="0 0 24 24" fill="#00A1D6"><path d="M8 5v14l11-7z"/></svg>
            </div>`;
        }).join("");
    }

    syncPlayState() {
        const playing = !audio.paused;
        $fpDisc.classList.toggle("playing", playing);
        $fpPlayBtn.querySelector(".fp-icon-play").style.display = playing ? "none" : "block";
        $fpPlayBtn.querySelector(".fp-icon-pause").style.display = playing ? "block" : "none";
    }

    syncProgress() {
        if (!audio.duration) return;
        const pct = (audio.currentTime / audio.duration) * 100;
        $fpBarFill.style.width = pct + "%";
        $fpCurTime.textContent = formatTime(audio.currentTime);
        $fpDurTime.textContent = formatTime(audio.duration);
    }

    syncMode() {
        $fpModeBtn.innerHTML = MODE_ICONS[state.playMode];
        $fpModeBtn.title = MODE_TITLES[state.playMode];
        $fpModeBtn.style.color = state.playMode !== "sequential" ? "#00A1D6" : "";
    }

    initAudioContext() {
        if (this.audioCtx) return;
        try {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 128;
            const source = this.audioCtx.createMediaElementSource(audio);
            source.connect(this.analyser);
            this.analyser.connect(this.audioCtx.destination);
            this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
        } catch (e) {
            this.analyser = null;
        }
        this.canvasCtx = $fpCanvas.getContext("2d");
    }

    startVisualizer() {
        if (this.rafId) return;
        const draw = () => {
            this.rafId = requestAnimationFrame(draw);
            this.drawBars();
            this.updateGlow();
        };
        draw();
    }

    stopVisualizer() {
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        $fpDisc.style.setProperty("--glow", "0px 0 0 0 rgba(0,161,214,0)");
    }

    drawBars() {
        if (!this.canvasCtx || !this.analyser) return;
        const ctx = this.canvasCtx;
        const w = $fpCanvas.width = $fpCanvas.offsetWidth * devicePixelRatio;
        const h = $fpCanvas.height = $fpCanvas.offsetHeight * devicePixelRatio;
        ctx.clearRect(0, 0, w, h);

        this.analyser.getByteFrequencyData(this.dataArray);
        const bins = this.dataArray.length;
        const barCount = Math.min(bins, 64);
        const gap = 3 * devicePixelRatio;
        const barW = (w - gap * (barCount - 1)) / barCount;

        for (let i = 0; i < barCount; i++) {
            const val = this.dataArray[i] / 255;
            const barH = Math.max(val * h * 0.9, 2 * devicePixelRatio);
            const x = i * (barW + gap);
            const radius = Math.min(barW / 2, 3 * devicePixelRatio);

            ctx.fillStyle = `rgba(255,255,255,${0.15 + val * 0.55})`;
            ctx.beginPath();
            ctx.roundRect(x, h - barH, barW, barH, [radius, radius, 0, 0]);
            ctx.fill();
        }
    }

    updateGlow() {
        if (!this.dataArray) return;
        let bass = 0;
        for (let i = 0; i < 8; i++) bass += this.dataArray[i];
        bass = bass / 8 / 255;
        const size = Math.round(bass * 40);
        const opacity = (0.15 + bass * 0.5).toFixed(2);
        $fpDisc.style.setProperty("--glow", `0 0 ${size}px ${opacity} rgba(0,161,214,${opacity})`);
    }

    async loadLyrics() {
        if (!state.currentBvid) return;
        const bvid = state.currentBvid;
        try {
            const resp = await fetch(`/api/lyrics/${bvid}`);
            const json = await resp.json();
            // 如果 bvid 已经变了，丢弃这次结果
            if (bvid !== state.currentBvid) return;
            if (json.code === 0 && json.data.lyrics && json.data.lyrics.length > 0) {
                this.fpLyrics = json.data.lyrics;
                this.fpCurrentIndex = -1;
                this.renderLyrics();
                if (audio.currentTime > 0) this.updateLyricsTime(audio.currentTime);
            } else {
                this.fpLyrics = [];
                this.fpCurrentIndex = -1;
                $fpLyricsScroll.innerHTML = '<p class="fp-lyrics-empty">暂无歌词</p>';
            }
        } catch (err) {
            this.fpLyrics = [];
            this.fpCurrentIndex = -1;
            $fpLyricsScroll.innerHTML = '<p class="fp-lyrics-empty">暂无歌词</p>';
        }
    }

    renderLyrics() {
        $fpLyricsScroll.innerHTML = this.fpLyrics.map((line, i) =>
            `<p class="fp-lyric-line" data-index="${i}">${escapeHtml(line[1])}</p>`
        ).join("");
    }

    updateLyricsTime(currentTime) {
        if (!this.isOpen || this.fpLyrics.length === 0) return;
        let low = 0, high = this.fpLyrics.length - 1, idx = 0;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (this.fpLyrics[mid][0] <= currentTime) { idx = mid; low = mid + 1; }
            else { high = mid - 1; }
        }
        if (idx !== this.fpCurrentIndex) this.highlightLyric(idx);
    }

    highlightLyric(idx) {
        this.fpCurrentIndex = idx;
        $fpLyricsScroll.querySelectorAll(".fp-lyric-line").forEach((el, i) => {
            el.classList.toggle("active", i === idx);
        });
        const active = $fpLyricsScroll.querySelectorAll(".fp-lyric-line")[idx];
        if (active) {
            const container = $fpLyricsScroll;
            const target = active.offsetTop - container.offsetTop - container.clientHeight / 2 + active.clientHeight / 2;
            container.scrollTo({ top: target, behavior: "smooth" });
        }
    }
}

const fullPlayer = new FullPlayer();

// Lyrics click: seek to clicked line
$fpLyricsScroll.addEventListener("click", (e) => {
    const line = e.target.closest(".fp-lyric-line");
    if (!line || !audio.duration) return;
    const idx = parseInt(line.dataset.index);
    if (idx >= 0 && idx < fullPlayer.fpLyrics.length) {
        audio.currentTime = fullPlayer.fpLyrics[idx][0];
        fullPlayer.highlightLyric(idx);
    }
});

// Open full player: click cover or song name in mini player
$playerCover.addEventListener("click", () => fullPlayer.open());
$playerName.addEventListener("click", () => fullPlayer.open());
$playerInfo.addEventListener("click", (e) => {
    if (e.target.closest(".player-lyrics")) return;
    fullPlayer.open();
});

// Close
document.getElementById("fpBackBtn").addEventListener("click", () => fullPlayer.close());

// Playlist panel
document.getElementById("fpListBtn").addEventListener("click", () => fullPlayer.toggleList());
document.getElementById("fpListCloseBtn").addEventListener("click", () => {
    $fpListPanel.classList.remove("show");
    setTimeout(() => $fpListPanel.classList.add("hidden"), 350);
});
$fpListContent.addEventListener("click", (e) => {
    const item = e.target.closest(".fp-list-item");
    if (!item) return;
    const bvid = item.dataset.bvid;
    if (bvid === state.currentBvid && !audio.ended) return;
    $fpListPanel.classList.remove("show");
    setTimeout(() => $fpListPanel.classList.add("hidden"), 350);
    playOnline(bvid, state.playlist);
});

// Controls
$fpPlayBtn.addEventListener("click", () => {
    if (audio.paused) { audio.play(); fullPlayer.syncPlayState(); updatePlayingHighlight(state.currentBvid); }
    else { audio.pause(); fullPlayer.syncPlayState(); document.querySelectorAll(".result-card .play-btn").forEach(b => { b.classList.remove("is-playing"); b.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'; }); }
});
document.getElementById("fpPrevBtn").addEventListener("click", playPrevTrack);
document.getElementById("fpNextBtn").addEventListener("click", playNextTrack);
const $fpModeBtn = document.getElementById("fpModeBtn");
$fpModeBtn.addEventListener("click", () => {
    const idx = MODES.indexOf(state.playMode);
    state.playMode = MODES[(idx + 1) % MODES.length];
    $playerModeBtn.innerHTML = MODE_ICONS[state.playMode];
    $playerModeBtn.title = MODE_TITLES[state.playMode];
    $playerModeBtn.classList.toggle("mode-active", state.playMode !== "sequential");
    $fpModeBtn.innerHTML = MODE_ICONS[state.playMode];
    $fpModeBtn.title = MODE_TITLES[state.playMode];
    $fpModeBtn.style.color = state.playMode !== "sequential" ? "#00A1D6" : "";
    showToast(MODE_TITLES[state.playMode], "info");
});

// Progress seek (full player)
enableDragSeek($fpBar, $fpBarFill, (pct, preview) => {
    $fpBarFill.style.width = (pct * 100) + "%";
    $fpCurTime.textContent = formatTime(audio.duration * pct);
    if (!preview) audio.currentTime = audio.duration * pct;
});

// Sync audio events to full player
audio.addEventListener("timeupdate", () => {
    if (fullPlayer.isOpen) fullPlayer.syncProgress();
    fullPlayer.updateLyricsTime(audio.currentTime);
});
audio.addEventListener("play", () => { if (fullPlayer.isOpen) fullPlayer.syncPlayState(); });
audio.addEventListener("pause", () => { if (fullPlayer.isOpen) fullPlayer.syncPlayState(); });
audio.addEventListener("loadedmetadata", () => { if (fullPlayer.isOpen) fullPlayer.syncProgress(); });

// Sync mini player changes to full player
const origPlayOnline = playOnline;
playOnline = function(bvid, playlist) {
    origPlayOnline(bvid, playlist);
    if (fullPlayer.isOpen) {
        setTimeout(() => {
            fullPlayer.open();
        }, 100);
    }
};

// ── Keyboard Shortcuts ────────────────────────
document.addEventListener("keydown", (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    switch (e.code) {
        case "Space":
            e.preventDefault();
            togglePlay();
            break;
        case "ArrowLeft":
            if (e.shiftKey) {
                e.preventDefault();
                if (audio.duration) audio.currentTime = Math.max(0, audio.currentTime - 5);
            } else {
                playPrevTrack();
            }
            break;
        case "ArrowRight":
            if (e.shiftKey) {
                e.preventDefault();
                if (audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
            } else {
                playNextTrack();
            }
            break;
        case "ArrowUp":
            e.preventDefault();
            setVolume(Math.min(100, Math.round(audio.volume * 100) + 5));
            break;
        case "ArrowDown":
            e.preventDefault();
            setVolume(Math.max(0, Math.round(audio.volume * 100) - 5));
            break;
        case "KeyM":
            if (audio.volume > 0) {
                $volumeBtn._prevVol = Math.round(audio.volume * 100);
                setVolume(0);
            } else {
                setVolume($volumeBtn._prevVol || 80);
            }
            break;
        case "KeyL":
            lyricsPanel.toggle();
            break;
        case "Escape":
            if (fullPlayer.isOpen) fullPlayer.close();
            break;
    }
});

// ── MediaSession API ─────────────────────────
function updateMediaSession(title, artist, coverUrl) {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
        title: title,
        artist: artist,
        album: "Bilibili Music",
        artwork: [
            { src: coverUrl, sizes: "96x96", type: "image/jpeg" },
            { src: coverUrl, sizes: "128x128", type: "image/jpeg" },
            { src: coverUrl, sizes: "256x256", type: "image/jpeg" },
            { src: coverUrl, sizes: "512x512", type: "image/jpeg" },
        ],
    });
    if (!navigator.mediaSession._handlersSet) {
        navigator.mediaSession.setActionHandler("play", () => audio.play());
        navigator.mediaSession.setActionHandler("pause", () => audio.pause());
        navigator.mediaSession.setActionHandler("previoustrack", playPrevTrack);
        navigator.mediaSession.setActionHandler("nexttrack", playNextTrack);
        navigator.mediaSession.setActionHandler("seekto", (details) => {
            if (audio.duration) audio.currentTime = details.seekTime;
        });
        navigator.mediaSession._handlersSet = true;
    }
}

audio.addEventListener("play", () => {
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
});
audio.addEventListener("pause", () => {
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
});

// ── Search History ────────────────────────────
class SearchHistory {
    constructor() {
        this.KEY = "bili_search_history";
        this.MAX = 20;
    }
    getAll() {
        try { return JSON.parse(localStorage.getItem(this.KEY)) || []; }
        catch { return []; }
    }
    add(keyword) {
        keyword = keyword.trim();
        if (!keyword) return;
        let list = this.getAll().filter(k => k !== keyword);
        list.unshift(keyword);
        if (list.length > this.MAX) list = list.slice(0, this.MAX);
        localStorage.setItem(this.KEY, JSON.stringify(list));
    }
    remove(keyword) {
        let list = this.getAll().filter(k => k !== keyword);
        localStorage.setItem(this.KEY, JSON.stringify(list));
    }
    clear() {
        localStorage.removeItem(this.KEY);
    }
}

const searchHistory = new SearchHistory();
const $searchHistory = document.getElementById("searchHistory");
const $historyList = document.getElementById("historyList");
const $clearHistory = document.getElementById("clearHistory");

function renderSearchHistory() {
    const list = searchHistory.getAll();
    if (list.length === 0) {
        $searchHistory.classList.add("hidden");
        return;
    }
    $historyList.innerHTML = list.map(k =>
        `<div class="history-item" data-keyword="${escapeAttr(k)}">
            <span class="history-text">${escapeHtml(k)}</span>
            <button class="history-del" data-keyword="${escapeAttr(k)}" title="删除">&times;</button>
        </div>`
    ).join("");
    $searchHistory.classList.remove("hidden");
}

$searchInput.addEventListener("focus", () => {
    if (!$searchInput.value) renderSearchHistory();
});
$searchInput.addEventListener("input", () => {
    if ($searchInput.value) $searchHistory.classList.add("hidden");
    else renderSearchHistory();
});
document.addEventListener("click", (e) => {
    if (!e.target.closest(".header-search")) $searchHistory.classList.add("hidden");
});
$searchHistory.addEventListener("click", (e) => {
    const del = e.target.closest(".history-del");
    if (del) {
        e.stopPropagation();
        searchHistory.remove(del.dataset.keyword);
        renderSearchHistory();
        return;
    }
    const item = e.target.closest(".history-item");
    if (item) {
        $searchInput.value = item.dataset.keyword;
        $searchHistory.classList.add("hidden");
        search(item.dataset.keyword);
    }
});
$clearHistory.addEventListener("click", () => {
    searchHistory.clear();
    renderSearchHistory();
    showToast("搜索历史已清空", "info");
});

// Hook into search to record history
const origSearch = search;
search = function(keyword, page) {
    origSearch(keyword, page);
    if (page === 1 || page === undefined) searchHistory.add(keyword);
};

// ── Play History ──────────────────────────────
class PlayHistoryMgr {
    constructor() {
        this.KEY = "bili_play_history";
        this.MAX = 100;
    }
    getAll() {
        try { return JSON.parse(localStorage.getItem(this.KEY)) || []; }
        catch { return []; }
    }
    record(song) {
        let list = this.getAll();
        const idx = list.findIndex(s => s.bvid === song.bvid);
        if (idx >= 0) {
            const item = list.splice(idx, 1)[0];
            item.lastPlayedAt = Date.now();
            item.playCount = (item.playCount || 1) + 1;
            list.unshift(item);
        } else {
            list.unshift({ ...song, lastPlayedAt: Date.now(), playCount: 1 });
        }
        if (list.length > this.MAX) list = list.slice(0, this.MAX);
        localStorage.setItem(this.KEY, JSON.stringify(list));
    }
    clear() {
        localStorage.removeItem(this.KEY);
    }
}

const playHistoryMgr = new PlayHistoryMgr();
const $historyTabBtn = document.getElementById("historyTabBtn");
const $historyTab = document.getElementById("historyTab");
const $historyListEl = document.getElementById("historyListEl");
const $historyEmpty = document.getElementById("historyEmpty");
const $historyTotal = document.getElementById("historyTotal");
const $clearPlayHistory = document.getElementById("clearPlayHistory");

if ($historyTabBtn) {
    $historyTabBtn.addEventListener("click", () => {
        if (state.activeTab === "history") {
            goHome();
        } else {
            switchTab("history");
        }
    });
}

if ($clearPlayHistory) {
    $clearPlayHistory.addEventListener("click", () => {
        playHistoryMgr.clear();
        renderPlayHistory();
        showToast("播放记录已清空", "info");
    });
}

function switchTab(name) {
    state.activeTab = name;
    $welcomeSection.classList.add("hidden");
    document.getElementById("searchTab").classList.toggle("hidden", name !== "search");
    document.getElementById("favoritesTab").classList.toggle("hidden", name !== "favorites");
    if ($historyTab) $historyTab.classList.toggle("hidden", name !== "history");
    $favTabBtn.classList.toggle("is-active", name === "favorites");
    if ($historyTabBtn) $historyTabBtn.classList.toggle("is-active", name === "history");
    if (name === "favorites") renderFavorites();
    if (name === "history") renderPlayHistory();
}

function renderPlayHistory() {
    if (!$historyListEl) return;
    const list = playHistoryMgr.getAll();
    if (list.length === 0) {
        $historyListEl.innerHTML = "";
        $historyEmpty.classList.remove("hidden");
        $historyTotal.textContent = "";
        return;
    }
    $historyEmpty.classList.add("hidden");
    $historyTotal.textContent = `共 ${list.length} 首`;
    $historyListEl.innerHTML = list.map(r => {
        const coverSrc = r.bvid ? `/api/cover/${r.bvid}` : r.coverUrl || "";
        const timeStr = r.lastPlayedAt ? new Date(r.lastPlayedAt).toLocaleDateString() : "";
        return `
        <div class="result-card" data-bvid="${r.bvid}">
            <div class="card-cover">
                <img class="cover" src="${escapeAttr(coverSrc)}" alt="" loading="lazy"
                     onerror="this.parentElement.style.display='none'">
                <button class="play-btn" title="播放">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </button>
                <span class="card-duration">${escapeHtml(r.duration || "")}</span>
            </div>
            <div class="card-body">
                <h3 class="title" title="${escapeAttr(r.title)}">${escapeHtml(r.title)}</h3>
                <p class="author">${escapeHtml(r.author || "")}</p>
                <div class="card-meta">
                    <span>${ICONS.clock} ${timeStr} · 播放 ${r.playCount || 1} 次</span>
                </div>
                <div class="card-actions">
                    <button class="fav-btn ${isFavorited(r.bvid) ? 'is-fav' : ''}" data-bvid="${r.bvid}" title="${isFavorited(r.bvid) ? '取消收藏' : '收藏'}">
                        ${isFavorited(r.bvid) ? ICONS.heartFill : ICONS.heart}
                    </button>
                    <button class="download-btn">${ICONS.download}</button>
                </div>
            </div>
        </div>`;
    }).join("");
    updatePlayingHighlight(state.currentBvid);
}

// Hook into playOnline to record play history
const origPlayOnline2 = playOnline;
playOnline = function(bvid, playlist) {
    const song = findSongData(bvid);
    origPlayOnline2(bvid, playlist);
    if (song) playHistoryMgr.record(song);
};

// ── Sleep Timer ───────────────────────────────
class SleepTimer {
    constructor() {
        this.timerId = null;
        this.endTime = null;
        this.mode = "off";
        this._endOfSongHandler = null;
        this._tickInterval = null;
    }
    set(minutes) {
        this.clear();
        this.mode = "timed";
        this.endTime = Date.now() + minutes * 60 * 1000;
        this.timerId = setTimeout(() => {
            audio.pause();
            this.mode = "off";
            this.endTime = null;
            clearInterval(this._tickInterval);
            this._tickInterval = null;
            showToast("定时关闭已执行", "info");
            $sleepTimerBtn.classList.remove("timer-active");
            $sleepTimerBtn.title = "定时关闭";
        }, minutes * 60 * 1000);
        this._tickInterval = setInterval(() => this.updateUI(), 1000);
        $sleepTimerBtn.classList.add("timer-active");
        showToast(`已设置 ${minutes} 分钟后关闭`, "info");
    }
    setEndOfSong() {
        this.clear();
        this.mode = "end_of_song";
        this._endOfSongHandler = () => {
            audio.pause();
            audio.removeEventListener("ended", this._endOfSongHandler);
            this.mode = "off";
            $sleepTimerBtn.classList.remove("timer-active");
            $sleepTimerBtn.title = "定时关闭";
            showToast("歌曲播放完毕，已自动关闭", "info");
        };
        audio.addEventListener("ended", this._endOfSongHandler);
        $sleepTimerBtn.classList.add("timer-active");
        showToast("将在当前歌曲播放完毕后关闭", "info");
    }
    clear() {
        if (this.timerId) { clearTimeout(this.timerId); this.timerId = null; }
        if (this._endOfSongHandler) { audio.removeEventListener("ended", this._endOfSongHandler); this._endOfSongHandler = null; }
        if (this._tickInterval) { clearInterval(this._tickInterval); this._tickInterval = null; }
        this.endTime = null;
        this.mode = "off";
        $sleepTimerBtn.classList.remove("timer-active");
        $sleepTimerBtn.title = "定时关闭";
    }
    getRemaining() {
        if (this.mode !== "timed" || !this.endTime) return null;
        const diff = Math.max(0, this.endTime - Date.now());
        const m = Math.floor(diff / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        return `${m}:${s.toString().padStart(2, "0")}`;
    }
    updateUI() {
        const rem = this.getRemaining();
        $sleepTimerBtn.title = this.mode === "end_of_song" ? "播完关闭" : (rem ? `剩余 ${rem}` : "定时关闭");
    }
}

const sleepTimer = new SleepTimer();
const $sleepTimerBtn = document.getElementById("sleepTimerBtn");
const $sleepTimerPanel = document.getElementById("sleepTimerPanel");

$sleepTimerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isShow = $sleepTimerPanel.classList.contains("show");
    if (isShow) {
        $sleepTimerPanel.classList.remove("show");
    } else {
        $sleepTimerPanel.classList.add("show");
    }
});
document.addEventListener("click", (e) => {
    if (!e.target.closest("#sleepTimerBtn") && !e.target.closest("#sleepTimerPanel")) {
        $sleepTimerPanel.classList.remove("show");
    }
});
$sleepTimerPanel.addEventListener("click", (e) => {
    const btn = e.target.closest(".sleep-timer-option");
    if (!btn) return;
    const val = btn.dataset.value;
    if (val === "off") {
        sleepTimer.clear();
        showToast("已取消定时关闭", "info");
    } else if (val === "end") {
        sleepTimer.setEndOfSong();
    } else {
        sleepTimer.set(parseInt(val));
    }
    $sleepTimerPanel.classList.remove("show");
});

// ── Cover Background ──────────────────────────
const $coverBg = document.getElementById("coverBg");

function updateCoverBackground(coverUrl) {
    if (!coverUrl) {
        $coverBg.classList.remove("show");
        return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
        $coverBg.style.backgroundImage = `url(${coverUrl})`;
        $coverBg.classList.add("show");
    };
    img.src = coverUrl;
}

// Hook into playOnline to update cover bg
const origPlayOnline3 = playOnline;
playOnline = function(bvid, playlist) {
    origPlayOnline3(bvid, playlist);
    const coverSrc = `/api/cover/${bvid}`;
    updateCoverBackground(coverSrc);
};

// Clear cover bg when player closes
const origClosePlayer = closePlayer;
closePlayer = function() {
    origClosePlayer();
    $coverBg.classList.remove("show");
};

// ── Import / Export Favorites ─────────────────
const $exportFavBtn = document.getElementById("exportFavBtn");
const $importFavInput = document.getElementById("importFavInput");

if ($exportFavBtn) {
    $exportFavBtn.addEventListener("click", () => {
        const favs = getFavorites();
        if (favs.length === 0) { showToast("收藏列表为空", "info"); return; }
        const data = { version: 1, exportTime: new Date().toISOString(), count: favs.length, items: favs };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `bilibili-music-favorites-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast(`已导出 ${favs.length} 首收藏`, "success");
    });
}

if ($importFavInput) {
    $importFavInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const data = JSON.parse(ev.target.result);
                if (!data.items || !Array.isArray(data.items)) {
                    showToast("文件格式不正确", "error");
                    return;
                }
                const existing = getFavorites();
                const existingBvids = new Set(existing.map(f => f.bvid));
                let imported = 0;
                for (const item of data.items) {
                    if (item.bvid && !existingBvids.has(item.bvid)) {
                        existing.push(item);
                        existingBvids.add(item.bvid);
                        imported++;
                    }
                }
                saveFavorites(existing);
                updateFavCount();
                if (state.activeTab === "favorites") renderFavorites();
                showToast(`成功导入 ${imported} 首，跳过 ${data.items.length - imported} 首重复`, "success");
            } catch {
                showToast("文件解析失败", "error");
            }
            $importFavInput.value = "";
        };
        reader.readAsText(file);
    });
}

// ── Desktop Lyrics ────────────────────────────
const $desktopLyrics = document.getElementById("desktopLyrics");
const $dlBody = document.getElementById("dlBody");
const $dlCloseBtn = document.getElementById("dlCloseBtn");
const $dlLockBtn = document.getElementById("dlLockBtn");

function updateDesktopLyrics(currentTime) {
    if (!$desktopLyrics || $desktopLyrics.classList.contains("hidden")) return;
    const lyrics = lyricsPanel.lyrics;
    if (!lyrics || lyrics.length === 0) return;

    let low = 0, high = lyrics.length - 1, idx = 0;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (lyrics[mid][0] <= currentTime) { idx = mid; low = mid + 1; }
        else { high = mid - 1; }
    }

    const lines = $dlBody.querySelectorAll(".dl-line");
    lines.forEach((el, i) => {
        el.classList.toggle("active", i === idx);
    });
    const activeLine = lines[idx];
    if (activeLine) {
        const container = $dlBody;
        const target = activeLine.offsetTop - container.offsetTop - container.clientHeight / 2 + activeLine.clientHeight / 2;
        container.scrollTo({ top: target, behavior: "smooth" });
    }
}

const $desktopLyricsBtn = document.getElementById("desktopLyricsBtn");
if ($desktopLyricsBtn) {
    $desktopLyricsBtn.addEventListener("click", () => {
        const lyrics = lyricsPanel.lyrics;
        if ($desktopLyrics.classList.contains("hidden")) {
            if (lyrics.length === 0) { showToast("暂无歌词", "info"); return; }
            $dlBody.innerHTML = lyrics.map(l => `<p class="dl-line">${escapeHtml(l[1])}</p>`).join("");
            $desktopLyrics.classList.remove("hidden");
            $desktopLyricsBtn.classList.add("lyrics-active");
        } else {
            $desktopLyrics.classList.add("hidden");
            $desktopLyricsBtn.classList.remove("lyrics-active");
        }
    });
}

if ($dlCloseBtn) {
    $dlCloseBtn.addEventListener("click", () => {
        $desktopLyrics.classList.add("hidden");
        if ($desktopLyricsBtn) $desktopLyricsBtn.classList.remove("lyrics-active");
    });
}

if ($dlLockBtn) {
    $dlLockBtn.addEventListener("click", () => {
        $desktopLyrics.classList.toggle("locked");
        $dlLockBtn.textContent = $desktopLyrics.classList.contains("locked") ? "解锁" : "锁定";
    });
}

// Desktop lyrics drag
(function() {
    if (!$desktopLyrics) return;
    let dragging = false, startX, startY, origLeft, origTop;
    const handle = $desktopLyrics.querySelector(".desktop-lyrics-header");

    handle.addEventListener("mousedown", (e) => {
        if ($desktopLyrics.classList.contains("locked")) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = $desktopLyrics.getBoundingClientRect();
        origLeft = rect.left;
        origTop = rect.top;
        $desktopLyrics.style.transform = "none";
        $desktopLyrics.style.left = origLeft + "px";
        $desktopLyrics.style.top = origTop + "px";
        e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        $desktopLyrics.style.left = (origLeft + e.clientX - startX) + "px";
        $desktopLyrics.style.top = (origTop + e.clientY - startY) + "px";
    });

    document.addEventListener("mouseup", () => { dragging = false; });
})();

// Hook into lyrics load to refresh desktop lyrics content
const origLyricsLoad = lyricsPanel.load.bind(lyricsPanel);
lyricsPanel.load = async function(bvid) {
    await origLyricsLoad(bvid);
    if (!$desktopLyrics || $desktopLyrics.classList.contains("hidden")) return;
    if (this.lyrics.length > 0) {
        $dlBody.innerHTML = this.lyrics.map(l => `<p class="dl-line">${escapeHtml(l[1])}</p>`).join("");
    } else {
        $dlBody.innerHTML = '<p class="dl-line">暂无歌词</p>';
    }
};

// Hook into timeupdate for desktop lyrics
audio.addEventListener("timeupdate", () => updateDesktopLyrics(audio.currentTime));

// ── Init ─────────────────────────────────────────
updateFavCount();

// Logo click → go home
document.querySelector(".logo").addEventListener("click", goHome);
document.querySelector(".logo").style.cursor = "pointer";

// Hot search hint buttons
document.querySelectorAll(".hint-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        const keyword = btn.dataset.keyword;
        $searchInput.value = keyword;
        search(keyword);
    });
});
