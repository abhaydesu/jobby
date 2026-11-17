import crypto from 'node:crypto';
import {
  stripHtmlToText,
  sanitizeHtml,
  extractSkills,
  extractSalary,
  estimateStipendBenchmark,
  classifyRoleCategory,
  extractExperience,
  extractWorkMode,
  extractVisaSponsorship,
  extractFlags,
} from '../nlp.js';

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const HOST_NEXT_SLOT = new Map();

function defaultSleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function parseRetryAfterMs(headerVal) {
  if (!headerVal) return 0;
  const trimmed = String(headerVal).trim();
  const secs = Number(trimmed);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const ts = Date.parse(trimmed);
  if (Number.isFinite(ts)) return Math.max(0, ts - Date.now());
  return 0;
}

async function waitForHostSlot(url, minGapMs, sleepFn) {
  if (!minGapMs || minGapMs <= 0) return;
  let host = 'default';
  try {
    host = new URL(url).hostname || 'default';
  } catch {
    host = 'default';
  }
  const now = Date.now();
  const prev = HOST_NEXT_SLOT.get(host) || 0;
  const slot = Math.max(now, prev + minGapMs);
  HOST_NEXT_SLOT.set(host, slot);
  const waitMs = slot - now;
  if (waitMs > 0) await sleepFn(waitMs);
}

export async function fetchWithHardening(url, options = {}) {
  const {
    method = 'GET',
    body = null,
    headers = {},
    timeoutMs = 20000,
    retries = 3,
    minGapMs = 150,
    baseDelayMs = 400,
    maxRetryAfterMs = 15000,
    db = null,
    fetchImpl = globalThis.fetch,
    sleepImpl = defaultSleep,
    accept = '*/*',
  } = options;

  const upperMethod = String(method).toUpperCase();
  const cached = db && upperMethod === 'GET' ? db.prepare('SELECT etag, last_modified, body FROM http_cache WHERE url = ?').get(url) : null;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await waitForHostSlot(url, minGapMs, sleepImpl);

    const reqHeaders = {
      'User-Agent': USER_AGENT,
      Accept: accept,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    };
    if (cached && attempt === 0) {
      if (cached.etag) reqHeaders['If-None-Match'] = cached.etag;
      if (cached.last_modified) reqHeaders['If-Modified-Since'] = cached.last_modified;
    }

    try {
      const res = await fetchImpl(url, {
        method: upperMethod,
        headers: reqHeaders,
        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.status === 304 && cached) {
        return { text: cached.body, status: 304, headers: res.headers, fromCache: true };
      }

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = parseRetryAfterMs(res.headers?.get?.('retry-after'));
        if (attempt < retries) {
          const exp = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250);
          const delay = Math.min(maxRetryAfterMs, Math.max(exp, retryAfter));
          await sleepImpl(delay);
          lastErr = new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
          continue;
        }
        throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
      }

      const text = await res.text();
      if (db && upperMethod === 'GET') {
        const etag = res.headers?.get?.('etag') || '';
        const lastMod = res.headers?.get?.('last-modified') || '';
        if (etag || lastMod) {
          db.prepare(
            'INSERT INTO http_cache (url, etag, last_modified, body, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified, body = excluded.body, updated_at = excluded.updated_at'
          ).run(url, etag, lastMod, text, new Date().toISOString());
        }
      }
      return { text, status: res.status, headers: res.headers, fromCache: false };
    } catch (err) {
      lastErr = err;
      const isHttpClientErr = /^HTTP 4\d\d\b/.test(err?.message || '') && !/^HTTP 429\b/.test(err?.message || '');
      if (isHttpClientErr || attempt >= retries) {
        throw err;
      }
      const exp = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250);
      await sleepImpl(Math.min(maxRetryAfterMs, exp));
    }
  }
  throw lastErr || new Error(`Failed to fetch ${url}`);
}

export async function fetchJson(url, options = {}) {
  const res = await fetchWithHardening(url, {
    accept: 'application/json, text/plain, */*',
    ...options,
  });
  return JSON.parse(res.text);
}

export async function fetchText(url, options = {}) {
  const res = await fetchWithHardening(url, {
    accept: 'text/html, application/xml, application/rss+xml, text/plain, */*',
    ...options,
  });
  return res.text;
}

function normalizeDedupePart(val = '') {
  return String(val)
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|co|gmbh|technologies|labs|ai)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function computeDedupeHash(company, title, location = '') {
  const locNorm = normalizeDedupePart(location).split(' ').slice(0, 3).join(' ');
  const rawKey = `${normalizeDedupePart(company)}::${normalizeDedupePart(title)}::${locNorm}`;
  return crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 32);
}

export function makeJobId(sourceId, externalId) {
  return crypto.createHash('sha256').update(`${sourceId}::${externalId}`).digest('hex').slice(0, 24);
}

export function normalizeJobPayload({
  sourceId,
  sourceType,
  externalId,
  title,
  company,
  companyLogo = '',
  department = '',
  location = '',
  explicitRemote = null,
  explicitMode = null,
  employmentType = 'Full-Time',
  descriptionHtml = '',
  descriptionText = '',
  tags = [],
  structuredSalary = null,
  explicitVisa = false,
  explicitSeniority = null,
  applyUrl,
  companyUrl = '',
  postedAt = null,
}) {
  const cleanTitle = stripHtmlToText(title || '').replace(/\s+/g, ' ').trim();
  const cleanCompany = stripHtmlToText(company || '').replace(/\s+/g, ' ').trim() || 'Unknown Company';
  const rawLocation = stripHtmlToText(location || '').replace(/\s+/g, ' ').trim() || (explicitRemote ? 'Remote' : 'Unspecified');
  const cleanLocation = rawLocation.length > 85 ? `${rawLocation.split(/\.\s+|\n/)[0].slice(0, 82).trim()}` : rawLocation;

  const safeHtml = sanitizeHtml(descriptionHtml || descriptionText || '');
  const plainText = (descriptionText ? stripHtmlToText(descriptionText) : stripHtmlToText(descriptionHtml || '')).trim();
  const combinedForNlp = `${cleanTitle}\n${department}\n${cleanLocation}\n${plainText}`;

  const skills = extractSkills(combinedForNlp, tags);
  const roleCategory = classifyRoleCategory(cleanTitle, department, plainText);
  const exp = extractExperience(plainText, cleanTitle);
  if (explicitSeniority && (exp.seniority === 'unknown' || exp.seniority === 'mid')) {
    exp.seniority = explicitSeniority;
  }
  const workMode = explicitMode || extractWorkMode(plainText, cleanLocation, cleanTitle, explicitRemote);
  const extractedSal = extractSalary(plainText, structuredSalary);
  const salary =
    extractedSal.min !== null
      ? extractedSal
      : estimateStipendBenchmark({
          title: cleanTitle,
          company: cleanCompany,
          location: cleanLocation,
          workMode,
          seniority: exp.seniority,
          sourceType,
        });
  const visaSponsorship = extractVisaSponsorship(plainText, explicitVisa);

  const isoPosted = postedAt ? safeIsoDate(postedAt) : null;
  const flags = extractFlags(
    {
      sourceType,
      title: cleanTitle,
      salaryMin: salary.min,
      isSalaryEstimated: salary.estimated,
      workMode,
      visaSponsorship,
      postedAt: isoPosted,
      experienceMin: exp.min,
    },
    plainText
  );

  const extId = String(externalId || applyUrl || `${cleanCompany}-${cleanTitle}`);
  const id = makeJobId(sourceId, extId);
  const dedupeHash = computeDedupeHash(cleanCompany, cleanTitle, workMode === 'remote' ? 'remote' : cleanLocation);

  return {
    id,
    dedupe_hash: dedupeHash,
    external_id: extId,
    source_id: sourceId,
    source_type: sourceType,
    title: cleanTitle,
    company: cleanCompany,
    company_logo: companyLogo || '',
    department: department || '',
    role_category: roleCategory,
    location: cleanLocation,
    work_mode: workMode,
    seniority: exp.seniority,
    employment_type: employmentType || 'Full-Time',
    experience_min: exp.min,
    experience_max: exp.max,
    salary_min: salary.min,
    salary_max: salary.max,
    salary_currency: salary.currency,
    salary_period: salary.period,
    salary_raw: salary.raw,
    is_salary_estimated: salary.estimated,
    description_html: safeHtml,
    description_text: plainText,
    skills,
    green_flags: flags.greenFlags,
    red_flags: flags.redFlags,
    visa_sponsorship: visaSponsorship,
    apply_url: applyUrl,
    company_url: companyUrl || '',
    posted_at: isoPosted,
  };
}

function safeIsoDate(val) {
  if (!val) return null;
  try {
    const d = typeof val === 'number' ? new Date(val > 1e12 ? val : val * 1000) : new Date(val);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}
