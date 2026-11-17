(() => {
  function detectSiteTag() {
    const h = location.hostname.toLowerCase();
    if (h.includes('linkedin.com')) return 'linkedin_ext';
    if (h.includes('wellfound.com')) return 'wellfound_ext';
    if (h.includes('naukri.com')) return 'naukri_ext';
    if (h.includes('instahyre.com')) return 'instahyre_ext';
    if (h.includes('cutshort.io')) return 'cutshort_ext';
    return 'browser_ext';
  }

  function cleanText(el) {
    return (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function extractFromNextAndApollo() {
    const out = [];
    const nextEl = document.getElementById('__NEXT_DATA__');
    if (!nextEl?.textContent) return out;
    try {
      const root = JSON.parse(nextEl.textContent);
      const apollo = root?.props?.pageProps?.apolloState?.data || root?.props?.pageProps?.__APOLLO_STATE__ || {};
      const values = Object.values(apollo);
      for (const node of values) {
        if (!node || typeof node !== 'object') continue;
        if ((node.__typename === 'JobListing' || node.__typename === 'JobListingSearchResult' || node.__typename === 'Job') && node.title) {
          const startup = node.startup?.__ref ? apollo[node.startup.__ref] : node.startup;
          const locs = Array.isArray(node.locationNames) ? node.locationNames.join(', ') : node.location || 'Remote / India';
          const sal = node.compensation ? String(node.compensation) : '';
          out.push({
            externalId: node.id || node.slug || `${startup?.name || 'wf'}-${node.title}`,
            title: node.title,
            company: startup?.name || node.companyName || 'Wellfound Startup',
            location: locs,
            descriptionText: [node.description || '', sal ? `Salary: ${sal}` : ''].filter(Boolean).join('\n'),
            applyUrl: node.slug ? `https://wellfound.com/jobs/${node.slug}` : location.href,
          });
        }
      }
      const dehydrated = root?.props?.pageProps?.dehydratedState?.queries || [];
      for (const q of dehydrated) {
        const list = q?.state?.data?.data?.jobs || q?.state?.data?.jobs || [];
        if (Array.isArray(list)) {
          for (const j of list) {
            if (!j?.title) continue;
            out.push({
              externalId: j._id || j.id || j.slug || j.title,
              title: j.title,
              company: j.companyDetails?.name || j.company?.name || 'Cutshort Company',
              location: Array.isArray(j.locations) ? j.locations.join(', ') : j.location || 'India',
              descriptionText: j.description || j.sanitizedDescription || '',
              applyUrl: j.publicUrl || (j.slug ? `https://cutshort.io/job/${j.slug}` : location.href),
            });
          }
        }
      }
    } catch {
      return out;
    }
    return out;
  }

  function extractFromJsonLd() {
    const out = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((sc) => {
      try {
        const raw = JSON.parse(sc.textContent || '{}');
        const list = Array.isArray(raw) ? raw : Array.isArray(raw['@graph']) ? raw['@graph'] : [raw];
        for (const node of list) {
          const t = node?.['@type'];
          if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
            if (!node.title) continue;
            const addr = node.jobLocation?.address || (Array.isArray(node.jobLocation) ? node.jobLocation[0]?.address : {}) || {};
            out.push({
              externalId: node.identifier?.value || node.url || node.title,
              title: node.title,
              company: node.hiringOrganization?.name || document.title,
              location: [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).join(', ') || 'Unspecified',
              descriptionHtml: node.description || '',
              applyUrl: node.url || location.href,
              postedAt: node.datePosted || null,
            });
          }
        }
      } catch {
        return;
      }
    });
    return out;
  }

  function extractFromDom(siteTag) {
    const out = [];
    if (siteTag === 'linkedin_ext') {
      document.querySelectorAll('li[data-occludable-job-id], .job-search-card, .jobs-search-results__list-item').forEach((card) => {
        const titleEl = card.querySelector('.job-card-list__title, .base-search-card__title, a[href*="/jobs/view/"]');
        const compEl = card.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle, .base-search-card__subtitle');
        const locEl = card.querySelector('.job-card-container__metadata-wrapper li, .job-search-card__location');
        const linkEl = card.querySelector('a[href*="/jobs/view/"], .base-card__full-link');
        const id = card.getAttribute('data-occludable-job-id') || (linkEl?.href?.match(/\/view\/[^/]*?(\d+)/)?.[1]) || '';
        const title = cleanText(titleEl);
        if (!title) return;
        out.push({
          externalId: id || linkEl?.href || title,
          title,
          company: cleanText(compEl) || 'LinkedIn Company',
          location: cleanText(locEl) || 'Unspecified',
          applyUrl: linkEl?.href || location.href,
        });
      });
      const detailTitle = cleanText(document.querySelector('.job-details-jobs-unified-top-card__job-title, h1.t-24'));
      const detailDesc = document.querySelector('#job-details, .jobs-description__content')?.innerHTML || '';
      if (detailTitle && detailDesc) {
        const detailComp = cleanText(document.querySelector('.job-details-jobs-unified-top-card__company-name')) || 'LinkedIn Company';
        const detailLoc = cleanText(document.querySelector('.job-details-jobs-unified-top-card__primary-description-container')) || 'Unspecified';
        out.unshift({
          externalId: location.href,
          title: detailTitle,
          company: detailComp,
          location: detailLoc,
          descriptionHtml: detailDesc,
          applyUrl: location.href,
        });
      }
    } else if (siteTag === 'naukri_ext') {
      document.querySelectorAll('.srp-jobtuple-wrapper, article.jobTuple, .cust-job-tuple').forEach((card) => {
        const titleEl = card.querySelector('a.title, .title a');
        const compEl = card.querySelector('a.comp-name, .comp-name');
        const locEl = card.querySelector('.locWdth, .loc-wrap, .location');
        const salEl = card.querySelector('.sal-wrap, .salary');
        const descEl = card.querySelector('.job-desc');
        const title = cleanText(titleEl);
        if (!title) return;
        out.push({
          externalId: card.getAttribute('data-job-id') || titleEl?.href || title,
          title,
          company: cleanText(compEl) || 'Naukri Company',
          location: cleanText(locEl) || 'India',
          descriptionText: [cleanText(descEl), cleanText(salEl) ? `Salary: ${cleanText(salEl)}` : ''].filter(Boolean).join('\n'),
          applyUrl: titleEl?.href || location.href,
        });
      });
    } else if (siteTag === 'instahyre_ext' || siteTag === 'cutshort_ext' || siteTag === 'wellfound_ext') {
      document.querySelectorAll('.employer-block, .job-card, [data-test="JobListing"], div[class*="JobListing"], div[class*="job-card"]').forEach((card) => {
        const link = card.querySelector('a[href*="/job"], a[href*="/jobs/"]');
        const title = cleanText(card.querySelector('h2, h3, h4, .job-title, a[href*="/job"]'));
        const comp = cleanText(card.querySelector('.company-name, [class*="company"], h5'));
        const loc = cleanText(card.querySelector('[class*="location"], .job-locations'));
        if (!title || title.length > 140) return;
        out.push({
          externalId: link?.href || `${comp}-${title}`,
          title,
          company: comp || document.title.split('|')[0].trim(),
          location: loc || 'India',
          descriptionText: cleanText(card),
          applyUrl: link?.href || location.href,
        });
      });
    }
    return out;
  }

  function captureAllJobsOnPage() {
    const sourceTag = detectSiteTag();
    const combined = [...extractFromNextAndApollo(), ...extractFromJsonLd(), ...extractFromDom(sourceTag)];
    const seen = new Set();
    const deduped = [];
    for (const j of combined) {
      if (!j?.title) continue;
      const key = `${j.title.toLowerCase()}::${(j.company || '').toLowerCase()}::${j.applyUrl || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(j);
    }
    return { sourceTag, pageUrl: location.href, jobs: deduped };
  }

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.action === 'CAPTURE_PAGE') {
        try {
          sendResponse({ ok: true, ...captureAllJobsOnPage() });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      }
      return true;
    });
  }
})();
