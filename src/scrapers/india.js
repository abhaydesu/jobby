// Cutshort (cutshort.io) — India startup/tech job board.
//
// There is no public API, but cutshort publishes a crawler sitemap (robots.txt → sitemap_jobs.xml, ~45k URLs
// with <lastmod>) and every job page embeds a schema.org JobPosting (title, company, city, INR salary range,
// monthsOfExperience, datePosted). We filter the sitemap by recency + slug keywords first, then fetch only
// pages we haven't seen, so a run costs one sitemap download plus a few dozen paced page fetches.

import { fetchText, normalizeJobPayload } from './normalize.js';

const CUTSHORT_SITEMAP = 'https://cutshort.io/sitemap_jobs.xml';

const SLUG_INCLUDE_RX =
  /\b(software|developer|engineer|engineering|sde|programmer|frontend|front-end|backend|back-end|full-stack|fullstack|react|reactjs|node|nodejs|python|java|golang|android|ios|flutter|mern|mean|web|devops|intern|internship|trainee|fresher|graduate)\b/i;
const SLUG_EXCLUDE_RX =
  /\b(senior|sr|lead|principal|staff|architect|manager|head|director|vp|chief|sales|marketing|business|account|accounts|recruiter|recruitment|hr|executive|consultant|support|telecaller|counsellor|counselor)\b/i;

/** Parse sitemap XML → [{ url, slug, externalId, lastmod }]. */
export function parseCutshortSitemap(xml = '') {
  const out = [];
  const rx = /<url>\s*<loc>\s*(https:\/\/cutshort\.io\/job\/([^<\s]+))\s*<\/loc>\s*(?:<lastmod>\s*([^<\s]+)\s*<\/lastmod>)?/g;
  let m;
  while ((m = rx.exec(String(xml || ''))) !== null) {
    const slug = m[2];
    const externalId = slug.split('-').pop();
    out.push({ url: m[1], slug, externalId, lastmod: m[3] || null });
  }
  return out;
}

/** Recent + slug looks like an entry-friendly software role. */
export function selectCutshortCandidates(entries, { maxAgeDays = 3, now = Date.now() } = {}) {
  const cutoff = now - maxAgeDays * 864e5;
  return entries
    .filter((e) => {
      const t = e.lastmod ? Date.parse(e.lastmod) : NaN;
      if (!Number.isFinite(t) || t < cutoff) return false;
      const words = e.slug.replace(/-/g, ' ');
      return SLUG_INCLUDE_RX.test(words) && !SLUG_EXCLUDE_RX.test(words);
    })
    .sort((a, b) => Date.parse(b.lastmod) - Date.parse(a.lastmod));
}

/** schema.org values can be a string, an object ({url}/{name}) or an array of either. */
function schemaString(v) {
  if (!v) return '';
  if (Array.isArray(v)) return schemaString(v.find(Boolean));
  if (typeof v === 'object') return String(v.url || v.contentUrl || v['@id'] || v.name || '');
  return String(v);
}

function findJobPosting(html = '') {
  const blocks = [...String(html || '').matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, raw] of blocks) {
    try {
      const data = JSON.parse(raw);
      for (const node of Array.isArray(data) ? data : data?.['@graph'] || [data]) {
        if (node && node['@type'] === 'JobPosting') return node;
      }
    } catch {
      // ignore malformed blocks
    }
  }
  return null;
}

/** Map a Cutshort job page (JSON-LD JobPosting) to a normalized job; null if not a JobPosting. */
export function parseCutshortJobPage(html = '', { url = '', externalId = '' } = {}, source = {}) {
  const jp = findJobPosting(html);
  if (!jp || !jp.title) return null;

  const places = Array.isArray(jp.jobLocation) ? jp.jobLocation : jp.jobLocation ? [jp.jobLocation] : [];
  const cities = [...new Set(places.map((p) => p?.address?.addressLocality).filter((c) => c && c !== '-'))];
  const isRemote = /TELECOMMUTE/i.test(String(jp.jobLocationType || '')) || /\bremote\b/i.test(cities.join(' '));
  const location = isRemote
    ? `Remote (India)${cities.length ? `, ${cities.join(', ')}` : ''}`
    : cities.length
      ? `${cities.join(', ')}, India`
      : 'India';

  const months = Number(jp.experienceRequirements?.monthsOfExperience);
  const years = Number.isFinite(months) ? Math.floor(months / 12) : null;
  const sal = jp.baseSalary?.value || {};
  const fmt = (v) => Math.round(Number(v)).toLocaleString('en-IN');
  const salaryText =
    (jp.baseSalary?.currency || '').toUpperCase() === 'INR' && Number(sal.minValue) > 0
      ? `Salary: ₹ ${fmt(sal.minValue)}${Number(sal.maxValue) > Number(sal.minValue) ? ` - ${fmt(sal.maxValue)}` : ''} per year`
      : '';
  const employment = [].concat(jp.employmentType || []).join(' ');
  const isIntern = /INTERN/i.test(employment) || /\bintern/i.test(jp.title);

  const descriptionHtml = [
    years !== null ? `<p>${years} years of experience required.</p>` : '',
    salaryText ? `<p>${salaryText}</p>` : '',
    jp.description || '',
  ].join('\n');

  return normalizeJobPayload({
    sourceId: source.id || 'india-cutshort',
    sourceType: 'cutshort',
    externalId: externalId || url,
    title: schemaString(jp.title),
    company: schemaString(jp.hiringOrganization?.name) || 'Cutshort company',
    companyLogo: schemaString(jp.hiringOrganization?.logo),
    location,
    explicitRemote: isRemote,
    employmentType: isIntern ? 'Internship' : 'Full-Time',
    explicitSeniority: isIntern ? 'intern' : years !== null && years <= 1 ? 'junior' : null,
    descriptionHtml,
    tags: String(jp.skills || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    applyUrl: url,
    companyUrl: schemaString(jp.hiringOrganization?.sameAs),
    postedAt: jp.datePosted || null,
  });
}

export async function scrapeCutshort(source, options = {}) {
  const db = source?.db || options.db || null;
  const fetchFn = options.fetchImpl || globalThis.fetch;
  const maxPages = options.maxPages ?? source?.config?.maxPages ?? 40;
  const sourceId = source?.id || 'india-cutshort';

  const xml = await fetchText(CUTSHORT_SITEMAP, { timeoutMs: 60000, fetchImpl: fetchFn, db });
  const entries = parseCutshortSitemap(xml);
  const candidates = selectCutshortCandidates(entries, { maxAgeDays: options.maxAgeDays ?? 3 });

  // Jobs we already have: keep them alive while they remain in the sitemap, don't refetch
  const known = new Set();
  if (db) {
    for (const r of db.prepare('SELECT external_id FROM jobs WHERE source_id = ?').all(sourceId)) known.add(r.external_id);
    const live = entries.filter((e) => known.has(e.externalId)).map((e) => e.externalId);
    const now = new Date().toISOString();
    const touch = db.prepare('UPDATE jobs SET last_seen_at = ? WHERE source_id = ? AND external_id = ? AND is_active = 1');
    for (const id of live) touch.run(now, sourceId, id);
  }

  const out = [];
  for (const c of candidates.filter((c) => !known.has(c.externalId)).slice(0, maxPages)) {
    try {
      const html = await fetchText(c.url, { timeoutMs: 20000, minGapMs: 1500, fetchImpl: fetchFn, sleepImpl: options.sleepImpl, db: null });
      const job = parseCutshortJobPage(html, c, source);
      if (job) out.push(job);
    } catch {
      // skip individual page failures
    }
  }
  return out;
}
