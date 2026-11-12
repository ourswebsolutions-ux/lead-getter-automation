# Lead-source integrations

All keys are entered in **Settings → Integrations**, stored encrypted, and can be tested with **Test connection**.

## Google Maps Search (browser-based, like the original Lead Finder)

The **Google Maps Search** tab searches Google Maps itself in a real Chrome window — the same approach as the original Lead Finder, whose search, extraction and website rules were ported (`src/main/services/maps/`).

* **Chrome**: the app opens your installed Google Chrome with its own profile (`<app data>/chrome-maps-profile`) and controls it over the Chrome DevTools Protocol (`playwright-core` `connectOverCDP`). A separate profile is used because Chrome 136+ ignores remote-debugging on the everyday profile. Keep the window open while searching. Set `LGE_CHROME_PATH` if Chrome is in an unusual location.
* **Search**: opens `google.com/maps/search/<keyword in location>` (falls back to typing in the search box), scrolls the results list, and opens each business to read **name, category, phone (international format), address, website, rating and review count**.
* **Business type**: *All*, *With website* (own website on Maps), *Without website* (no website, or social media only — confirmed with one Google web search per business, as in the original).
* **Emails**: with *Find emails from business websites* on, each business website is read (robots.txt respected, up to 6 pages, each site once) and public emails are attached.
* **Duplicates**: every listing has a stable Maps place ID; a business already saved (in this or an earlier search) is counted as a duplicate and not saved again. Results also go into the central Leads database (source *Google Maps*).
* **Google checks**: if Google shows a CAPTCHA, consent or "unusual traffic" page, the search **pauses** and asks you to complete it in the Chrome window; it continues by itself afterwards. The app never solves or bypasses these.
* **Pacing**: the original's gentle pace — 2.5–5 s between businesses, a 15–30 s break every 25.
* **Results**: live table with sorting, pagination, filters (email / website / phone / category / rating) and export (all or selected, CSV or Excel).

The earlier Places-API implementation (`sources/googleMaps.ts`) remains in the code but is no longer used by the UI.

## LinkedIn — public pages via Google Programmable Search

LinkedIn has no public lead-search API, and scraping logged-in pages violates its terms. This module queries Google's **Custom Search JSON API** restricted to `linkedin.com/in` or `linkedin.com/company` and parses the public titles/snippets (name, title, company, industry). Create a search engine at programmablesearchengine.google.com ("Search the entire web"), then add the **API key** and **engine ID (cx)**. The API returns at most 100 results per query.

Note: Google has announced restrictions on the Custom Search JSON API for new customers; if your project can't enable it, use Apollo or import LinkedIn/Sales Navigator CSV exports (Leads Management → Import).

## Apollo

Uses `mixed_people/api_search` (falls back to `mixed_people/search`) and `mixed_companies/search` with title, seniority, industry keyword, location and employee-range filters. **Reveal work emails** calls `people/match`, which consumes Apollo credits — the UI shows the maximum credits a search can use. Placeholder emails (`email_not_unlocked@…`) are discarded.

## Website email extraction (used by Google Maps and AI research)

There is no separate tab; with **Find emails on business websites** on, Google Maps discovery visits each lead's site. `src/main/services/sources/website.ts`: same-host crawl, contact/about/team pages first, robots.txt (Allow/Disallow, Crawl-delay), page and size caps, polite delay. Extracts `mailto:` links, plain text, Cloudflare-protected and `name [at] domain [dot] com` emails, `tel:` links, and social links. Each email keeps the URL it was found on.
