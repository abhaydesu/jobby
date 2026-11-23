# Deep Research: How State-of-the-Art Job Boards & Scrapers Extract All Openings

This document summarizes extensive architectural research into how leading modern job aggregators (such as **Hiring.cafe**, **Simplify**, **Otta / Welcome to the Jungle**, **Levels.fyi**, and open-source pipelines like **python-jobspy** and **Levergreen**) scrape, normalize, deduplicate, and match job openings across the internet reliably and at scale.

---

## 1. Why Naive Job Scraping Fails (and What Works Instead)

Most naive job scrapers point a headless browser at LinkedIn or Indeed and try to parse brittle CSS selectors. That approach fails quickly because:
1. **Aggressive Anti-Bot Protection**: LinkedIn, Indeed, Glassdoor, and ZipRecruiter deploy Cloudflare/Akamai TLS fingerprinting, login walls, CAPTCHAs, and rate limits.
2. **Ghost Jobs & Repost Churn**: Consumer boards are heavily polluted by recruiter agencies, promoted duplicates, and stale postings that were filled weeks ago on the company's actual hiring system.
3. **High Resource Cost**: Running Chromium/Playwright for thousands of pages wastes CPU, RAM, and residential proxy bandwidth.

**How elite aggregators solve this**: They flip the funnel upside down. Instead of scraping middleman consumer job boards first, they hit **Tier 1: Direct Applicant Tracking System (ATS) Public JSON APIs** where companies actually store their source-of-truth requisitions, and supplement them with **Tier 2: Startup/Founder Feeds**, **Tier 3: Open Aggregator JSON/RSS APIs**, and **Tier 4: Career Page ATS Fingerprinting + Schema.org JSON-LD**.

---

## 2. The 4-Tier Multi-Source Ingestion Architecture

### Tier 1: Direct ATS Public JSON APIs (Highest Signal, Zero Middlemen)
Almost every modern tech and growth company hosts its career page on a third-party ATS. When your browser loads `company.com/careers`, the page's JavaScript calls a **public, keyless JSON API** on the ATS domain. Querying these APIs directly gives you structured fields, full descriptions, exact department metadata, real-time opening/closing status (eliminating ghost jobs), and direct apply links:

| ATS Platform | Public Endpoint Pattern | Method | Notable Data Provided |
| :--- | :--- | :--- | :--- |
| **Greenhouse** | `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` | `GET` | Job ID, title, location, departments, updated timestamp, full HTML description (`content=true`). |
| **Ashby HQ** | `https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true` | `GET` | Title, department, team, `isRemote`, workplaceType, `compensationTierSummary`, full HTML & plain text, direct apply URL. |
| **Lever** | `https://api.lever.co/v0/postings/{slug}?mode=json` | `GET` | Title, categories (`commitment`, `department`, `location`, `team`), `workplaceType`, `salaryRange`, `descriptionPlain`. |
| **SmartRecruiters** | `https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=100` | `GET` | Paginated postings, location object, experience level, department, release date, detail endpoint `.../postings/{id}`. |
| **Workable** | `https://apply.workable.com/api/v3/accounts/{slug}/jobs` | `POST` | JSON search endpoint accepting `{ query, location, department, worktype, remote }`, returning structured locations & remote flags. |
| **Recruitee** | `https://{slug}.recruitee.com/api/offers/` | `GET` | Full offer list with min/max salary, tags, remote/hybrid flags, department, and HTML description. |
| **Workday (CXS)** | `https://{tenant}.wd{n}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` | `POST` | Enterprise internal JSON API (requires session/CSRF cookie handling or Playwright fallback for custom flows). |
| **Rippling ATS** | `https://api.rippling.com/platform/api/ats/v1/board/{slug}/jobs` | `GET` | Direct Rippling public job board JSON listing titles, workLocations, departments, and ATS URLs. |
| **Pinpoint HQ** | `https://{subdomain}.pinpointhq.com/postings.json` | `GET` | CORS-open public JSON feed with workplace type, location, structured salary, and full HTML descriptions. |

**Why ATS scraping is unbeatable**:
- When a role is filled or paused in Greenhouse/Ashby/Lever, it disappears from the JSON response immediately.
- Zero CAPTCHAs, sub-second HTTP latency, and full clean descriptions without UI chrome.

---

### Tier 2: Startup, Founder & Early-Career Community Feeds
Many early-stage startups (Seed to Series A) don't list on traditional boards or enterprise ATS platforms yet, while university hiring is heavily curated in open-source trackers:

1. **Hacker News "Ask HN: Who is hiring?" (Monthly Thread)**:
   - Discovered dynamically via Algolia Search API:
     `https://hn.algolia.com/api/v1/search_by_date?query=%22Ask%20HN:%20Who%20is%20hiring%22&tags=story,ask_hn`
   - Top-level comments retrieved via `https://hn.algolia.com/api/v1/items/{story_id}`.
   - Comments almost universally follow the pipe-delimited convention:
     `Company Name | Role(s) | Location / REMOTE | Salary / Equity | Visa | URL`
   - High signal: direct contact emails or engineering manager links.
2. **YC Jobs Feed (`tags=job`)**:
   - `https://hn.algolia.com/api/v1/search_by_date?tags=job&hitsPerPage=50`
   - Surfaces direct Y Combinator company job posts.
3. **SimplifyJobs Early-Career JSON Feeds (`Summer2027-Internships`, `New-Grad-Positions`)**:
   - `https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json`
   - `https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json`
   - Community-verified live intern & new-grad feeds tracking thousands of tech openings with `active`, `sponsorship`, `terms` (`Summer 2027`), and `degrees` metadata.

---

### Tier 3: Open Global & Remote Job Aggregator Feeds
For broad market coverage across thousands of companies that aren't in your explicit ATS slug list:

1. **Remotive**: `https://remotive.com/api/remote-jobs?limit=100` — Curated remote software, data, design, and product roles with salary strings and tags.
2. **Arbeitnow**: `https://www.arbeitnow.com/api/job-board-api` — Aggregates European, global remote, and visa-sponsored roles directly from ATS feeds (`visa_sponsorship` boolean included).
3. **RemoteOK**: `https://remoteok.com/api` — Provides structured `salary_min`, `salary_max`, normalized skill tags, company logos, and epoch timestamps.
4. **The Muse**: `https://www.themuse.com/api/public/jobs?page=1` — Broad US/global corporate & tech openings across Engineering, Data, Product, and Design.
5. **Himalayas**: `https://himalayas.app/jobs/api?limit=50` — Rich structured remote jobs with `minSalary`, `maxSalary`, `currency`, `seniority`, `locationRestrictions`, and `timezoneRestrictions`.
6. **Jobicy**: `https://jobicy.com/api/v2/remote-jobs?count=50` — Remote jobs with `annualSalaryMin`, `annualSalaryMax`, `salaryCurrency`, `jobLevel`, and `jobGeo`.
7. **WeWorkRemotely RSS**: `https://weworkremotely.com/remote-jobs.rss` — Reliable XML feed of curated remote listings.

*(Note: For consumer boards like LinkedIn, Indeed, Glassdoor, and ZipRecruiter, open-source Python tools like `python-jobspy` act as a complement using rotating residential proxies and TLS-impersonating HTTP clients.)*

---

### Tier 4: Universal ATS Fingerprinting & Schema.org `JobPosting` Extraction
How do aggregators discover *new* companies automatically?
1. **Company Domain Crawling**: Fetch `https://company.com/careers` or `https://company.com/jobs`.
2. **Network/DOM Fingerprinting**: Scan HTML, `<script>` tags, and `<iframe>` targets for ATS signatures:
   - `boards.greenhouse.io/{slug}` or `job-boards.greenhouse.io/{slug}`
   - `jobs.ashbyhq.com/{slug}`
   - `jobs.lever.co/{slug}`
   - `apply.workable.com/{slug}`
   - `jobs.smartrecruiters.com/{slug}`
   - `{slug}.recruitee.com`
   - `ats.rippling.com/{slug}` or `api.rippling.com/platform/api/ats/v1/board/{slug}`
   - `{slug}.pinpointhq.com`
3. **Google Search Dorking Patterns** (used by talent intelligence platforms):
   - `site:boards.greenhouse.io "Software Engineer" "Remote"`
   - `site:jobs.ashbyhq.com "AI Engineer"`
   - `site:jobs.lever.co "Full Stack"`
4. **Schema.org `JobPosting` JSON-LD Parsing**:
   - Almost every SEO-compliant career portal embeds `<script type="application/ld+json">` containing `@type: "JobPosting"` with `title`, `hiringOrganization`, `baseSalary`, `jobLocation`, `validThrough`, and `description`—allowing clean extraction even on custom career sites!

---

## 3. Deduplication, NLP Normalization & Anti-Ghost-Job Pipeline

Scraping raw feeds is only half the battle. A world-class job board turns raw payloads into structured intelligence:

1. **Cross-Source Deduplication**:
   - The same role often appears on a company's Greenhouse board *and* Arbeitnow *and* RemoteOK.
   - Generate a canonical deduplication key:
     `sha256(normalize(company) + "::" + normalize(title) + "::" + normalize(location_bucket))`
   - Prefer Tier 1 direct ATS records over Tier 3 aggregator duplicates when merging metadata, while preserving user CRM state (`saved`, `applied`, `notes`).
2. **Ghost Job & Freshness Filtering**:
   - Track `first_seen_at` and `last_seen_at` on every scrape cycle.
   - Automatically mark full-snapshot Tier 1 ATS postings (`greenhouse`, `ashby`, `lever`, `workable`, `recruitee`, `rippling`, `pinpoint`) missing from an active board snapshot as inactive (`is_active = 0`) when the user has not triaged them yet.
   - Flag postings older than 35 days as stale red flags; highlight postings under 48 hours old, `Class of 2026/2027 Eligible`, and `Intern-to-FTE / PPO Signal` roles as high-signal green flags.
3. **Deterministic NLP & Role Discipline Classification**:
   - Extract 135+ canonical technical skills with word-boundary & alias resolution (e.g., `TS` -> `TypeScript`, `k8s` -> `Kubernetes`, `Postgres` -> `PostgreSQL`, zero `"Go"` false positives).
   - Separate job tracks cleanly via `classifyRoleCategory` (`swe`, `ai_data`, `devops_sec`, `product_design`, `non_tech`, `other`) so non-tech trainees/associates (Payroll, HR, Accounting, Sales/Support Ops) do not pollute technical intern/new-grad feeds.
   - Normalize hourly/monthly/annual salaries across currencies (`$`, `£`, `€`, `₹`, INR LPA) while filtering out non-salary funding mentions (`"$50M Series B"`).
   - Extract years of experience (`3-5 years`), seniority level (`Intern` -> `Executive`), work mode (`Remote`, `Hybrid`, `Onsite`), visa sponsorship signals, and green/red flags.
4. **Multi-Dimensional Profile Scoring (0–100)**:
   - Weighted scoring across **Role/Title Alignment**, **Skills Overlap**, **Work Mode & Location**, **Salary Fit**, and **Experience Alignment**, with instant re-scoring whenever your profile or resume changes.

---

## 5. What Actually Works for an India-Based Fresher (Nov 2026 audit)

Measured on this project's own 36k-job database rather than assumed:

| Source | Active jobs | India-reachable intern/fresher roles |
| :--- | ---: | ---: |
| Internshala | 218 | 214 |
| LinkedIn guest search | 340 | 152 |
| All Greenhouse boards (84) | 13,818 | 23 |
| All Ashby boards (54) | 4,720 | 10 |
| Instahyre (old unfiltered query) | 554 | 7 → **160** after using real filters |
| Arbeitnow (EU) | 4,034 | 1 (retired) |

Takeaways:

1. **Geography is the dominant filter.** ~85% of the DB was outside India or "remote but US/EU-only". Treating `Remote (USA)` as remote put Portland/Dallas/Berlin roles at the top of a Bengaluru fresher's feed. Remote must be split into *open to India* vs *country-locked*.
2. **Indian boards beat direct ATS for this persona.** Products like HiringCafe win on direct ATS crawling — but most Indian product companies (Swiggy, Zomato, Flipkart, PhonePe, Freshworks, Zoho, Postman, BrowserStack…) are *not* on Greenhouse/Lever/Ashby (they use Darwinbox, Keka, SuccessFactors or custom portals). A slug probe of ~110 Indian companies found only a handful (Tekion, Sigmoid, MindTickle, FamPay, Commvault, Atlan, plus the existing Razorpay/Groww/Meesho/Paytm/CRED/Hevo).
3. **Use the board's own filters.** Instahyre's `experience=0` parameter is silently ignored; `experience_level=entry_level` + `job_functions` (max 3 per request) is what works. Internshala renamed its fresher-jobs URL; the old one returned zero cards. Fetching the firehose and filtering locally wastes requests and misses most relevant rows.
4. **Speed matters, modestly.** Hiring.cafe crawls ~2×/day and removes jobs when the source removes them. Evidence that early applicants do better is consistent in direction (St. Louis Fed: 41% of applications arrive within 48h) though vendor multipliers ("8× more interviews") are unreliable. A "new since last look" view is worth more than any scoring nuance.
5. **Don't invent data.** The previous build filled 64% of jobs with benchmark "stipend estimates"; for a fresher deciding where to apply these are worse than nothing. Only stated pay is stored.
6. **Naukri** has no public API; its private search API requires app-identity headers. Its job-alert emails (and LinkedIn's) can be imported via `POST /api/import/eml`, and the browser extension can save any page.
