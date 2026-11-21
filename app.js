/**
 * DeepStream — app.js (Project D)
 * Exact Project B integration with Universal HLS Proxy & Shaka Player ClearKey DASH
 * - Supports FanCode Pro+ DASH (ClearKey DRM, Amazon CDN, 0 GB Vercel Bandwidth)
 * - Supports FanCode HLS (.m3u8) via Hls.js
 * - Dynamic Quality Selection (Auto, 1080p, 720p, 540p, 480p, 360p)
 * - Audio unmuted by default
 */

"use strict";

/** @typedef {{ title:string, url:string, key?:string, type?:string, logo:string, group:string, matchName:string, eventName:string, team1:string, team2:string, matchId:number, language:string, qualities:Object }} Channel */

const $ = (sel) => document.querySelector(sel);

const video         = $("#video");
const channelList   = $("#channel-list");
const channelSearch = $("#channel-search");
const channelCount  = $("#channel-count");
const playerOverlay = $("#player-overlay");
const playerLoading = $("#player-loading");
const playerError   = $("#player-error");
const errorMessage  = $("#error-message");
const nowTitle      = $("#now-title");
const nowGroup      = $("#now-group");
const nowUrl        = $("#now-url");
const nowLogo       = $("#now-logo");

/** @type {Channel[]} */
let channels = [];
/** @type {Channel|null} */
let activeChannel = null;
let hls = null;
let shakaPlayer = null;
let networkRetries = 0;

/* ── M3U Sources ── */
const M3U_SOURCES = [
  "https://raw.githubusercontent.com/sportlive18/Fancode-New-Auto-Update/main/fancode2.m3u"
];
const REFRESH_MS = 5 * 60 * 1000;   // 5 minutes

/* ── FanCode Pro+ 24/7 DASH Channels (Direct Amazon CDN, ClearKey DRM, 0 Proxy / 0 Bandwidth) ── */
const FANCODE_PRO_CHANNELS = [
  {
    title:     "FanCode Live 1 (FHD)",
    matchName: "FanCode Live 1",
    eventName: "Live Sports Broadcast",
    team1:     "FanCode",
    team2:     "Live",
    group:     "Cricket",
    logo:      "https://www.fancode.com/skillup-uploads/cms-media/fancode_logo.png",
    url:       "https://otte.cache.aiv-cdn.net/iad-nitro/live/clients/dash/enc/avqlywnuzx/out/v1/aefca6420f944a9482e117f315de535f/cenc.mpd",
    key:       "1994b1df7dfd2e8a8d7b9bf3fb900285:22a1444b3da18e139191665b3d652835",
    type:      "dash",
    language:  "",
    matchId:   1,
    qualities: {}
  },
  {
    title:     "FanCode Live 2 (HD)",
    matchName: "FanCode Live 2",
    eventName: "Live Sports Broadcast",
    team1:     "FanCode",
    team2:     "Live",
    group:     "Cricket",
    logo:      "https://www.fancode.com/skillup-uploads/cms-media/fancode_logo.png",
    url:       "https://otte.cache.aiv-cdn.net/iad-nitro/live/clients/dash/enc/b3b3fkmrbl/out/v1/1084d5c9a97a4c5b9f9554c88f486646/cenc.mpd",
    key:       "82dfca238e8c4b430a3269db71965db9:a00b28caf4ac628e77a553d440c0ddca",
    type:      "dash",
    language:  "",
    matchId:   2,
    qualities: {}
  }
];

const SPORTS_DATA_URL = "https://raw.githubusercontent.com/sm-monirulislam/Upcoming-and-Live-Sports-Data/main/Sports_data.json";

/**
 * Automatically inspects the sports database to see what match is actively streaming
 * on the two FanCode feeds, updating the title, category, and real match thumbnail.
 */
async function fetchDynamicProChannels() {
  try {
    const res = await fetch(`${SPORTS_DATA_URL}?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return FANCODE_PRO_CHANNELS;
    const data = await res.json();
    const matches = data.matches || [];

    // Find live match broadcasting on Server 1 (avqlywnuzx) & Server 2 (b3b3fkmrbl)
    const s1Match = matches.find(m => m.status === "LIVE" && Array.isArray(m.streams) && m.streams.some(s => s.stream_url && s.stream_url.includes("avqlywnuzx")));
    const s2Match = matches.find(m => m.status === "LIVE" && Array.isArray(m.streams) && m.streams.some(s => s.stream_url && s.stream_url.includes("b3b3fkmrbl")));

    const ch1 = { ...FANCODE_PRO_CHANNELS[0] };
    const ch2 = { ...FANCODE_PRO_CHANNELS[1] };

    if (s1Match) {
      ch1.title     = `${s1Match.event_name} (FHD Live)`;
      ch1.matchName = s1Match.event_name;
      ch1.group     = s1Match.Category || "Cricket";
      ch1.logo      = `https://raw.githubusercontent.com/sm-monirulislam/Upcoming-and-Live-Sports-Data/main/match_image/${encodeURIComponent(s1Match.event_name)}.jpg`;
    }

    if (s2Match) {
      ch2.title     = `${s2Match.event_name} (Server 2)`;
      ch2.matchName = s2Match.event_name;
      ch2.group     = s2Match.Category || "Cricket";
      ch2.logo      = `https://raw.githubusercontent.com/sm-monirulislam/Upcoming-and-Live-Sports-Data/main/match_image/${encodeURIComponent(s2Match.event_name)}.jpg`;
    }

    return [ch1, ch2];
  } catch (err) {
    console.warn("[DeepStream] Match auto-detect fallback:", err);
    return FANCODE_PRO_CHANNELS;
  }
}

/**
 * Optional Proxy URL for HLS (.m3u8) streams
 */
const PROXY_WORKER_URL = "";

function proxiedStreamUrl(url) {
  if (!url) return "";
  const clean = url.split("|")[0].trim();
  if (PROXY_WORKER_URL && PROXY_WORKER_URL.trim() !== "") {
    const base = PROXY_WORKER_URL.trim().replace(/\/+$/, "");
    return `${base}/?url=${encodeURIComponent(clean)}`;
  }
  return clean;
}

/* ══════════════════════════════════════════════════════════════════════
   M3U FETCH & PARSE
══════════════════════════════════════════════════════════════════════ */

/**
 * Fetches and parses all M3U playlists with deduplication and merges Pro+ channels.
 * @returns {Promise<Channel[]>}
 */
async function fetchEvents() {
  const bust = Date.now();
  const seenUrls = new Set();
  const allChannels = [];

  // 1. Add auto-detected FanCode Pro+ channels first (with real live match title and thumbnail)
  const proChannels = await fetchDynamicProChannels();
  for (const ch of proChannels) {
    seenUrls.add(ch.url);
    allChannels.push(ch);
  }

  // 2. Fetch M3U playlists
  for (const src of M3U_SOURCES) {
    try {
      const res = await fetch(`${src}?_=${bust}`, { cache: "no-store" });
      if (!res.ok) continue;
      const text = await res.text();
      const parsed = parseM3U(text);

      for (const ch of parsed) {
        if (!seenUrls.has(ch.url)) {
          seenUrls.add(ch.url);
          allChannels.push(ch);
        }
      }
    } catch (err) {
      console.warn("Failed to fetch M3U from:", src, err);
    }
  }

  return allChannels;
}

/**
 * Parses raw M3U playlist string into Channel objects.
 * @param {string} text
 * @returns {Channel[]}
 */
function parseM3U(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const list = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("#EXTINF:")) continue;

    /* ── Parse EXTINF attributes ── */
    const logoMatch   = line.match(/tvg-logo="([^"]*)"/i);
    const groupMatch  = line.match(/group-title="([^"]*)"/i);
    
    /* Title is everything after the last attribute's closing quote + comma */
    let title = "Live Match";
    const quoteCommaMatch = line.match(/",\s*(.+)$/);
    if (quoteCommaMatch) {
      title = quoteCommaMatch[1].trim();
    } else {
      const commaIdx = line.indexOf(",");
      if (commaIdx !== -1) title = line.substring(commaIdx + 1).trim();
    }

    /* ── URL is the next non-comment, non-empty line ── */
    let url = "";
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] && !lines[j].startsWith("#")) {
        url = lines[j];
        break;
      }
    }
    if (!url) continue;

    /* ── Clean up group ── */
    let group = (groupMatch ? groupMatch[1] : "Sports")
      .replace(/^Fancode-/i, "")
      .replace(/^(ENGLISH|HINDI|TAMIL|TELUGU|KANNADA|MALAYALAM|BENGALI|PUNJABI|GUJARATI|MARATHI)\s+/i, "")
      .trim() || "Sports";

    const logo = logoMatch ? logoMatch[1] : "";

    list.push({
      url,
      qualities: {},
      title,
      matchName: title,
      eventName: "",
      team1:     "",
      team2:     "",
      group,
      logo,
      matchId:   0,
      startTime: "",
      language:  "",
      type:      url.includes(".mpd") ? "dash" : "hls",
    });
  }

  return list;
}

/* ══════════════════════════════════════════════════════════════════════
   RENDER CHANNEL LIST
══════════════════════════════════════════════════════════════════════ */

/** @param {Channel[]} list */
function renderChannelList(list) {
  if (!list.length) {
    channelList.innerHTML = `<div class="empty-state"><p>No live matches right now</p></div>`;
    channelCount.textContent = "0 live";
    return;
  }

  /* Group by event_category */
  const grouped = new Map();
  for (const ch of list) {
    const g = ch.group || "Sports";
    if (!grouped.has(g)) grouped.set(g, []);
    grouped.get(g).push(ch);
  }

  const frag = document.createDocumentFragment();
  for (const [group, items] of grouped) {
    const label = document.createElement("div");
    label.className = "group-label";
    label.textContent = group;
    frag.appendChild(label);
    for (const ch of items) frag.appendChild(createChannelButton(ch));
  }

  channelList.innerHTML = "";
  channelList.appendChild(frag);
  channelCount.textContent = `${list.length} live`;
}

/** @param {Channel} ch */
function createChannelButton(ch) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "channel-item";
  btn.dataset.url = ch.url;
  if (ch.key)  btn.dataset.key = ch.key;
  if (ch.type) btn.dataset.type = ch.type;
  if (activeChannel?.url === ch.url) btn.classList.add("active");

  const logoEl = ch.logo
    ? Object.assign(document.createElement("img"), {
        className: "channel-logo",
        src:       ch.logo,
        alt:       "",
        loading:   "lazy",
      })
    : (() => {
        const div = document.createElement("div");
        div.className = "channel-logo placeholder";
        div.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>`;
        return div;
      })();

  if (logoEl.onerror !== undefined) {
    logoEl.onerror = () => {
      const div = document.createElement("div");
      div.className = "channel-logo placeholder";
      div.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>`;
      logoEl.replaceWith(div);
    };
  }

  const meta = document.createElement("div");
  meta.className = "channel-meta";
  const langBadge = ch.language
    ? `<span class="channel-lang">${escapeHtml(ch.language)}</span>`
    : "";
  meta.innerHTML = `
    <div class="channel-name">${escapeHtml(ch.title)}</div>
    ${langBadge}<div class="channel-group">${escapeHtml(ch.group)}</div>`;

  btn.append(logoEl, meta);
  btn.addEventListener("click", () => playChannel(ch));
  return btn;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/* ══════════════════════════════════════════════════════════════════════
   STREAM PLAYBACK (Shaka Player DASH ClearKey + Hls.js HLS)
══════════════════════════════════════════════════════════════════════ */

/** @param {Channel} ch */
function playChannel(ch) {
  activeChannel = ch;
  updateNowPlaying(ch);
  highlightActiveChannel(ch.url);
  closeDrawer();

  /* Start playback */
  loadStream(ch);
}

/** Ensure Shaka Player library is loaded dynamically even if missing from HTML */
async function ensureShakaLoaded() {
  if (window.shaka && window.shaka.Player) return true;
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/shaka-player/4.11.7/shaka-player.compiled.js";
    script.async = true;
    script.onload = () => {
      console.log("[DeepStream] Shaka Player library loaded dynamically.");
      resolve(true);
    };
    script.onerror = (e) => {
      console.error("[DeepStream] Failed to load Shaka Player script:", e);
      resolve(false);
    };
    document.head.appendChild(script);
  });
}

/** Load stream with Shaka Player (DASH) or Hls.js (HLS) */
async function loadStream(ch) {
  await destroyPlayer();
  networkRetries = 0;
  showLoading(true);
  hideError();
  playerOverlay.classList.add("hidden");

  let rawUrl = typeof ch === "string" ? ch : (ch?.url || "");
  let drmKey = typeof ch === "object" ? (ch?.key || "") : "";
  let isDash = (ch && (ch.type === "dash" || (ch.url && ch.url.includes(".mpd")))) || rawUrl.includes(".mpd");

  // Fallback lookup in FANCODE_PRO_CHANNELS if key or type missing
  if (!drmKey || !isDash) {
    const cleanLookup = rawUrl.split("|")[0].trim();
    const found = FANCODE_PRO_CHANNELS.find(c => c.url.split("|")[0].trim() === cleanLookup) ||
                  channels.find(c => c.url.split("|")[0].trim() === cleanLookup);
    if (found) {
      if (!drmKey && found.key) drmKey = found.key;
      if (!isDash && (found.type === "dash" || found.url.includes(".mpd"))) isDash = true;
    }
  }

  const cleanUrl = rawUrl.split("|")[0].trim();

  // 1. DASH Playback via Shaka Player (ClearKey DRM)
  if (isDash) {
    const shakaReady = await ensureShakaLoaded();
    if (shakaReady && window.shaka) {
      try {
        if (typeof shaka.polyfill?.installAll === "function") {
          shaka.polyfill.installAll();
        }
        if (!shaka.Player.isBrowserSupported()) {
          showError("Your browser does not support DASH playback (EME required).");
          showLoading(false);
          return;
        }

        shakaPlayer = new shaka.Player();
        await shakaPlayer.attach(video);
        window.__shakaInstance = shakaPlayer;

        // Configure ClearKey DRM
        const clearKeysConfig = {};
        if (drmKey && drmKey.includes(":")) {
          const parts = drmKey.split(":");
          clearKeysConfig[parts[0].trim()] = parts[1].trim();
        }

        shakaPlayer.configure({
          streaming: {
            bufferingGoal: 30,
            rebufferingGoal: 3,
            bufferBehind: 30,
            lowLatencyMode: false,
            safeSeekOffset: 5,
            stallEnabled: true,
            stallThreshold: 2,
            stallSkip: 0.5,
            jumpLargeGaps: true,
            retryParameters: { maxAttempts: 6, baseDelay: 500, backoffFactor: 1.5, timeout: 10000 }
          },
          manifest: {
            dash: {
              autoCorrectDrift: true,
              ignoreSuggestedPresentationDelay: true,
              defaultPresentationDelay: 14
            },
            retryParameters: { maxAttempts: 4, baseDelay: 400, backoffFactor: 1.5, timeout: 10000 }
          },
          abr: {
            enabled: true,
            defaultBandwidthEstimate: 3000000,
            switchInterval: 4
          },
          ...(Object.keys(clearKeysConfig).length > 0 ? { drm: { clearKeys: clearKeysConfig } } : {})
        });

        shakaPlayer.addEventListener("error", (event) => {
          console.error("[Shaka Error]", event.detail);
          showLoading(false);
          showError("Stream error. The live match may be temporarily unavailable.");
        });

        console.log("[DeepStream] Loading DASH via Shaka Player:", cleanUrl, "ClearKeys:", clearKeysConfig);
        await shakaPlayer.load(cleanUrl);

        showLoading(false);
        buildQualitySelectorShaka();

        video.muted = false;
        video.play().catch((e) => {
          console.log("Unmuted autoplay restricted; trying muted fallback:", e);
          video.muted = true;
          video.play().catch(() => {});
        });

        video.addEventListener("playing", () => showLoading(false), { once: true });
        return;
      } catch (err) {
        console.error("[Shaka Load Failed]", err);
        showLoading(false);
        showError("DASH playback failed: " + (err.message || err.code || "Network error"));
        return;
      }
    }
  }

  // 2. HLS Playback via Hls.js
  const streamUrl = proxiedStreamUrl(cleanUrl);
  console.log("[DeepStream] Loading HLS stream:", streamUrl);

  if (Hls.isSupported()) {
    hls = new Hls({
      maxMaxBufferLength: 60,
      enableWorker: true,
      lowLatencyMode: true,
    });
    window.__hlsInstance = hls;

    hls.loadSource(streamUrl);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
      showLoading(false);
      buildQualitySelectorHls(data.levels);

      video.muted = false;
      video.play().catch((e) => {
        console.log("Unmuted autoplay restricted; trying muted fallback:", e);
        video.muted = true;
        video.play().catch(() => {});
      });
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
      updateActiveQualityButton(data.level);
    });

    hls.on(Hls.Events.ERROR, (event, data) => {
      console.warn("[HLS Error]", data);
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
    // Native Safari HLS
    video.src = streamUrl;
    video.load();
    video.muted = false;
    video.play().catch(() => {
      video.muted = true;
      video.play().catch(() => {});
    });
    video.addEventListener("playing", () => showLoading(false), { once: true });
    video.addEventListener("error", () => {
      showLoading(false);
      showError("Native HLS playback failed.");
    }, { once: true });
  } else {
    showLoading(false);
    showError("Your browser does not support this stream format.");
  }
}

/* ── Quality Selector UI (Shaka DASH) ── */
function buildQualitySelectorShaka() {
  const container = document.getElementById("quality-selector");
  if (!container || !shakaPlayer) return;

  const tracks = shakaPlayer.getVariantTracks().filter(t => t.height);
  if (!tracks || tracks.length <= 1) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

  container.innerHTML = "";

  // Group unique heights descending
  const uniqueHeights = [...new Set(tracks.map(t => t.height))].sort((a, b) => b - a);

  // Default to 720p if available
  const has720 = uniqueHeights.includes(720);
  let defaultHeight = has720 ? 720 : null;

  if (defaultHeight) {
    shakaPlayer.configure({ abr: { enabled: false } });
    const targetTrack = tracks.find(t => t.height === defaultHeight);
    if (targetTrack) shakaPlayer.selectVariantTrack(targetTrack, /* clearBuffer= */ false);
  }

  // Auto Button
  const autoBtn = document.createElement("button");
  autoBtn.type = "button";
  autoBtn.className = "quality-btn" + (!defaultHeight ? " active" : "");
  autoBtn.textContent = "Auto";
  autoBtn.addEventListener("click", () => {
    shakaPlayer.configure({ abr: { enabled: true } });
    container.querySelectorAll(".quality-btn").forEach(b => b.classList.remove("active"));
    autoBtn.classList.add("active");
  });
  container.appendChild(autoBtn);

  uniqueHeights.forEach(h => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "quality-btn" + (h === defaultHeight ? " active" : "");
    btn.textContent = `${h}p`;
    btn.addEventListener("click", () => {
      shakaPlayer.configure({ abr: { enabled: false } });
      const targetTrack = tracks.find(t => t.height === h);
      if (targetTrack) shakaPlayer.selectVariantTrack(targetTrack, /* clearBuffer= */ false);
      container.querySelectorAll(".quality-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    });
    container.appendChild(btn);
  });

  container.classList.remove("hidden");
}

/* ── Quality Selector UI (Hls.js) ── */
function buildQualitySelectorHls(levels) {
  const container = document.getElementById("quality-selector");
  if (!container) return;

  if (!levels || levels.length <= 1) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

  container.innerHTML = "";

  // Check if 720p is available
  const idx720 = levels.findIndex(lvl => lvl.height === 720);
  const defaultLevel = idx720 !== -1 ? idx720 : -1;

  if (hls) {
    hls.currentLevel = defaultLevel;
  }

  const autoBtn = document.createElement("button");
  autoBtn.type = "button";
  autoBtn.className = "quality-btn" + (defaultLevel === -1 ? " active" : "");
  autoBtn.textContent = "Auto";
  autoBtn.dataset.level = "-1";
  autoBtn.addEventListener("click", () => {
    if (hls) hls.currentLevel = -1;
    container.querySelectorAll(".quality-btn").forEach(b => b.classList.remove("active"));
    autoBtn.classList.add("active");
  });
  container.appendChild(autoBtn);

  const sorted = levels
    .map((lvl, idx) => ({ ...lvl, index: idx }))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  sorted.forEach((lvl) => {
    if (!lvl.height) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "quality-btn" + (lvl.index === defaultLevel ? " active" : "");
    btn.textContent = `${lvl.height}p`;
    btn.dataset.level = String(lvl.index);

    btn.addEventListener("click", () => {
      if (hls) hls.currentLevel = lvl.index;
      container.querySelectorAll(".quality-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    });

    container.appendChild(btn);
  });

  container.classList.remove("hidden");
}

function updateActiveQualityButton(levelIdx) {
  const container = document.getElementById("quality-selector");
  if (!container) return;
  const targetLevel = hls && hls.autoLevelEnabled ? "-1" : String(levelIdx);
  container.querySelectorAll(".quality-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.level === targetLevel);
  });
}

function hideQualitySelector() {
  const container = document.getElementById("quality-selector");
  if (container) {
    container.classList.add("hidden");
    container.innerHTML = "";
  }
}

async function destroyPlayer() {
  if (shakaPlayer) {
    try { await shakaPlayer.destroy(); } catch(e) {}
    shakaPlayer = null;
  }
  window.__shakaInstance = null;

  if (hls) {
    try { hls.destroy(); } catch(e) {}
    hls = null;
  }
  window.__hlsInstance = null;

  video.pause();
  video.removeAttribute("src");
  video.load();
  hideQualitySelector();
}

/** @param {Channel} ch */
function updateNowPlaying(ch) {
  nowTitle.textContent = ch.title;
  nowGroup.textContent = ch.group;
  nowUrl.textContent   = ch.url;

  if (ch.logo) {
    nowLogo.src = ch.logo;
    nowLogo.classList.remove("hidden");
    nowLogo.onerror = () => nowLogo.classList.add("hidden");
    video.poster = ch.logo;
  } else {
    nowLogo.classList.add("hidden");
    nowLogo.removeAttribute("src");
    video.removeAttribute("poster");
  }
}

function highlightActiveChannel(url) {
  channelList.querySelectorAll(".channel-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.url === url);
  });
}

function showLoading(on) { playerLoading.classList.toggle("hidden", !on); }
function showError(msg)  { errorMessage.textContent = msg; playerError.classList.remove("hidden"); playerOverlay.classList.add("hidden"); }
function hideError()     { playerError.classList.add("hidden"); }

/* ══════════════════════════════════════════════════════════════════════
   LOAD + REFRESH
══════════════════════════════════════════════════════════════════════ */

async function loadEvents() {
  channelCount.textContent = "Loading…";
  const list = await fetchEvents();

  if (!list.length) {
    channelList.innerHTML = `<div class="empty-state"><p>No live matches right now. Check back soon.</p></div>`;
    channelCount.textContent = "0 live";
    return;
  }

  channels = list;
  renderChannelList(channels);
}

function startRefresh() {
  setInterval(async () => {
    const list = await fetchEvents();
    if (!list.length) return;

    const prevUrl = activeChannel?.url;
    channels = list;
    renderChannelList(channels);
    if (prevUrl) highlightActiveChannel(prevUrl);
  }, REFRESH_MS);
}

/* ── Search ── */
function filterChannels(query) {
  const q = query.trim().toLowerCase();
  if (!q) { renderChannelList(channels); return; }
  const filtered = channels.filter(
    (c) =>
      c.title.toLowerCase().includes(q) ||
      c.group.toLowerCase().includes(q) ||
      c.eventName.toLowerCase().includes(q) ||
      c.matchName.toLowerCase().includes(q)
  );
  renderChannelList(filtered);
}
channelSearch.addEventListener("input", (e) => filterChannels(e.target.value));

/* ── Drawer (sidebar) ── */
const sidebar        = $("#sidebar");
const drawerBackdrop = $("#drawer-backdrop");

function openDrawer()  { sidebar.classList.add("open"); drawerBackdrop.classList.remove("hidden"); document.body.classList.add("drawer-open"); }
function closeDrawer() { sidebar.classList.remove("open"); drawerBackdrop.classList.add("hidden"); document.body.classList.remove("drawer-open"); }

$("#btn-channels")?.addEventListener("click", openDrawer);
$("#btn-close-drawer")?.addEventListener("click", closeDrawer);
drawerBackdrop?.addEventListener("click", closeDrawer);

$("#btn-retry").addEventListener("click", () => { if (activeChannel) playChannel(activeChannel); });

window.addEventListener("beforeunload", destroyPlayer);

/* ══════════════════════════════════════════════════════════════════════
   CUSTOM CLEAN PLAYER CONTROLS (LiveXO Style: No epoch time)
══════════════════════════════════════════════════════════════════════ */
function setupCustomControls() {
  const playerWrap = document.getElementById("player-wrap");
  const playPauseBtn = document.getElementById("ctrl-play-pause");
  const muteBtn = document.getElementById("ctrl-mute");
  const fullscreenBtn = document.getElementById("ctrl-fullscreen");
  if (!playerWrap || !video) return;

  const iconPause = playPauseBtn?.querySelector(".icon-pause");
  const iconPlay = playPauseBtn?.querySelector(".icon-play");
  const iconVol = muteBtn?.querySelector(".icon-vol");
  const iconMuted = muteBtn?.querySelector(".icon-muted");

  let idleTimer = null;

  function resetIdleTimer() {
    playerWrap.classList.remove("idle");
    clearTimeout(idleTimer);
    if (!video.paused) {
      idleTimer = setTimeout(() => {
        if (!video.paused) {
          playerWrap.classList.add("idle");
        }
      }, 3000);
    }
  }

  function togglePlayPause() {
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
    resetIdleTimer();
  }

  function toggleMute() {
    video.muted = !video.muted;
    resetIdleTimer();
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      if (playerWrap.requestFullscreen) {
        playerWrap.requestFullscreen().catch(() => {});
      } else if (playerWrap.webkitRequestFullscreen) {
        playerWrap.webkitRequestFullscreen();
      } else if (video.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    }
    resetIdleTimer();
  }

  function syncPlayState() {
    const isPaused = video.paused;
    if (iconPause && iconPlay) {
      iconPause.classList.toggle("hidden", isPaused);
      iconPlay.classList.toggle("hidden", !isPaused);
    }
    if (isPaused) {
      playerWrap.classList.remove("idle");
      clearTimeout(idleTimer);
    } else {
      resetIdleTimer();
    }
  }

  function syncMuteState() {
    const isMuted = video.muted || video.volume === 0;
    if (iconVol && iconMuted) {
      iconVol.classList.toggle("hidden", isMuted);
      iconMuted.classList.toggle("hidden", !isMuted);
    }
  }

  playPauseBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePlayPause();
  });

  muteBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMute();
  });

  fullscreenBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFullscreen();
  });

  video.addEventListener("click", () => {
    togglePlayPause();
  });

  playerWrap.addEventListener("mousemove", resetIdleTimer);
  playerWrap.addEventListener("touchstart", resetIdleTimer, { passive: true });
  playerWrap.addEventListener("mouseleave", () => {
    if (!video.paused) playerWrap.classList.add("idle");
  });

  video.addEventListener("play", syncPlayState);
  video.addEventListener("pause", syncPlayState);
  video.addEventListener("playing", syncPlayState);
  video.addEventListener("volumechange", syncMuteState);

  syncPlayState();
  syncMuteState();
}

/* ── Boot ── */
setupCustomControls();
loadEvents();
startRefresh();

/* Expose playChannel globally so index.html's inline script can call it directly */
window.playChannel = playChannel;
