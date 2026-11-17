import { detectAllAtsFromText } from './fingerprinter.js';
import { buildConfigForAts, upsertSourceCandidate, upsertJobsBatch } from '../db.js';

const PORTAL_DOMAINS = /(?:linkedin\.com|wellfound\.com|naukri\.com|instahyre\.com|cutshort\.io|news\.ycombinator\.com|github\.com)/i;
const DIRECT_ATS_TYPES = new Set([
  'greenhouse',
  'ashby',
  'lever',
  'smartrecruiters',
  'workable',
  'recruitee',
  'rippling',
  'pinpoint',
  'workday',
  'oracle_hcm',
  'personio',
  'teamtailor',
]);

export function resolveOffsiteAtsUrls(jobs = []) {
  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    const blob = [job.apply_url || '', job.description_html || '', job.description_text || ''].join('\n');
    const matches = detectAllAtsFromText(blob);
    const preferred = matches.find((m) => DIRECT_ATS_TYPES.has(m.type) && m.url);
    if (preferred && (!job.apply_url || PORTAL_DOMAINS.test(job.apply_url))) {
      job.apply_url = preferred.url;
    }
  }
  return jobs;
}

function inferCompanyLabel(job, type, slug) {
  const rawComp = String(job?.company || '').trim();
  if (rawComp && !/^(linkedin|wellfound|naukri|instahyre|cutshort|unknown|simplify|hn)/i.test(rawComp)) {
    return rawComp;
  }
  if (type === 'oracle_hcm' && slug.includes('::')) {
    return slug.split('::')[0].split('.')[0];
  }
  if (type === 'workday') {
    return slug.split('.')[0];
  }
  return slug.split('.')[0].replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function scanJobsForAtsCandidates(db, jobs = [], sourceId = '') {
  const discovered = [];
  for (const job of jobs) {
    if (!job) continue;
    const textBlob = [job.apply_url || '', job.company_url || '', job.description_html || '', job.description_text || ''].join('\n');
    const matches = detectAllAtsFromText(textBlob);
    for (const m of matches) {
      if (job.source_type === m.type) continue;
      const name = inferCompanyLabel(job, m.type, m.slug);
      const res = upsertSourceCandidate(db, {
        name,
        type: m.type,
        boardToken: m.slug,
        url: m.url || job.apply_url || '',
        tier: DIRECT_ATS_TYPES.has(m.type) ? 1 : 2,
        discoveredFrom: sourceId || job.source_id || 'job-scan',
      });
      if (res.inserted && res.candidate) {
        discovered.push(res.candidate);
      }
    }
  }
  return discovered;
}

export async function verifyPendingCandidates(db, { scrapeFn = null, limit = 5 } = {}) {
  const candidates = db
    .prepare("SELECT * FROM source_candidates WHERE status = 'pending' AND last_checked_at IS NULL ORDER BY created_at DESC LIMIT ?")
    .all(limit * 3);

  const promoted = [];
  let checked = 0;
  let resolveAdapter = scrapeFn;

  if (!resolveAdapter) {
    const idx = await import('./index.js');
    resolveAdapter = idx.scrapeBySourceObject;
  }

  for (const cand of candidates) {
    if (checked >= limit) break;
    if (!DIRECT_ATS_TYPES.has(cand.type)) continue;
    checked += 1;
    const now = new Date().toISOString();
    const cfg = buildConfigForAts(cand.type, cand.board_token, cand.url, cand.name);
    const tempSource = {
      id: cand.id,
      name: cand.name,
      type: cand.type,
      tier: cand.tier || 1,
      config: JSON.stringify(cfg),
      enabled: 1,
      db,
    };

    try {
      const fetched = await resolveAdapter(tempSource);
      const valid = Array.isArray(fetched) ? fetched.filter((j) => j && j.title && j.apply_url) : [];
      if (valid.length >= 1) {
        db.prepare(`
          INSERT INTO sources (id, name, type, tier, config, enabled, scrape_interval_mins, last_scraped_at, last_status, jobs_found_last)
          VALUES (?, ?, ?, ?, ?, 1, 45, ?, 'success', ?)
          ON CONFLICT(id) DO UPDATE SET enabled = 1, last_status = 'success', jobs_found_last = excluded.jobs_found_last
        `).run(cand.id, cand.name, cand.type, cand.tier || 1, JSON.stringify(cfg), now, valid.length);
        upsertJobsBatch(db, valid, cand.id);
        db.prepare(`
          UPDATE source_candidates SET status = 'approved', jobs_found = ?, last_checked_at = ? WHERE id = ?
        `).run(valid.length, now, cand.id);
        promoted.push({ id: cand.id, name: cand.name, type: cand.type, jobsFound: valid.length });
      } else {
        db.prepare('UPDATE source_candidates SET last_checked_at = ?, jobs_found = 0 WHERE id = ?').run(now, cand.id);
      }
    } catch {
      db.prepare('UPDATE source_candidates SET last_checked_at = ? WHERE id = ?').run(now, cand.id);
    }
  }

  return promoted;
}
