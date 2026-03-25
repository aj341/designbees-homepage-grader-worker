# DesignBees Homepage Grader Worker

This is the Cloudflare Worker backend for the DesignBees homepage grader v2.

It is designed to work with the standalone Wix-uploaded HTML frontend by giving that page a single API endpoint that can:

- render a live homepage in a real browser
- capture a screenshot
- extract rendered DOM signals
- return structured JSON for scoring

## What It Does

`POST /analyze`

Request body:

```json
{
  "url": "https://www.hubspot.com",
  "includeScreenshot": true
}
```

Response includes:

- normalized URL
- screenshot as a base64 data URL
- extracted title, h1, headings, CTA list, forms, sections, trust hits

## Why This Matters

The standalone HTML grader can only do so much by fetching raw HTML in-browser.

This Worker improves accuracy because it:

- renders JS-heavy pages before analysis
- sees the same DOM structure a user sees after hydration
- can return an actual screenshot for future image-based scoring

## Setup

1. In Cloudflare, enable Browser Rendering for your Workers account.
2. In this folder, install dependencies:

```bash
npm install
```

3. Run locally:

```bash
npm run dev
```

4. Deploy:

```bash
npm run deploy
```

## Required Cloudflare Config

The Worker uses a browser binding named `BROWSER`, configured in [wrangler.jsonc](/C:/Users/ajkav/OneDrive/Documents/codex/designbees-homepage-grader-worker/wrangler.jsonc).

## Free Tier Reality

This is viable for MVP and low traffic.

As of March 26, 2026, Cloudflare Browser Rendering documents:

- Workers Free: 10 minutes/day of browser usage
- Workers Free: 3 concurrent browsers

Source:

- [Cloudflare Browser Rendering pricing](https://developers.cloudflare.com/browser-rendering/pricing/)

That is enough for testing and light use, but not for heavy public traffic.

## Next Recommended Step

Wire the Wix HTML file to this Worker instead of trying to fetch homepages directly from the browser.

That would let the frontend:

- send a homepage URL to the Worker
- receive rendered-page evidence
- score only criteria with enough evidence
- optionally display the screenshot in the report
