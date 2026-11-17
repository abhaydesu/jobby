// Tier 2 & Tier 3: Startup Feeds (HN Who Is Hiring, YC Algolia)
// & Global Public Remote/Tech Aggregator APIs (Remotive, Arbeitnow, RemoteOK, The Muse, Himalayas, Jobicy, WWR RSS)

import { fetchJson, fetchText, normalizeJobPayload } from './normalize.js';
import { decodeHtmlEntities, stripHtmlToText, extractExperience, classifyRoleCategory } from '../nlp.js';

function aggOpts(source, fallbackMs = 20000) {
  return { timeoutMs: source?.timeoutMs || fallbackMs, db: source?.db || null };
}

export async function scrapeRemotive(source) {
  const data = await fetchJson('https://remotive.com/api/remote-jobs?limit=120', aggOpts(source));
  const items = Array.isArray(data?.jobs) ? data.jobs : [];

  return items.map((job) =>
    normalizeJobPayload({
      sourceId: source.id,
      sourceType: 'remotive',
      externalId: job.id,
      title: job.title,
      company: job.company_name,
      companyLogo: job.company_logo || '',
      department: job.category || '',
      location: job.candidate_required_location || 'Remote',
      explicitRemote: true,
      explicitMode: 'remote',
      employmentType: job.job_type || 'Full-Time',
      descriptionHtml: job.description || '',
      tags: Array.isArray(job.tags) ? job.tags : [],
      structuredSalary: job.salary ? null : null,
      // Prepend job.salary string so regex extractor catches it reliably
      descriptionText: job.salary ? `Salary: ${job.salary}\n` : '',
      applyUrl: job.url,
      postedAt: job.publication_date || null,
    })
  );
}

export async function scrapeArbeitnow(source) {
  const pages = [1, 2];
  const opts = aggOpts(source);
  const responses = await Promise.allSettled(
    pages.map((p) => fetchJson(`https://www.arbeitnow.com/api/job-board-api?page=${p}`, opts))
  );
  const allItems = [];
  let firstErr = null;
  let anySuccess = false;
  for (const r of responses) {
    if (r.status === 'fulfilled') {
      anySuccess = true;
      if (Array.isArray(r.value?.data)) {
        allItems.push(...r.value.data);
      }
    } else if (!firstErr) {
      firstErr = r.reason;
    }
  }
  if (!anySuccess && firstErr) {
    throw firstErr;
  }

  return allItems.map((job) =>
    normalizeJobPayload({
      sourceId: source.id,
      sourceType: 'arbeitnow',
      externalId: job.slug || job.url,
      title: job.title,
      company: job.company_name,
      location: job.location || (job.remote ? 'Remote' : 'Europe'),
      explicitRemote: Boolean(job.remote),
      employmentType: Array.isArray(job.job_types) && job.job_types[0] ? job.job_types[0] : 'Full-Time',
      descriptionHtml: job.description || '',
      tags: Array.isArray(job.tags) ? job.tags : [],
      explicitVisa: Boolean(job.visa_sponsorship),
      applyUrl: job.url,
      postedAt: job.created_at ? job.created_at * 1000 : null,
    })
  );
}

export async function scrapeRemoteOK(source) {
  const data = await fetchJson('https://remoteok.com/api', aggOpts(source));
  if (!Array.isArray(data)) return [];
  // First element is RemoteOK legal/metadata header
  const items = data.filter((item) => item && item.id && item.position).slice(0, 120);

  return items.map((job) => {
    const structuredSalary =
      job.salary_min || job.salary_max
        ? {
            min: job.salary_min || job.salary_max,
            max: job.salary_max || job.salary_min,
            currency: 'USD',
            period: 'year',
          }
        : null;

    return normalizeJobPayload({
      sourceId: source.id,
      sourceType: 'remoteok',
      externalId: job.id || job.slug,
      title: job.position,
      company: job.company,
      companyLogo: job.company_logo || job.logo || '',
      location: job.location || 'Remote Worldwide',
      explicitRemote: true,
      explicitMode: 'remote',
      descriptionHtml: job.description || '',
      tags: Array.isArray(job.tags) ? job.tags : [],
      structuredSalary,
      applyUrl: job.apply_url || job.url || `https://remoteok.com/remote-jobs/${job.id}`,
      postedAt: job.date || (job.epoch ? job.epoch * 1000 : null),
    });
  });
}

export async function scrapeTheMuse(source) {
  const urls = [
    'https://www.themuse.com/api/public/jobs?page=1&category=Software%20Engineering',
    'https://www.themuse.com/api/public/jobs?page=2&category=Software%20Engineering',
    'https://www.themuse.com/api/public/jobs?page=1&category=Data%20and%20Analytics',
    'https://www.themuse.com/api/public/jobs?page=1&category=Product%20Management',
  ];
  const responses = await Promise.allSettled(urls.map((u) => fetchJson(u)));
  const items = [];
  for (const r of responses) {
    if (r.status === 'fulfilled' && Array.isArray(r.value?.results)) {
      items.push(...r.value.results);
    }
  }

  return items.map((job) => {
    const locs = Array.isArray(job.locations) ? job.locations.map((l) => l.name).filter(Boolean) : [];
    const locStr = locs.join(', ') || 'United States';
    const cats = Array.isArray(job.categories) ? job.categories.map((c) => c.name).filter(Boolean) : [];
    const levels = Array.isArray(job.levels) ? job.levels.map((l) => l.name).filter(Boolean) : [];

    return normalizeJobPayload({
      sourceId: source.id,
      sourceType: 'themuse',
      externalId: job.id,
      title: job.name,
      company: job.company?.name || 'Unknown Company',
      department: cats.join(', '),
      location: locStr,
      explicitRemote: /remote|flexible/i.test(locStr),
      descriptionHtml: job.contents || '',
      tags: [...cats, ...levels],
      applyUrl: job.refs?.landing_page || `https://www.themuse.com/jobs`,
      postedAt: job.publication_date || null,
    });
  });
}

export async function scrapeHimalayas(source) {
  const data = await fetchJson('https://himalayas.app/jobs/api?limit=80', aggOpts(source));
  const items = Array.isArray(data?.jobs) ? data.jobs : [];

  return items.map((job) => {
    const structuredSalary =
      job.minSalary || job.maxSalary
        ? {
            min: job.minSalary || job.maxSalary,
            max: job.maxSalary || job.minSalary,
            currency: job.currency || 'USD',
            period: 'year',
          }
        : null;

    const locs = Array.isArray(job.locationRestrictions) && job.locationRestrictions.length
      ? `Remote (${job.locationRestrictions.slice(0, 3).join(', ')})`
      : 'Remote Worldwide';

    return normalizeJobPayload({
      sourceId: source.id,
      sourceType: 'himalayas',
      externalId: job.guid || job.applicationLink || `${job.companyName}-${job.title}`,
      title: job.title,
      company: job.companyName,
      companyLogo: job.companyLogo || '',
      department: Array.isArray(job.categories) ? job.categories.join(', ') : '',
      location: locs,
      explicitRemote: true,
      explicitMode: 'remote',
      employmentType: job.employmentType || 'Full-Time',
      descriptionHtml: job.description || job.excerpt || '',
      tags: Array.isArray(job.parentCategories) ? job.parentCategories : [],
      structuredSalary,
      applyUrl: job.applicationLink || job.guid,
      postedAt: job.pubDate ? job.pubDate * 1000 : null,
    });
  });
}

export async function scrapeJobicy(source) {
  const data = await fetchJson('https://jobicy.com/api/v2/remote-jobs?count=50', aggOpts(source));
  const items = Array.isArray(data?.jobs) ? data.jobs : [];

  return items.map((job) => {
    const structuredSalary =
      job.annualSalaryMin || job.annualSalaryMax
        ? {
            min: Number(job.annualSalaryMin) || Number(job.annualSalaryMax),
            max: Number(job.annualSalaryMax) || Number(job.annualSalaryMin),
            currency: job.salaryCurrency || 'USD',
            period: 'year',
          }
        : null;

    return normalizeJobPayload({
      sourceId: source.id,
      sourceType: 'jobicy',
      externalId: job.id || job.url,
      title: decodeHtmlEntities(job.jobTitle || ''),
      company: decodeHtmlEntities(job.companyName || ''),
      companyLogo: job.companyLogo || '',
      department: Array.isArray(job.jobIndustry) ? job.jobIndustry.join(', ') : job.jobIndustry || '',
      location: job.jobGeo ? `Remote (${job.jobGeo})` : 'Remote',
      explicitRemote: true,
      explicitMode: 'remote',
      employmentType: Array.isArray(job.jobType) ? job.jobType.join(', ') : job.jobType || 'Full-Time',
      descriptionHtml: job.jobDescription || job.jobExcerpt || '',
      structuredSalary,
      applyUrl: job.url,
      postedAt: job.pubDate || null,
    });
  });
}

function extractXmlTag(block, tag) {
  const rx = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = rx.exec(block);
  if (!m) return '';
  let val = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/i.exec(val);
  if (cdata) val = cdata[1].trim();
  return decodeHtmlEntities(val);
}

export async function scrapeWeWorkRemotely(source) {
  const xml = await fetchText('https://weworkremotely.com/remote-jobs.rss', aggOpts(source));
  const items = [];
  const itemRx = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRx.exec(xml)) !== null && items.length < 100) {
    const block = match[1];
    const fullTitle = extractXmlTag(block, 'title');
    const colonIdx = fullTitle.indexOf(':');
    const company = colonIdx > 0 ? fullTitle.slice(0, colonIdx).trim() : 'WeWorkRemotely Company';
    const title = colonIdx > 0 ? fullTitle.slice(colonIdx + 1).trim() : fullTitle;
    const link = extractXmlTag(block, 'link') || extractXmlTag(block, 'guid');
    const region = extractXmlTag(block, 'region') || 'Remote';
    const category = extractXmlTag(block, 'category') || '';
    const pubDate = extractXmlTag(block, 'pubDate');
    const description = extractXmlTag(block, 'description');

    if (!title || !link) continue;
    items.push(
      normalizeJobPayload({
        sourceId: source.id,
        sourceType: 'wwr',
        externalId: link,
        title,
        company,
        department: category,
        location: region ? `Remote (${region})` : 'Remote',
        explicitRemote: true,
        explicitMode: 'remote',
        descriptionHtml: description,
        applyUrl: link,
        postedAt: pubDate || null,
      })
    );
  }
  return items;
}

export async function scrapeHackerNewsWhoIsHiring(source) {
  const opts = aggOpts(source);
  const searchData = await fetchJson(
    'https://hn.algolia.com/api/v1/search_by_date?query=%22Ask%20HN:%20Who%20is%20hiring%22&tags=story,ask_hn&hitsPerPage=5',
    opts
  );
  const hits = Array.isArray(searchData?.hits) ? searchData.hits : [];
  const story = hits.find((h) => /who is hiring/i.test(h.title || '')) || hits[0];
  if (!story?.objectID) return [];

  const itemData = await fetchJson(`https://hn.algolia.com/api/v1/items/${story.objectID}`, opts);
  const children = Array.isArray(itemData?.children) ? itemData.children : [];

  const jobs = [];
  for (const comment of children.slice(0, 120)) {
    if (!comment?.text) continue;
    const plain = stripHtmlToText(comment.text);
    const firstLine = plain.split('\n').find((l) => l.trim().length > 4) || '';
    if (!firstLine) continue;

    // Standard HN format: Company | Role | Location | Salary | URL
    const parts = firstLine.split('|').map((p) => p.trim()).filter(Boolean);
    const company = parts[0] && parts[0].length <= 60 ? parts[0] : `HN Startup (${comment.author || 'Anon'})`;
    const role = parts[1] && parts[1].length <= 100 ? parts[1] : 'Software / Engineering Role';
    const locationParts = parts
      .slice(2)
      .filter((p) => !/^https?:\/\//i.test(p) && !/^\$\d/.test(p))
      .map((p) => p.split(/\.\s+/)[0].slice(0, 48).trim())
      .filter(Boolean);
    const rawLoc = locationParts.join(' • ') || (/remote/i.test(plain) ? 'Remote' : 'Unspecified');
    const location = rawLoc.length > 75 ? `${rawLoc.slice(0, 72)}...` : rawLoc;

    // Extract URL inside comment text if any, otherwise link directly to HN comment
    const urlMatch = comment.text.match(/href="([^"]+)"/i);
    const applyUrl = urlMatch ? decodeHtmlEntities(urlMatch[1]) : `https://news.ycombinator.com/item?id=${comment.id}`;

    jobs.push(
      normalizeJobPayload({
        sourceId: source.id,
        sourceType: 'hackernews',
        externalId: comment.id,
        title: role,
        company,
        location,
        explicitRemote: /\bremote\b/i.test(firstLine),
        descriptionHtml: comment.text,
        applyUrl,
        companyUrl: `https://news.ycombinator.com/item?id=${comment.id}`,
        postedAt: comment.created_at || story.created_at || null,
      })
    );
  }
  return jobs;
}

export async function scrapeYCJobs(source) {
  const data = await fetchJson('https://hn.algolia.com/api/v1/search_by_date?tags=job&hitsPerPage=60', aggOpts(source));
  const hits = Array.isArray(data?.hits) ? data.hits : [];

  return hits
    .filter((h) => h.title)
    .map((hit) => {
      // Often formatted as "Company (YC S22) Is Hiring a Senior Engineer"
      const m = /^(.+?)\s+(?:\(YC [^)]+\)\s+)?(?:is|are)\s+hiring\s+(?:an?\s+)?(.+)$/i.exec(hit.title);
      const company = m ? m[1].trim() : 'Y Combinator Startup';
      const title = m ? m[2].trim() : hit.title;

      return normalizeJobPayload({
        sourceId: source.id,
        sourceType: 'yc',
        externalId: hit.objectID,
        title,
        company,
        location: /\bremote\b/i.test(hit.title) ? 'Remote' : 'San Francisco / Remote',
        explicitRemote: /\bremote\b/i.test(hit.title),
        descriptionHtml: hit.story_text || `<p>${hit.title}</p><p>Posted by Y Combinator company on Hacker News Jobs.</p>`,
        applyUrl: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
        postedAt: hit.created_at || null,
      });
    });
}

export async function scrapeSimplifyGithub(source) {
  const repo = source.config?.repo || 'Summer2027-Internships';
  const defaultSeniority = source.config?.defaultSeniority || (repo.toLowerCase().includes('intern') ? 'intern' : 'junior');
  const url = `https://raw.githubusercontent.com/SimplifyJobs/${encodeURIComponent(repo)}/dev/.github/scripts/listings.json`;
  const data = await fetchJson(url, aggOpts(source, 25000));
  if (!Array.isArray(data)) return [];

  const active = data.filter((item) => item && item.active !== false && item.is_visible !== false && item.url && item.title);
  const indiaLocRx = /\b(india|bangalore|bengaluru|hyderabad|pune|mumbai|gurgaon|gurugram|noida|chennai|delhi|kolkata|ahmedabad|kochi)\b/i;
  const indianaGuardRx = /\b(indiana|indianapolis)\b/i;

  const isIndiaLoc = (l) => !indianaGuardRx.test(l) && indiaLocRx.test(l);
  const isRemoteLoc = (l) => /\bremote\b/i.test(l);

  const prioritized = [];
  const remaining = [];
  for (const item of active) {
    const locs = Array.isArray(item.locations) ? item.locations : [];
    if (locs.some((l) => isIndiaLoc(l) || isRemoteLoc(l))) {
      prioritized.push(item);
    } else {
      remaining.push(item);
    }
  }

  remaining.sort((a, b) => Number(b.date_posted || b.date_updated || 0) - Number(a.date_posted || a.date_updated || 0));
  const seen = new Set();
  const selected = [];
  for (const item of [...prioritized, ...remaining.slice(0, 260)]) {
    const key = item.id || `${item.company_name}-${item.title}-${item.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(item);
  }

  return selected.map((item) => {
    const rawLocs = Array.isArray(item.locations) ? item.locations.filter(Boolean) : [];
    const sortedLocs = [...rawLocs].sort((a, b) => {
      const aScore = isIndiaLoc(a) ? 0 : isRemoteLoc(a) ? 1 : 2;
      const bScore = isIndiaLoc(b) ? 0 : isRemoteLoc(b) ? 1 : 2;
      return aScore - bScore;
    });
    const locStr =
      sortedLocs.length > 3
        ? `${sortedLocs.slice(0, 2).join(', ')} (+${sortedLocs.length - 2} locs)`
        : sortedLocs.join(', ') || 'United States';

    const terms = Array.isArray(item.terms) ? item.terms.join(', ') : '';
    const degrees = Array.isArray(item.degrees) ? item.degrees.join(', ') : '';
    const sponsorshipNote = item.sponsorship || 'Unspecified';
    const hasRemote = sortedLocs.some((l) => isRemoteLoc(l));

    const summaryLines = [
      `${item.title} at ${item.company_name} (${item.category || 'Engineering'}).`,
      terms ? `Cycle / Terms: ${terms}.` : '',
      degrees ? `Eligible Degrees: ${degrees}.` : '',
      `Visa Sponsorship: ${sponsorshipNote === 'Does Not Offer Sponsorship' ? 'Unable to sponsor visas.' : sponsorshipNote}.`,
      sortedLocs.length ? `Locations: ${sortedLocs.join(', ')}.` : '',
      `Curated via SimplifyJobs (${repo}).`,
    ].filter(Boolean);

    return normalizeJobPayload({
      sourceId: source.id,
      sourceType: 'simplify',
      externalId: item.id || item.url,
      title: item.title,
      company: item.company_name || 'Simplify Company',
      department: item.category || '',
      location: locStr,
      explicitRemote: hasRemote,
      explicitSeniority: defaultSeniority,
      explicitVisa: /offers\s+sponsorship/i.test(sponsorshipNote),
      descriptionHtml: summaryLines.map((l) => `<p>${l}</p>`).join('\n'),
      descriptionText: summaryLines.join('\n'),
      tags: [item.category, ...(item.terms || [])].filter(Boolean),
      applyUrl: item.url,
      companyUrl: item.company_url || '',
      postedAt: item.date_posted || item.date_updated || null,
    });
  });
}

export function parseAmazonJobs(data, source = {}) {
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  return jobs
    .filter((j) => j && j.title && (j.job_path || j.id_icims))
    .map((j) => {
      const loc = j.normalized_location || j.location || j.city || 'Unspecified';
      const html = [j.description, j.basic_qualifications, j.preferred_qualifications].filter(Boolean).join('\n');
      const applyUrl = j.job_path ? `https://www.amazon.jobs${j.job_path}` : j.url_next_step;
      return normalizeJobPayload({
        sourceId: source.id || 'bigtech-amazon',
        sourceType: 'amazon',
        externalId: j.id_icims || j.id || j.job_path,
        title: j.title,
        company: 'Amazon',
        department: j.job_category || j.job_family || '',
        location: loc,
        explicitRemote: /\bremote|virtual\b/i.test(loc),
        descriptionHtml: html,
        applyUrl,
        companyUrl: 'https://www.amazon.jobs/',
        postedAt: j.posted_date || null,
      });
    });
}

export async function scrapeAmazonJobs(source) {
  const opts = aggOpts(source, 25000);
  const urls = [
    'https://www.amazon.jobs/en/search.json?base_query=software+intern&normalized_country_code[]=IND&result_limit=40&sort=recent',
    'https://www.amazon.jobs/en/search.json?base_query=software+development+engineer&normalized_country_code[]=IND&category_type=studentprograms&result_limit=40&sort=recent',
    'https://www.amazon.jobs/en/search.json?base_query=intern&category_type=studentprograms&result_limit=30&sort=recent',
  ];
  const responses = await Promise.allSettled(urls.map((u) => fetchJson(u, opts)));
  const byId = new Map();
  let anyOk = false;
  let firstErr = null;
  for (const r of responses) {
    if (r.status === 'fulfilled') {
      anyOk = true;
      for (const j of r.value?.jobs || []) {
        const key = j.id_icims || j.id;
        if (key && !byId.has(key)) byId.set(key, j);
      }
    } else if (!firstErr) {
      firstErr = r.reason;
    }
  }
  if (!anyOk && firstErr) throw firstErr;
  return parseAmazonJobs({ jobs: Array.from(byId.values()) }, source);
}

export function parseGoogleCareersHtml(html = '', source = {}) {
  const match = /AF_initDataCallback\(\{key:\s*'ds:1'[\s\S]*?data:([\s\S]*?),\s*sideChannel:/i.exec(String(html || ''));
  if (!match) return [];
  let root;
  try {
    root = JSON.parse(match[1]);
  } catch {
    return [];
  }
  const rows = Array.isArray(root?.[0]) ? root[0] : [];
  return rows
    .filter((item) => Array.isArray(item) && item[0] && item[1])
    .map((item) => {
      const id = String(item[0]);
      const title = String(item[1]);
      const locs = Array.isArray(item[9]) ? item[9].map((l) => (Array.isArray(l) ? l[0] : l)).filter(Boolean) : [];
      const location = locs.slice(0, 3).join(' • ') || 'India';
      const descParts = [item[10]?.[1], item[3]?.[1], item[4]?.[1]].filter(Boolean).join('\n');
      const epochSec = Number(item[12]?.[0] || item[13]?.[0] || 0);
      const postedAt = epochSec > 0 ? epochSec * 1000 : null;
      return normalizeJobPayload({
        sourceId: source.id || 'bigtech-google',
        sourceType: 'google',
        externalId: id,
        title,
        company: 'Google',
        location,
        explicitRemote: /\bremote\b/i.test(location),
        descriptionHtml: descParts,
        applyUrl: `https://www.google.com/about/careers/applications/jobs/results/${encodeURIComponent(id)}`,
        companyUrl: 'https://www.google.com/about/careers/applications/',
        postedAt,
      });
    });
}

export async function scrapeGoogleCareers(source) {
  const opts = aggOpts(source, 25000);
  const urls = [
    'https://www.google.com/about/careers/applications/jobs/results/?q=Software%20Engineer%20Intern&location=India',
    'https://www.google.com/about/careers/applications/jobs/results/?q=Software%20Engineer&target_level=EARLY&location=India',
  ];
  const responses = await Promise.allSettled(urls.map((u) => fetchText(u, opts)));
  const seen = new Set();
  const out = [];
  let anyOk = false;
  let firstErr = null;
  for (const r of responses) {
    if (r.status === 'fulfilled') {
      anyOk = true;
      for (const job of parseGoogleCareersHtml(r.value, source)) {
        if (!seen.has(job.external_id)) {
          seen.add(job.external_id);
          out.push(job);
        }
      }
    } else if (!firstErr) {
      firstErr = r.reason;
    }
  }
  if (!anyOk && firstErr) throw firstErr;
  return out;
}

export function parseAtlassianListings(data, source = {}) {
  const list = Array.isArray(data) ? data : [];
  const prioritized = list.filter((x) => {
    const locs = Array.isArray(x.locations) ? x.locations.join(' ') : '';
    const ttl = String(x.title || '');
    return /\b(india|bengaluru|bangalore|remote|intern|grad|university|early|junior|entry)\b/i.test(`${locs} ${ttl}`);
  });
  return prioritized.slice(0, 180).map((item) => {
    const locs = Array.isArray(item.locations) ? item.locations : [];
    const loc = locs.slice(0, 2).join(' • ') || 'Global';
    const desc = [item.overview, item.responsibilities, item.qualifications].filter(Boolean).join('\n');
    return normalizeJobPayload({
      sourceId: source.id || 'bigtech-atlassian',
      sourceType: 'atlassian',
      externalId: item.id,
      title: item.title,
      company: 'Atlassian',
      department: item.category || '',
      location: loc,
      explicitRemote: locs.some((l) => /\bremote\b/i.test(l)),
      employmentType: item.type || 'Full-Time',
      descriptionHtml: desc,
      applyUrl: item.applyUrl || item.portalJobPost?.portalUrl,
      companyUrl: 'https://www.atlassian.com/company/careers',
      postedAt: item.portalJobPost?.updatedDate || null,
    });
  });
}

export async function scrapeAtlassian(source) {
  const data = await fetchJson('https://www.atlassian.com/endpoint/careers/listings', aggOpts(source, 30000));
  return parseAtlassianListings(data, source);
}

export function parseAppleCareersHtml(html = '', source = {}) {
  const m = /window\.__staticRouterHydrationData\s*=\s*JSON\.parse\("([\s\S]*?)"\);/i.exec(String(html || ''));
  if (!m) return [];
  let parsed;
  try {
    const unescaped = JSON.parse(`"${m[1]}"`);
    parsed = JSON.parse(unescaped);
  } catch {
    return [];
  }
  const loaderData = parsed?.loaderData || {};
  const resultsKey = Object.keys(loaderData).find((k) => Array.isArray(loaderData[k]?.searchResults));
  const results = resultsKey ? loaderData[resultsKey].searchResults : [];

  return results
    .filter((item) => item && item.postingTitle && (item.id || item.positionId))
    .map((item) => {
      const locs = Array.isArray(item.locations) ? item.locations : [];
      const locStr = locs.map((l) => [l.city, l.name, l.countryName].filter(Boolean).join(', ')).filter(Boolean).slice(0, 2).join(' • ') || 'India';
      const slugId = item.id || item.positionId;
      const slugTitle = item.transformedPostingTitle ? `/${item.transformedPostingTitle}` : '';
      return normalizeJobPayload({
        sourceId: source.id || 'bigtech-apple',
        sourceType: 'apple',
        externalId: slugId,
        title: item.postingTitle,
        company: 'Apple',
        department: item.team?.teamName || '',
        location: locStr,
        explicitRemote: Boolean(item.homeOffice),
        descriptionText: item.jobSummary || '',
        applyUrl: `https://jobs.apple.com/en-in/details/${encodeURIComponent(slugId)}${slugTitle}`,
        companyUrl: 'https://jobs.apple.com/en-in/',
        postedAt: item.postDateInGMT || item.postingDate || null,
      });
    });
}

export async function scrapeAppleCareers(source) {
  const opts = aggOpts(source, 25000);
  const urls = [
    'https://jobs.apple.com/en-in/search?location=india-IND',
    'https://jobs.apple.com/en-in/search?search=intern&location=india-IND',
  ];
  const responses = await Promise.allSettled(urls.map((u) => fetchText(u, opts)));
  const seen = new Set();
  const out = [];
  let anyOk = false;
  let firstErr = null;
  for (const r of responses) {
    if (r.status === 'fulfilled') {
      anyOk = true;
      for (const job of parseAppleCareersHtml(r.value, source)) {
        if (!seen.has(job.external_id)) {
          seen.add(job.external_id);
          out.push(job);
        }
      }
    } else if (!firstErr) {
      firstErr = r.reason;
    }
  }
  if (!anyOk && firstErr) throw firstErr;
  return out;
}

export function parseInternshalaHtml(html = '', source = {}) {
  const blocks = String(html || '').split(/<div[^>]+class="[^"]*\bindividual_internship\b[^"]*"/i).slice(1);
  return blocks
    .map((block) => {
      const idMatch = /\binternshipId=["'](\d+)["']/i.exec(block);
      const typeMatch = /\bemployment_type=["']([^"']+)["']/i.exec(block);
      const hrefMatch = /<a[^>]+class="[^"]*job-title-href[^"]*"[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
      const altHrefMatch = !hrefMatch ? /\bdata-href=["']([^"']+)["']/i.exec(block) : null;
      const href = hrefMatch?.[1] || altHrefMatch?.[1] || '';
      const rawTitle = stripHtmlToText(hrefMatch?.[2] || '');
      const compMatch = /<p[^>]+class="[^"]*company-name[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
      const company = stripHtmlToText(compMatch?.[1] || '') || 'Internshala Employer';

      const locSection = /class="[^"]*row-1-item locations[^"]*"([\s\S]*?)<\/div>/i.exec(block)?.[1] || '';
      const locLinks = [...locSection.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => stripHtmlToText(m[1])).filter(Boolean);
      const locText = locLinks.join(', ') || stripHtmlToText(locSection) || 'India';
      const isRemote = /work from home|remote/i.test(locText);

      const stipendRaw = stripHtmlToText(/<span[^>]+class=['"]stipend['"][^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1] || '');
      const aboutRaw = stripHtmlToText(/<div[^>]+class="[^"]*about_job[^"]*"[\s\S]*?<div[^>]+class="[^"]*text[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1] || '');
      const skills = [...block.matchAll(/<div[^>]+class=['"]job_skill['"][^>]*>([\s\S]*?)<\/div>/gi)].map((m) => stripHtmlToText(m[1])).filter(Boolean);
      const cats = [...block.matchAll(/<div[^>]+class="[^"]*category_name[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)].map((m) => stripHtmlToText(m[1])).filter(Boolean);
      const isIntern = /intern/i.test(`${typeMatch?.[1] || ''} ${href}`);

      if (!rawTitle || !href) return null;
      const fullUrl = href.startsWith('http') ? href : `https://internshala.com${href}`;
      const title = isIntern && !/\bintern/i.test(rawTitle) ? `${rawTitle} Intern` : rawTitle;
      const descText = [
        aboutRaw,
        stipendRaw ? `Stipend: ${stipendRaw}` : '',
        cats.length ? `Categories: ${cats.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      return normalizeJobPayload({
        sourceId: source.id || 'india-internshala',
        sourceType: 'internshala',
        externalId: idMatch?.[1] || fullUrl,
        title,
        company,
        department: cats[0] || 'Engineering',
        location: isRemote ? `Remote (${locText})` : locText,
        explicitRemote: isRemote,
        explicitSeniority: isIntern ? 'intern' : 'junior',
        descriptionText: descText,
        tags: [...skills, ...cats],
        applyUrl: fullUrl,
        companyUrl: 'https://internshala.com/',
      });
    })
    .filter(Boolean);
}

export async function scrapeInternshala(source) {
  const opts = aggOpts(source, 25000);
  const urls = [
    'https://internshala.com/internships/computer-science-internship-in-bangalore/',
    'https://internshala.com/internships/work-from-home-computer-science-internships/',
    'https://internshala.com/jobs/fresher-software-development-jobs/',
  ];
  const responses = await Promise.allSettled(urls.map((u) => fetchText(u, opts)));
  const seen = new Set();
  const out = [];
  let anyOk = false;
  let firstErr = null;
  for (const r of responses) {
    if (r.status === 'fulfilled') {
      anyOk = true;
      for (const job of parseInternshalaHtml(r.value, source)) {
        if (!seen.has(job.external_id)) {
          seen.add(job.external_id);
          out.push(job);
        }
      }
    } else if (!firstErr) {
      firstErr = r.reason;
    }
  }
  if (!anyOk && firstErr) throw firstErr;
  return out;
}

export function parseInstahyreJson(data, source = {}) {
  const objects = Array.isArray(data?.objects) ? data.objects : [];
  return objects
    .filter((o) => o && o.title && (o.public_url || o.id))
    .map((o) => {
      const company = o.employer?.company_name || 'Instahyre Company';
      const logo = o.employer?.profile_image_src || '';
      const keywords = Array.isArray(o.keywords) ? o.keywords.filter(Boolean) : [];
      const loc = o.locations || 'India';
      const desc = [
        o.employer?.instahyre_note || o.employer?.company_tagline || '',
        keywords.length ? `Tech stack: ${keywords.join(', ')}.` : '',
      ]
        .filter(Boolean)
        .join('\n');
      return normalizeJobPayload({
        sourceId: source.id || 'india-instahyre',
        sourceType: 'instahyre',
        externalId: o.id || o.public_url,
        title: o.title,
        company,
        companyLogo: logo,
        location: loc,
        explicitRemote: /\bremote|work from home\b/i.test(loc),
        descriptionText: desc,
        tags: keywords,
        applyUrl: o.public_url || `https://www.instahyre.com/job-${o.id}/`,
        companyUrl: 'https://www.instahyre.com/',
      });
    });
}

export async function scrapeInstahyre(source) {
  const opts = aggOpts(source, 25000);
  const urls = [
    'https://www.instahyre.com/api/v1/job_search?company_size=0&experience=0&job_type=0&offset=0',
    'https://www.instahyre.com/api/v1/job_search?company_size=0&experience=1&job_type=0&offset=0',
    'https://www.instahyre.com/api/v1/job_search?company_size=0&job_type=0&offset=0',
  ];
  const responses = await Promise.allSettled(urls.map((u) => fetchJson(u, opts)));
  const seen = new Set();
  const out = [];
  let anyOk = false;
  let firstErr = null;
  for (const r of responses) {
    if (r.status === 'fulfilled') {
      anyOk = true;
      for (const job of parseInstahyreJson(r.value, source)) {
        if (!seen.has(job.external_id)) {
          seen.add(job.external_id);
          out.push(job);
        }
      }
    } else if (!firstErr) {
      firstErr = r.reason;
    }
  }
  if (!anyOk && firstErr) throw firstErr;
  return out;
}

export function parseLinkedInGuestCards(html = '', source = {}, detailMap = new Map()) {
  const blocks = String(html || '').split(/<li[\s>]/i).slice(1);
  return blocks
    .map((block) => {
      const idMatch = /data-entity-urn=["']urn:li:jobPosting:(\d+)["']/i.exec(block);
      const jobId = idMatch?.[1];
      if (!jobId) return null;

      const titleMatch = /<h3[^>]+class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i.exec(block);
      const title = stripHtmlToText(titleMatch?.[1] || '');
      const companyMatch = /<h4[^>]+class="[^"]*base-search-card__subtitle[^"]*"[^>]*>[\s\S]*?(?:<a[^>]*>([\s\S]*?)<\/a>|([\s\S]*?))<\/h4>/i.exec(block);
      const company = stripHtmlToText(companyMatch?.[1] || companyMatch?.[2] || '') || 'LinkedIn Company';
      const locMatch = /<span[^>]+class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block);
      const location = stripHtmlToText(locMatch?.[1] || '') || 'Unspecified';
      const linkMatch = /<a[^>]+class="[^"]*base-card__full-link[^"]*"[^>]+href=["']([^"']+)["']/i.exec(block);
      const url = decodeHtmlEntities(linkMatch?.[1] || `https://www.linkedin.com/jobs/view/${jobId}/`);
      const timeMatch = /<time[^>]+datetime=["']([^"']+)["']/i.exec(block);

      if (!title) return null;
      const detail = detailMap.get(jobId) || {};
      const applyUrl = detail.offsiteUrl || url;
      return normalizeJobPayload({
        sourceId: source.id || 'agg-linkedin-guest',
        sourceType: 'linkedin_guest',
        externalId: jobId,
        title,
        company,
        location,
        explicitRemote: /\bremote\b/i.test(location),
        descriptionHtml: detail.html || '',
        applyUrl,
        companyUrl: url,
        postedAt: timeMatch?.[1] || null,
      });
    })
    .filter(Boolean);
}

function extractLinkedInDetailParts(detailHtml = '') {
  const markupMatch = /<div[^>]+class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(detailHtml);
  const offsiteMatch = /href=["'](https?:\/\/(?!(?:[a-z]+\.)?linkedin\.com)[^"']+)["'][^>]*data-tracking-control-name=["'][^"']*apply/i.exec(detailHtml)
    || /<code[^>]+id=["']applyUrl["'][^>]*><!--\s*"([^"]+)"\s*--><\/code>/i.exec(detailHtml);
  return {
    html: markupMatch?.[1] || '',
    offsiteUrl: offsiteMatch ? decodeHtmlEntities(offsiteMatch[1]) : '',
  };
}

export async function scrapeLinkedInGuest(source, options = {}) {
  const db = source?.db || options.db || null;
  const now = Date.now();
  if (db) {
    const backoffRow = db.prepare("SELECT value FROM settings WHERE key = 'linkedin_backoff_until'").get();
    const backoffUntil = Number(backoffRow?.value || 0);
    if (backoffUntil > now) {
      return [];
    }
    const runsRow = db.prepare("SELECT value FROM settings WHERE key = 'linkedin_run_timestamps'").get();
    let recentRuns = [];
    try {
      recentRuns = JSON.parse(runsRow?.value || '[]').filter((ts) => Number(ts) > now - 24 * 3600 * 1000);
    } catch {
      recentRuns = [];
    }
    if (recentRuns.length >= 4) {
      return [];
    }
    recentRuns.push(now);
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('linkedin_run_timestamps', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(JSON.stringify(recentRuns));
  }

  const keywords = options.keywords || ['SDE intern', 'software engineer new grad', 'ML intern', 'data intern', 'devops intern'];
  const locations = options.locations || ['Bengaluru', 'India', 'Remote'];
  const fetchFn = options.fetchImpl || globalThis.fetch;
  const minGapMs = options.delayMs ?? 4000;
  const rawHtmlBlocks = [];
  const candidateMeta = [];
  const seenIds = new Set();

  for (const kw of keywords) {
    for (const loc of locations) {
      const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(kw)}&location=${encodeURIComponent(loc)}&f_E=1,2&f_TPR=r86400&start=0`;
      try {
        const html = await fetchText(url, {
          timeoutMs: 15000,
          retries: 0,
          minGapMs,
          fetchImpl: fetchFn,
          sleepImpl: options.sleepImpl,
          db: null,
        });
        rawHtmlBlocks.push(html);
        for (const card of parseLinkedInGuestCards(html, source)) {
          if (seenIds.has(card.external_id)) continue;
          seenIds.add(card.external_id);
          const exp = extractExperience(card.description_text, card.title);
          const cat = classifyRoleCategory(card.title, card.department, card.description_text);
          if ((exp.seniority === 'intern' || exp.seniority === 'junior') && cat !== 'non_tech') {
            candidateMeta.push(card.external_id);
          }
        }
      } catch (err) {
        if (/HTTP 429\b/.test(err?.message || '')) {
          if (db) {
            db.prepare(
              "INSERT INTO settings (key, value) VALUES ('linkedin_backoff_until', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            ).run(String(Date.now() + 6 * 3600 * 1000));
          }
          break;
        }
      }
    }
    if (db) {
      const backoffAfter = Number(db.prepare("SELECT value FROM settings WHERE key = 'linkedin_backoff_until'").get()?.value || 0);
      if (backoffAfter > Date.now()) break;
    }
  }

  const detailMap = new Map();
  const maxDetails = options.maxDetails ?? 10;
  for (const id of candidateMeta.slice(0, maxDetails)) {
    if (db) {
      const backoffNow = Number(db.prepare("SELECT value FROM settings WHERE key = 'linkedin_backoff_until'").get()?.value || 0);
      if (backoffNow > Date.now()) break;
    }
    try {
      const detailHtml = await fetchText(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${encodeURIComponent(id)}`, {
        timeoutMs: 15000,
        retries: 0,
        minGapMs,
        fetchImpl: fetchFn,
        sleepImpl: options.sleepImpl,
        db: null,
      });
      detailMap.set(id, extractLinkedInDetailParts(detailHtml));
    } catch (err) {
      if (/HTTP 429\b/.test(err?.message || '')) {
        if (db) {
          db.prepare(
            "INSERT INTO settings (key, value) VALUES ('linkedin_backoff_until', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
          ).run(String(Date.now() + 6 * 3600 * 1000));
        }
        break;
      }
    }
  }

  const combinedHtml = rawHtmlBlocks.join('\n');
  const allParsed = parseLinkedInGuestCards(combinedHtml, source, detailMap);
  const uniq = new Map();
  for (const job of allParsed) {
    if (!uniq.has(job.external_id)) uniq.set(job.external_id, job);
  }
  return Array.from(uniq.values());
}
