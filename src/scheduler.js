import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { getSetting, setSetting } from './db.js';
import { scrapeSingleSource, runConcurrentPool } from './scrapers/index.js';
import { scanJobsForAtsCandidates, verifyPendingCandidates } from './scrapers/autodiscover.js';

export class ScrapeScheduler extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.isRunning = false;
    this.currentRun = null;
    this.timer = null;
  }

  getConfig() {
    const enabled = getSetting(this.db, 'scheduler_enabled', 'true') === 'true';
    const intervalMins = Math.max(5, Number(getSetting(this.db, 'scrape_interval_mins', '30')) || 30);
    return { enabled, intervalMins };
  }

  updateConfig({ enabled, intervalMins }) {
    if (enabled !== undefined) {
      setSetting(this.db, 'scheduler_enabled', enabled ? 'true' : 'false');
    }
    if (intervalMins !== undefined) {
      const mins = Math.max(5, Math.min(1440, Number(intervalMins) || 30));
      setSetting(this.db, 'scrape_interval_mins', String(mins));
      this.db.prepare('UPDATE sources SET scrape_interval_mins = ?').run(mins);
    }
    const cfg = this.getConfig();
    this.emit('event', { type: 'scheduler:updated', data: cfg });
    return cfg;
  }

  startDaemon() {
    if (this.timer) return;
    // Check every 60 seconds for due sources
    this.timer = setInterval(() => {
      const { enabled } = this.getConfig();
      if (!enabled || this.isRunning) return;
      this.scrapeDueSources().catch((err) => {
        console.error('[Scheduler] Background tick error:', err.message);
      });
    }, 60 * 1000);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stopDaemon() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getDueSources() {
    const { intervalMins } = this.getConfig();
    const sources = this.db.prepare('SELECT * FROM sources WHERE enabled = 1').all();
    const now = Date.now();
    return sources.filter((s) => {
      if (!s.last_scraped_at) return true;
      const last = new Date(s.last_scraped_at).getTime();
      if (!Number.isFinite(last)) return true;
      const mins = Number(s.scrape_interval_mins || intervalMins);
      return now - last >= mins * 60 * 1000;
    });
  }

  async scrapeDueSources() {
    const due = this.getDueSources();
    if (due.length === 0) return null;
    return this._executeRun(due, 'scheduled');
  }

  async triggerScrape({ mode = 'all', sourceId = null } = {}) {
    if (this.isRunning) {
      return { alreadyRunning: true, currentRun: this.currentRun };
    }

    let targets = [];
    if (sourceId) {
      const row = this.db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId);
      if (!row) throw new Error(`Source "${sourceId}" not found`);
      targets = [row];
    } else if (mode === 'ats') {
      targets = this.db.prepare('SELECT * FROM sources WHERE enabled = 1 AND tier = 1').all();
    } else if (mode === 'aggregators') {
      targets = this.db.prepare('SELECT * FROM sources WHERE enabled = 1 AND tier IN (2, 3)').all();
    } else {
      targets = this.db.prepare('SELECT * FROM sources WHERE enabled = 1').all();
    }

    if (targets.length === 0) {
      return { runId: null, total: 0, completed: 0, newJobs: 0, updatedJobs: 0, results: [] };
    }

    return this._executeRun(targets, sourceId ? `single:${sourceId}` : mode);
  }

  async _executeRun(targets, label) {
    if (this.isRunning) return { alreadyRunning: true, currentRun: this.currentRun };

    const runId = crypto.randomUUID().slice(0, 8);
    this.isRunning = true;
    this.currentRun = {
      runId,
      label,
      startedAt: new Date().toISOString(),
      total: targets.length,
      completed: 0,
      succeeded: 0,
      failed: 0,
      fetchedTotal: 0,
      newJobs: 0,
      updatedJobs: 0,
      currentSources: [],
    };

    this.emit('event', { type: 'scrape:start', data: { ...this.currentRun } });

    try {
      const results = await runConcurrentPool(targets, 6, async (sourceRow) => {
        this.currentRun.currentSources.push(sourceRow.name);
        this.emit('event', {
          type: 'scrape:source_start',
          data: { runId, sourceId: sourceRow.id, name: sourceRow.name, completed: this.currentRun.completed, total: this.currentRun.total },
        });

        const res = await scrapeSingleSource(this.db, sourceRow, runId);

        this.currentRun.completed += 1;
        this.currentRun.currentSources = this.currentRun.currentSources.filter((n) => n !== sourceRow.name);
        if (res.status === 'success') {
          this.currentRun.succeeded += 1;
          this.currentRun.fetchedTotal += res.fetched;
          this.currentRun.newJobs += res.newCount;
          this.currentRun.updatedJobs += res.updatedCount;
        } else {
          this.currentRun.failed += 1;
        }

        this.emit('event', {
          type: 'scrape:source_done',
          data: {
            runId,
            result: res,
            progress: {
              completed: this.currentRun.completed,
              total: this.currentRun.total,
              succeeded: this.currentRun.succeeded,
              failed: this.currentRun.failed,
              fetchedTotal: this.currentRun.fetchedTotal,
              newJobs: this.currentRun.newJobs,
              updatedJobs: this.currentRun.updatedJobs,
            },
          },
        });

        return res;
      });

      const activeJobs = this.db
        .prepare(
          // Mine ATS links only from India-reachable postings so discovery finds employers that hire here
          "SELECT source_id, source_type, company, apply_url, company_url, description_text FROM jobs WHERE is_active = 1 AND location_tier IN ('bangalore', 'india', 'remote')"
        )
        .all();
      scanJobsForAtsCandidates(this.db, activeJobs, label);
      const promoted = await verifyPendingCandidates(this.db, { limit: 3 }).catch(() => []);

      const summary = {
        ...this.currentRun,
        finishedAt: new Date().toISOString(),
        promotedCandidates: promoted.length,
        results,
      };
      this.emit('event', { type: 'scrape:complete', data: summary });
      return summary;
    } finally {
      this.isRunning = false;
      this.currentRun = null;
    }
  }

  getStatus() {
    const cfg = this.getConfig();
    const recentLogs = this.db
      .prepare('SELECT * FROM scrape_logs ORDER BY id DESC LIMIT 40')
      .all();
    return {
      isRunning: this.isRunning,
      currentRun: this.currentRun,
      schedulerEnabled: cfg.enabled,
      intervalMins: cfg.intervalMins,
      dueCount: this.getDueSources().length,
      recentLogs,
    };
  }
}
