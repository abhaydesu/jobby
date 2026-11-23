// Y Combinator's public job board (ycombinator.com/jobs) + company pages.
//
// Listing pages embed their data as an Inertia `data-page` JSON blob (≈30 postings each, no pagination).
// Each company page carries the company's *full* set of open roles plus its founders (name, title, LinkedIn),
// which is what makes this feed useful for reaching out to founders directly.

import { fetchText, normalizeJobPayload } from './normalize.js';
import { decodeHtmlEntities } from '../nlp.js';

const YC_BASE = 'https://www.ycombinator.com';

// Verified Nov 2026. India first so company enrichment budget goes to India-located startups.
export const YC_LISTING_PATHS = [
  '/jobs/location/india',
  '/jobs/role/software-engineer/india',
  '/jobs/role/software-engineer/remote',
  '/jobs/role/software-engineer',
  '/jobs',
];

export function parseYcPageProps(html = '') {
  const m = /data-page="([^"]+)"/.exec(String(html || ''));
  if (!m) return null;
  try {
    return JSON.parse(decodeHtmlEntities(m[1]))?.props || null;
  } catch {
    return null;
  }
}

/** "6 days" | "about 1 month" | "over 2 years" → ISO date (approximate); null if unparseable. */
export function ycRelativeToIso(rel = '', now = Date.now()) {
  const m = /(\d+)\s*(minute|hour|day|week|month|year)s?/i.exec(String(rel || ''));
  if (!m) return null;
  const n = Number(m[1]);
  const unitMs = { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 }[m[2].toLowerCase()];
  return new Date(now - n * unitMs).toISOString();
}

function isStale(rel = '') {
  return /\byears?\b/i.test(String(rel || ''));
}

/** YC writes "IN" for India in location strings ("IN / Remote (IN)", "San Francisco, CA, US / IN"). */
export function normalizeYcLocation(loc = '') {
  return String(loc || '')
    .replace(/\bIN\b/g, 'India')
    .trim();
}

/** "₹1.8M - ₹3M INR" → "Salary: ₹ 18,00,000 - 30,00,000 per year"; "$120K - $200K" passes through. */
export function ycSalaryToText(range = '') {
  const raw = String(range || '').trim();
  if (!raw) return '';
  if (/₹|INR/.test(raw)) {
    const vals = [...raw.matchAll(/₹?\s*([\d.]+)\s*([KkMm])?/g)]
      .map(([, num, unit]) => Number(num) * (unit ? (unit.toLowerCase() === 'm' ? 1e6 : 1e3) : 1))
      .filter((v) => v >= 50000);
    if (vals.length === 0) return '';
    const fmt = (v) => Math.round(v).toLocaleString('en-IN');
    return `Salary: ₹ ${fmt(vals[0])}${vals[1] ? ` - ${fmt(vals[1])}` : ''} per year`;
  }
  return `Salary: ${raw}${/month/i.test(raw) ? '' : ' per year'}`;
}

function experienceText(minExperience = '') {
  const s = String(minExperience || '');
  if (/new\s+grads?\s+ok|^any\b/i.test(s)) return 'Open to new grads. 0 years of experience required.';
  const n = /(\d+)\+?\s*years?/i.exec(s);
  return n ? `${n[1]}+ years of experience required.` : '';
}

export function founderContacts(company = {}) {
  const founders = Array.isArray(company?.founders) ? company.founders : [];
  return founders
    .filter((f) => f && f.full_name && f.is_active !== false)
    .map((f) => ({
      name: f.full_name,
      role: f.title || 'Founder',
      url: f.linkedin_url || f.twitter_url || '',
      kind: f.linkedin_url ? 'linkedin' : f.twitter_url ? 'twitter' : 'web',
    }));
}

/** Map one YC posting (+ optional company page data) to a normalized job. Returns null for non-eng/stale roles. */
export function mapYcPosting(p, source = {}, company = null, now = Date.now()) {
  if (!p || !p.title || !p.url) return null;
  if (p.role && p.role !== 'eng') return null;
  if (isStale(p.createdAt)) return null;

  const location = normalizeYcLocation(p.location) || normalizeYcLocation(company?.location) || 'Unspecified';
  const isIntern = /intern/i.test(`${p.type || ''} ${p.title}`);
  const newGradOk = /new\s+grads?\s+ok/i.test(p.minExperience || '');
  const batch = p.companyBatchName ? `YC ${p.companyBatchName}` : 'YC';
  const companyPage = p.companyUrl ? `${YC_BASE}${p.companyUrl}` : '';

  const descriptionText = [
    `${p.companyName} (${batch}) — ${p.companyOneLiner || company?.one_liner || ''}`.trim(),
    company?.team_size ? `Team size: ${company.team_size}.` : '',
    company?.location ? `Company HQ: ${company.location}.` : '',
    p.roleSpecificType ? `Role type: ${p.roleSpecificType}.` : '',
    experienceText(p.minExperience),
    ycSalaryToText(p.salaryRange),
    p.equityRange ? `Equity: ${p.equityRange}.` : '',
    Array.isArray(p.skills) && p.skills.length ? `Skills: ${p.skills.join(', ')}.` : '',
    `Posted on YC Work at a Startup ${p.createdAt ? `${p.createdAt} ago` : ''}.`.trim(),
  ]
    .filter(Boolean)
    .join('\n');

  const contacts = founderContacts(company);
  if (p.hiringManager && typeof p.hiringManager === 'object' && p.hiringManager.name) {
    contacts.unshift({ name: p.hiringManager.name, role: 'Hiring manager', url: p.hiringManager.linkedin_url || '', kind: 'linkedin' });
  }
  if (companyPage) contacts.push({ name: `${p.companyName} on YC`, role: 'Company page', url: companyPage, kind: 'web' });

  return normalizeJobPayload({
    sourceId: source.id || 'agg-yc-jobs',
    sourceType: 'yc',
    externalId: String(p.id),
    title: p.title,
    company: p.companyName || company?.name || 'YC Startup',
    companyLogo: p.companyLogoUrl || '',
    department: p.roleSpecificType || 'Engineering',
    location,
    explicitRemote: /\bremote\b/i.test(location),
    employmentType: p.type || 'Full-time',
    explicitSeniority: isIntern ? 'intern' : newGradOk ? 'junior' : null,
    descriptionText,
    tags: Array.isArray(p.skills) ? p.skills : [],
    applyUrl: `${YC_BASE}${p.url}`,
    companyUrl: company?.website || companyPage,
    postedAt: ycRelativeToIso(p.createdAt, now),
    contacts,
  });
}

export async function scrapeYCJobs(source, options = {}) {
  const fetchFn = options.fetchImpl || globalThis.fetch;
  const opts = { timeoutMs: source?.timeoutMs || 25000, minGapMs: 1000, fetchImpl: fetchFn, sleepImpl: options.sleepImpl, db: null };
  const maxCompanies = options.maxCompanies ?? 40;

  // 1. Listing pages → postings + the companies behind them
  const listingPostings = [];
  let anyOk = false;
  let firstErr = null;
  for (const p of YC_LISTING_PATHS) {
    try {
      const props = parseYcPageProps(await fetchText(`${YC_BASE}${p}`, opts));
      if (!props) continue;
      anyOk = true;
      listingPostings.push(...(props.jobPostings || []));
    } catch (err) {
      firstErr ??= err;
    }
  }
  if (!anyOk && firstErr) throw firstErr;

  // 2. Company pages: full role list + founders. Prioritize India-located, new-grad-friendly eng roles.
  const priority = (p) =>
    (/\bIN\b|india/i.test(p.location || '') ? 0 : 2) + (/new\s+grads?\s+ok/i.test(p.minExperience || '') ? 0 : 1);
  const companySlugs = [];
  for (const p of [...listingPostings].filter((x) => x.role === 'eng').sort((a, b) => priority(a) - priority(b))) {
    const slug = /^\/companies\/([^/]+)/.exec(p.companyUrl || '')?.[1];
    if (slug && !companySlugs.includes(slug)) companySlugs.push(slug);
  }

  const companies = new Map();
  const companyPostings = [];
  for (const slug of companySlugs.slice(0, maxCompanies)) {
    try {
      const props = parseYcPageProps(await fetchText(`${YC_BASE}/companies/${slug}`, opts));
      if (!props?.company) continue;
      companies.set(`/companies/${slug}`, props.company);
      companyPostings.push(...(props.jobPostings || []));
    } catch {
      // Listing-page data is still usable without enrichment
    }
  }

  // 3. Merge (company page versions win), map, dedupe
  const byId = new Map();
  for (const p of [...listingPostings, ...companyPostings]) byId.set(String(p.id), p);
  const out = [];
  for (const p of byId.values()) {
    const job = mapYcPosting(p, source, companies.get(p.companyUrl) || null);
    if (job) out.push(job);
  }
  return out;
}
