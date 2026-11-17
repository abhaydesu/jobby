# Jobby — Autonomous Multi-Source Job Board & Profile Match Engine

Jobby is a local-first, zero-dependency Node.js job aggregator, continuous multi-tier scraper, NLP job intelligence parser, 100-point profile match engine, resume tailoring assistant, and application CRM pipeline.

## Why Jobby Exists

Instead of clicking through fragmented job boards full of duplicate listings and stale ghost jobs, Jobby runs continuously on your machine and pulls directly from:

1. **Tier 1 — Direct ATS Public JSON APIs** (Greenhouse, Ashby HQ, Lever, SmartRecruiters, Workable, Recruitee) across 55+ top tech & AI companies (Stripe, Anthropic, OpenAI, Linear, Vercel, Figma, Databricks, Ramp, Perplexity, Supabase, Cloudflare, Palantir, and more).
2. **Tier 2 — Startup & Founder Community Feeds** (Hacker News monthly *"Who is Hiring?"* thread + YC Jobs via Algolia API).
3. **Tier 3 — Open Global & Remote Job Boards** (Remotive, Arbeitnow, RemoteOK, The Muse, Himalayas, Jobicy, WeWorkRemotely RSS).
4. **Tier 4 — Universal Career Page Auto-Fingerprinter** (Paste any company career URL to auto-detect its ATS or extract Schema.org `JobPosting` JSON-LD).

See [docs/SCRAPING_RESEARCH.md](docs/SCRAPING_RESEARCH.md) for the complete technical deep-dive into how modern job aggregators scrape and normalize openings.

---

## Quick Start

Requires **Node.js >= 22** (uses built-in `node:sqlite` with FTS5, native `fetch`, and `node:http` — zero `npm install` needed).

```bash
# 1. Start the Jobby server & continuous background scheduler
npm start

# 2. Or run a one-shot scrape across all enabled sources from the CLI
npm run scrape

# 3. Run the automated test suite
npm test
```

Open **http://localhost:3456** in your browser.

---

## Key Features

- **Real-Time Continuous Scraping Daemon**: Configurable interval scheduler (15m / 30m / 60m / 6h) with live Server-Sent Events (SSE) progress streaming in the UI.
- **SQLite + FTS5 Full-Text Search**: Sub-millisecond faceted filtering across thousands of jobs by keyword, match score, work mode, seniority, salary, ATS source, and skills.
- **130+ Skill Taxonomy & Deep NLP Extraction**: Extracts skills, normalized annual salary ranges, years of experience, seniority tier, work mode, visa sponsorship signals, and green/red flags from raw HTML descriptions.
- **Explainable 100-Point Profile Matching**: Scores every job across Title Alignment, Primary/Secondary Skills, Work Mode & Location, Compensation, and Experience with customizable weights.
- **1-Click Resume Parser & Job Tailoring Kit**: Paste your resume to auto-configure your profile, and get job-specific ATS keywords, gap analysis, tailored resume bullets, and cold outreach / cover letter drafts for any opening.
- **Application CRM Kanban**: Track openings through `Saved → Applied → Screen → Interview → Offer / Rejected` with persistent notes.
