import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initDb,
  getProfile,
  updateProfile,
  queryJobs,
  getJobById,
  updateJobStatus,
  getAnalytics,
  getSourcesHealth,
  getSourceCandidates,
  updateSourceCandidateStatus,
  buildConfigForAts,
  getSetting,
  upsertJobsBatch,
  syncFresherProfileAndReclassify,
} from './db.js';
import { parseResumeText, generateJobTailoring } from './matcher.js';
import { seedDefaultSources, hydrateSourceRow } from './scrapers/index.js';
import { normalizeJobPayload } from './scrapers/normalize.js';
import { discoverCareerPage } from './scrapers/fingerprinter.js';
import { resolveOffsiteAtsUrls, scanJobsForAtsCandidates } from './scrapers/autodiscover.js';
import { parseJobAlertEmail } from './importer.js';
import { ScrapeScheduler } from './scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const RESEARCH_DOC_PATH = path.join(ROOT_DIR, 'docs', 'SCRAPING_RESEARCH.md');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJson(res, status, data, extraHeaders = {}) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function isLocalhostReq(req) {
  const remote = req.socket?.remoteAddress || '';
  const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (!isLoopback) return false;
  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  if (origin.startsWith('chrome-extension://')) return true;
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin);
}

function getIngestCorsHeaders(req) {
  const origin = String(req.headers.origin || '');
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, X-Jobby-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}

function verifySecretToken(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function readRawBody(req, maxBytes = 5 * 1024 * 1024) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      throw new Error('Request payload too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req) {
  const raw = (await readRawBody(req, 2 * 1024 * 1024)).trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

export function createApp({ dbPath } = {}) {
  const db = initDb(dbPath);
  seedDefaultSources(db);
  const needsUpgrade = db
    .prepare("SELECT COUNT(*) AS c FROM jobs WHERE is_active = 1 AND (match_breakdown NOT LIKE '%locationTier%' OR match_breakdown NOT LIKE '%roleCategory%' OR salary_min IS NULL)")
    .get();
  if ((needsUpgrade?.c ?? 0) > 0) {
    syncFresherProfileAndReclassify(db);
  }
  const scheduler = new ScrapeScheduler(db);
  const sseClients = new Set();

  function broadcastSse(evt) {
    const line = `data: ${JSON.stringify(evt)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(line);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  scheduler.on('event', broadcastSse);

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = reqUrl.pathname;
    const method = req.method || 'GET';

    try {
      // SSE Live Events Stream
      if (method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({ type: 'connected', data: scheduler.getStatus() })}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      // Jobs Query & Faceted Search
      if (method === 'GET' && pathname === '/api/jobs') {
        const sp = reqUrl.searchParams;
        const result = queryJobs(db, {
          q: sp.get('q') || '',
          minScore: Number(sp.get('minScore') || 0),
          workMode: sp.get('workMode') || '',
          seniority: sp.get('seniority') ?? 'intern,junior',
          roleCategory: sp.get('roleCategory') ?? 'tech',
          locationPriority: sp.get('locationPriority') || '',
          sourceType: sp.get('sourceType') || '',
          sourceId: sp.get('sourceId') || '',
          company: sp.get('company') || '',
          skills: sp.get('skills') || '',
          minSalary: Number(sp.get('minSalary') || 0),
          status: sp.get('status') || '',
          maxAgeDays: Number(sp.get('maxAgeDays') || 0),
          visaOnly: sp.get('visaOnly') === 'true' || sp.get('visaOnly') === '1',
          hasSalaryOnly: sp.get('hasSalaryOnly') === 'true' || sp.get('hasSalaryOnly') === '1',
          hideDismissed: sp.get('hideDismissed') !== 'false',
          sortBy: sp.get('sortBy') || 'match',
          limit: Number(sp.get('limit') || 40),
          offset: Number(sp.get('offset') || 0),
        });
        return sendJson(res, 200, result);
      }

      // Single Job Detail + Live Tailoring Kit
      const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(pathname);
      if (jobMatch) {
        const jobId = decodeURIComponent(jobMatch[1]);
        if (method === 'GET') {
          const job = getJobById(db, jobId);
          if (!job) return sendJson(res, 404, { error: 'Job not found' });
          const profile = getProfile(db);
          const tailoring = generateJobTailoring(job, profile);
          return sendJson(res, 200, { job, tailoring });
        }
        if (method === 'PATCH') {
          const body = await readJsonBody(req);
          const updated = updateJobStatus(db, jobId, {
            status: body.status,
            user_notes: body.user_notes,
          });
          if (!updated) return sendJson(res, 404, { error: 'Job not found' });
          return sendJson(res, 200, { job: updated });
        }
      }

      // Profile Endpoints
      if (pathname === '/api/profile') {
        if (method === 'GET') {
          return sendJson(res, 200, { profile: getProfile(db) });
        }
        if (method === 'PUT') {
          const body = await readJsonBody(req);
          const updated = updateProfile(db, body);
          return sendJson(res, 200, { profile: updated });
        }
      }

      if (method === 'POST' && pathname === '/api/profile/parse-resume') {
        const body = await readJsonBody(req);
        const extracted = parseResumeText(body.resume_text || '');
        return sendJson(res, 200, { extracted });
      }

      if (method === 'OPTIONS' && pathname.startsWith('/api/ingest')) {
        if (!isLocalhostReq(req)) {
          return sendJson(res, 403, { error: 'Forbidden' });
        }
        res.writeHead(204, getIngestCorsHeaders(req));
        res.end();
        return;
      }

      if (method === 'GET' && pathname === '/api/ingest/config') {
        if (!isLocalhostReq(req)) {
          return sendJson(res, 403, { error: 'Forbidden' });
        }
        return sendJson(res, 200, { ingestToken: getSetting(db, 'ingest_token', '') }, getIngestCorsHeaders(req));
      }

      if (method === 'POST' && pathname === '/api/ingest') {
        const corsHeaders = getIngestCorsHeaders(req);
        if (!isLocalhostReq(req)) {
          return sendJson(res, 403, { error: 'Forbidden' }, corsHeaders);
        }
        const expectedToken = getSetting(db, 'ingest_token', '');
        const providedToken = req.headers['x-jobby-token'] || '';
        if (!verifySecretToken(providedToken, expectedToken)) {
          return sendJson(res, 401, { error: 'Unauthorized ingest token' }, corsHeaders);
        }

        const body = await readJsonBody(req);
        const rawTag = String(body.sourceTag || body.source || 'browser_ext')
          .toLowerCase()
          .replace(/[^a-z0-9_]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 32) || 'browser_ext';
        const sourceId = rawTag.startsWith('ext-') ? rawTag : `ext-${rawTag.replace(/_/g, '-')}`;
        const rawJobs = Array.isArray(body.jobs) ? body.jobs : [];
        if (rawJobs.length === 0) {
          return sendJson(res, 400, { error: 'jobs array is required' }, corsHeaders);
        }

        db.prepare(`
          INSERT OR IGNORE INTO sources (id, name, type, tier, config, enabled, scrape_interval_mins)
          VALUES (?, ?, ?, 2, '{}', 1, 60)
        `).run(sourceId, `Extension (${rawTag})`, rawTag);

        const normalized = rawJobs
          .filter((item) => item && typeof item === 'object' && String(item.title || '').trim())
          .map((item) =>
            normalizeJobPayload({
              sourceId,
              sourceType: rawTag,
              externalId: item.externalId || item.id || item.applyUrl || item.url || `${item.company || 'unknown'}-${item.title}`,
              title: String(item.title).trim(),
              company: String(item.company || 'Unknown').trim(),
              location: String(item.location || 'India').trim(),
              explicitRemote: item.explicitRemote,
              employmentType: item.employmentType || '',
              descriptionHtml: item.descriptionHtml || '',
              descriptionText: item.descriptionText || '',
              structuredSalary: item.structuredSalary || null,
              applyUrl: item.applyUrl || item.url || body.pageUrl || '',
              companyUrl: item.companyUrl || '',
              postedAt: item.postedAt || null,
            })
          );

        resolveOffsiteAtsUrls(normalized);
        const stats = upsertJobsBatch(db, normalized, sourceId);
        scanJobsForAtsCandidates(db, normalized, sourceId);
        db.prepare(`
          UPDATE sources
          SET last_scraped_at = ?, last_status = 'ok', jobs_found_last = ?,
              total_active_jobs = (SELECT COUNT(*) FROM jobs WHERE source_id = ? AND is_active = 1)
          WHERE id = ?
        `).run(new Date().toISOString(), normalized.length, sourceId, sourceId);

        broadcastSse({
          type: 'ingest:complete',
          sourceId,
          sourceTag: rawTag,
          received: normalized.length,
          newCount: stats.newCount,
          updatedCount: stats.updatedCount,
        });

        return sendJson(
          res,
          200,
          {
            ok: true,
            sourceId,
            received: normalized.length,
            count: normalized.length,
            newCount: stats.newCount,
            updatedCount: stats.updatedCount,
          },
          corsHeaders
        );
      }

      if (method === 'POST' && pathname === '/api/import/url') {
        const body = await readJsonBody(req);
        const targetUrl = String(body.url || '').trim();
        if (!targetUrl) {
          return sendJson(res, 400, { error: 'url is required' });
        }
        const discovery = await discoverCareerPage(targetUrl);
        if (discovery.detectedAts) {
          const { type, slug } = discovery.detectedAts;
          const companyName =
            body.name?.trim() ||
            slug.split('.')[0].replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
          const sourceId = `${type}-${slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48)}`;
          const cfg = buildConfigForAts(type, slug, discovery.targetUrl, companyName);
          db.prepare(`
            INSERT INTO sources (id, name, type, tier, config, enabled, scrape_interval_mins)
            VALUES (?, ?, ?, 1, ?, 1, 30)
            ON CONFLICT(id) DO UPDATE SET enabled = 1, config = excluded.config
          `).run(sourceId, companyName, type, JSON.stringify(cfg));
          const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId);
          const scrapeResult = await scheduler.triggerScrape({ mode: 'source', sourceId });
          return sendJson(res, 200, {
            ok: true,
            outcome: 'ats_detected',
            detectedAts: discovery.detectedAts,
            source: hydrateSourceRow(row),
            scrapeResult,
          });
        }
        if (discovery.jsonLdJobs.length > 0) {
          const hostname = new URL(discovery.targetUrl).hostname.replace(/^www\./, '');
          const sourceId = `custom-${hostname.replace(/[^a-z0-9]+/g, '-')}`;
          db.prepare(`
            INSERT INTO sources (id, name, type, tier, config, enabled, scrape_interval_mins)
            VALUES (?, ?, 'custom', 3, ?, 1, 60)
            ON CONFLICT(id) DO UPDATE SET enabled = 1
          `).run(sourceId, body.name?.trim() || hostname, JSON.stringify({ url: discovery.targetUrl, companyName: hostname }));
          const jobs = discovery.jsonLdJobs.map((j) => ({ ...j, source_id: sourceId }));
          resolveOffsiteAtsUrls(jobs);
          const stats = upsertJobsBatch(db, jobs, sourceId);
          scanJobsForAtsCandidates(db, jobs, sourceId);
          db.prepare(`
            UPDATE sources
            SET last_scraped_at = ?, last_status = 'success', jobs_found_last = ?,
                total_active_jobs = (SELECT COUNT(*) FROM jobs WHERE source_id = ? AND is_active = 1)
            WHERE id = ?
          `).run(new Date().toISOString(), jobs.length, sourceId, sourceId);
          broadcastSse({ type: 'import:complete', sourceId, jobsFound: jobs.length, ...stats });
          return sendJson(res, 200, {
            ok: true,
            outcome: 'json_ld_ingested',
            targetUrl: discovery.targetUrl,
            sourceId,
            jobsFound: jobs.length,
            ...stats,
          });
        }
        return sendJson(res, 200, {
          ok: false,
          outcome: 'not_detected',
          targetUrl: discovery.targetUrl,
          message: 'Could not detect ATS endpoint or Schema.org JobPosting JSON-LD on that page.',
        });
      }

      if (method === 'POST' && pathname === '/api/import/eml') {
        const contentType = String(req.headers['content-type'] || '').toLowerCase();
        const rawBody = await readRawBody(req, 5 * 1024 * 1024);
        let emailText = rawBody;
        if (contentType.includes('application/json')) {
          const parsed = JSON.parse(rawBody || '{}');
          emailText = String(parsed.content || parsed.eml || '');
        }
        if (!emailText || !emailText.trim()) {
          return sendJson(res, 400, { error: 'Non-empty .eml or mbox content is required' });
        }
        const sourceId = 'email-import';
        const jobs = parseJobAlertEmail(emailText, { sourceId });
        db.prepare(`
          INSERT OR IGNORE INTO sources (id, name, type, tier, config, enabled, scrape_interval_mins)
          VALUES (?, 'Email Alerts (.eml / mbox)', 'email_import', 2, '{}', 1, 60)
        `).run(sourceId);
        resolveOffsiteAtsUrls(jobs);
        const stats = upsertJobsBatch(db, jobs, sourceId);
        scanJobsForAtsCandidates(db, jobs, sourceId);
        db.prepare(`
          UPDATE sources
          SET last_scraped_at = ?, last_status = 'success', jobs_found_last = ?,
              total_active_jobs = (SELECT COUNT(*) FROM jobs WHERE source_id = ? AND is_active = 1)
          WHERE id = ?
        `).run(new Date().toISOString(), jobs.length, sourceId, sourceId);
        broadcastSse({ type: 'import:complete', sourceId, parsedCount: jobs.length, ...stats });
        return sendJson(res, 200, {
          ok: true,
          sourceId,
          parsedCount: jobs.length,
          ...stats,
        });
      }

      if (pathname === '/api/sources') {
        if (method === 'GET') {
          const rows = db.prepare('SELECT * FROM sources ORDER BY tier ASC, total_active_jobs DESC, name ASC').all();
          return sendJson(res, 200, { sources: rows.map(hydrateSourceRow) });
        }
        if (method === 'POST') {
          const body = await readJsonBody(req);
          const type = String(body.type || '').trim().toLowerCase();
          const name = String(body.name || '').trim();
          const slug = String(body.slug || '').trim();
          const url = String(body.url || '').trim();
          if (!type || !name || (!slug && !url)) {
            return sendJson(res, 400, { error: 'name, type, and slug (or url) are required' });
          }
          const cleanId = `${type}-${(slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;
          const config = {
            slug,
            url,
            companyName: body.companyName || name,
          };
          const tier = ['greenhouse', 'ashby', 'lever', 'smartrecruiters', 'workable', 'recruitee', 'rippling', 'pinpoint'].includes(type) ? 1 : type === 'simplify' ? 2 : 3;
          db.prepare(`
            INSERT INTO sources (id, name, type, tier, config, enabled, scrape_interval_mins)
            VALUES (?, ?, ?, ?, ?, 1, 30)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, config = excluded.config, enabled = 1
          `).run(cleanId, name, type, tier, JSON.stringify(config));

          const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(cleanId);
          // Optionally scrape immediately in background
          if (body.scrapeNow !== false) {
            scheduler.triggerScrape({ mode: 'source', sourceId: cleanId }).catch(() => {});
          }
          return sendJson(res, 201, { source: hydrateSourceRow(row) });
        }
      }

      if (method === 'POST' && pathname === '/api/sources/discover') {
        const body = await readJsonBody(req);
        const targetUrl = String(body.url || '').trim();
        const discovery = await discoverCareerPage(targetUrl);

        if (discovery.detectedAts) {
          const { type, slug } = discovery.detectedAts;
          const companyName =
            body.name?.trim() ||
            slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
          const sourceId = `${type}-${slug.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
          db.prepare(`
            INSERT INTO sources (id, name, type, tier, config, enabled, scrape_interval_mins)
            VALUES (?, ?, ?, 1, ?, 1, 30)
            ON CONFLICT(id) DO UPDATE SET enabled = 1
          `).run(sourceId, companyName, type, JSON.stringify({ slug, companyName }));
          const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId);
          const scrapeResult = await scheduler.triggerScrape({ mode: 'source', sourceId });
          return sendJson(res, 200, {
            outcome: 'ats_detected',
            detectedAts: discovery.detectedAts,
            source: hydrateSourceRow(row),
            scrapeResult,
          });
        }

        if (discovery.jsonLdJobs.length > 0) {
          const hostname = new URL(discovery.targetUrl).hostname.replace(/^www\./, '');
          const sourceId = `custom-${hostname.replace(/[^a-z0-9]+/g, '-')}`;
          db.prepare(`
            INSERT INTO sources (id, name, type, tier, config, enabled, scrape_interval_mins)
            VALUES (?, ?, 'custom', 3, ?, 1, 60)
            ON CONFLICT(id) DO UPDATE SET enabled = 1
          `).run(sourceId, body.name?.trim() || hostname, JSON.stringify({ url: discovery.targetUrl, companyName: hostname }));
          const scrapeResult = await scheduler.triggerScrape({ mode: 'source', sourceId });
          return sendJson(res, 200, {
            outcome: 'json_ld_detected',
            targetUrl: discovery.targetUrl,
            jobsFound: discovery.jsonLdJobs.length,
            scrapeResult,
          });
        }

        return sendJson(res, 200, {
          outcome: 'not_detected',
          targetUrl: discovery.targetUrl,
          message:
            'Could not automatically fingerprint Greenhouse, Ashby, Lever, Workable, SmartRecruiters, Recruitee, Rippling, Pinpoint, or Schema.org JobPosting JSON-LD on that page. Try entering the direct ATS slug manually.',
        });
      }

      if (method === 'GET' && pathname === '/api/sources/health') {
        return sendJson(res, 200, { health: getSourcesHealth(db) });
      }

      if (method === 'GET' && pathname === '/api/sources/candidates') {
        const statusFilter = reqUrl.searchParams.get('status') || null;
        return sendJson(res, 200, { candidates: getSourceCandidates(db, statusFilter) });
      }

      const candidateMatch = /^\/api\/sources\/candidates\/([^/]+)$/.exec(pathname);
      if (candidateMatch && method === 'PATCH') {
        const candidateId = decodeURIComponent(candidateMatch[1]);
        const body = await readJsonBody(req);
        const action = String(body.action || '').trim().toLowerCase();
        if (action !== 'approve' && action !== 'disable') {
          return sendJson(res, 400, { error: 'action must be approve or disable' });
        }
        const updated = updateSourceCandidateStatus(db, candidateId, action);
        if (!updated) return sendJson(res, 404, { error: 'Candidate not found' });
        if (action === 'approve' && body.scrapeNow !== false) {
          scheduler.triggerScrape({ mode: 'source', sourceId: updated.id }).catch(() => {});
        }
        return sendJson(res, 200, { candidate: updated });
      }

      const sourceMatch = /^\/api\/sources\/([^/]+)$/.exec(pathname);
      if (sourceMatch) {
        const sourceId = decodeURIComponent(sourceMatch[1]);
        if (method === 'PATCH') {
          const body = await readJsonBody(req);
          const existing = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId);
          if (!existing) return sendJson(res, 404, { error: 'Source not found' });
          if (body.enabled !== undefined) {
            db.prepare('UPDATE sources SET enabled = ? WHERE id = ?').run(body.enabled ? 1 : 0, sourceId);
          }
          if (body.scrape_interval_mins !== undefined) {
            db.prepare('UPDATE sources SET scrape_interval_mins = ? WHERE id = ?').run(
              Math.max(5, Number(body.scrape_interval_mins) || 30),
              sourceId
            );
          }
          const updated = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId);
          return sendJson(res, 200, { source: hydrateSourceRow(updated) });
        }
        if (method === 'DELETE') {
          db.prepare('DELETE FROM jobs_fts WHERE job_id IN (SELECT id FROM jobs WHERE source_id = ?)').run(sourceId);
          db.prepare('DELETE FROM jobs WHERE source_id = ?').run(sourceId);
          db.prepare('DELETE FROM sources WHERE id = ?').run(sourceId);
          return sendJson(res, 200, { deleted: sourceId });
        }
      }

      // Scraper Control Endpoints
      if (method === 'POST' && pathname === '/api/scrape/run') {
        const body = await readJsonBody(req);
        const mode = body.mode || 'all';
        const sourceId = body.sourceId || null;

        if (scheduler.isRunning) {
          return sendJson(res, 202, { status: 'already_running', currentRun: scheduler.currentRun });
        }

        // Launch asynchronously so HTTP request returns immediately and SSE streams progress
        const runPromise = scheduler.triggerScrape({ mode, sourceId });
        if (body.wait) {
          const result = await runPromise;
          return sendJson(res, 200, result);
        }
        runPromise.catch((err) => console.error('[Scrape Run Error]', err.message));
        return sendJson(res, 202, { status: 'started', mode, sourceId });
      }

      if (method === 'GET' && pathname === '/api/scrape/status') {
        return sendJson(res, 200, scheduler.getStatus());
      }

      if (method === 'PUT' && pathname === '/api/scrape/schedule') {
        const body = await readJsonBody(req);
        const cfg = scheduler.updateConfig({
          enabled: body.enabled,
          intervalMins: body.intervalMins,
        });
        return sendJson(res, 200, cfg);
      }

      // Analytics & Research Endpoints
      if (method === 'GET' && pathname === '/api/analytics') {
        return sendJson(res, 200, getAnalytics(db));
      }

      if (method === 'GET' && pathname === '/api/research') {
        const content = fs.existsSync(RESEARCH_DOC_PATH) ? fs.readFileSync(RESEARCH_DOC_PATH, 'utf8') : '';
        return sendJson(res, 200, { markdown: content });
      }

      if (method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
      }

      // Static Frontend Serving
      if (method === 'GET' && !pathname.startsWith('/api/')) {
        const safeRel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const filePath = path.resolve(PUBLIC_DIR, safeRel);
        if (!filePath.startsWith(PUBLIC_DIR)) {
          res.writeHead(403);
          return res.end('Forbidden');
        }
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath).toLowerCase();
          res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
          return fs.createReadStream(filePath).pipe(res);
        }
        // Fallback to index.html for SPA paths
        const indexPath = path.join(PUBLIC_DIR, 'index.html');
        if (fs.existsSync(indexPath)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return fs.createReadStream(indexPath).pipe(res);
        }
      }

      return sendJson(res, 404, { error: 'Route not found' });
    } catch (err) {
      console.error(`[HTTP Error] ${method} ${pathname}:`, err);
      return sendJson(res, 500, { error: err.message || 'Internal Server Error' });
    }
  });

  return { db, scheduler, server };
}

// CLI Entrypoint
const isDirectMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectMain) {
  const args = process.argv.slice(2);
  if (args.includes('--scrape-once')) {
    const { db, scheduler } = createApp();
    console.log('🚀 Jobby: Starting one-shot multi-tier scrape across all enabled sources...');
    const summary = await scheduler.triggerScrape({ mode: 'all' });
    const stats = queryJobs(db, { limit: 1 }).stats;
    console.log('\n✅ Scrape Complete:');
    console.log(`   Sources Attempted: ${summary.total}`);
    console.log(`   Succeeded: ${summary.succeeded} | Failed: ${summary.failed}`);
    console.log(`   Fetched Jobs: ${summary.fetchedTotal}`);
    console.log(`   New Jobs Added: ${summary.newJobs} | Updated: ${summary.updatedJobs}`);
    console.log(`   Total Active Jobs in DB: ${stats.totalActive} (80%+ Matches: ${stats.highMatchCount})`);
    const failedList = (summary.results || []).filter((r) => r.status === 'error');
    if (failedList.length > 0) {
      console.log('\n⚠️  Source errors:');
      for (const f of failedList.slice(0, 10)) {
        console.log(`   - ${f.name} (${f.type}): ${f.error}`);
      }
    }
    db.close();
    process.exit(0);
  } else {
    const port = Number(process.env.PORT || 3456);
    const { db, scheduler, server } = createApp();
    scheduler.startDaemon();

    server.listen(port, '127.0.0.1', () => {
      console.log(`\n⚡ Jobby Job Board running at http://127.0.0.1:${port}`);
      const countRow = db.prepare('SELECT COUNT(*) AS c FROM jobs WHERE is_active = 1').get();
      if ((countRow?.c ?? 0) === 0 && process.env.JOBBY_NO_AUTO_SCRAPE !== '1') {
        console.log('📡 Database is empty — kicking off initial multi-source scrape in background...');
        scheduler.triggerScrape({ mode: 'all' }).catch((err) => {
          console.error('[Initial Scrape Error]', err.message);
        });
      }
    });
  }
}
