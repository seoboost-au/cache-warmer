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

const USER_AGENT = "Seoboost-CacheWarmer-AU/1.0";

/* ================= UTIL ================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractCfEdge(cfRay) {
  if (typeof cfRay === "string" && cfRay.includes("-")) {
    return cfRay.split("-").pop();
  }
  return "N/A";
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
    country = "",
    url = "",
    status = "",
    cfCache = "",
    originCache = "",
    cfRay = "",
    responseMs = "",
    error = 0,
    message = "",
  }) {
    this.rows.push([
      this.runId,
      this.startedAt,
      this.finishedAt,
      country,
      url,
      status,
      cfCache,
      originCache,
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

    this.rows = [];
  }
}

/* ================= HTTP (AU ANCHORED) ================= */
function createAuAgent() {
  if (!PROXY) throw new Error("Missing BRD_PROXY_AU");
  return new HttpsProxyAgent(PROXY);
}

async function fetchWithProxy(url, agent, timeout = 15000) {
  const res = await axios.get(url, {
    httpsAgent: agent,
    timeout,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-AU,en;q=0.9",
    },
  });
  return res.data;
}

/* ================= SITEMAP (URLSET ONLY) ================= */
async function fetchUrlsFromSitemap(agent) {
  try {
    const xml = await fetchWithProxy(`${DOMAIN}/sitemap.xml`, agent, 20000);
    const parsed = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
    });

    const urls = parsed?.urlset?.url;
    if (!urls) return [];

    return (Array.isArray(urls) ? urls : [urls])
      .map((u) => u.loc)
      .filter(Boolean);
  } catch {
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
}

/* ================= WARMER ================= */
async function warmUrls(urls, agent, logger) {
  const BATCH_SIZE = 3;
  const DELAY = 7000;

  const batches = Array.from(
    { length: Math.ceil(urls.length / BATCH_SIZE) },
    (_, i) => urls.slice(i * BATCH_SIZE, i * BATCH_SIZE + BATCH_SIZE)
  );

  for (const batch of batches) {
    await Promise.all(
      batch.map(async (url) => {
        const t0 = Date.now();
        try {
          const res = await axios.get(url, {
            httpsAgent: agent,
            timeout: 30000,
            headers: { "User-Agent": USER_AGENT },
          });

          const dt = Date.now() - t0;

          const cfCache = res.headers["cf-cache-status"] || "N/A";
          const cfRay = res.headers["cf-ray"] || "N/A";
          const edge = extractCfEdge(cfRay);
          const originCache = res.headers["x-litespeed-cache"] || "N/A";

          console.log(
            `[${edge}] ${res.status} cf=${cfCache} ls=${originCache} - ${url}`
          );

          logger.log({
            country: edge,
            url,
            status: res.status,
            cfCache,
            originCache,
            cfRay,
            responseMs: dt,
          });

          if (cfCache !== "HIT") {
            await purgeCloudflareCache(url);
          }
        } catch (e) {
          logger.log({
            country: "ERROR",
            url,
            error: 1,
            message: e?.message || "request failed",
          });
        }
      })
    );

    await sleep(DELAY);
  }
}

/* ================= MAIN ================= */
(async () => {
  const logger = new AppsScriptLogger();
  const agent = createAuAgent();

  try {
    const urls = await fetchUrlsFromSitemap(agent);
    console.log(`[AU] Found ${urls.length} URLs`);
    await warmUrls(urls, agent, logger);
  } finally {
    logger.setFinished();
    await logger.flush();
  }
})();
