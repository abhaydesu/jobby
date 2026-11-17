// Tier 4: Universal Career Page ATS Fingerprinter & Schema.org JSON-LD Extractor
// Takes any company career page URL (or domain), auto-detects embedded ATS providers
// (Greenhouse, Ashby, Lever, SmartRecruiters, Workable, Recruitee) or extracts Schema.org JobPosting JSON-LD.

import { fetchText, normalizeJobPayload } from './normalize.js';

const ATS_PATTERNS = [
  {
    type: 'greenhouse',
    rx: /https?:\/\/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-zA-Z0-9_-]+)/i,
  },
  {
    type: 'greenhouse',
    rx: /https?:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([a-zA-Z0-9_-]+)/i,
  },
  {
    type: 'ashby',
    rx: /https?:\/\/jobs\.ashbyhq\.com\/([a-zA-Z0-9_.-]+)/i,
  },
  {
    type: 'ashby',
    rx: /https?:\/\/api\.ashbyhq\.com\/posting-api\/job-board\/([a-zA-Z0-9_.-]+)/i,
  },
  {
    type: 'lever',
    rx: /https?:\/\/jobs\.(?:eu\.)?lever\.co\/([a-zA-Z0-9_.-]+)/i,
  },
  {
    type: 'workable',
    rx: /https?:\/\/apply\.workable\.com\/([a-zA-Z0-9_.-]+)/i,
  },
  {
    type: 'smartrecruiters',
    rx: /https?:\/\/jobs\.smartrecruiters\.com\/([a-zA-Z0-9_.-]+)/i,
  },
  {
    type: 'recruitee',
    rx: /https?:\/\/([a-zA-Z0-9_-]+)\.recruitee\.com/i,
  },
  {
    type: 'rippling',
    rx: /https?:\/\/(?:ats\.rippling\.com|api\.rippling\.com\/platform\/api\/ats\/v1\/board)\/([a-zA-Z0-9_-]+)/i,
  },
  {
    type: 'pinpoint',
    rx: /https?:\/\/([a-zA-Z0-9_-]+)\.pinpointhq\.com/i,
  },
  {
    type: 'workday',
    rx: /https?:\/\/([a-zA-Z0-9_-]+\.wd\d+\.myworkdayjobs\.com\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?[a-zA-Z0-9_-]+)/i,
  },
  {
    type: 'oracle_hcm',
    rx: /https?:\/\/([a-zA-Z0-9_.-]+\.(?:oraclecloud\.com|dell\.com))\/hcmUI\/CandidateExperience\/[a-z-]+\/sites\/([a-zA-Z0-9_-]+)/i,
  },
  {
    type: 'personio',
    rx: /https?:\/\/([a-zA-Z0-9_-]+)\.jobs\.personio\.(?:de|com)/i,
  },
  {
    type: 'teamtailor',
    rx: /https?:\/\/([a-zA-Z0-9_-]+\.teamtailor\.com)\/jobs/i,
  },
  {
    type: 'keka',
    rx: /https?:\/\/([a-zA-Z0-9_-]+)\.keka\.com\/careers/i,
  },
  {
    type: 'darwinbox',
    rx: /https?:\/\/([a-zA-Z0-9_.-]+)\.darwinbox\.in/i,
  },
  {
    type: 'zohorecruit',
    rx: /https?:\/\/([a-zA-Z0-9_-]+)\.zohorecruit\.(?:com|in)/i,
  },
  {
    type: 'freshteam',
    rx: /https?:\/\/([a-zA-Z0-9_-]+)\.freshteam\.com\/jobs/i,
  },
  {
    type: 'bamboohr',
    rx: /https?:\/\/([a-zA-Z0-9_-]+)\.bamboohr\.com\/(?:careers|jobs)/i,
  },
  {
    type: 'breezy',
    rx: /https?:\/\/([a-zA-Z0-9_-]+)\.breezy\.hr/i,
  },
  {
    type: 'eightfold',
    rx: /https?:\/\/([a-zA-Z0-9_.-]+)\/careers\?.*domain=([a-zA-Z0-9_.-]+)|https?:\/\/([a-zA-Z0-9_.-]+\.eightfold\.ai)\/careers/i,
  },
  {
    type: 'phenom',
    rx: /phenompeople\.com|\/phx\/|phenomtrack/i,
  },
  {
    type: 'successfactors',
    rx: /https?:\/\/jobs\.(?:sap|[a-z0-9-]+)\.com\/.*careersection|successfactors\.com\/careers/i,
  },
  {
    type: 'icims',
    rx: /https?:\/\/careers-[a-z0-9-]+\.icims\.com\/jobs/i,
  },
];

export function detectAtsFromText(text = '') {
  for (const pat of ATS_PATTERNS) {
    const m = pat.rx.exec(text);
    if (m) {
      const candidateSlug = (m[2] && pat.type === 'oracle_hcm' ? `${m[1]}::${m[2]}` : (m[1] || m[2] || m[3] || m[0])).replace(/\/$/, '');
      if (candidateSlug && !['embed', 'api', 'v1', 'v2', 'assets', 'static'].includes(candidateSlug.toLowerCase())) {
        return { type: pat.type, slug: candidateSlug };
      }
    }
  }
  return null;
}

export function extractJsonLdJobPostings(html = '', sourceId = 'custom', baseUrl = '') {
  const jobs = [];
  const scriptRx = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRx.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const candidates = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.['@graph'])
          ? parsed['@graph']
          : [parsed];

      for (const node of candidates) {
        const nodeType = node?.['@type'];
        const isJob =
          nodeType === 'JobPosting' || (Array.isArray(nodeType) && nodeType.includes('JobPosting'));
        if (!isJob || !node.title) continue;

        const orgName = node.hiringOrganization?.name || new URL(baseUrl).hostname.replace(/^www\./, '');
        const locObj = Array.isArray(node.jobLocation) ? node.jobLocation[0] : node.jobLocation;
        const addr = locObj?.address || {};
        const locStr = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).join(', ');
        const isRemote = node.jobLocationType === 'TELECOMMUTE';

        let structuredSalary = null;
        if (node.baseSalary?.value) {
          const val = node.baseSalary.value;
          structuredSalary = {
            min: val.minValue || val.value,
            max: val.maxValue || val.value,
            currency: node.baseSalary.currency || 'USD',
            period: (val.unitText || 'YEAR').toLowerCase(),
          };
        }

        jobs.push(
          normalizeJobPayload({
            sourceId,
            sourceType: 'custom',
            externalId: node.identifier?.value || node.url || `${orgName}-${node.title}`,
            title: node.title,
            company: orgName,
            location: isRemote ? `Remote${locStr ? ` (${locStr})` : ''}` : locStr || 'Unspecified',
            explicitRemote: isRemote,
            employmentType: Array.isArray(node.employmentType) ? node.employmentType[0] : node.employmentType || 'Full-Time',
            descriptionHtml: node.description || '',
            structuredSalary,
            applyUrl: node.url || baseUrl,
            companyUrl: baseUrl,
            postedAt: node.datePosted || null,
          })
        );
      }
    } catch {
      // Ignore invalid JSON-LD blocks
    }
  }
  return jobs;
}

export async function discoverCareerPage(rawInput) {
  let targetUrl = String(rawInput || '').trim();
  if (!targetUrl) throw new Error('Please enter a career page URL or company domain.');

  // First check if the URL itself matches an ATS signature
  const directMatch = detectAtsFromText(targetUrl);
  if (directMatch) {
    return {
      detectedAts: directMatch,
      targetUrl,
      jsonLdJobs: [],
    };
  }

  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = `https://${targetUrl}`;
  }

  // Try fetching the given URL (and if bare domain without path, try /careers as well)
  const urlsToCheck = [targetUrl];
  try {
    const parsed = new URL(targetUrl);
    if (parsed.pathname === '/' || parsed.pathname === '') {
      urlsToCheck.push(`${parsed.origin}/careers`, `${parsed.origin}/jobs`);
    }
  } catch {
    throw new Error('Invalid URL format.');
  }

  for (const url of urlsToCheck) {
    try {
      const html = await fetchText(url, { timeoutMs: 12000 });
      const ats = detectAtsFromText(html);
      if (ats) {
        return { detectedAts: ats, targetUrl: url, jsonLdJobs: [] };
      }
      const jsonLdJobs = extractJsonLdJobPostings(html, 'custom-discovered', url);
      if (jsonLdJobs.length > 0) {
        return { detectedAts: null, targetUrl: url, jsonLdJobs };
      }
    } catch {
      // Try next candidate URL
    }
  }

  return {
    detectedAts: null,
    targetUrl,
    jsonLdJobs: [],
  };
}

export async function scrapeCustomUrl(source) {
  const url = source.config?.url;
  if (!url) return [];
  const html = await fetchText(url, { timeoutMs: 15000 });
  return extractJsonLdJobPostings(html, source.id, url);
}
