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

  try {
    const body = await request.json();
    const normalizedUrl = normalizeUrl(body.url);
    const includeScreenshot = body.includeScreenshot !== false;

    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    await page.setViewport({ width: 1440, height: 2200, deviceScaleFactor: 1 });
    await page.goto(normalizedUrl, {
      waitUntil: "networkidle2",
      timeout: 30000
    });

    await page.waitForTimeout(1200);

    const screenshotBuffer = includeScreenshot
      ? await page.screenshot({
          type: "jpeg",
          quality: 70,
          fullPage: false
        })
      : null;

    const extracted = await page.evaluate(({ trustKeywords, ctaKeywords }) => {
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
        primaryCtas,
        trustHits,
        hasViewport: !!document.querySelector('meta[name="viewport"]')
      };
    }, { trustKeywords: TRUST_KEYWORDS, ctaKeywords: CTA_KEYWORDS });

    const response = {
      ok: true,
      analyzedAt: new Date().toISOString(),
      url: normalizedUrl,
      extraction: extracted,
      screenshot: screenshotBuffer ? `data:image/jpeg;base64,${toBase64(screenshotBuffer)}` : null
    };

    return jsonResponse(response);
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error"
    }, 500);
  } finally {
    if (browser) {
      await browser.close();
    }
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
