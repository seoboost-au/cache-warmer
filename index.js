import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { parseStringPromise } from "xml2js";
import * as dotenv from "dotenv";

dotenv.config();

/* ================= ENV ================= */
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

/* ================= DOMAIN / PROXY / UA ================= */
const DOMAIN = "https://seoboost.au";

const PROXY = process.env.BRD_PROXY_AU;
if (!PROXY) {
  throw new Error("❌ BRD_PROXY_AU is required");
}

const USER_AGENT = "Seoboost-CacheWarmer-AU/1.0";

/* ================= UTIL ================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractCfEdge(cfRay) {
  if (typeof cfRay === "string" && cfRay.includes("-")) {
    return cfRay.split("-").pop();
  }
  return "N/A";
}

function shouldPurgeByVercel(vercelCache) {
  return ["MISS", "REVALIDATED", "PRERENDER", "STALE"].includes(vercelCache);
}

/* ================= LOGGER → GSHEETS ================= */
class AppsScriptLogger {
  constructor() {
    this.rows = [];
    this.runId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
  }

  log({
    edge = "",
    url = "",
    status = "",
    cfCache = "",
    vercelCache = "",
    cfRay = "",
    responseMs = "",
    error = 0,
    message = "",
  }) {
    this.rows.push([
      this.runId,
      this.startedAt,
      this.finishedAt,
      edge,
      url,
      status,
      cfCache,
      vercelCache,
      cfRay,
      typeof responseMs === "number" ? responseMs : "",
      error ? 1 : 0,
      message,
    ]);
  }

  setFinished() {
    this.finishedAt = new Date().toISOString();
    this.rows = this.rows.map((r) => {
      r[2] = this.finishedAt;
      return r;
    });
  }

  async flush() {
    if (!APPS_SCRIPT_URL || this.rows.length === 0) return;

    await axios.post(
      APPS_SCRIPT_URL,
      { rows: this.rows },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 20000,
      }
    );

    console.log(`📝 Logged ${this.rows.length} rows to GSheets`);
    this.rows = [];
  }
}

/* ================= HTTP ================= */
const agent = new HttpsProxyAgent(PROXY);

function axiosCfg(timeout = 30000) {
  return {
    httpsAgent: agent,
    timeout,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
    },
  };
}

/* ================= SITEMAP (SINGLE) ================= */
async function fetchUrlsFromSitemap() {
  try {
    const xml = await axios
      .get(`${DOMAIN}/sitemap.xml`, axiosCfg(20000))
      .then((r) => r.data);

    const parsed = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
    });

    const urls = parsed?.urlset?.url;
    if (!urls) return [];

    return (Array.isArray(urls) ? urls : [urls])
      .map((u) => u.loc)
      .filter(Boolean);
  } catch (e) {
    console.warn("❌ Failed to fetch sitemap:", e?.message || e);
    return [];
  }
}

/* ================= CLOUDFLARE ================= */
async function purgeCloudflareCache(url) {
  if (!CLOUDFLARE_ZONE_ID || !CLOUDFLARE_API_TOKEN) return;

  await axios.post(
    `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache`,
    { files: [url] },
    {
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );

  console.log(`🧹 CF purged → ${url}`);
}

/* ================= WARMER ================= */
async function warmUrls(urls, logger) {
  for (const url of urls) {
    const t0 = Date.now();

    try {
      const res = await axios.get(url, axiosCfg(30000));
      const dt = Date.now() - t0;

      const cfCache = res.headers["cf-cache-status"] || "N/A";
      const vercelCache = res.headers["x-vercel-cache"] || "N/A";
      const cfRay = res.headers["cf-ray"] || "";
      const edge = extractCfEdge(cfRay);

      console.log(
        `[${edge}] ${res.status} cf=${cfCache} vercel=${vercelCache} - ${url}`
      );

      logger.log({
        edge,
        url,
        status: res.status,
        cfCache,
        vercelCache,
        cfRay,
        responseMs: dt,
      });

      // ✅ PURGE RULE — SESUAI KEPUTUSAN KAMU
      if (shouldPurgeByVercel(vercelCache)) {
        await purgeCloudflareCache(url);
      }
    } catch (err) {
      logger.log({
        edge: "ERROR",
        url,
        error: 1,
        message: err?.message || "request failed",
      });
    }

    await sleep(1500);
  }
}

/* ================= MAIN ================= */
(async () => {
  console.log(`[CacheWarmer-AU] Started at ${new Date().toISOString()}`);
  const logger = new AppsScriptLogger();

  try {
    const urls = await fetchUrlsFromSitemap();
    console.log(`[AU] Found ${urls.length} URLs`);
    await warmUrls(urls, logger);
  } finally {
    logger.setFinished();
    await logger.flush();
  }

  console.log(`[CacheWarmer-AU] Finished at ${new Date().toISOString()}`);
})();
