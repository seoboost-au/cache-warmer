// cache-warmer-au.js
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { parseStringPromise } from "xml2js";
import * as dotenv from "dotenv";

dotenv.config();

/* ================= ENV ================= */
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

/* ================= TARGET (AU) ================= */
const DOMAIN = "https://seoboost.au";
const PROXY = process.env.BRD_PROXY_AU;
const USER_AGENT = "Seoboost-CacheWarmer-AU/1.0";

/* ================= HARD GUARD ================= */
if (!PROXY) {
  throw new Error("❌ BRD_PROXY_AU is REQUIRED. Aborting to avoid US edge.");
}

/* ================= UTIL ================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractCfEdge(cfRay) {
  if (typeof cfRay === "string" && cfRay.includes("-")) {
    return cfRay.split("-").pop();
  }
  return "UNKNOWN";
}

function makeSheetNameForRun(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const local = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return (
    `${local.getUTCFullYear()}-` +
    `${pad(local.getUTCMonth() + 1)}-` +
    `${pad(local.getUTCDate())}_` +
    `${pad(local.getUTCHours())}-` +
    `${pad(local.getUTCMinutes())}-` +
    `${pad(local.getUTCSeconds())}_WITA`
  );
}

/* ================= LOGGER ================= */
class AppsScriptLogger {
  constructor() {
    this.rows = [];
    this.runId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.sheetName = makeSheetNameForRun();
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
      { sheetName: this.sheetName, rows: this.rows },
      { timeout: 20000, headers: { "Content-Type": "application/json" } }
    );

    console.log(`📝 Logged ${this.rows.length} rows → ${this.sheetName}`);
    this.rows = [];
  }
}

/* ================= HTTP (AU-ANCHORED) ================= */
const agent = new HttpsProxyAgent(PROXY);

async function fetch(url, timeout = 30000) {
  return axios.get(url, {
    httpsAgent: agent,
    timeout,
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-AU,en;q=0.9",
    },
  });
}

/* ================= SITEMAP ================= */
async function fetchUrlsFromSitemap() {
  const xml = (await fetch(`${DOMAIN}/sitemap.xml`, 20000)).data;

  const parsed = await parseStringPromise(xml, {
    explicitArray: false,
    ignoreAttrs: true,
  });

  const urls = parsed?.urlset?.url;
  if (!urls) return [];

  return (Array.isArray(urls) ? urls : [urls])
    .map((u) => u.loc)
    .filter(Boolean);
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
}

/* ================= WARMER ================= */
async function warmUrls(urls, logger) {
  for (const url of urls) {
    const t0 = Date.now();
    try {
      const res = await fetch(url);
      const dt = Date.now() - t0;

      const cfCache = res.headers["cf-cache-status"] || "N/A";
      const vercelCache = res.headers["x-vercel-cache"] || "N/A";
      const cfRay = res.headers["cf-ray"] || "";
      const edge = extractCfEdge(cfRay);

      // HARD AU GUARD
      if (!["SYD", "MEL", "BNE", "PER"].includes(edge)) {
        throw new Error(`Non-AU edge detected: ${edge}`);
      }

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

      if (["MISS", "REVALIDATED", "PRERENDER", "STALE"].includes(vercelCache)) {
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
  console.log(`[CacheWarmer] Started ${new Date().toISOString()}`);
  const logger = new AppsScriptLogger();

  try {
    const urls = await fetchUrlsFromSitemap();
    console.log(`[AU] Found ${urls.length} URLs`);
    await warmUrls(urls, logger);
  } finally {
    logger.setFinished();
    await logger.flush();
  }

  console.log(`[CacheWarmer] Finished ${new Date().toISOString()}`);
})();
