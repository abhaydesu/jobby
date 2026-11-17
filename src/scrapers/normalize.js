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
  'JobbyJobAggregator/1.0 (+https://github.com/local/jobby; personal job discovery engine)';

export async function fetchJson(url, options = {}) {
  const { method = 'GET', body = null, headers = {}, timeoutMs = 15000 } = options;
  const res = await fetch(url, {
    method,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
  }
  return res.json();
}

export async function fetchText(url, options = {}) {
  const { timeoutMs = 15000, headers = {} } = options;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html, application/xml, application/rss+xml, text/plain, */*',
      ...headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
  }
  return res.text();
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
