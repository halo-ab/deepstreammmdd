/**
 * DeepStream — Project D (app.js)
 * High-performance sports streaming with universal proxy
 * - Zero Vercel bandwidth used (all video streams routed via cinexcricket.com proxy)
 * - Standard Hls.js player with dynamic quality selection (Auto, 1080p, 720p, etc.)
 * - Multi-source M3U auto-updater with clean category parsing
 */

"use strict";

/* ── DOM Elements ────────────────────────────────────────── */
const $ = (sel) => document.querySelector(sel);

const homeView         = $("#home-view");
const playerView       = $("#player-view");
const video            = $("#video");
const channelList      = $("#channel-list");
const channelSearch    = $("#channel-search");
const channelCount     = $("#channel-count");
const categoryScroll   = $("#category-scroll");
const categoryBar      = $("#category-bar");
const statEvents       = $("#stat-events");
const statCats         = $("#stat-cats");

const playerLoading    = $("#player-loading");
const playerError      = $("#player-error");
const errorMessage     = $("#error-message");
const btnRetry         = $("#btn-retry");
const btnBackHome      = $("#btn-back-home");
const qualitySelector  = $("#quality-selector");

const nowTeams         = $("#now-teams");
const nowTitle         = $("#now-title");
const nowGroup         = $("#now-group");
const nowUrl           = $("#now-url");
const nowLogo          = $("#now-logo");

const suggestionsSection = $("#suggestions-section");
const suggestionsScroll  = $("#suggestions-scroll");
const moreCount          = $("#more-count");

/* ── App State ───────────────────────────────────────────── */
let allChannels = [];
let activeChannel = null;
let activeCategory = "All";
let hls = null;

/* ── Configuration & Proxy ───────────────────────────────── */
const M3U_SOURCES = [
  "https://raw.githubusercontent.com/sportlive18/Fancode-New-Auto-Update/main/fancode2.m3u",
  "https://raw.githubusercontent.com/drmlive/fancode-live-events/refs/heads/main/fancode.m3u",
  "https://raw.githubusercontent.com/halo-ab/Matches-playlist-/refs/heads/main/Playlist.m3u"
];

const REFRESH_MS = 5 * 60 * 1000; // 5 minutes auto-refresh

/**
 * Universal Proxy URL
 * Routes all HLS manifests and TS segments through cinexcricket.com LiteSpeed proxy.
 * This provides Access-Control-Allow-Origin: * and bypasses FanCode CDN blocks
 * with zero bandwidth usage on your web host.
 */
function proxiedStreamUrl(rawUrl) {
  if (!rawUrl) return "";
  // Strip trailing metadata if present (|User-Agent=...)
  const cleanUrl = rawUrl.split("|")[0].trim();
  return `https://cinexcricket.com/proxy/universal.php/?url=${encodeURIComponent(cleanUrl)}`;
}

/* ── Helper: Clean Category Name ─────────────────────────── */
function cleanCategory(rawGroup) {
  if (!rawGroup) return "Sports";
  return rawGroup
    .replace(/^Fancode-/i, "")
    .replace(/^(ENGLISH|HINDI|TAMIL|TELUGU|KANNADA|MALAYALAM|BENGALI|PUNJABI|GUJARATI|MARATHI)\s+/i, "")
    .trim() || "Sports";
}

/* ── Helper: Clean Title ─────────────────────────────────── */
function cleanMatchTitle(rawTitle) {
  if (!rawTitle) return "Live Match";
  return rawTitle
    .replace(/^(ENG|HIN|TEL|TAM)\s*\|\s*/i, "")
    .replace(/\s*\([^)]*League[^)]*\)/gi, "")
    .replace(/\s*\([^)]*202\d[^)]*\)/gi, "")
    .trim() || rawTitle.trim();
}

/* ── Helper: Match Title HTML with 'VS' Badge ────────────── */
function matchTitleHtml(title) {
  const parts = title.split(/\s+(?:vs\.?|v)\s+/i);
  if (parts.length === 2) {
    return `<span class="team">${escapeHtml(parts[0].trim())}</span> <span class="vs-badge">VS</span> <span class="team">${escapeHtml(parts[1].trim())}</span>`;
  }
  return escapeHtml(title);
}

function escapeHtml(str) {
  if (!str) return "";
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

/* ════════════════════════════════════════════════════════════
   PLAYLIST FETCHING & PARSING
════════════════════════════════════════════════════════════ */

async function fetchAllPlaylists() {
  const bust = Date.now();
  const seenUrls = new Set();
  const matches = [];

  for (const src of M3U_SOURCES) {
    try {
      const res = await fetch(`${src}?_=${bust}`, { cache: "no-store" });
      if (!res.ok) continue;
      const text = await res.text();
      const parsed = parseM3U(text);

      for (const m of parsed) {
        if (!seenUrls.has(m.url)) {
          seenUrls.add(m.url);
          matches.push(m);
        }
      }
    } catch (err) {
      console.warn("Failed to fetch M3U from:", src, err);
    }
  }

  return matches;
}

function parseM3U(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const channels = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("#EXTINF:")) continue;

    const logoMatch  = line.match(/tvg-logo="([^"]*)"/i);
    const groupMatch = line.match(/group-title="([^"]*)"/i);
    
    // Extract title after last closing quote and comma
    let title = "Live Match";
    const quoteCommaMatch = line.match(/",\s*(.+)$/);
    if (quoteCommaMatch) {
      title = quoteCommaMatch[1].trim();
    } else {
      const commaIdx = line.indexOf(",");
      if (commaIdx !== -1) title = line.substring(commaIdx + 1).trim();
    }

    // Find stream URL
    let url = "";
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] && !lines[j].startsWith("#")) {
        url = lines[j];
        break;
      }
    }
    if (!url) continue;

    const group = cleanCategory(groupMatch ? groupMatch[1] : "");
    const logo  = logoMatch ? logoMatch[1] : "";

    channels.push({
      url,
      title: cleanMatchTitle(title),
      rawTitle: title,
      group,
      logo
    });
  }

  return channels;
}

/* ════════════════════════════════════════════════════════════
   RENDER UI
════════════════════════════════════════════════════════════ */

function renderApp() {
  renderCategoryBar();
  renderMatches();
  updateStats();
}

function updateStats() {
  statEvents.textContent = allChannels.length;
  const groups = new Set(allChannels.map((c) => c.group).filter(Boolean));
  statCats.textContent = groups.size;
  channelCount.textContent = `${allChannels.length} Live Matches`;
  channelCount.style.display = "";
}

function renderCategoryBar() {
  const groups = ["All", ...new Set(allChannels.map((c) => c.group).filter(Boolean).sort())];
  categoryScroll.innerHTML = groups
    .map(
      (g) =>
        `<button class="cat-pill${g === activeCategory ? " active" : ""}" data-group="${escapeHtml(g)}">${escapeHtml(g)}</button>`
    )
    .join("");

  categoryScroll.querySelectorAll(".cat-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      categoryScroll.querySelectorAll(".cat-pill").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeCategory = btn.dataset.group;
      renderMatches();
    });
  });
}

function renderMatches() {
  const query = (channelSearch.value || "").trim().toLowerCase();
  const filtered = allChannels.filter((c) => {
    const matchesCat = activeCategory === "All" || c.group === activeCategory;
    const matchesQuery = !query || c.title.toLowerCase().includes(query) || c.group.toLowerCase().includes(query);
    return matchesCat && matchesQuery;
  });

  if (!filtered.length) {
    channelList.innerHTML = `<div class="empty-state"><p>No matches found matching your search.</p></div>`;
    return;
  }

  channelList.innerHTML = "";
  const frag = document.createDocumentFragment();

  filtered.forEach((ch) => {
    const card = document.createElement("div");
    card.className = "match-card";
    
    const logoHtml = ch.logo
      ? `<img class="match-img" src="${escapeHtml(ch.logo)}" alt="${escapeHtml(ch.title)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />`
      : "";
    const fbHtml = `<div class="match-img-fb" style="${ch.logo ? "display:none" : "display:flex"}"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/></svg></div>`;

    card.innerHTML = `
      <div class="match-thumb">
        ${logoHtml}${fbHtml}
        <div class="match-badge-live"><span class="dot"></span>LIVE</div>
        <div class="match-badge-cat">${escapeHtml(ch.group)}</div>
      </div>
      <div class="match-info">
        <div class="match-title">${escapeHtml(ch.title)}</div>
        <div class="match-meta">
          <span class="match-cat-tag">${escapeHtml(ch.group)}</span>
          <span>·</span>
          <span>Live HD</span>
        </div>
      </div>
    `;

    card.addEventListener("click", () => openPlayer(ch));
    frag.appendChild(card);
  });

  channelList.appendChild(frag);
}

/* ════════════════════════════════════════════════════════════
   PLAYER LOGIC (Hls.js + Universal Proxy)
════════════════════════════════════════════════════════════ */

function openPlayer(ch) {
  activeChannel = ch;
  homeView.style.display = "none";
  playerView.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });

  // Update match details card
  nowTeams.innerHTML = matchTitleHtml(ch.title);
  nowGroup.textContent = ch.group;
  nowUrl.textContent = ch.url;

  if (ch.logo) {
    nowLogo.src = ch.logo;
    nowLogo.classList.remove("hidden");
    nowLogo.onerror = () => nowLogo.classList.add("hidden");
    video.poster = ch.logo;
  } else {
    nowLogo.classList.add("hidden");
    video.removeAttribute("poster");
  }

  renderSuggestions(ch.url);
  startPlayback(ch.url);
}

function closePlayer() {
  destroyPlayer();
  playerView.classList.add("hidden");
  homeView.style.display = "block";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function destroyPlayer() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  video.pause();
  video.removeAttribute("src");
  video.load();
  qualitySelector.classList.add("hidden");
  qualitySelector.innerHTML = "";
}

function showLoading(show) {
  if (show) playerLoading.classList.remove("hidden");
  else playerLoading.classList.add("hidden");
}

function showError(msg) {
  showLoading(false);
  errorMessage.textContent = msg || "Stream failed to load.";
  playerError.classList.remove("hidden");
}

function hideError() {
  playerError.classList.add("hidden");
}

function startPlayback(rawUrl) {
  destroyPlayer();
  hideError();
  showLoading(true);

  const streamUrl = proxiedStreamUrl(rawUrl);
  console.log("[DeepStream] Playing via Universal Proxy:", streamUrl);

  if (Hls.isSupported()) {
    hls = new Hls({
      maxMaxBufferLength: 60,
      enableWorker: true,
      lowLatencyMode: true,
    });

    hls.loadSource(streamUrl);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
      showLoading(false);
      buildQualitySelector(data.levels);

      // Unmuted autoplay with safe fallback
      video.muted = false;
      video.play().catch(() => {
        console.log("Unmuted autoplay restricted by browser; trying muted...");
        video.muted = true;
        video.play();
      });
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
      updateActiveQualityButton(data.level);
    });

    hls.on(Hls.Events.ERROR, (event, data) => {
      console.error("[HLS Error]", data);
      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            hls.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            break;
          default:
            destroyPlayer();
            showError("Stream error. The match may have ended or is temporarily unavailable.");
            break;
        }
      }
    });

    video.addEventListener("playing", () => showLoading(false), { once: true });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    // Native HLS for Safari on iOS
    video.src = streamUrl;
    video.muted = false;
    video.play().catch(() => {
      video.muted = true;
      video.play();
    });
    video.addEventListener("loadedmetadata", () => showLoading(false), { once: true });
    video.addEventListener("error", () => showError("Playback error on your device."));
  } else {
    showError("Your browser does not support HLS video playback.");
  }
}

/* ── Quality Selector Toolbar ───────────────────────────── */
function buildQualitySelector(levels) {
  if (!levels || levels.length <= 1) {
    qualitySelector.classList.add("hidden");
    return;
  }

  qualitySelector.innerHTML = `<span class="quality-label">Quality:</span>`;

  // Auto quality button
  const autoBtn = document.createElement("button");
  autoBtn.className = "quality-btn active";
  autoBtn.textContent = "Auto";
  autoBtn.dataset.level = "-1";
  autoBtn.onclick = () => {
    if (hls) hls.currentLevel = -1;
    setActiveQualityButton(autoBtn);
  };
  qualitySelector.appendChild(autoBtn);

  // Resolution buttons sorted highest first
  const sorted = levels
    .map((lvl, idx) => ({ ...lvl, index: idx }))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  sorted.forEach((lvl) => {
    if (!lvl.height) return;
    const btn = document.createElement("button");
    btn.className = "quality-btn";
    btn.textContent = `${lvl.height}p`;
    btn.dataset.level = lvl.index;
    btn.onclick = () => {
      if (hls) hls.currentLevel = lvl.index;
      setActiveQualityButton(btn);
    };
    qualitySelector.appendChild(btn);
  });

  qualitySelector.classList.remove("hidden");
}

function setActiveQualityButton(activeBtn) {
  qualitySelector.querySelectorAll(".quality-btn").forEach((b) => b.classList.remove("active"));
  activeBtn.classList.add("active");
}

function updateActiveQualityButton(activeLevelIdx) {
  if (!qualitySelector) return;
  const targetLevel = hls && hls.autoLevelEnabled ? "-1" : String(activeLevelIdx);
  qualitySelector.querySelectorAll(".quality-btn").forEach((btn) => {
    if (btn.dataset.level === targetLevel) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });
}

/* ── Suggestions Section ────────────────────────────────── */
function renderSuggestions(currentUrl) {
  if (!suggestionsScroll) return;
  const others = allChannels.filter((c) => c.url !== currentUrl).slice(0, 15);
  if (!others.length) {
    suggestionsSection.style.display = "none";
    return;
  }

  suggestionsScroll.innerHTML = "";
  moreCount.textContent = others.length;

  others.forEach((ch) => {
    const card = document.createElement("div");
    card.className = "match-card";
    card.style.minWidth = "220px";
    card.innerHTML = `
      <div class="match-info" style="padding:12px;">
        <span class="match-cat-tag" style="font-size:0.7rem;">${escapeHtml(ch.group)}</span>
        <div class="match-title" style="font-size:0.85rem;margin-top:4px;">${escapeHtml(ch.title)}</div>
      </div>
    `;
    card.addEventListener("click", () => openPlayer(ch));
    suggestionsScroll.appendChild(card);
  });

  suggestionsSection.style.display = "block";
}

/* ════════════════════════════════════════════════════════════
   EVENT LISTENERS & INIT
════════════════════════════════════════════════════════════ */

channelSearch.addEventListener("input", renderMatches);
btnBackHome.addEventListener("click", closePlayer);
btnRetry.addEventListener("click", () => {
  if (activeChannel) startPlayback(activeChannel.url);
});

async function init() {
  try {
    allChannels = await fetchAllPlaylists();
    renderApp();

    // Auto-refresh match list in background
    setInterval(async () => {
      const refreshed = await fetchAllPlaylists();
      if (refreshed && refreshed.length > 0) {
        allChannels = refreshed;
        updateStats();
        renderMatches();
      }
    }, REFRESH_MS);
  } catch (err) {
    console.error("Initialization failed:", err);
    channelList.innerHTML = `<div class="empty-state"><p>Failed to load matches. Please refresh the page.</p></div>`;
  }
}

document.addEventListener("DOMContentLoaded", init);
