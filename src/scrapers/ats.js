// Tier 1: Direct ATS Public JSON API Adapters
// Greenhouse, Ashby HQ, Lever, SmartRecruiters, Workable, Recruitee

import { fetchJson, normalizeJobPayload } from './normalize.js';

function reqOpts(source, fallbackMs = 20000) {
  return { timeoutMs: source?.timeoutMs || fallbackMs, db: source?.db || null };
}

export async function scrapeGreenhouse(source) {
  const { slug, companyName } = source.config;
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
  const data = await fetchJson(url, reqOpts(source));
  const items = Array.isArray(data?.jobs) ? data.jobs : [];

  return items.map((job) =>
    normalizeJobPayload({
      sourceId: source.id,
      sourceType: 'greenhouse',
      externalId: job.id,
      title: job.title,
      company: companyName || source.name,
      department: Array.isArray(job.departments) && job.departments[0] ? job.departments[0].name : '',
      location: job.location?.name || '',
      descriptionHtml: job.content || '',
      applyUrl: job.absolute_url || `https://boards.greenhouse.io/${slug}/jobs/${job.id}`,
      companyUrl: `https://boards.greenhouse.io/${slug}`,
      postedAt: job.updated_at || job.first_published || null,
    })
  );
}

export async function scrapeAshby(source) {
  const { slug, companyName } = source.config;
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;
  const data = await fetchJson(url, reqOpts(source));
  const items = Array.isArray(data?.jobs) ? data.jobs : [];

  return items.map((job) => {
    let structuredSalary = null;
    if (job.compensation) {
      const comps = Array.isArray(job.compensation.summaryComponents) ? job.compensation.summaryComponents : [];
      const baseComp = comps.find((c) => /salary|base/i.test(c.label || c.compensationType || '')) || comps[0];
      if (baseComp && (baseComp.minValue || baseComp.maxValue)) {
        structuredSalary = {
          min: baseComp.minValue,
          max: baseComp.maxValue,
          currency: baseComp.currencyCode || 'USD',
          period: (baseComp.interval || 'year').toLowerCase().includes('hour') ? 'hour' : 'year',
          raw: job.compensation.compensationTierSummary || '',
        };
      }
    }

    const modeMap = {
      Remote: 'remote',
      Hybrid: 'hybrid',
      OnSite: 'onsite',
    };
    const explicitMode = modeMap[job.workplaceType] || null;
    const locParts = [job.location];
    if (Array.isArray(job.secondaryLocations) && job.secondaryLocations.length > 0) {
      locParts.push(
        ...job.secondaryLocations.slice(0, 2).map((l) => (typeof l === 'string' ? l : l.location)).filter(Boolean)
      );
    }

    return normalizeJobPayload({
      sourceId: source.id,
      sourceType: 'ashby',
      externalId: job.id || job.jobUrl,
      title: job.title,
      company: companyName || source.name,
      department: job.department || job.team || '',
      location: locParts.filter(Boolean).join(' • '),
      explicitRemote: Boolean(job.isRemote),
      explicitMode,
      employmentType: job.employmentType || 'Full-Time',
      descriptionHtml: job.descriptionHtml || '',
      descriptionText: job.descriptionPlain || '',
      structuredSalary,
      applyUrl: job.applyUrl || job.jobUrl,
      companyUrl: `https://jobs.ashbyhq.com/${slug}`,
      postedAt: job.publishedAt || null,
    });
  });
}

export async function scrapeLever(source) {
  const { slug, companyName } = source.config;
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
  const items = await fetchJson(url, reqOpts(source));
  if (!Array.isArray(items)) return [];

  return items.map((job) => {
    const cats = job.categories || {};
    let structuredSalary = null;
    if (job.salaryRange && (job.salaryRange.min || job.salaryRange.max)) {
      structuredSalary = {
        min: job.salaryRange.min,
        max: job.salaryRange.max,
        currency: job.salaryRange.currency || 'USD',
        period: (job.salaryRange.interval || 'year').toLowerCase().includes('hour') ? 'hour' : 'year',
        raw: job.salaryDescriptionPlain || '',
      };
    }

    const listHtml = Array.isArray(job.lists)
      ? job.lists.map((l) => `<h3>${l.text || ''}</h3>${l.content || ''}`).join('\n')
      : '';
    const fullHtml = [job.description || '', listHtml, job.additional || ''].filter(Boolean).join('\n');
    const fullPlain = [job.descriptionPlain || '', job.additionalPlain || ''].filter(Boolean).join('\n');

    const wt = String(job.workplaceType || '').toLowerCase();
    const explicitMode = wt === 'remote' ? 'remote' : wt === 'hybrid' ? 'hybrid' : wt === 'onsite' ? 'onsite' : null;

    return normalizeJobPayload({
      sourceId: source.id,
      sourceType: 'lever',
      externalId: job.id,
      title: job.text,
      company: companyName || source.name,
      department: cats.department || cats.team || '',
      location: cats.location || (Array.isArray(cats.allLocations) ? cats.allLocations.join(', ') : ''),
      explicitMode,
      employmentType: cats.commitment || 'Full-Time',
      descriptionHtml: fullHtml,
      descriptionText: fullPlain,
      structuredSalary,
      applyUrl: job.hostedUrl || job.applyUrl,
      companyUrl: `https://jobs.lever.co/${slug}`,
      postedAt: job.createdAt || null,
    });
  });
}

export async function scrapeSmartRecruiters(source) {
  const { slug, companyName } = source.config;
  const opts = reqOpts(source);
  const listUrl = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=60`;
  const data = await fetchJson(listUrl, opts);
  const items = Array.isArray(data?.content) ? data.content : [];

  const detailResults = await Promise.allSettled(
    items.slice(0, 20).map((item) =>
      fetchJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings/${item.id}`, {
        ...opts,
        timeoutMs: 12000,
      })
    )
  );

  return items.map((item, idx) => {
    const detail = idx < 20 && detailResults[idx]?.status === 'fulfilled' ? detailResults[idx].value : null;
    const locObj = item.location || {};
    const locText = [locObj.city, locObj.region, locObj.country].filter(Boolean).join(', ');
    let descHtml = '';
    if (detail?.jobAd?.sections) {
      const secs = detail.jobAd.sections;
      descHtml = [
        secs.companyDescription?.text,
        secs.jobDescription?.text,
        secs.qualifications?.text,
        secs.additionalInformation?.text,
      ]
        .filter(Boolean)
        .join('\n');
    }

    return normalizeJobPayload({
      sourceId: source.id,
      sourceType: 'smartrecruiters',
      externalId: item.id,
      title: item.name,
      company: item.company?.name || companyName || source.name,
      department: item.department?.label || '',
      location: locObj.remote ? `${locText ? `${locText} ` : ''}(Remote)` : locText,
      explicitRemote: Boolean(locObj.remote),
      employmentType: item.typeOfEmployment?.label || 'Full-Time',
      descriptionHtml: descHtml,
      applyUrl: detail?.postingUrl || `https://jobs.smartrecruiters.com/${slug}/${item.id}`,
      companyUrl: `https://jobs.smartrecruiters.com/${slug}`,
      postedAt: item.releasedDate || null,
    });
  });
}

export async function scrapeWorkable(source) {
  const { slug, companyName } = source.config;
  const opts = reqOpts(source);
  const url = `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(slug)}/jobs`;
  const data = await fetchJson(url, {
    ...opts,
    method: 'POST',
    body: { query: '', location: [], department: [], worktype: [], remote: [] },
  });
  const items = Array.isArray(data?.results) ? data.results : [];

  const detailResults = await Promise.allSettled(
    items.slice(0, 20).map((item) =>
      fetchJson(`https://apply.workable.com/api/v2/accounts/${encodeURIComponent(slug)}/jobs/${item.shortcode}`, {
        ...opts,
        timeoutMs: 12000,
      })
    )
  );

  return items.map((item, idx) => {
    const detail = idx < 20 && detailResults[idx]?.status === 'fulfilled' ? detailResults[idx].value : null;
    const locObj = item.location || {};
    const locStr = [locObj.city, locObj.region, locObj.country].filter(Boolean).join(', ');
    const descHtml = detail
      ? [detail.description, detail.requirements, detail.benefits].filter(Boolean).join('\n')
      : '';

    return normalizeJobPayload({
      sourceId: source.id,
      sourceType: 'workable',
      externalId: item.shortcode || item.id,
      title: item.title,
      company: companyName || source.name,
      department: Array.isArray(item.department) ? item.department.join(', ') : item.department || '',
      location: item.remote ? `${locStr ? `${locStr} ` : ''}(Remote)` : locStr,
      explicitRemote: Boolean(item.remote),
      employmentType: item.type || 'Full-Time',
      descriptionHtml: descHtml,
      applyUrl: `https://apply.workable.com/${slug}/j/${item.shortcode}/`,
      companyUrl: `https://apply.workable.com/${slug}/`,
      postedAt: item.published || null,
    });
  });
}

export async function scrapeRecruitee(source) {
  const { slug, companyName } = source.config;
  const url = `https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`;
  const data = await fetchJson(url, reqOpts(source));
  const items = Array.isArray(data?.offers) ? data.offers : [];

  return items.map((offer) => {
    let structuredSalary = null;
    if (offer.salary && (offer.salary.min || offer.salary.max)) {
      structuredSalary = {
        min: offer.salary.min,
        max: offer.salary.max,
        currency: offer.salary.currency || 'USD',
        period: offer.salary.period || 'year',
      };
    }
    const explicitMode = offer.remote ? 'remote' : offer.hybrid ? 'hybrid' : offer.on_site ? 'onsite' : null;
    const descHtml = [offer.description, offer.requirements].filter(Boolean).join('\n');

    return normalizeJobPayload({
      sourceId: source.id,
      sourceType: 'recruitee',
      externalId: offer.id || offer.slug,
      title: offer.title,
      company: offer.company_name || companyName || source.name,
      department: offer.department || '',
      location: offer.location || '',
      explicitRemote: Boolean(offer.remote),
      explicitMode,
      employmentType: offer.employment_type_code || 'Full-Time',
      descriptionHtml: descHtml,
      tags: Array.isArray(offer.tags) ? offer.tags : [],
      structuredSalary,
      applyUrl: offer.careers_apply_url || offer.careers_url,
      companyUrl: `https://${slug}.recruitee.com/`,
      postedAt: offer.published_at || offer.created_at || null,
    });
  });
}

export async function scrapeRippling(source) {
  const { slug, companyName } = source.config;
  const url = `https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(slug)}/jobs`;
  const data = await fetchJson(url, reqOpts(source));
  const items = Array.isArray(data) ? data : Array.isArray(data?.jobs) ? data.jobs : [];

  return items.map((job) => {
    const title = String(job.name || job.title || '').trim();
    const loc =
      job.workLocation?.label ||
      (Array.isArray(job.locations) ? job.locations.map((l) => l.name || l).filter(Boolean).join(', ') : '') ||
      '';
    const dept = job.department?.label || job.department?.name || '';
    const applyUrl = job.url || `https://ats.rippling.com/${slug}/jobs/${job.uuid}`;

    return normalizeJobPayload({
      sourceId: source.id,
      sourceType: 'rippling',
      externalId: job.uuid || job.id || applyUrl,
      title,
      company: companyName || source.name,
      department: dept,
      location: loc,
      descriptionHtml: job.description || '',
      applyUrl,
      companyUrl: `https://ats.rippling.com/${slug}`,
      postedAt: job.createdAt || job.publishedAt || null,
    });
  });
}

export async function scrapePinpoint(source) {
  const { slug, companyName } = source.config;
  const url = `https://${encodeURIComponent(slug)}.pinpointhq.com/postings.json`;
  const data = await fetchJson(url, reqOpts(source));
  const items = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];

  return items.map((item) => {
    const locObj = item.location || {};
    const locStr = [locObj.name, locObj.city, locObj.country].filter(Boolean).join(', ') || item.location_name || '';
    let structuredSalary = null;
    if (item.compensation_minimum || item.compensation_maximum) {
      structuredSalary = {
        min: Number(item.compensation_minimum || item.compensation_maximum),
        max: Number(item.compensation_maximum || item.compensation_minimum),
        currency: item.compensation_currency || 'USD',
        period: (item.compensation_frequency || 'year').toLowerCase(),
      };
    }

    return normalizeJobPayload({
      sourceId: source.id,
      sourceType: 'pinpoint',
      externalId: item.id || item.url,
      title: item.title,
      company: companyName || source.name,
      department: item.department?.name || item.job?.department?.name || '',
      location: locStr,
      explicitRemote: /remote/i.test(String(item.workplace_type || locStr)),
      explicitMode: /hybrid/i.test(String(item.workplace_type || '')) ? 'hybrid' : null,
      employmentType: item.employment_type_text || item.employment_type || 'Full-Time',
      descriptionHtml: item.description || item.job?.description || '',
      structuredSalary,
      applyUrl: item.url || `https://${slug}.pinpointhq.com/postings/${item.id}`,
      companyUrl: `https://${slug}.pinpointhq.com/`,
      postedAt: item.published_at || item.created_at || null,
    });
  });
}

function parseWorkdayPostedDate(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/today/i.test(s)) return new Date().toISOString();
  if (/yesterday/i.test(s)) return new Date(Date.now() - 86400000).toISOString();
  const daysMatch = /(\d+)\+?\s*days?\s+ago/i.exec(s);
  if (daysMatch) {
    return new Date(Date.now() - Number(daysMatch[1]) * 86400000).toISOString();
  }
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function parseWorkdayListings(data, detailMap = new Map(), source = {}) {
  const { tenant = 'tenant', wdNum = 5, site = 'External', companyName } = source.config || {};
  const hostBase = `https://${tenant}.wd${wdNum}.myworkdayjobs.com`;
  const postings = Array.isArray(data?.jobPostings) ? data.jobPostings : [];

  return postings
    .filter((p) => p && p.title && p.externalPath)
    .map((p) => {
      const detail = detailMap.get(p.externalPath)?.jobPostingInfo || detailMap.get(p.externalPath) || {};
      const location = detail.location || p.locationsText || 'Unspecified';
      const externalUrl =
        detail.externalUrl || `${hostBase}/${encodeURIComponent(site)}${p.externalPath}`;
      const postedAt = detail.startDate || parseWorkdayPostedDate(detail.postedOn || p.postedOn);
      const extId = detail.jobReqId || detail.id || p.bulletFields?.[0] || p.externalPath;

      return normalizeJobPayload({
        sourceId: source.id || `wd-${tenant}`,
        sourceType: 'workday',
        externalId: extId,
        title: detail.title || p.title,
        company: companyName || source.name || tenant,
        location,
        explicitRemote: /\bremote\b/i.test(location),
        employmentType: detail.timeType || 'Full-Time',
        descriptionHtml: detail.jobDescription || '',
        applyUrl: externalUrl,
        companyUrl: `${hostBase}/${encodeURIComponent(site)}`,
        postedAt,
      });
    });
}

export async function scrapeWorkday(source) {
  const { tenant, wdNum, site } = source.config;
  const opts = reqOpts(source, 35000);
  const cxsBase = `https://${encodeURIComponent(tenant)}.wd${wdNum}.myworkdayjobs.com/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;
  const searchTerms = ['intern', 'new grad', 'university', 'graduate', 'entry level', 'associate'];

  const byPath = new Map();
  let indiaFacetQuery = null;

  for (let i = 0; i < searchTerms.length; i++) {
    const data = await fetchJson(`${cxsBase}/jobs`, {
      ...opts,
      method: 'POST',
      body: { appliedFacets: {}, limit: 20, offset: 0, searchText: searchTerms[i] },
    }).catch(() => null);
    if (!data) continue;

    if (!indiaFacetQuery && Array.isArray(data.facets)) {
      for (const f of data.facets) {
        const indiaVal = (f.values || []).find((v) => /^India$/i.test(String(v.descriptor || '').trim()));
        if (indiaVal?.id && f.facetParameter) {
          indiaFacetQuery = { [f.facetParameter]: [indiaVal.id] };
          break;
        }
      }
    }

    for (const item of data.jobPostings || []) {
      if (item?.externalPath && !byPath.has(item.externalPath)) {
        byPath.set(item.externalPath, item);
      }
    }
  }

  if (indiaFacetQuery) {
    const indiaData = await fetchJson(`${cxsBase}/jobs`, {
      ...opts,
      method: 'POST',
      body: { appliedFacets: indiaFacetQuery, limit: 20, offset: 0, searchText: '' },
    }).catch(() => null);
    for (const item of indiaData?.jobPostings || []) {
      if (item?.externalPath && !byPath.has(item.externalPath)) {
        byPath.set(item.externalPath, item);
      }
    }
  }

  const allItems = Array.from(byPath.values());
  const priorityCandidates = allItems
    .filter((p) => {
      const t = String(p.title || '');
      const l = String(p.locationsText || '');
      const isSenior = /\b(senior|sr\.?|staff|principal|director|vp|vice\s+president|manager)\b/i.test(t);
      const isEarlyOrIndia = /\b(intern|co-?op|new\s+grad|graduate|university|fresher|entry|2026|2027|india|bangalore|bengaluru)\b/i.test(`${t} ${l}`);
      return !isSenior && isEarlyOrIndia;
    })
    .sort((a, b) => {
      const aIn = /india|bangalore|bengaluru/i.test(a.locationsText || '') ? 0 : 1;
      const bIn = /india|bangalore|bengaluru/i.test(b.locationsText || '') ? 0 : 1;
      return aIn - bIn;
    });

  const detailTargets = priorityCandidates.slice(0, 12);
  const detailMap = new Map();
  const detailResults = await Promise.allSettled(
    detailTargets.map((item) => fetchJson(`${cxsBase}${item.externalPath}`, { ...opts, timeoutMs: 12000 }))
  );
  detailResults.forEach((r, idx) => {
    if (r.status === 'fulfilled' && r.value) {
      detailMap.set(detailTargets[idx].externalPath, r.value);
    }
  });

  return parseWorkdayListings({ jobPostings: allItems }, detailMap, source);
}
