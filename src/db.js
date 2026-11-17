import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { scoreJobAgainstProfile } from './matcher.js';
import { extractExperience, extractWorkMode, extractSalary, estimateStipendBenchmark } from './nlp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.resolve(__dirname, '..', 'data', 'jobby.db');

function safeJsonParse(str, fallback) {
  if (!str) return fallback;
  if (typeof str !== 'string') return str;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

export function initDb(dbPath = process.env.JOBBY_DB_PATH || DEFAULT_DB_PATH) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL DEFAULT 'Abhay',
      headline TEXT NOT NULL DEFAULT 'Full-Stack & AI Systems Engineer',
      resume_text TEXT NOT NULL DEFAULT '',
      target_titles TEXT NOT NULL DEFAULT '[]',
      primary_skills TEXT NOT NULL DEFAULT '[]',
      secondary_skills TEXT NOT NULL DEFAULT '[]',
      excluded_skills TEXT NOT NULL DEFAULT '[]',
      excluded_companies TEXT NOT NULL DEFAULT '[]',
      target_companies TEXT NOT NULL DEFAULT '[]',
      experience_years REAL NOT NULL DEFAULT 4,
      preferred_seniority TEXT NOT NULL DEFAULT '[]',
      work_modes TEXT NOT NULL DEFAULT '[]',
      preferred_locations TEXT NOT NULL DEFAULT '[]',
      min_salary INTEGER NOT NULL DEFAULT 120000,
      require_visa INTEGER NOT NULL DEFAULT 0,
      weights TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      tier INTEGER NOT NULL DEFAULT 1,
      config TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      scrape_interval_mins INTEGER NOT NULL DEFAULT 30,
      last_scraped_at TEXT,
      last_status TEXT DEFAULT 'pending',
      last_error TEXT DEFAULT '',
      last_duration_ms INTEGER DEFAULT 0,
      jobs_found_last INTEGER DEFAULT 0,
      total_active_jobs INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      dedupe_hash TEXT UNIQUE NOT NULL,
      external_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      title TEXT NOT NULL,
      company TEXT NOT NULL,
      company_logo TEXT DEFAULT '',
      department TEXT DEFAULT '',
      location TEXT DEFAULT '',
      work_mode TEXT DEFAULT 'unknown',
      seniority TEXT DEFAULT 'unknown',
      employment_type TEXT DEFAULT 'Full-Time',
      experience_min INTEGER,
      experience_max INTEGER,
      salary_min INTEGER,
      salary_max INTEGER,
      salary_currency TEXT DEFAULT 'USD',
      salary_period TEXT DEFAULT 'year',
      salary_raw TEXT DEFAULT '',
      is_salary_estimated INTEGER DEFAULT 0,
      description_html TEXT DEFAULT '',
      description_text TEXT DEFAULT '',
      skills TEXT NOT NULL DEFAULT '[]',
      green_flags TEXT NOT NULL DEFAULT '[]',
      red_flags TEXT NOT NULL DEFAULT '[]',
      visa_sponsorship INTEGER DEFAULT 0,
      apply_url TEXT NOT NULL,
      company_url TEXT DEFAULT '',
      posted_at TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      match_score INTEGER NOT NULL DEFAULT 0,
      match_breakdown TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'new',
      user_notes TEXT NOT NULL DEFAULT '',
      applied_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_score ON jobs(match_score DESC, posted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source_id, is_active);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, is_active);
    CREATE INDEX IF NOT EXISTS idx_jobs_work_mode ON jobs(work_mode);
    CREATE INDEX IF NOT EXISTS idx_jobs_seniority ON jobs(seniority);
    CREATE INDEX IF NOT EXISTS idx_jobs_posted_at ON jobs(posted_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5(
      job_id UNINDEXED,
      title,
      company,
      location,
      skills_text,
      description_text
    );

    CREATE TABLE IF NOT EXISTS scrape_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      fetched_count INTEGER NOT NULL DEFAULT 0,
      new_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS http_cache (
      url TEXT PRIMARY KEY,
      etag TEXT DEFAULT '',
      last_modified TEXT DEFAULT '',
      body TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_health (
      source_id TEXT PRIMARY KEY,
      last_ok_at TEXT,
      last_error TEXT DEFAULT '',
      error_streak INTEGER NOT NULL DEFAULT 0,
      jobs_last_run INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);

  // Seed default profile if empty
  const existingProfile = db.prepare('SELECT id FROM profile WHERE id = 1').get();
  if (!existingProfile) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO profile (
        id, name, headline, resume_text, target_titles, primary_skills, secondary_skills,
        excluded_skills, excluded_companies, target_companies, experience_years,
        preferred_seniority, work_modes, preferred_locations, min_salary, require_visa,
        weights, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      1,
      'Final-Year Student Profile',
      'Final-Year CS Student • Intern & Fresher SWE / AI Engineer',
      '',
      JSON.stringify([
        'Software Engineer Intern',
        'Software Engineer',
        'Software Development Engineer',
        'SDE 1',
        'New Grad Software Engineer',
        'Full-Stack Engineer',
        'Backend Engineer',
        'AI Engineer',
      ]),
      JSON.stringify([
        'TypeScript',
        'JavaScript',
        'Python',
        'React',
        'Node.js',
        'Next.js',
        'PostgreSQL',
        'AWS',
        'Docker',
        'LLMs',
      ]),
      JSON.stringify([
        'Go',
        'Kubernetes',
        'Redis',
        'GraphQL',
        'FastAPI',
        'RAG',
        'Distributed Systems',
        'Tailwind CSS',
        'Terraform',
        'Kafka',
      ]),
      JSON.stringify(['PHP', 'WordPress', 'Drupal']),
      JSON.stringify([]),
      JSON.stringify(['Stripe', 'Anthropic', 'OpenAI', 'Linear', 'Vercel', 'Databricks', 'Figma', 'Supabase', 'Razorpay', 'Postman', 'HackerRank', 'Enterpret', 'SingleStore', 'CynLr']),
      0.5,
      JSON.stringify(['intern', 'junior']),
      JSON.stringify(['remote', 'hybrid', 'onsite']),
      JSON.stringify(['Bangalore', 'Bengaluru', 'Remote', 'India']),
      0,
      0,
      JSON.stringify({ title: 30, skills: 35, location: 15, salary: 10, experience: 10 }),
      now
    );
  }

  // Seed default scheduler settings
  const defaultSettings = {
    scheduler_enabled: 'true',
    scrape_interval_mins: '30',
    ingest_token: crypto.randomBytes(24).toString('hex'),
  };
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaultSettings)) {
    insertSetting.run(k, v);
  }

  return db;
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    String(value)
  );
}

export function getHttpCache(db, url) {
  return db.prepare('SELECT url, etag, last_modified, body, updated_at FROM http_cache WHERE url = ?').get(url) || null;
}

export function setHttpCache(db, { url, etag = '', lastModified = '', body = '' }) {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO http_cache (url, etag, last_modified, body, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified, body = excluded.body, updated_at = excluded.updated_at'
  ).run(url, etag, lastModified, body, now);
}

export function recordSourceHealth(db, { sourceId, ok, error = '', jobsCount = 0, durationMs = 0 }) {
  const now = new Date().toISOString();
  if (ok) {
    db.prepare(`
      INSERT INTO source_health (source_id, last_ok_at, last_error, error_streak, jobs_last_run, duration_ms, updated_at)
      VALUES (?, ?, '', 0, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        last_ok_at = excluded.last_ok_at,
        last_error = '',
        error_streak = 0,
        jobs_last_run = excluded.jobs_last_run,
        duration_ms = excluded.duration_ms,
        updated_at = excluded.updated_at
    `).run(sourceId, now, Number(jobsCount) || 0, Number(durationMs) || 0, now);
    return { sourceId, errorStreak: 0, autoDisabled: false };
  }

  db.prepare(`
    INSERT INTO source_health (source_id, last_ok_at, last_error, error_streak, jobs_last_run, duration_ms, updated_at)
    VALUES (?, NULL, ?, 1, 0, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET
      last_error = excluded.last_error,
      error_streak = source_health.error_streak + 1,
      duration_ms = excluded.duration_ms,
      updated_at = excluded.updated_at
  `).run(sourceId, String(error || '').slice(0, 300), Number(durationMs) || 0, now);

  const row = db.prepare('SELECT error_streak FROM source_health WHERE source_id = ?').get(sourceId);
  const errorStreak = Number(row?.error_streak ?? 1);
  let autoDisabled = false;
  if (errorStreak >= 5) {
    const upd = db.prepare('UPDATE sources SET enabled = 0 WHERE id = ? AND enabled = 1').run(sourceId);
    autoDisabled = Number(upd?.changes ?? 0) > 0;
  }
  return { sourceId, errorStreak, autoDisabled };
}

export function getSourcesHealth(db) {
  return db
    .prepare(`
      SELECT
        s.id,
        s.name,
        s.type,
        s.tier,
        s.enabled,
        COALESCE(h.last_ok_at, CASE WHEN s.last_status = 'success' THEN s.last_scraped_at ELSE NULL END) AS last_ok_at,
        COALESCE(NULLIF(h.last_error, ''), s.last_error, '') AS last_error,
        COALESCE(h.error_streak, 0) AS error_streak,
        COALESCE(h.jobs_last_run, s.jobs_found_last, 0) AS jobs_last_run,
        COALESCE(h.duration_ms, s.last_duration_ms, 0) AS duration_ms,
        COALESCE(h.updated_at, s.last_scraped_at) AS updated_at
      FROM sources s
      LEFT JOIN source_health h ON h.source_id = s.id
      ORDER BY COALESCE(h.error_streak, 0) DESC, s.enabled ASC, s.tier ASC, s.name ASC
    `)
    .all();
}

export function getProfile(db) {
  const row = db.prepare('SELECT * FROM profile WHERE id = 1').get();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    headline: row.headline,
    resume_text: row.resume_text,
    target_titles: safeJsonParse(row.target_titles, []),
    primary_skills: safeJsonParse(row.primary_skills, []),
    secondary_skills: safeJsonParse(row.secondary_skills, []),
    excluded_skills: safeJsonParse(row.excluded_skills, []),
    excluded_companies: safeJsonParse(row.excluded_companies, []),
    target_companies: safeJsonParse(row.target_companies, []),
    experience_years: Number(row.experience_years ?? 4),
    preferred_seniority: safeJsonParse(row.preferred_seniority, []),
    work_modes: safeJsonParse(row.work_modes, []),
    preferred_locations: safeJsonParse(row.preferred_locations, []),
    min_salary: Number(row.min_salary ?? 0),
    require_visa: Boolean(row.require_visa),
    weights: safeJsonParse(row.weights, { title: 30, skills: 35, location: 15, salary: 10, experience: 10 }),
    updated_at: row.updated_at,
  };
}

export function updateProfile(db, input) {
  const current = getProfile(db);
  const merged = {
    name: input.name ?? current.name,
    headline: input.headline ?? current.headline,
    resume_text: input.resume_text ?? current.resume_text,
    target_titles: Array.isArray(input.target_titles) ? input.target_titles : current.target_titles,
    primary_skills: Array.isArray(input.primary_skills) ? input.primary_skills : current.primary_skills,
    secondary_skills: Array.isArray(input.secondary_skills) ? input.secondary_skills : current.secondary_skills,
    excluded_skills: Array.isArray(input.excluded_skills) ? input.excluded_skills : current.excluded_skills,
    excluded_companies: Array.isArray(input.excluded_companies) ? input.excluded_companies : current.excluded_companies,
    target_companies: Array.isArray(input.target_companies) ? input.target_companies : current.target_companies,
    experience_years: input.experience_years !== undefined ? Number(input.experience_years) : current.experience_years,
    preferred_seniority: Array.isArray(input.preferred_seniority) ? input.preferred_seniority : current.preferred_seniority,
    work_modes: Array.isArray(input.work_modes) ? input.work_modes : current.work_modes,
    preferred_locations: Array.isArray(input.preferred_locations) ? input.preferred_locations : current.preferred_locations,
    min_salary: input.min_salary !== undefined ? Number(input.min_salary) : current.min_salary,
    require_visa: input.require_visa !== undefined ? (input.require_visa ? 1 : 0) : current.require_visa ? 1 : 0,
    weights: input.weights && typeof input.weights === 'object' ? input.weights : current.weights,
    updated_at: new Date().toISOString(),
  };

  db.prepare(`
    UPDATE profile SET
      name = ?, headline = ?, resume_text = ?, target_titles = ?, primary_skills = ?,
      secondary_skills = ?, excluded_skills = ?, excluded_companies = ?, target_companies = ?,
      experience_years = ?, preferred_seniority = ?, work_modes = ?, preferred_locations = ?,
      min_salary = ?, require_visa = ?, weights = ?, updated_at = ?
    WHERE id = 1
  `).run(
    merged.name,
    merged.headline,
    merged.resume_text,
    JSON.stringify(merged.target_titles),
    JSON.stringify(merged.primary_skills),
    JSON.stringify(merged.secondary_skills),
    JSON.stringify(merged.excluded_skills),
    JSON.stringify(merged.excluded_companies),
    JSON.stringify(merged.target_companies),
    merged.experience_years,
    JSON.stringify(merged.preferred_seniority),
    JSON.stringify(merged.work_modes),
    JSON.stringify(merged.preferred_locations),
    merged.min_salary,
    merged.require_visa,
    JSON.stringify(merged.weights),
    merged.updated_at
  );

  recalculateAllJobScores(db);
  return getProfile(db);
}

export function recalculateAllJobScores(db) {
  const profile = getProfile(db);
  const rows = db
    .prepare(
      'SELECT id, title, company, department, location, work_mode, seniority, experience_min, salary_min, salary_max, skills, description_text, visa_sponsorship FROM jobs WHERE is_active = 1'
    )
    .all();

  const updateStmt = db.prepare('UPDATE jobs SET match_score = ?, match_breakdown = ? WHERE id = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const jobObj = {
        ...row,
        skills: safeJsonParse(row.skills, []),
        visa_sponsorship: Boolean(row.visa_sponsorship),
      };
      const scored = scoreJobAgainstProfile(jobObj, profile);
      updateStmt.run(scored.score, JSON.stringify(scored.breakdown), row.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return rows.length;
}

export function syncFresherProfileAndReclassify(db) {
  const current = getProfile(db);
  if (
    current &&
    current.name === 'Candidate Profile' &&
    Number(current.experience_years) === 4 &&
    !current.resume_text
  ) {
    db.prepare(`
      UPDATE profile SET
        name = ?, headline = ?, target_titles = ?, target_companies = ?,
        experience_years = ?, preferred_seniority = ?, work_modes = ?,
        preferred_locations = ?, min_salary = ?, updated_at = ?
      WHERE id = 1
    `).run(
      'Final-Year Student Profile',
      'Final-Year CS Student • Intern & Fresher SWE / AI Engineer',
      JSON.stringify([
        'Software Engineer Intern',
        'Software Engineer',
        'Software Development Engineer',
        'SDE 1',
        'New Grad Software Engineer',
        'Full-Stack Engineer',
        'Backend Engineer',
        'AI Engineer',
      ]),
      JSON.stringify(['Stripe', 'Anthropic', 'OpenAI', 'Linear', 'Vercel', 'Databricks', 'Figma', 'Supabase', 'Razorpay', 'Postman', 'HackerRank', 'Enterpret', 'SingleStore', 'CynLr']),
      0.5,
      JSON.stringify(['intern', 'junior']),
      JSON.stringify(['remote', 'hybrid', 'onsite']),
      JSON.stringify(['Bangalore', 'Bengaluru', 'Remote', 'India']),
      0,
      new Date().toISOString()
    );
  }

  const profile = getProfile(db);
  const rows = db
    .prepare(
      'SELECT id, source_type, title, company, department, location, work_mode, seniority, experience_min, experience_max, salary_min, salary_max, salary_currency, salary_period, salary_raw, is_salary_estimated, skills, description_text, visa_sponsorship FROM jobs WHERE is_active = 1'
    )
    .all();

  const updateStmt = db.prepare(
    'UPDATE jobs SET seniority = ?, experience_min = ?, experience_max = ?, work_mode = ?, location = ?, salary_min = ?, salary_max = ?, salary_currency = ?, salary_period = ?, salary_raw = ?, is_salary_estimated = ?, match_score = ?, match_breakdown = ? WHERE id = ?'
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const exp = extractExperience(row.description_text || '', row.title || '');
      const cleanLoc =
        (row.location || '').length > 85
          ? `${row.location.split(/\.\s+|\n/)[0].slice(0, 82).trim()}`
          : row.location;
      const workMode = extractWorkMode(row.description_text || '', cleanLoc || '', row.title || '');

      let sal;
      if (row.salary_min && !row.is_salary_estimated) {
        sal = {
          min: row.salary_min,
          max: row.salary_max || row.salary_min,
          currency: row.salary_currency || 'USD',
          period: row.salary_period || 'year',
          raw: row.salary_raw || '',
          estimated: false,
        };
      } else {
        const extracted = extractSalary(row.description_text || '');
        sal =
          extracted.min !== null
            ? extracted
            : estimateStipendBenchmark({
                title: row.title || '',
                company: row.company || '',
                location: cleanLoc || '',
                workMode,
                seniority: exp.seniority,
                sourceType: row.source_type || '',
              });
      }

      const jobObj = {
        ...row,
        department: row.department || '',
        location: cleanLoc,
        work_mode: workMode,
        seniority: exp.seniority,
        experience_min: exp.min,
        experience_max: exp.max,
        salary_min: sal.min,
        salary_max: sal.max,
        salary_currency: sal.currency,
        salary_period: sal.period,
        salary_raw: sal.raw,
        is_salary_estimated: sal.estimated ? 1 : 0,
        skills: safeJsonParse(row.skills, []),
        visa_sponsorship: Boolean(row.visa_sponsorship),
      };
      const scored = scoreJobAgainstProfile(jobObj, profile);
      updateStmt.run(
        exp.seniority,
        exp.min,
        exp.max,
        workMode,
        cleanLoc,
        sal.min,
        sal.max,
        sal.currency,
        sal.period,
        sal.raw,
        sal.estimated ? 1 : 0,
        scored.score,
        JSON.stringify(scored.breakdown),
        row.id
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return rows.length;
}

export function hydrateJobRow(row, includeDescription = false) {
  if (!row) return null;
  const out = {
    id: row.id,
    dedupe_hash: row.dedupe_hash,
    external_id: row.external_id,
    source_id: row.source_id,
    source_type: row.source_type,
    title: row.title,
    company: row.company,
    company_logo: row.company_logo,
    department: row.department,
    location: row.location,
    work_mode: row.work_mode,
    seniority: row.seniority,
    employment_type: row.employment_type,
    experience_min: row.experience_min,
    experience_max: row.experience_max,
    salary_min: row.salary_min,
    salary_max: row.salary_max,
    salary_currency: row.salary_currency,
    salary_period: row.salary_period,
    salary_raw: row.salary_raw,
    is_salary_estimated: Boolean(row.is_salary_estimated),
    skills: safeJsonParse(row.skills, []),
    green_flags: safeJsonParse(row.green_flags, []),
    red_flags: safeJsonParse(row.red_flags, []),
    visa_sponsorship: Boolean(row.visa_sponsorship),
    apply_url: row.apply_url,
    company_url: row.company_url,
    posted_at: row.posted_at,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    is_active: Boolean(row.is_active),
    match_score: Number(row.match_score ?? 0),
    match_breakdown: safeJsonParse(row.match_breakdown, {}),
    status: row.status,
    user_notes: row.user_notes || '',
    applied_at: row.applied_at,
  };
  if (includeDescription) {
    out.description_html = row.description_html || '';
    out.description_text = row.description_text || '';
  } else {
    const txt = row.description_text || '';
    out.snippet = txt.length > 220 ? `${txt.slice(0, 220).trim()}...` : txt;
  }
  return out;
}

const FULL_SNAPSHOT_ATS = new Set([
  'greenhouse',
  'ashby',
  'lever',
  'workable',
  'recruitee',
  'rippling',
  'pinpoint',
]);

export function upsertJobsBatch(db, normalizedJobs, sourceId) {
  const now = new Date().toISOString();
  const profile = getProfile(db);
  let newCount = 0;
  let updatedCount = 0;
  const seenJobIds = new Set();
  const srcMeta = sourceId ? db.prepare('SELECT tier, type FROM sources WHERE id = ?').get(sourceId) : null;

  const findExisting = db.prepare('SELECT id, status, user_notes, applied_at, first_seen_at FROM jobs WHERE dedupe_hash = ? OR id = ?');
  const insertJob = db.prepare(`
    INSERT INTO jobs (
      id, dedupe_hash, external_id, source_id, source_type, title, company, company_logo,
      department, location, work_mode, seniority, employment_type, experience_min, experience_max,
      salary_min, salary_max, salary_currency, salary_period, salary_raw, is_salary_estimated,
      description_html, description_text, skills, green_flags, red_flags, visa_sponsorship,
      apply_url, company_url, posted_at, first_seen_at, last_seen_at, is_active,
      match_score, match_breakdown, status, user_notes, applied_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'new', '', NULL)
  `);
  const updateJob = db.prepare(`
    UPDATE jobs SET
      external_id = ?, source_id = ?, source_type = ?, title = ?, company = ?, company_logo = ?,
      department = ?, location = ?, work_mode = ?, seniority = ?, employment_type = ?,
      experience_min = ?, experience_max = ?, salary_min = ?, salary_max = ?,
      salary_currency = ?, salary_period = ?, salary_raw = ?, is_salary_estimated = ?,
      description_html = ?, description_text = ?, skills = ?, green_flags = ?, red_flags = ?,
      visa_sponsorship = ?, apply_url = ?, company_url = ?, posted_at = COALESCE(?, posted_at),
      last_seen_at = ?, is_active = 1, match_score = ?, match_breakdown = ?
    WHERE id = ?
  `);
  const deleteFts = db.prepare('DELETE FROM jobs_fts WHERE job_id = ?');
  const insertFts = db.prepare(
    'INSERT INTO jobs_fts (job_id, title, company, location, skills_text, description_text) VALUES (?, ?, ?, ?, ?, ?)'
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const j of normalizedJobs) {
      const scored = scoreJobAgainstProfile(j, profile);
      const existing = findExisting.get(j.dedupe_hash, j.id);
      seenJobIds.add(existing ? existing.id : j.id);
      const skillsJson = JSON.stringify(j.skills || []);
      const skillsText = (j.skills || []).join(' ');

      if (!existing) {
        insertJob.run(
          j.id,
          j.dedupe_hash,
          j.external_id,
          j.source_id,
          j.source_type,
          j.title,
          j.company,
          j.company_logo || '',
          j.department || '',
          j.location || '',
          j.work_mode || 'unknown',
          j.seniority || 'unknown',
          j.employment_type || 'Full-Time',
          j.experience_min ?? null,
          j.experience_max ?? null,
          j.salary_min ?? null,
          j.salary_max ?? null,
          j.salary_currency || 'USD',
          j.salary_period || 'year',
          j.salary_raw || '',
          j.is_salary_estimated ? 1 : 0,
          j.description_html || '',
          j.description_text || '',
          skillsJson,
          JSON.stringify(j.green_flags || []),
          JSON.stringify(j.red_flags || []),
          j.visa_sponsorship ? 1 : 0,
          j.apply_url,
          j.company_url || '',
          j.posted_at || now,
          now,
          now,
          scored.score,
          JSON.stringify(scored.breakdown)
        );
        insertFts.run(j.id, j.title, j.company, j.location || '', skillsText, j.description_text || '');
        newCount++;
      } else {
        updateJob.run(
          j.external_id,
          j.source_id,
          j.source_type,
          j.title,
          j.company,
          j.company_logo || '',
          j.department || '',
          j.location || '',
          j.work_mode || 'unknown',
          j.seniority || 'unknown',
          j.employment_type || 'Full-Time',
          j.experience_min ?? null,
          j.experience_max ?? null,
          j.salary_min ?? null,
          j.salary_max ?? null,
          j.salary_currency || 'USD',
          j.salary_period || 'year',
          j.salary_raw || '',
          j.is_salary_estimated ? 1 : 0,
          j.description_html || '',
          j.description_text || '',
          skillsJson,
          JSON.stringify(j.green_flags || []),
          JSON.stringify(j.red_flags || []),
          j.visa_sponsorship ? 1 : 0,
          j.apply_url,
          j.company_url || '',
          j.posted_at || null,
          now,
          scored.score,
          JSON.stringify(scored.breakdown),
          existing.id
        );
        deleteFts.run(existing.id);
        insertFts.run(existing.id, j.title, j.company, j.location || '', skillsText, j.description_text || '');
        updatedCount++;
      }
    }

    if (sourceId) {
      if (srcMeta?.tier === 1 && FULL_SNAPSHOT_ATS.has(srcMeta.type) && normalizedJobs.length >= 3) {
        const activeRows = db
          .prepare("SELECT id FROM jobs WHERE source_id = ? AND is_active = 1 AND status = 'new'")
          .all(sourceId);
        const deactivateStmt = db.prepare('UPDATE jobs SET is_active = 0 WHERE id = ?');
        for (const r of activeRows) {
          if (!seenJobIds.has(r.id)) {
            deactivateStmt.run(r.id);
          }
        }
      }
      const cnt = db.prepare('SELECT COUNT(*) AS c FROM jobs WHERE source_id = ? AND is_active = 1').get(sourceId);
      db.prepare('UPDATE sources SET total_active_jobs = ? WHERE id = ?').run(cnt?.c ?? 0, sourceId);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { newCount, updatedCount };
}

function buildFtsQuery(rawQuery) {
  const tokens = String(rawQuery)
    .trim()
    .replace(/['"*()^{}[\]:]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(' AND ');
}

export function queryJobs(db, params = {}) {
  const {
    q = '',
    minScore = 0,
    workMode = '',
    seniority = 'intern,junior',
    roleCategory = 'tech',
    locationPriority = '',
    sourceType = '',
    sourceId = '',
    company = '',
    skills = '',
    minSalary = 0,
    status = '',
    maxAgeDays = 0,
    visaOnly = false,
    hasSalaryOnly = false,
    hideDismissed = true,
    sortBy = 'match',
    limit = 40,
    offset = 0,
  } = params;

  const where = ['j.is_active = 1'];
  const args = [];
  let joinFts = '';

  const ftsQuery = buildFtsQuery(q);
  if (ftsQuery) {
    joinFts = 'JOIN jobs_fts fts ON fts.job_id = j.id';
    where.push('jobs_fts MATCH ?');
    args.push(ftsQuery);
  } else if (q && q.trim()) {
    where.push('(j.title LIKE ? OR j.company LIKE ? OR j.location LIKE ?)');
    const like = `%${q.trim()}%`;
    args.push(like, like, like);
  }

  if (Number(minScore) > 0) {
    where.push('j.match_score >= ?');
    args.push(Number(minScore));
  }

  if (workMode && workMode !== 'all') {
    const modes = String(workMode)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (modes.length > 0) {
      where.push(`j.work_mode IN (${modes.map(() => '?').join(',')})`);
      args.push(...modes);
    }
  }

  const effectiveSeniority = seniority === '' ? 'intern,junior' : seniority;
  if (effectiveSeniority && effectiveSeniority !== 'all') {
    const levels = String(effectiveSeniority)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (levels.length > 0) {
      where.push(`j.seniority IN (${levels.map(() => '?').join(',')})`);
      args.push(...levels);
    }
  }

  const effectiveRoleCategory = roleCategory || 'tech';
  if (effectiveRoleCategory === 'tech') {
    where.push('j.match_breakdown NOT LIKE ?');
    args.push('%"roleCategory":"non_tech"%');
  } else if (effectiveRoleCategory !== 'all') {
    const cats = String(effectiveRoleCategory)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (cats.length > 0) {
      where.push(`(${cats.map(() => 'j.match_breakdown LIKE ?').join(' OR ')})`);
      for (const c of cats) {
        args.push(`%"roleCategory":"${c}"%`);
      }
    }
  }

  const blrCond = "(j.location LIKE '%Bangalore%' OR j.location LIKE '%Bengaluru%' OR j.location LIKE '%BLR%')";
  const remoteCond = "(j.work_mode = 'remote' OR j.location LIKE '%Remote%' OR j.location LIKE '%Worldwide%' OR j.location LIKE '%Anywhere%')";
  const indiaGuard = "(j.location NOT LIKE '%Indiana%' AND j.location NOT LIKE '%Indianapolis%')";
  const indiaCond = `((j.location LIKE '%India%' AND ${indiaGuard}) OR j.location LIKE '%Hyderabad%' OR j.location LIKE '%Pune%' OR j.location LIKE '%Mumbai%' OR j.location LIKE '%Gurgaon%' OR j.location LIKE '%Gurugram%' OR j.location LIKE '%Noida%' OR j.location LIKE '%Chennai%' OR j.location LIKE '%Delhi%' OR j.location LIKE '%Kolkata%')`;

  if (locationPriority === 'bangalore') {
    where.push(blrCond);
  } else if (locationPriority === 'remote') {
    where.push(remoteCond);
  } else if (locationPriority === 'india') {
    where.push(`(${blrCond} OR ${indiaCond})`);
  } else if (locationPriority === 'global') {
    where.push(`NOT (${blrCond} OR ${remoteCond} OR ${indiaCond})`);
  }

  if (sourceType && sourceType !== 'all') {
    where.push('j.source_type = ?');
    args.push(sourceType);
  }

  if (sourceId) {
    where.push('j.source_id = ?');
    args.push(sourceId);
  }

  if (company) {
    where.push('j.company LIKE ?');
    args.push(`%${company.trim()}%`);
  }

  if (skills) {
    const skillList = String(skills)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const sk of skillList) {
      where.push('j.skills LIKE ?');
      args.push(`%"${sk}"%`);
    }
  }

  if (Number(minSalary) > 0) {
    where.push('COALESCE(j.salary_max, j.salary_min, 0) >= ?');
    args.push(Number(minSalary));
  }

  if (status && status !== 'all') {
    const statuses = String(status)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (statuses.length > 0) {
      where.push(`j.status IN (${statuses.map(() => '?').join(',')})`);
      args.push(...statuses);
    }
  } else if (hideDismissed) {
    where.push("j.status != 'dismissed'");
  }

  if (Number(maxAgeDays) > 0) {
    const cutoff = new Date(Date.now() - Number(maxAgeDays) * 24 * 60 * 60 * 1000).toISOString();
    where.push('COALESCE(j.posted_at, j.first_seen_at) >= ?');
    args.push(cutoff);
  }

  if (visaOnly) {
    where.push('j.visa_sponsorship = 1');
  }

  if (hasSalaryOnly) {
    where.push('j.is_salary_estimated = 0 AND (j.salary_min IS NOT NULL OR j.salary_max IS NOT NULL)');
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const priorityOrderCase = `
    CASE
      WHEN ${blrCond} THEN 1
      WHEN ${remoteCond} THEN 2
      WHEN ${indiaCond} THEN 3
      ELSE 4
    END
  `;

  const orderMap = {
    match: `${priorityOrderCase} ASC, j.match_score DESC, COALESCE(j.posted_at, j.first_seen_at) DESC`,
    score: 'j.match_score DESC, COALESCE(j.posted_at, j.first_seen_at) DESC',
    newest: `${priorityOrderCase} ASC, COALESCE(j.posted_at, j.first_seen_at) DESC, j.match_score DESC`,
    salary: 'COALESCE(j.salary_max, j.salary_min, 0) DESC, j.match_score DESC',
    company: 'j.company ASC, j.match_score DESC',
  };
  const orderSql = orderMap[sortBy] || orderMap.match;

  const countSql = `SELECT COUNT(*) AS total FROM jobs j ${joinFts} ${whereSql}`;
  const totalRow = db.prepare(countSql).get(...args);

  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 40));
  const safeOffset = Math.max(0, Number(offset) || 0);

  const listSql = `
    SELECT j.id, j.dedupe_hash, j.external_id, j.source_id, j.source_type, j.title, j.company,
           j.company_logo, j.department, j.location, j.work_mode, j.seniority, j.employment_type,
           j.experience_min, j.experience_max, j.salary_min, j.salary_max, j.salary_currency,
           j.salary_period, j.salary_raw, j.is_salary_estimated, j.description_text, j.skills,
           j.green_flags, j.red_flags, j.visa_sponsorship, j.apply_url, j.company_url,
           j.posted_at, j.first_seen_at, j.last_seen_at, j.is_active, j.match_score,
           j.match_breakdown, j.status, j.user_notes, j.applied_at
    FROM jobs j
    ${joinFts}
    ${whereSql}
    ORDER BY ${orderSql}
    LIMIT ? OFFSET ?
  `;
  const rows = db.prepare(listSql).all(...args, safeLimit, safeOffset);

  // Dashboard global stats (scoped to Intern & Fresher eligible tech roles + total DB count)
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const techGuard = effectiveRoleCategory === 'all' ? '' : `AND match_breakdown NOT LIKE '%"roleCategory":"non_tech"%'`;
  const stats = db
    .prepare(`
      SELECT
        COUNT(*) AS totalAllActive,
        SUM(CASE WHEN seniority IN ('intern', 'junior') ${techGuard} THEN 1 ELSE 0 END) AS totalActive,
        SUM(CASE WHEN seniority = 'intern' ${techGuard} THEN 1 ELSE 0 END) AS internCount,
        SUM(CASE WHEN seniority = 'junior' ${techGuard} THEN 1 ELSE 0 END) AS fresherCount,
        SUM(CASE WHEN seniority IN ('intern', 'junior') ${techGuard} AND (location LIKE '%Bangalore%' OR location LIKE '%Bengaluru%' OR location LIKE '%BLR%') THEN 1 ELSE 0 END) AS bangaloreCount,
        SUM(CASE WHEN seniority IN ('intern', 'junior') ${techGuard} AND (work_mode = 'remote' OR location LIKE '%Remote%' OR location LIKE '%Worldwide%' OR location LIKE '%Anywhere%') THEN 1 ELSE 0 END) AS remoteCount,
        SUM(CASE WHEN seniority IN ('intern', 'junior') ${techGuard} AND match_score >= 80 AND status != 'dismissed' THEN 1 ELSE 0 END) AS highMatchCount,
        SUM(CASE WHEN seniority IN ('intern', 'junior') ${techGuard} AND first_seen_at >= ? THEN 1 ELSE 0 END) AS new24h,
        SUM(CASE WHEN status IN ('saved', 'applied', 'screen', 'interview', 'offer') THEN 1 ELSE 0 END) AS trackedCount
      FROM jobs
      WHERE is_active = 1
    `)
    .get(dayAgo);

  const sourceStats = db
    .prepare('SELECT COUNT(*) AS totalSources, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabledSources FROM sources')
    .get();

  const facetSeniorityClause = effectiveSeniority === 'all' ? '' : "AND seniority IN ('intern', 'junior')";
  const sourceTypes = db
    .prepare(`
      SELECT source_type AS type, COUNT(*) AS count
      FROM jobs WHERE is_active = 1 AND status != 'dismissed' ${facetSeniorityClause} ${techGuard}
      GROUP BY source_type ORDER BY count DESC
    `)
    .all();

  return {
    jobs: rows.map((r) => hydrateJobRow(r, false)),
    total: Number(totalRow?.total ?? 0),
    stats: {
      totalAllActive: Number(stats?.totalAllActive ?? 0),
      totalActive: Number(stats?.totalActive ?? 0),
      internCount: Number(stats?.internCount ?? 0),
      fresherCount: Number(stats?.fresherCount ?? 0),
      bangaloreCount: Number(stats?.bangaloreCount ?? 0),
      remoteCount: Number(stats?.remoteCount ?? 0),
      highMatchCount: Number(stats?.highMatchCount ?? 0),
      new24h: Number(stats?.new24h ?? 0),
      trackedCount: Number(stats?.trackedCount ?? 0),
      totalSources: Number(sourceStats?.totalSources ?? 0),
      enabledSources: Number(sourceStats?.enabledSources ?? 0),
    },
    facets: {
      sourceTypes,
    },
  };
}

export function getJobById(db, id) {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  return hydrateJobRow(row, true);
}

export function updateJobStatus(db, id, { status, user_notes }) {
  const existing = db.prepare('SELECT id, status, applied_at FROM jobs WHERE id = ?').get(id);
  if (!existing) return null;

  const newStatus = status ?? existing.status;
  let appliedAt = existing.applied_at;
  if (newStatus === 'applied' && !appliedAt) {
    appliedAt = new Date().toISOString();
  }

  db.prepare(`
    UPDATE jobs SET
      status = COALESCE(?, status),
      user_notes = COALESCE(?, user_notes),
      applied_at = ?
    WHERE id = ?
  `).run(status ?? null, user_notes ?? null, appliedAt, id);

  return getJobById(db, id);
}

export function getAnalytics(db) {
  const activeRows = db
    .prepare('SELECT skills, salary_min, salary_max, seniority, work_mode, source_type, company, match_score FROM jobs WHERE is_active = 1')
    .all();

  const skillCounts = new Map();
  const sourceCounts = new Map();
  const companyCounts = new Map();
  const modeCounts = new Map();
  const senioritySalaries = new Map();
  const scoreBuckets = { '90-100': 0, '80-89': 0, '60-79': 0, '40-59': 0, '0-39': 0 };
  const allMidSalaries = [];

  for (const r of activeRows) {
    const skills = safeJsonParse(r.skills, []);
    for (const sk of skills) {
      skillCounts.set(sk, (skillCounts.get(sk) || 0) + 1);
    }
    sourceCounts.set(r.source_type, (sourceCounts.get(r.source_type) || 0) + 1);
    companyCounts.set(r.company, (companyCounts.get(r.company) || 0) + 1);
    modeCounts.set(r.work_mode || 'unknown', (modeCounts.get(r.work_mode || 'unknown') || 0) + 1);

    const s = Number(r.match_score ?? 0);
    if (s >= 90) scoreBuckets['90-100']++;
    else if (s >= 80) scoreBuckets['80-89']++;
    else if (s >= 60) scoreBuckets['60-79']++;
    else if (s >= 40) scoreBuckets['40-59']++;
    else scoreBuckets['0-39']++;

    const sMin = Number(r.salary_min || 0);
    const sMax = Number(r.salary_max || 0);
    if (sMin > 0 || sMax > 0) {
      const mid = sMin && sMax ? Math.round((sMin + sMax) / 2) : sMax || sMin;
      allMidSalaries.push(mid);
      const lvl = r.seniority || 'unknown';
      if (!senioritySalaries.has(lvl)) senioritySalaries.set(lvl, []);
      senioritySalaries.get(lvl).push(mid);
    }
  }

  allMidSalaries.sort((a, b) => a - b);
  const medianSalary = allMidSalaries.length ? allMidSalaries[Math.floor(allMidSalaries.length / 2)] : null;

  const topSkills = Array.from(skillCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([skill, count]) => ({ skill, count }));

  const bySource = Array.from(sourceCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => ({ source, count }));

  const topCompanies = Array.from(companyCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([company, count]) => ({ company, count }));

  const byWorkMode = Array.from(modeCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([mode, count]) => ({ mode, count }));

  const salaryBySeniority = Array.from(senioritySalaries.entries())
    .map(([seniority, arr]) => {
      arr.sort((a, b) => a - b);
      const avg = Math.round(arr.reduce((sum, x) => sum + x, 0) / arr.length);
      const median = arr[Math.floor(arr.length / 2)];
      return { seniority, count: arr.length, avg, median, min: arr[0], max: arr[arr.length - 1] };
    })
    .sort((a, b) => b.median - a.median);

  return {
    totalJobs: activeRows.length,
    jobsWithSalary: allMidSalaries.length,
    medianSalary,
    topSkills,
    bySource,
    topCompanies,
    byWorkMode,
    salaryBySeniority,
    scoreBuckets,
  };
}
