const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const API_KEY = process.env.YOUTUBE_API_KEY || "AIzaSyDPoage3uPPmJoRUmeUUk2A0mFTXcQFaPw";
const PORT = process.env.PORT || 7000;
const CACHE_MS = 30 * 60 * 1000;
const PAGES = parseInt(process.env.PAGES || "10", 10); // 50 videos per page
const KEYWORDS = (process.env.KEYWORDS || "highlight,recap")
  .toLowerCase()
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// One catalog per sport. "handle" is the YouTube @handle of the official channel.
const SPORTS = [
  { id: "nfl-highlights", name: "NFL Highlights", handle: "NFL", keywords: ["highlights"], exclude: ["recap"] },
  { id: "nba-highlights", name: "NBA Highlights", handle: "NBA" },
  { id: "mlb-highlights", name: "MLB Highlights", handle: "MLB" },
  { id: "nhl-highlights", name: "NHL Highlights", handle: "NHL" },
  { id: "epl-highlights", name: "Premier League Highlights", handle: "premierleague" },
  { id: "mls-highlights", name: "MLS Highlights", handle: "MLS" },
];

const manifest = {
  id: "community.nfl.highlights", // kept the same so existing collections still link up
  version: "2.0.0",
  name: "Sports Highlights",
  description: "Highlight videos from official sports YouTube channels.",
  resources: ["catalog", "meta", "stream"],
  types: ["movie"],
  idPrefixes: ["hl:", "nflhl:"],
  catalogs: SPORTS.map((s) => ({
    type: "movie",
    id: s.id,
    name: s.name,
    extra: [{ name: "search", isRequired: false }],
  })),
};

if (!API_KEY) console.error("WARNING: YOUTUBE_API_KEY is not set. Catalogs will be empty.");

// ---------- YouTube API helpers ----------
async function api(path, params) {
  const qs = new URLSearchParams({ ...params, key: API_KEY });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${qs}`);
  const data = await res.json();
  if (data.error) throw new Error(`${path}: ${data.error.message}`);
  return data;
}

const uploadsCache = {};
async function getUploads(handle) {
  if (uploadsCache[handle]) return uploadsCache[handle];
  const data = await api("channels", { part: "contentDetails", forHandle: handle });
  const item = (data.items || [])[0];
  if (!item) throw new Error(`No channel found for @${handle}`);
  uploadsCache[handle] = item.contentDetails.relatedPlaylists.uploads;
  return uploadsCache[handle];
}

const toVideo = (s, id) => ({
  id,
  title: s.title || "",
  published: s.publishedAt || "",
  thumb:
    ((s.thumbnails && (s.thumbnails.high || s.thumbnails.medium || s.thumbnails.default)) || {})
      .url || "",
});

async function fetchSport(sport) {
  const playlistId = await getUploads(sport.handle);
  const out = [];
  let pageToken = "";
  for (let i = 0; i < PAGES; i++) {
    const params = { part: "snippet", maxResults: "50", playlistId };
    if (pageToken) params.pageToken = pageToken;
    const data = await api("playlistItems", params);
    for (const it of data.items || []) {
      const s = it.snippet;
      if (!s || !s.resourceId) continue;
      out.push(toVideo(s, s.resourceId.videoId));
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return out.filter((v) => KEYWORDS.some((k) => v.title.toLowerCase().includes(k)));
}

// ---------- Per-sport cache ----------
const caches = {};
async function getSportVideos(sport) {
  const c = caches[sport.id];
  if (c && Date.now() - c.at < CACHE_MS && c.videos.length) return c.videos;
  try {
    caches[sport.id] = { at: Date.now(), videos: await fetchSport(sport) };
  } catch (err) {
    console.error(`Fetch failed for ${sport.name}:`, err.message);
  }
  return (caches[sport.id] && caches[sport.id].videos) || [];
}

async function getVideoById(vid) {
  for (const c of Object.values(caches)) {
    const v = c.videos.find((x) => x.id === vid);
    if (v) return v;
  }
  try {
    const data = await api("videos", { part: "snippet", id: vid });
    const it = (data.items || [])[0];
    return it ? toVideo(it.snippet, vid) : null;
  } catch (err) {
    return null;
  }
}

// ---------- Addon handlers ----------
const toMeta = (v) => ({
  id: "hl:" + v.id,
  type: "movie",
  name: v.title,
  poster: v.thumb,
  posterShape: "landscape",
  background: v.thumb,
  releaseInfo: v.published ? v.published.slice(0, 10) : undefined,
});

const videoIdFrom = (id) => id.split(":").pop();

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ id, extra }) => {
  const sport = SPORTS.find((s) => s.id === id);
  if (!sport) return { metas: [] };
  let videos = await getSportVideos(sport);
  if (extra && extra.search) {
    const q = extra.search.toLowerCase();
    videos = videos.filter((v) => v.title.toLowerCase().includes(q));
  }
  return { metas: videos.map(toMeta) };
});

builder.defineMetaHandler(async ({ id }) => {
  const v = await getVideoById(videoIdFrom(id));
  return { meta: v ? toMeta(v) : null };
});

builder.defineStreamHandler(async ({ id }) => {
  const vid = videoIdFrom(id);
  return {
    streams: [
      { externalUrl: `https://www.youtube.com/watch?v=${vid}`, title: "Open in YouTube" },
      { ytId: vid, title: "Play (YouTube player)" },
    ],
  };
});

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Sports Highlights addon running: http://localhost:${PORT}/manifest.json`);
