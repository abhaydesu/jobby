# Jobby — Personal Fresher SDE Job Board (India)

Jobby is a local-first, zero-dependency Node.js job aggregator tuned for one person: a final-year CS student in India looking for intern / fresher SDE roles (frontend, backend, full-stack) in Bengaluru, elsewhere in India, or remote roles that are genuinely open to India.

It continuously pulls jobs, throws away what you can't apply to, ranks the rest, and lets you track what you've applied to.

## Where jobs come from

Ranked by how many India-reachable fresher roles each actually produces (measured on real data, Nov 2026):

1. **Indian boards** — Internshala (internship + fresher job category pages, with stipend/CTC), Instahyre (entry-level + internship API filtered to SWE functions), LinkedIn guest search (fresher/SDE-1 keywords, India, last 24h, rate-capped), Cutshort (sitemap + JSON-LD job pages). These produce the large majority of relevant roles.
2. **Direct ATS APIs** — Greenhouse, Ashby, Lever, SmartRecruiters, Workday, Oracle HCM, Rippling, etc. for ~240 companies, including India-heavy boards (Razorpay, Groww, Meesho, Paytm, CRED, Hevo, Tekion, Sigmoid, MindTickle, FamPay…). Fresh and authoritative, but most global companies hire few freshers in India.
3. **Startup feeds** — ycombinator.com/jobs (incl. company pages with founders' LinkedIn) and the full monthly HN "Who is hiring" thread (with hiring emails). These power the **Startups** tab.
4. **Remote boards** — RemoteOK, Himalayas, Jobicy, WWR, Remotive, Simplify lists. Only the remote-worldwide/APAC/India rows survive the filter.
5. **Manual inputs** — paste a career-page URL (ATS fingerprint / JSON-LD), import job-alert emails (`.eml`/mbox — the practical way to get Naukri/LinkedIn alerts in), or save from any page with the browser extension.

Auto-discovery mines ATS links out of India-reachable postings and only promotes a board if it lists at least one role you could apply to.

## What it does with them

- **Location eligibility** — every job gets a tier: `bangalore`, `india`, `remote` (open to India), `remote_restricted` ("Remote – US"), `abroad`, `unknown`. The feed shows only the reachable ones by default; "Abroad" is one click away.
- **Seniority & role filtering** — intern/junior and tech roles by default; parses "0–1 years", "SDE 1", "fresher", batch/CGPA eligibility.
- **Ranking** — explainable 100-point match (title, skills, location, pay, experience) with small tie-breaker bonuses, so scores spread out instead of piling up at 100.
- **Only real pay** — salary/stipend is shown only when the posting states it (incl. ₹ monthly stipends, LPA, and lakh-format CTC). No synthetic estimates.
- **Fresh Drops** — newest discoveries first; applying in the first few days matters.
- **Startups** — YC / HN roles shown regardless of listed location (India first), with founder / poster contacts for direct outreach.
- **"+ Maybe"** — roles that never state an experience level are kept as `unknown` instead of assumed mid-level; one click adds them to the feed.
- **Tracking** — save / applied / interview / dismissed with notes, so you never re-apply or re-read.

## Quick Start

Requires **Node.js >= 22** (built-in `node:sqlite`, `fetch`, `node:http` — no `npm install`).

```bash
npm start            # server + background scheduler at http://localhost:3456
npm run scrape       # one-shot scrape of all enabled sources
npm test
```

On first start after an upgrade, stored jobs are re-classified once (≈30 s on a 35k-job DB).

See [docs/SCRAPING_RESEARCH.md](docs/SCRAPING_RESEARCH.md) for the research behind the source mix.
