const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

// Official NFL YouTube channel. Override with env vars if needed.
const CHANNEL_ID = process.env.CHANNEL_ID || "UCDVYQ4Zhbm3S2dlz7P1GBDg";
const KEYWORD = (process.env.KEYWORD || "highlights").toLowerCase();
const API_KEY = process.env.YOUTUBE_API_KEY || ""; // optional, gives deeper history
const PORT = process.env.PORT || 7000;
const CACHE_MS = 30 * 60 * 1000;

const manifest = {
  id: "community.nfl.highlights",
  version: "1.0.0",
  name: "NFL Highlights",
  description: "Highlight videos from the official NFL YouTube channel.",
  resources: ["catalog", "meta", "stream"],
  types: ["movie"],
  idPrefixes: ["nflhl:"],
  catalogs: [
    {
      type: "movie",
      id: "nfl-highlights",
      name: "NFL Highlights",
      extra: [{ name: "search", isRequired: false }],
    },
  ],
};

const decode = (s) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

// --- Source 1: public RSS feed (latest ~15 uploads, no key needed) ---
async function fetchRss() {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
  const xml = await (await fetch(url)).text();
  const entries = xml.split("<entry>").slice(1);
  return entries.map((e) => {
    const pick = (re) => (e.match(re) || [])[1] || "";
    return {
      id: pick(/<yt:videoId>(.*?)<\/yt:videoId>/),
      title: decode(pick(/<title>(.*?)<\/title>/)),
      published: pick(/<published>(.*?)<\/published>/),
      thumb: pick(/<media:thumbnail url="(.*?)"/),
      description: decode(pick(/<media:description>([\s\S]*?)<\/media:description>/)),
    };
  });
}

// --- Source 2: YouTube Data API uploads playlist (up to ~200 videos) ---
async function fetchApi() {
  const playlistId = "UU" + CHANNEL_ID.slice(2);
  const out = [];
  let pageToken = "";
  for (let page = 0; page < 4; page++) {
    const url =
      "https://www.googleapis.com/youtube/v3/playlistItems" +
      `?part=snippet&maxResults=50&playlistId=${playlistId}&key=${API_KEY}` +
      (pageToken ? `&pageToken=${pageToken}` : "");
    const data = await (await fetch(url)).json();
    for (const it of data.items || []) {
      const s = it.snippet;
      out.push({
        id: s.resourceId.videoId,
        title: s.title,
        published: s.publishedAt,
        thumb: (s.thumbnails.high || s.thumbnails.default || {}).url || "",
        description: s.description || "",
      });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

let cache = { at: 0, videos: [] };

async function getVideos() {
  if (Date.now() - cache.at < CACHE_MS && cache.videos.length) return cache.videos;
  try {
    const all = API_KEY ? await fetchApi() : await fetchRss();
    cache = {
      at: Date.now(),
      videos: all.filter((v) => v.id && v.title.toLowerCase().includes(KEYWORD)),
    };
  } catch (err) {
    console.error("Fetch failed:", err.message);
  }
  return cache.videos;
}

const toMeta = (v) => ({
  id: "nflhl:" + v.id,
  type: "movie",
  name: v.title,
  poster: v.thumb,
  posterShape: "landscape",
  background: v.thumb,
  description: v.description,
  releaseInfo: v.published ? v.published.slice(0, 10) : undefined,
});

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ extra }) => {
  let videos = await getVideos();
  if (extra && extra.search) {
    const q = extra.search.toLowerCase();
    videos = videos.filter((v) => v.title.toLowerCase().includes(q));
  }
  return { metas: videos.map(toMeta) };
});

builder.defineMetaHandler(async ({ id }) => {
  const videos = await getVideos();
  const v = videos.find((x) => "nflhl:" + x.id === id);
  return { meta: v ? toMeta(v) : null };
});

builder.defineStreamHandler(async ({ id }) => {
  if (!id.startsWith("nflhl:")) return { streams: [] };
  return { streams: [{ ytId: id.slice(6), title: "Watch on YouTube" }] };
});

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`NFL Highlights addon running: http://localhost:${PORT}/manifest.json`);
