# Lead-source integrations

All keys are entered in **Settings → Integrations**, stored encrypted, and can be tested with **Test connection**.

## Google Maps — Places API (New)

* Enable **Places API (New)** in a Google Cloud project with billing, create an API key and restrict it to that API.
* Each search runs `keyword × location` queries against Text Search (`places:searchText`), paging with `nextPageToken` up to 60 places per query. The field mask requests name, address components, phones, website, rating, review count, Maps URL and type — Google bills according to that mask.
* **Nationwide** expands to a built-in list of major cities for supported countries (US, UK, CA, AU, PK, AE, SA, DE, IN, ZA). For other countries, list the cities yourself.
* Optional **Find emails on business websites** visits each lead's site (robots.txt-aware) after the search.
* Searches are resumable: completed queries are checkpointed.

> Your original Lead Getter's exact Google workflow was not available in this workspace, so this module uses Google's official Places API. If the original used a different Google approach, the source is isolated in `src/main/services/sources/googleMaps.ts` and can be swapped without touching the CRM.

## LinkedIn — public pages via Google Programmable Search

LinkedIn has no public lead-search API, and scraping logged-in pages violates its terms. This module queries Google's **Custom Search JSON API** restricted to `linkedin.com/in` or `linkedin.com/company` and parses the public titles/snippets (name, title, company, industry). Create a search engine at programmablesearchengine.google.com ("Search the entire web"), then add the **API key** and **engine ID (cx)**. The API returns at most 100 results per query.

Note: Google has announced restrictions on the Custom Search JSON API for new customers; if your project can't enable it, use Apollo or import LinkedIn/Sales Navigator CSV exports (Leads Management → Import).

## Apollo

Uses `mixed_people/api_search` (falls back to `mixed_people/search`) and `mixed_companies/search` with title, seniority, industry keyword, location and employee-range filters. **Reveal work emails** calls `people/match`, which consumes Apollo credits — the UI shows the maximum credits a search can use. Placeholder emails (`email_not_unlocked@…`) are discarded.

## Website email extraction (used by Google Maps and AI research)

There is no separate tab; with **Find emails on business websites** on, Google Maps discovery visits each lead's site. `src/main/services/sources/website.ts`: same-host crawl, contact/about/team pages first, robots.txt (Allow/Disallow, Crawl-delay), page and size caps, polite delay. Extracts `mailto:` links, plain text, Cloudflare-protected and `name [at] domain [dot] com` emails, `tel:` links, and social links. Each email keeps the URL it was found on.
