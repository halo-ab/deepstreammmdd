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
  "https://raw.githubusercontent.com/doctor-8trange/zyphx8/refs/heads/main/data/fancode.m3u"
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

function cleanCategoryAndLang(rawCategory, defaultCat = "Cricket") {
  if (!rawCategory) return { group: defaultCat, language: "" };
  let group = rawCategory.trim();
  let language = "";
  const langMatch = group.match(/^(ENGLISH|HINDI|TAMIL|TELUGU|KANNADA|MALAYALAM|BENGALI|PUNJABI|GUJARATI|MARATHI)\s*/i);
  if (langMatch) {
    language = langMatch[1].toUpperCase();
    group = group.substring(langMatch[0].length).trim();
  }
  return {
    group: group || defaultCat,
    language: language
  };
}

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
      const cl = cleanCategoryAndLang(s1Match.Category, "Cricket");
      ch1.group     = cl.group;
      ch1.language  = cl.language || s1Match.Language || "English";
      ch1.logo      = `https://raw.githubusercontent.com/sm-monirulislam/Upcoming-and-Live-Sports-Data/main/match_image/${encodeURIComponent(s1Match.event_name)}.jpg`;
    }

    if (s2Match) {
      ch2.title     = `${s2Match.event_name} (Server 2)`;
      ch2.matchName = s2Match.event_name;
      const cl = cleanCategoryAndLang(s2Match.Category, "Cricket");
      ch2.group     = cl.group;
      ch2.language  = cl.language || s2Match.Language || "English";
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
 * Matches from the working M3U playlist appear FIRST, followed by the FanCode Pro+ channels.
 * @returns {Promise<Channel[]>}
 */
async function fetchEvents() {
  const bust = Date.now();
  const seenUrls = new Set();
  const allChannels = [];

  // 1. Fetch M3U playlists first so original source matches appear first!
  for (const src of M3U_SOURCES) {
    try {
      const res = await fetch(`${src}?_=${bust}`, { cache: "no-store" });
      if (!res.ok) continue;
      const text = await res.text();
      const parsed = parseM3U(text);

      for (const ch of parsed) {
        const cleanU = ch.url.split("|")[0].trim();
        if (!seenUrls.has(cleanU)) {
          seenUrls.add(cleanU);
          allChannels.push(ch);
        }
      }
    } catch (err) {
      console.warn("Failed to fetch M3U from:", src, err);
    }
  }

  // 2. Add auto-detected FanCode Pro+ DASH channels after the M3U matches
  try {
    const proChannels = await fetchDynamicProChannels();
    for (const ch of proChannels) {
      const cleanU = ch.url.split("|")[0].trim();
      if (!seenUrls.has(cleanU)) {
        seenUrls.add(cleanU);
        allChannels.push(ch);
      }
    }
  } catch (err) {
    console.warn("Failed to load Pro+ channels:", err);
  }

  return allChannels;
}

/**
 * Converts Base64URL string to Hex string for ClearKey DRM
 * @param {string} b64u
 * @returns {string}
 */
function base64UrlToHex(b64u) {
  if (!b64u) return "";
  let b64 = b64u.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  try {
    const raw = atob(b64);
    let hex = "";
    for (let i = 0; i < raw.length; i++) {
      const h = raw.charCodeAt(i).toString(16);
      hex += h.length === 1 ? "0" + h : h;
    }
    return hex.toLowerCase();
  } catch (e) {
    return "";
  }
}

/**
 * Parses raw M3U playlist string into Channel objects.
 * Supports HLS and ClearKey DRM DASH (#KODIPROP license_key)
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
    const langMatch   = line.match(/tvg-language="([^"]*)"/i);
    
    /* Title is everything after the last attribute's closing quote + comma */
    let title = "Live Match";
    const quoteCommaMatch = line.match(/",\s*(.+)$/);
    if (quoteCommaMatch) {
      title = quoteCommaMatch[1].trim();
    } else {
      const commaIdx = line.indexOf(",");
      if (commaIdx !== -1) title = line.substring(commaIdx + 1).trim();
    }

    // Clean up [DRM] tag and language prefix like "ENG | Australia Vs England" -> "Australia Vs England"
    title = title.replace(/\[DRM\]\s*/gi, "").trim();
    let language = langMatch ? langMatch[1] : "";
    const langPrefixMatch = title.match(/^(ENG|HIN|TAM|TEL|KAN|MAL|BEN|MAR)\s*\|\s*/i);
    if (langPrefixMatch) {
      if (!language) language = langPrefixMatch[1].toUpperCase();
      title = title.substring(langPrefixMatch[0].length).trim();
    }

    /* ── URL and DRM key from following lines ── */
    let url = "";
    let drmKey = "";
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l) continue;
      if (l.startsWith("#EXTINF:")) break;

      // Parse ClearKey DRM from KODIPROP license_key
      if (l.startsWith("#KODIPROP:inputstream.adaptive.license_key=")) {
        const val = l.replace("#KODIPROP:inputstream.adaptive.license_key=", "").trim();
        if (val.startsWith("{")) {
          try {
            const parsedJson = JSON.parse(val);
            if (Array.isArray(parsedJson.keys) && parsedJson.keys.length > 0) {
              const k0 = parsedJson.keys[0];
              const kidHex = base64UrlToHex(k0.kid);
              const keyHex = base64UrlToHex(k0.k);
              if (kidHex && keyHex) {
                drmKey = `${kidHex}:${keyHex}`;
              }
            }
          } catch (e) {}
        } else if (val.includes(":")) {
          drmKey = val;
        }
      }

      if (!l.startsWith("#")) {
        url = l;
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
      language,
      key:       drmKey,
      type:      (url.includes(".mpd") || drmKey) ? "dash" : "hls",
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

        const manifestDir = cleanUrl.substring(0, cleanUrl.lastIndexOf("/") + 1);

        // Register request filter to proxy hosts without CORS (e.g. in-mc-flive.fancode.com)
        // Also fixes relative segment resolution when manifest is proxied
        shakaPlayer.getNetworkingEngine().registerRequestFilter((type, request) => {
          for (let i = 0; i < request.uris.length; i++) {
            let uri = request.uris[i];
            if (!uri) continue;

            // Fix relative URLs accidentally resolved against proxy root
            if (uri.startsWith("https://cinexcricket.com/proxy/") && !uri.includes("?url=")) {
              const filename = uri.replace("https://cinexcricket.com/proxy/", "");
              uri = manifestDir + filename;
            }

            if (uri.includes("in-mc-flive.fancode.com") || uri.includes("fblive.fancode.com")) {
              request.uris[i] = "https://cinexcricket.com/proxy/universal.php/?url=" + encodeURIComponent(uri);
            }
          }
        });

        // Register response filter to inject BaseURL if missing so relative chunks resolve correctly
        shakaPlayer.getNetworkingEngine().registerResponseFilter((type, response) => {
          if (type === shaka.net.NetworkingEngine.RequestType.MANIFEST && response.data) {
            try {
              let text = "";
              if (typeof response.data === "string") {
                text = response.data;
              } else if (window.shaka?.util?.StringUtils?.fromUTF8) {
                text = shaka.util.StringUtils.fromUTF8(response.data);
              } else {
                text = new TextDecoder().decode(response.data);
              }

              if (text && !text.includes("<BaseURL>") && manifestDir) {
                text = text.replace(/<MPD([^>]*)>/, `<MPD$1><BaseURL>${manifestDir}</BaseURL>`);
                if (window.shaka?.util?.StringUtils?.toUTF8) {
                  response.data = shaka.util.StringUtils.toUTF8(text);
                } else {
                  response.data = new TextEncoder().encode(text);
                }
              }
            } catch (e) {
              console.warn("[DeepStream] Manifest BaseURL injection skipped:", e);
            }
          }
        });

        // Configure ClearKey DRM
        const clearKeysConfig = {};
        if (drmKey && drmKey.includes(":")) {
          const parts = drmKey.split(":");
          clearKeysConfig[parts[0].trim()] = parts[1].trim();
        }

        shakaPlayer.configure({
          streaming: {
            bufferingGoal: 2,
            rebufferingGoal: 0.5,
            bufferBehind: 10,
            lowLatencyMode: true,
            safeSeekOffset: 0.5,
            startAtSegmentBoundary: true,
            stallEnabled: true,
            stallThreshold: 1,
            stallSkip: 0.2,
            jumpLargeGaps: true,
            retryParameters: { maxAttempts: 5, baseDelay: 300, backoffFactor: 1.3, timeout: 6000 }
          },
          manifest: {
            dash: {
              autoCorrectDrift: true,
              clockSyncUri: "https://time.akamai.com/?iso",
              ignoreSuggestedPresentationDelay: false,
              defaultPresentationDelay: 2
            },
            retryParameters: { maxAttempts: 5, baseDelay: 300, backoffFactor: 1.3, timeout: 6000 }
          },
          abr: {
            enabled: false,
            defaultBandwidthEstimate: 3000000,
            restrictions: {
              maxHeight: 720
            }
          },
          ...(Object.keys(clearKeysConfig).length > 0 ? { drm: { clearKeys: clearKeysConfig } } : {})
        });

        shakaPlayer.addEventListener("error", (event) => {
          const detail = event.detail || {};
          console.error("[Shaka Error]", detail.code, detail.category, detail.message, detail);
          showLoading(false);
          showError(`Stream error (${detail.code || "DRM"}). The live match may be temporarily unavailable.`);
        });

        console.log("[DeepStream] Loading DASH via Shaka Player:", cleanUrl, "ClearKeys:", clearKeysConfig);
        await shakaPlayer.load(cleanUrl);

        showLoading(false);
        buildQualitySelectorShaka();

        // Lock to 720p variant track immediately
        try {
          const tracks = shakaPlayer.getVariantTracks().filter(t => t.height);
          const track720 = tracks.find(t => t.height === 720 && t.bandwidth <= 3500000) ||
                           tracks.find(t => t.height === 720) ||
                           tracks[0];
          if (track720) {
            shakaPlayer.selectVariantTrack(track720, /* clearBuffer= */ false);
          }
        } catch (e) {}

        video.controls = false;
        video.removeAttribute("controls");
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
    // Custom playlist loader to bust CDN and browser cache on every live .m3u8 poll
    // Prevents the browser from caching playlists with max-age=31536000 and repeating the stream
    class LivePlaylistLoader extends Hls.DefaultConfig.loader {
      load(context, config, callbacks) {
        if (context && context.url && (context.type === "manifest" || context.type === "level" || context.url.includes(".m3u8"))) {
          const sep = context.url.includes("?") ? "&" : "?";
          context.url = `${context.url}${sep}_t=${Date.now()}`;
        }
        super.load(context, config, callbacks);
      }
    }

    hls = new Hls({
      pLoader: LivePlaylistLoader,
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      enableWorker: true,
      lowLatencyMode: false,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 10,
      manifestLoadingTimeOut: 15000,
      manifestLoadingMaxRetry: 5,
      levelLoadingTimeOut: 15000,
      levelLoadingMaxRetry: 5,
      xhrSetup: (xhr, url) => {
        if (url && url.includes(".m3u8")) {
          try {
            xhr.setRequestHeader("Cache-Control", "no-cache, no-store, must-revalidate");
            xhr.setRequestHeader("Pragma", "no-cache");
          } catch (e) {}
        }
      }
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
    const sep = streamUrl.includes("?") ? "&" : "?";
    video.src = `${streamUrl}${sep}_t=${Date.now()}`;
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

  // Auto Button
  const autoBtn = document.createElement("button");
  autoBtn.type = "button";
  autoBtn.className = "quality-btn" + (!defaultHeight ? " active" : "");
  autoBtn.textContent = "Auto";
  autoBtn.addEventListener("click", () => {
    shakaPlayer.configure({ abr: { enabled: true, restrictions: { maxHeight: Infinity, minHeight: 0 } } });
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
      shakaPlayer.configure({ abr: { enabled: false, restrictions: { maxHeight: Infinity, minHeight: 0 } } });
      const targetTrack = tracks.find(t => t.height === h && t.bandwidth <= 3000000) || tracks.find(t => t.height === h && t.bandwidth <= 4500000) || tracks.find(t => t.height === h);
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
  if (nowUrl) nowUrl.textContent = "";

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
