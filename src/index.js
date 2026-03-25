import { DurableObject } from "cloudflare:workers";
import puppeteer from "@cloudflare/puppeteer";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const TRUST_KEYWORDS = [
  "testimonial",
  "case study",
  "trusted by",
  "clients",
  "customer",
  "brands",
  "review",
  "results",
  "award",
  "partner",
  "proof",
  "success story"
];

const CTA_KEYWORDS = [
  "book",
  "demo",
  "start",
  "trial",
  "contact",
  "sales",
  "schedule",
  "request",
  "get started",
  "talk",
  "apply"
];

const SECONDARY_CTA_KEYWORDS = [
  "pricing",
  "case study",
  "results",
  "learn more",
  "calculator",
  "tool",
  "guide",
  "download",
  "see how",
  "view work"
];

const GENERIC_CTA_KEYWORDS = [
  "learn more",
  "read more",
  "explore",
  "discover"
];

const VIEWPORT = { width: 1440, height: 2200, deviceScaleFactor: 1 };
const KEEP_BROWSER_ALIVE_MS = 60_000;
const ALARM_TICK_MS = 10_000;
const ACQUIRE_TIMEOUT_MS = 15_000;
const PAGE_TIMEOUT_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 25_000;
const POST_LOAD_WAIT_MS = 1_200;
const EXTRACTION_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 5_000;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return jsonResponse({
        ok: true,
        service: "designbees-homepage-grader-worker",
        endpoints: ["/analyze"]
      });
    }

    if (request.method === "POST" && url.pathname === "/analyze") {
      const id = env.ANALYZER.idFromName("homepage-grader");
      const stub = env.ANALYZER.get(id);
      return stub.fetch(request);
    }

    return jsonResponse({ ok: false, error: "Not found" }, 404);
  }
};

export class BrowserAnalyzer extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.browser = null;
    this.launchPromise = null;
    this.lastUsedAt = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/analyze") {
      return this.handleAnalyze(request);
    }

    return jsonResponse({ ok: false, error: "Not found" }, 404);
  }

  async alarm() {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = null;
      return;
    }

    const idleForMs = Date.now() - this.lastUsedAt;
    if (idleForMs >= KEEP_BROWSER_ALIVE_MS) {
      await safeCloseBrowser(this.browser);
      this.browser = null;
      return;
    }

    try {
      await withTimeout(
        this.browser.version(),
        PAGE_TIMEOUT_MS,
        "Timed out pinging the shared browser."
      );
    } catch (error) {
      await safeCloseBrowser(this.browser);
      this.browser = null;
      return;
    }

    await this.state.storage.setAlarm(Date.now() + ALARM_TICK_MS);
  }

  async handleAnalyze(request) {
    let page;
    let browserState;

    try {
      const body = await request.json();
      const normalizedUrl = normalizeUrl(body.url);
      const includeScreenshot = body.includeScreenshot !== false;

      try {
        browserState = await this.ensureBrowser();
        const browser = browserState.browser;
        const timings = {};

        const pageStartedAt = Date.now();
        page = await withTimeout(
          browser.newPage(),
          PAGE_TIMEOUT_MS,
          "Timed out opening the analysis page."
        );
        timings.pageMs = Date.now() - pageStartedAt;

        await withTimeout(
          page.setViewport(VIEWPORT),
          PAGE_TIMEOUT_MS,
          "Timed out preparing the browser viewport."
        );

        const navigationStartedAt = Date.now();
        await navigatePage(page, normalizedUrl);
        timings.navigationMs = Date.now() - navigationStartedAt;

        await page.waitForTimeout(POST_LOAD_WAIT_MS);

        const screenshotBuffer = includeScreenshot
          ? await safeScreenshot(page)
          : null;

        const extractionStartedAt = Date.now();
        const extracted = await extractSignalsFromPage(page);
        timings.extractionMs = Date.now() - extractionStartedAt;
        timings.totalMs = (browserState.launchMs || 0) + timings.pageMs + timings.navigationMs + timings.extractionMs;

        await this.touchBrowser();

        return jsonResponse({
          ok: true,
          analyzedAt: new Date().toISOString(),
          url: normalizedUrl,
          analysisMode: "rendered",
          session: {
            id: typeof browser.sessionId === "function" ? browser.sessionId() : null,
            mode: browserState.mode
          },
          timings,
          extraction: extracted,
          screenshot: screenshotBuffer ? `data:image/jpeg;base64,${toBase64(screenshotBuffer)}` : null
        });
      } catch (error) {
        if (!shouldUseFetchFallback(error)) {
          throw error;
        }

        const fallback = await analyzeWithFetch(normalizedUrl);
        return jsonResponse({
          ok: true,
          analyzedAt: new Date().toISOString(),
          url: normalizedUrl,
          analysisMode: "html",
          session: {
            id: null,
            mode: "html-fallback"
          },
          fallbackReason: formatWorkerError(error),
          timings: fallback.timings,
          extraction: fallback.extraction,
          screenshot: null
        });
      }
    } catch (error) {
      return jsonResponse({
        ok: false,
        error: formatWorkerError(error)
      }, getWorkerErrorStatus(error));
    } finally {
      if (page) {
        await safeClosePage(page);
      }

      if (this.browser && this.browser.isConnected()) {
        await this.touchBrowser();
      }
    }
  }

  async ensureBrowser() {
    if (this.browser && this.browser.isConnected()) {
      await this.touchBrowser();
      return { browser: this.browser, mode: "reused", launchMs: 0 };
    }

    if (!this.launchPromise) {
      this.launchPromise = (async () => {
        const connectedBrowser = await connectToAvailableSession(this.env.BROWSER);
        if (connectedBrowser) {
          this.browser = connectedBrowser;
          await this.touchBrowser();
          return { browser: connectedBrowser, mode: "connected", launchMs: 0 };
        }

        const startedAt = Date.now();
        const browser = await withTimeout(
          puppeteer.launch(this.env.BROWSER),
          ACQUIRE_TIMEOUT_MS,
          "Timed out starting the analysis browser."
        );
        this.browser = browser;
        await this.touchBrowser();
        return { browser, mode: "launched", launchMs: Date.now() - startedAt };
      })().finally(() => {
        this.launchPromise = null;
      });
    }

    return this.launchPromise;
  }

  async touchBrowser() {
    this.lastUsedAt = Date.now();
    await this.state.storage.put("lastUsedAt", this.lastUsedAt);
    await this.state.storage.setAlarm(Date.now() + ALARM_TICK_MS);
  }
}

async function extractSignalsFromPage(page) {
  return withTimeout(
    page.evaluate(
      ({ trustKeywords, ctaKeywords, secondaryCtaKeywords, genericCtaKeywords }) => {
        const clean = value => (value || "").replace(/\s+/g, " ").trim();
        const includesAny = (text, keywords) => {
          const value = (text || "").toLowerCase();
          return keywords.some(keyword => value.includes(keyword));
        };
        const uniqueBy = (items, keyFn) => {
          const seen = new Set();
          return items.filter(item => {
            const key = keyFn(item);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        };

        const main = document.querySelector("main") || document.body;
        const title = clean(document.title);
        const metaDescription = clean(document.querySelector('meta[name="description"]')?.getAttribute("content") || "");
        const h1 = clean(document.querySelector("h1")?.textContent || "");
        const headings = uniqueBy(
          [...main.querySelectorAll("h1,h2,h3")]
            .map(node => clean(node.textContent))
            .filter(Boolean),
          value => value
        );

        const paragraphs = [...main.querySelectorAll("p")]
          .map(node => clean(node.textContent))
          .filter(Boolean);

        const bodyText = clean(main.innerText || "");
        const actions = uniqueBy(
          [...document.querySelectorAll('a,button,input[type="submit"],input[type="button"]')]
            .map(node => ({
              text: clean(node.textContent || node.value || node.getAttribute("aria-label") || ""),
              href: clean(node.getAttribute("href") || ""),
              inNav: !!node.closest("nav,header,[role='navigation']")
            }))
            .filter(item => item.text || item.href),
          item => `${item.text}|${item.href}`
        );

        const primaryCtas = actions.filter(item => includesAny(item.text, ctaKeywords));
        const secondaryCtas = actions.filter(item => includesAny(item.text, secondaryCtaKeywords));
        const genericCtas = actions.filter(item => includesAny(item.text, genericCtaKeywords));
        const trustHits = trustKeywords.filter(keyword => bodyText.toLowerCase().includes(keyword)).length;

        return {
          title,
          metaDescription,
          h1,
          headings,
          paragraphs: paragraphs.slice(0, 20),
          bodyTextSample: bodyText.slice(0, 2500),
          navLinkCount: document.querySelector("nav")?.querySelectorAll("a").length || 0,
          imageCount: main.querySelectorAll("img,picture,svg").length,
          sectionCount: main.querySelectorAll("section,[class*='section'],[id*='section']").length,
          formCount: main.querySelectorAll("form").length,
          actionCount: actions.length,
          primaryCtas,
          secondaryCtas,
          genericCtas,
          trustHits,
          hasViewport: !!document.querySelector('meta[name="viewport"]')
        };
      },
      {
        trustKeywords: TRUST_KEYWORDS,
        ctaKeywords: CTA_KEYWORDS,
        secondaryCtaKeywords: SECONDARY_CTA_KEYWORDS,
        genericCtaKeywords: GENERIC_CTA_KEYWORDS
      }
    ),
    EXTRACTION_TIMEOUT_MS,
    "Timed out extracting homepage signals."
  );
}

async function analyzeWithFetch(url) {
  const startedAt = Date.now();
  const response = await withTimeout(
    fetch(url, {
      headers: {
        "User-Agent": "DesignBees Homepage Grader/1.0"
      }
    }),
    NAVIGATION_TIMEOUT_MS,
    "The homepage took too long to load over direct fetch."
  );
  const html = await response.text();
  return {
    timings: {
      pageMs: Date.now() - startedAt,
      navigationMs: Date.now() - startedAt,
      extractionMs: 0,
      totalMs: Date.now() - startedAt
    },
    extraction: extractSignalsFromHtml(html)
  };
}

function extractSignalsFromHtml(html) {
  const clean = value => decodeHtmlEntities(stripTags(value || "")).replace(/\s+/g, " ").trim();
  const cleanedHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const bodyText = clean(cleanedHtml);
  const headingCandidates = dedupe(
    [...cleanedHtml.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
      .map(match => clean(match[1]))
      .filter(Boolean)
      .filter(value => !/^h[1-3]$/i.test(value))
  );
  const paragraphCandidates = dedupe(
    bodyText
      .split(/(?<=[.!?])\s+/)
      .map(value => value.trim())
      .filter(value => value.length >= 35)
  ).slice(0, 20);
  const actions = extractActionsFromHtml(cleanedHtml);
  const primaryCtas = actions.filter(item => includesKeyword(item.text, CTA_KEYWORDS));
  const secondaryCtas = actions.filter(item => includesKeyword(item.text, SECONDARY_CTA_KEYWORDS));
  const genericCtas = actions.filter(item => includesKeyword(item.text, GENERIC_CTA_KEYWORDS));

  return {
    title: clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ""),
    metaDescription: clean(html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i)?.[1] || ""),
    h1: clean(cleanedHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || ""),
    headings: headingCandidates,
    paragraphs: paragraphCandidates,
    bodyTextSample: bodyText.slice(0, 2500),
    navLinkCount: (cleanedHtml.match(/<nav[\s\S]*?<\/nav>/gi)?.join(" ").match(/<a\b/gi) || []).length,
    imageCount: (cleanedHtml.match(/<(img|picture|svg)\b/gi) || []).length,
    sectionCount: (cleanedHtml.match(/<section\b/gi) || []).length,
    formCount: (cleanedHtml.match(/<form\b/gi) || []).length,
    actionCount: actions.length,
    primaryCtas,
    secondaryCtas,
    genericCtas,
    trustHits: TRUST_KEYWORDS.filter(keyword => bodyText.toLowerCase().includes(keyword)).length,
    hasViewport: /<meta[^>]+name=["']viewport["']/i.test(cleanedHtml)
  };
}

function extractActionsFromHtml(html) {
  const clean = value => decodeHtmlEntities(stripTags(value || "")).replace(/\s+/g, " ").trim();
  const actions = [];

  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    actions.push({
      text: clean(match[2]),
      href: clean(match[1].match(/href=["']([^"']*)["']/i)?.[1] || ""),
      inNav: /nav|header/i.test(match[0])
    });
  }

  for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    actions.push({
      text: clean(match[2]),
      href: "",
      inNav: /nav|header/i.test(match[0])
    });
  }

  for (const match of html.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = match[1] || "";
    if (!/type=["']?(submit|button)/i.test(attrs)) {
      continue;
    }
    actions.push({
      text: clean(attrs.match(/value=["']([^"']*)["']/i)?.[1] || attrs.match(/aria-label=["']([^"']*)["']/i)?.[1] || ""),
      href: "",
      inNav: /nav|header/i.test(match[0])
    });
  }

  return dedupeBy(actions.filter(item => item.text || item.href), item => `${item.text}|${item.href}`);
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function dedupe(items) {
  return dedupeBy(items, value => value);
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  return items.filter(item => {
    const key = keyFn(item);
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function includesKeyword(text, keywords) {
  const value = String(text || "").toLowerCase();
  return keywords.some(keyword => value.includes(keyword));
}

function shouldUseFetchFallback(error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  return /rate limit exceeded/i.test(message)
    || /code:\s*429/i.test(message)
    || /Timed out starting the analysis browser/i.test(message)
    || /Browser\.getVersion timed out/i.test(message)
    || /existing session/i.test(message)
    || /protocolTimeout/i.test(message);
}

async function connectToAvailableSession(endpoint) {
  let sessions = [];

  try {
    sessions = await puppeteer.sessions(endpoint);
  } catch (error) {
    return null;
  }

  const availableSessionIds = sessions
    .filter(session => !session.connectionId && session.sessionId)
    .map(session => session.sessionId);

  for (const sessionId of availableSessionIds) {
    try {
      return await withTimeout(
        puppeteer.connect(endpoint, sessionId),
        ACQUIRE_TIMEOUT_MS,
        "Timed out reconnecting to an available browser session."
      );
    } catch (error) {
    }
  }

  return null;
}

async function navigatePage(page, url) {
  const strategies = [
    { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS },
    { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS }
  ];

  let lastError;

  for (const strategy of strategies) {
    try {
      await withTimeout(
        page.goto(url, strategy),
        strategy.timeout + 2000,
        "The homepage took too long to render."
      );
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("The homepage could not be rendered.");
}

async function safeScreenshot(page) {
  try {
    return await withTimeout(
      page.screenshot({
        type: "jpeg",
        quality: 70,
        fullPage: false
      }),
      EXTRACTION_TIMEOUT_MS,
      "Timed out capturing the homepage screenshot."
    );
  } catch (error) {
    return null;
  }
}

async function safeClosePage(page) {
  try {
    await withTimeout(page.close(), CLEANUP_TIMEOUT_MS, "Timed out closing the browser page.");
  } catch (error) {
  }
}

async function safeCloseBrowser(browser) {
  try {
    await withTimeout(browser.close(), CLEANUP_TIMEOUT_MS, "Timed out closing the browser.");
    return;
  } catch (error) {
  }

  try {
    browser.disconnect();
  } catch (error) {
  }
}

async function withTimeout(promise, ms, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeUrl(raw) {
  const cleaned = String(raw || "").trim();
  if (!cleaned) {
    throw new Error("A homepage URL is required.");
  }

  if (/^https?:\/\//i.test(cleaned)) {
    return cleaned;
  }

  return `https://${cleaned.replace(/^\/+/, "")}`;
}

function formatWorkerError(error) {
  const message = error instanceof Error ? error.message : "Unknown error";

  if (/rate limit exceeded/i.test(message) || /code:\s*429/i.test(message)) {
    return "Browser capacity is temporarily busy on the current Cloudflare plan. Please wait about 60 seconds and retry.";
  }

  if (/Browser\.getVersion timed out/i.test(message) || /existing session/i.test(message) || /protocolTimeout/i.test(message) || /Timed out starting the analysis browser/i.test(message)) {
    return "Browser capacity is temporarily warming up or busy. Please retry in 30 to 60 seconds.";
  }

  if (/Navigation timeout/i.test(message) || /ERR_TIMED_OUT/i.test(message)) {
    return "The homepage took too long to render. Please retry, or test a lighter page.";
  }

  return message;
}

function getWorkerErrorStatus(error) {
  const message = error instanceof Error ? error.message : "Unknown error";

  if (/rate limit exceeded/i.test(message) || /code:\s*429/i.test(message)) {
    return 429;
  }

  return 500;
}

function toBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS
    }
  });
}
