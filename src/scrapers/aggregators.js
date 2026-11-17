// Tier 2 & Tier 3: Startup Feeds (HN Who Is Hiring, YC Algolia)
// & Global Public Remote/Tech Aggregator APIs (Remotive, Arbeitnow, RemoteOK, The Muse, Himalayas, Jobicy, WWR RSS)

import { fetchJson, fetchText, normalizeJobPayload } from './normalize.js';
import { decodeHtmlEntities, stripHtmlToText } from '../nlp.js';

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
