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
const ACQUIRE_TIMEOUT_MS = 15000;
const PAGE_TIMEOUT_MS = 10000;
const NAVIGATION_TIMEOUT_MS = 25000;
const POST_LOAD_WAIT_MS = 1200;
const EXTRACTION_TIMEOUT_MS = 10000;
const CLEANUP_TIMEOUT_MS = 5000;

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
      return handleAnalyze(request, env);
    }

    return jsonResponse({ ok: false, error: "Not found" }, 404);
  }
};

async function handleAnalyze(request, env) {
  let browser;
  let page;
  const timings = {};

  try {
    const body = await request.json();
    const normalizedUrl = normalizeUrl(body.url);
    const includeScreenshot = body.includeScreenshot !== false;

    const browserStartedAt = Date.now();
    browser = await withTimeout(
      puppeteer.launch(env.BROWSER),
      ACQUIRE_TIMEOUT_MS,
      "Timed out starting the analysis browser."
    );
    timings.browserMs = Date.now() - browserStartedAt;

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
    const extracted = await withTimeout(
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
    timings.extractionMs = Date.now() - extractionStartedAt;
    timings.totalMs = timings.browserMs + timings.pageMs + timings.navigationMs + timings.extractionMs;

    return jsonResponse({
      ok: true,
      analyzedAt: new Date().toISOString(),
      url: normalizedUrl,
      session: {
        id: typeof browser.sessionId === "function" ? browser.sessionId() : null,
        mode: "launched"
      },
      timings,
      extraction: extracted,
      screenshot: screenshotBuffer ? `data:image/jpeg;base64,${toBase64(screenshotBuffer)}` : null
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: formatWorkerError(error)
    }, getWorkerErrorStatus(error));
  } finally {
    if (page) {
      await safeClosePage(page);
    }
    if (browser) {
      await safeCloseBrowser(browser);
    }
  }
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
