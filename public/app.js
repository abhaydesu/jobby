// Jobby Frontend Application — Monochrome Architectural Edition

const state = {
  tab: 'feed',
  filters: {
    q: '',
    minScore: 0,
    workMode: '',
    seniority: 'intern,junior',
    roleCategory: 'tech',
    locationPriority: '',
    sourceType: '',
    minSalary: 0,
    maxAgeDays: 0,
    hasSalaryOnly: false,
    visaOnly: false,
    savedOnly: false,
    hideDismissed: true,
    skills: [],
    sortBy: 'match',
    limit: 30,
    offset: 0,
  },
  jobs: [],
  total: 0,
  stats: {},
  facets: {},
  topSkills: [],
  sources: [],
  profile: null,
  activeJobId: null,
  focusedIndex: 0,
  seenIds: new Set(
    (() => {
      try {
        return JSON.parse(localStorage.getItem('jobby_seen_ids') || '[]');
      } catch {
        return [];
      }
    })()
  ),
  lastUndo: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toast(msg, type = 'info', undoFn = null) {
  const box = $('#toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);

  if (typeof undoFn === 'function') {
    state.lastUndo = undoFn;
    const btn = document.createElement('button');
    btn.className = 'toast-undo-btn';
    btn.type = 'button';
    btn.textContent = 'Undo (Z)';
    btn.addEventListener('click', async () => {
      el.remove();
      const fn = state.lastUndo;
      state.lastUndo = null;
      if (fn) await fn();
    });
    el.appendChild(btn);
  }

  box.appendChild(el);
  setTimeout(() => el.remove(), undoFn ? 5200 : 3400);
}

function markJobSeen(id) {
  if (!id || state.seenIds.has(id)) return;
  state.seenIds.add(id);
  try {
    const arr = Array.from(state.seenIds).slice(-800);
    localStorage.setItem('jobby_seen_ids', JSON.stringify(arr));
  } catch {
    // Ignore quota errors
  }
  const row = document.querySelector(`.job-row[data-job-id="${CSS.escape(id)}"]`);
  if (row) row.classList.add('seen');
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function fmtMonthlyAmount(val, currency) {
  if (currency === 'INR') {
    if (val >= 100000) return `₹${(val / 100000).toFixed(val % 100000 === 0 ? 0 : 1)}L`;
    return `₹${Math.round(val / 1000)}k`;
  }
  const sym = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '$';
  if (val >= 1000) return `${sym}${(val / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${sym}${Math.round(val)}`;
}

function fmtStipendPill(job) {
  if (!job.salary_min && !job.salary_max) return '';
  const cur = (job.salary_currency || 'USD').toUpperCase();
  const minMo = Math.round((job.salary_min || job.salary_max) / 12);
  const maxMo = Math.round((job.salary_max || job.salary_min) / 12);
  const moRange =
    minMo !== maxMo
      ? `${fmtMonthlyAmount(minMo, cur)}–${fmtMonthlyAmount(maxMo, cur)}/mo`
      : `${fmtMonthlyAmount(maxMo, cur)}/mo`;

  if (!job.is_salary_estimated) {
    return `<span class="stipend-line accent-pill mono" title="Extracted directly from job listing"><span class="dot accent"></span>${esc(moRange)} <span class="stipend-note">listed</span></span>`;
  }
  const rawNote =
    job.salary_raw && job.salary_raw.includes('(')
      ? job.salary_raw.slice(job.salary_raw.indexOf('(') + 1, job.salary_raw.lastIndexOf(')'))
      : 'benchmark est.';
  return `<span class="stipend-line mono" title="Estimated from researched company & market benchmarks"><span class="dot muted"></span>~${esc(moRange)} <span class="stipend-note">${esc(rawNote)}</span></span>`;
}

function timeAgo(isoStr) {
  if (!isoStr) return 'recent';
  const ms = Date.now() - new Date(isoStr).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'now';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

function scoreDotClass(score) {
  if (score >= 80) return 'accent';
  return 'muted';
}

function detectJobPriorityTier(job) {
  const bdTier = job.match_breakdown?.locationTier;
  if (bdTier) return bdTier;
  const loc = String(job.location || '');
  if (/\b(bangalore|bengaluru|blr|karnataka)\b/i.test(loc)) return 'bangalore';
  if (job.work_mode === 'remote' || /\b(remote|worldwide|anywhere)\b/i.test(loc)) return 'remote';
  if (!/\b(indiana|indianapolis)\b/i.test(loc) && /\b(india|hyderabad|pune|mumbai|gurgaon|gurugram|noida|chennai|delhi|kolkata|ahmedabad|kochi)\b/i.test(loc)) return 'india';
  return 'global';
}

function renderPriorityPill(tier) {
  if (tier === 'bangalore') return '<span class="tag-pill accent-pill mono"><span class="dot accent"></span>BENGALURU</span>';
  if (tier === 'remote') return '<span class="tag-pill accent-pill mono"><span class="dot accent"></span>REMOTE</span>';
  if (tier === 'india') return '<span class="tag-pill mono"><span class="dot muted"></span>INDIA</span>';
  return '<span class="tag-pill mono">GLOBAL</span>';
}

function renderRolePill(seniority) {
  if (seniority === 'intern') return '<span class="tag-pill strong mono">INTERN</span>';
  if (seniority === 'junior') return '<span class="tag-pill mono">NEW GRAD</span>';
  if (seniority && seniority !== 'unknown') return `<span class="tag-pill mono">${esc(seniority.toUpperCase())}</span>`;
  return '';
}

function bindSpotlightHandlers() {
  document.addEventListener('pointermove', (e) => {
    const card = e.target.closest('.spotlight-card');
    if (!card) return;
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - rect.left}px`);
    card.style.setProperty('--my', `${e.clientY - rect.top}px`);
  });
}

function switchTab(tabName) {
  state.tab = tabName;
  $$('.nav-tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tabName));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${tabName}`));

  if (tabName !== 'feed' && state.activeJobId) {
    closeDrawer();
  }

  if (tabName === 'feed') loadJobs();
  if (tabName === 'crm') loadCrmBoard();
  if (tabName === 'scraper') loadScraperConsole();
  if (tabName === 'profile') loadProfile();
  if (tabName === 'analytics') loadAnalytics();
  if (tabName === 'research') loadResearch();
}

async function loadJobs() {
  const f = state.filters;
  const qs = new URLSearchParams({
    q: f.q,
    minScore: String(f.minScore),
    workMode: f.workMode,
    seniority: f.seniority,
    roleCategory: f.roleCategory,
    locationPriority: f.locationPriority,
    sourceType: f.sourceType,
    minSalary: String(f.minSalary),
    maxAgeDays: String(f.maxAgeDays),
    hasSalaryOnly: String(f.hasSalaryOnly),
    visaOnly: String(f.visaOnly),
    status: f.savedOnly ? 'saved' : '',
    hideDismissed: String(f.hideDismissed),
    skills: f.skills.join(','),
    sortBy: f.sortBy,
    limit: String(f.limit),
    offset: String(f.offset),
  });

  syncQuickIntentAndAdvBadge();
  renderActiveFilterChips();

  const data = await api(`/api/jobs?${qs.toString()}`);
  state.jobs = data.jobs || [];
  state.total = data.total || 0;
  state.stats = data.stats || {};
  state.facets = data.facets || {};

  if (state.focusedIndex >= state.jobs.length) {
    state.focusedIndex = Math.max(0, state.jobs.length - 1);
  }

  renderStatsAndFacets();
  renderJobsList();
}

function syncQuickIntentAndAdvBadge() {
  const f = state.filters;
  $('#qf-high-fit')?.classList.toggle('active', f.minScore >= 80);
  $('#qf-disclosed')?.classList.toggle('active', f.hasSalaryOnly);
  $('#qf-saved')?.classList.toggle('active', f.savedOnly);
  if ($('#f-has-salary')) $('#f-has-salary').checked = f.hasSalaryOnly;

  let advCount = 0;
  if (f.seniority !== 'intern,junior') advCount++;
  if (f.sourceType) advCount++;
  if (f.maxAgeDays > 0) advCount++;
  if (f.minSalary > 0) advCount++;
  if (f.minScore > 0 && f.minScore < 80) advCount++;
  if (f.visaOnly) advCount++;
  if (!f.hideDismissed) advCount++;

  const countEl = $('#adv-filters-count');
  if (countEl) countEl.textContent = advCount > 0 ? `(${advCount})` : '';
}

function renderActiveFilterChips() {
  const bar = $('#active-filter-chips');
  if (!bar) return;
  const f = state.filters;
  const chips = [];

  if (f.q.trim()) chips.push({ key: 'q', label: `Search: "${f.q.trim()}"` });
  if (f.seniority !== 'intern,junior') chips.push({ key: 'seniority', label: `Level: ${f.seniority}` });
  if (f.roleCategory && f.roleCategory !== 'tech') chips.push({ key: 'roleCategory', label: `Track: ${f.roleCategory}` });
  if (f.locationPriority) chips.push({ key: 'locationPriority', label: `Location: ${f.locationPriority}` });
  if (f.workMode) chips.push({ key: 'workMode', label: `Mode: ${f.workMode}` });
  if (f.minScore > 0) chips.push({ key: 'minScore', label: `Fit ≥ ${f.minScore}%` });
  if (f.hasSalaryOnly) chips.push({ key: 'hasSalaryOnly', label: 'Disclosed Pay' });
  if (f.savedOnly) chips.push({ key: 'savedOnly', label: 'Saved Only' });
  if (f.sourceType) chips.push({ key: 'sourceType', label: `ATS: ${f.sourceType}` });
  if (f.maxAgeDays > 0) chips.push({ key: 'maxAgeDays', label: `Last ${f.maxAgeDays}d` });
  if (f.minSalary > 0) chips.push({ key: 'minSalary', label: `$${Math.round(f.minSalary / 1000)}k+ eq.` });
  if (f.visaOnly) chips.push({ key: 'visaOnly', label: 'Visa Sponsor' });
  for (const sk of f.skills) {
    chips.push({ key: `skill:${sk}`, label: sk });
  }

  if (chips.length === 0) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }

  bar.classList.remove('hidden');
  bar.innerHTML =
    chips
      .map(
        (c) =>
          `<button class="active-chip" data-chip="${esc(c.key)}">${esc(c.label)} <span class="active-chip-x">×</span></button>`
      )
      .join('') + `<button class="btn-link" id="chips-clear-all" style="margin-left:auto;">Clear all</button>`;

  bar.querySelectorAll('.active-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.chip;
      if (k === 'q') {
        state.filters.q = '';
        $('#f-search').value = '';
      } else if (k === 'seniority') {
        state.filters.seniority = 'intern,junior';
        syncRoleScopeUI('intern,junior');
      } else if (k === 'roleCategory') {
        state.filters.roleCategory = 'tech';
        if ($('#f-role-category')) $('#f-role-category').value = 'tech';
      } else if (k === 'locationPriority') {
        state.filters.locationPriority = '';
        syncLocationPriorityUI('');
      } else if (k === 'workMode') {
        state.filters.workMode = '';
        $$('#f-work-mode .pill').forEach((p) => p.classList.toggle('active', p.dataset.value === ''));
      } else if (k === 'minScore') {
        state.filters.minScore = 0;
        $('#f-min-score').value = '0';
        $('#f-min-score-val').textContent = '0%';
      } else if (k === 'hasSalaryOnly') {
        state.filters.hasSalaryOnly = false;
      } else if (k === 'savedOnly') {
        state.filters.savedOnly = false;
      } else if (k === 'sourceType') {
        state.filters.sourceType = '';
        $('#f-source-type').value = '';
      } else if (k === 'maxAgeDays') {
        state.filters.maxAgeDays = 0;
        $('#f-max-age').value = '0';
      } else if (k === 'minSalary') {
        state.filters.minSalary = 0;
        $('#f-min-salary').value = '0';
      } else if (k === 'visaOnly') {
        state.filters.visaOnly = false;
        $('#f-visa').checked = false;
      } else if (k.startsWith('skill:')) {
        const sk = k.slice(6);
        state.filters.skills = state.filters.skills.filter((s) => s !== sk);
        refreshSkillCloud();
      }
      state.filters.offset = 0;
      loadJobs();
    });
  });

  $('#chips-clear-all')?.addEventListener('click', resetFilters);
}

function renderStatsAndFacets() {
  const s = state.stats;
  $('#kpi-total').textContent = (s.totalActive || 0).toLocaleString();
  $('#kpi-role-split').textContent = `${(s.internCount || 0).toLocaleString()} intern · ${(s.fresherCount || 0).toLocaleString()} grad`;
  $('#kpi-blr').textContent = (s.bangaloreCount || 0).toLocaleString();
  $('#kpi-remote').textContent = (s.remoteCount || 0).toLocaleString();
  $('#kpi-high').textContent = (s.highMatchCount || 0).toLocaleString();
  $('#kpi-new').textContent = (s.new24h || 0).toLocaleString();
  $('#kpi-sources').textContent = `${s.enabledSources || 0}/${s.totalSources || 0}`;
  $('#kpi-tracked').textContent = (s.trackedCount || 0).toLocaleString();

  $('#badge-feed').textContent = (s.totalActive || 0).toLocaleString();
  $('#badge-crm').textContent = (s.trackedCount || 0).toLocaleString();
  $('#badge-sources').textContent = s.enabledSources || 0;

  const select = $('#f-source-type');
  const currentVal = state.filters.sourceType;
  const options = ['<option value="">All Platforms</option>'];
  for (const st of state.facets.sourceTypes || []) {
    options.push(`<option value="${esc(st.type)}">${esc(st.type.toUpperCase())} (${st.count})</option>`);
  }
  select.innerHTML = options.join('');
  select.value = currentVal;
}

function syncRoleScopeUI(val) {
  $$('#bento-role-scope .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.seniority === val));
  const sel = $('#f-seniority');
  if (sel) sel.value = val;
}

function syncLocationPriorityUI(val) {
  $$('#bento-loc-priority .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.loc === val));
}

function buildMatchReasonLine(job) {
  const bd = job.match_breakdown || {};
  const matched = [...(bd.matchedPrimary || []), ...(bd.matchedSecondary || [])];
  const missing = bd.missingJobSkills || [];
  const parts = [];
  if (matched.length > 0) {
    parts.push(`<strong>Matches:</strong> ${esc(matched.slice(0, 4).join(', '))}`);
  }
  if (missing.length > 0) {
    parts.push(`<span>Gap: ${esc(missing.slice(0, 2).join(', '))}</span>`);
  }
  if (job.green_flags && job.green_flags.length > 0) {
    const priorityFlag =
      job.green_flags.find((fl) => /Class of 2026|Intern-to-FTE|Transparent Salary|Verified Early-Career|Fresh/.test(fl)) ||
      job.green_flags[0];
    parts.push(`<span>${esc(priorityFlag)}</span>`);
  }
  if (parts.length === 0) {
    return esc(job.snippet || '');
  }
  return parts.join(' <span class="job-sep">·</span> ');
}

function setFocusedIndex(newIdx, { openIfInspectorOpen = false, scroll = true } = {}) {
  if (state.jobs.length === 0) return;
  const clamped = Math.max(0, Math.min(state.jobs.length - 1, newIdx));
  state.focusedIndex = clamped;

  $$('.job-row').forEach((row, idx) => {
    row.classList.toggle('focused', idx === clamped);
  });

  const activeRow = $(`.job-row[data-idx="${clamped}"]`);
  if (activeRow && scroll) {
    activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  if (openIfInspectorOpen && state.activeJobId !== null && state.jobs[clamped]) {
    openJobDrawer(state.jobs[clamped].id);
  }
  updateInspectorNavButtons();
}

function updateInspectorNavButtons() {
  const prevBtn = $('#btn-prev-job');
  const nextBtn = $('#btn-next-job');
  if (prevBtn) prevBtn.disabled = state.focusedIndex <= 0;
  if (nextBtn) nextBtn.disabled = state.focusedIndex >= state.jobs.length - 1;
}

async function optimisticToggleSave(jobId) {
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return;
  const prevStatus = job.status || 'new';
  const nextStatus = prevStatus === 'saved' ? 'new' : 'saved';
  job.status = nextStatus;

  const btn = document.querySelector(`.act-save[data-id="${CSS.escape(jobId)}"]`);
  if (btn) btn.textContent = nextStatus === 'saved' ? 'Saved' : 'Save';
  if (state.activeJobId === jobId) $('#d-status-select').value = nextStatus;

  await api(`/api/jobs/${encodeURIComponent(jobId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: nextStatus }),
  });

  toast(
    nextStatus === 'saved' ? `Saved ${job.title}` : `Unsaved ${job.title}`,
    'info',
    async () => {
      await api(`/api/jobs/${encodeURIComponent(jobId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: prevStatus }),
      });
      loadJobs();
    }
  );
}

async function optimisticDismissJob(jobId) {
  const idx = state.jobs.findIndex((j) => j.id === jobId);
  const job = idx >= 0 ? state.jobs[idx] : null;
  const prevStatus = job?.status || 'new';

  await api(`/api/jobs/${encodeURIComponent(jobId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'dismissed' }),
  });

  if (idx >= 0 && state.filters.hideDismissed) {
    state.jobs.splice(idx, 1);
    state.total = Math.max(0, state.total - 1);
    if (state.focusedIndex >= state.jobs.length) {
      state.focusedIndex = Math.max(0, state.jobs.length - 1);
    }
    renderJobsList();
    if (state.activeJobId === jobId) {
      if (state.jobs[state.focusedIndex]) {
        openJobDrawer(state.jobs[state.focusedIndex].id);
      } else {
        closeDrawer();
      }
    }
  } else {
    loadJobs();
  }

  toast(
    job ? `Dismissed ${job.company} · ${job.title}` : 'Role dismissed',
    'info',
    async () => {
      await api(`/api/jobs/${encodeURIComponent(jobId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: prevStatus }),
      });
      loadJobs();
    }
  );
}

function renderJobsList() {
  const list = $('#jobs-list');
  const f = state.filters;
  const start = state.total === 0 ? 0 : f.offset + 1;
  const end = Math.min(state.total, f.offset + state.jobs.length);
  $('#feed-count-text').textContent = `${start}–${end} of ${state.total.toLocaleString()} openings`;

  if (state.jobs.length === 0) {
    list.innerHTML = `
      <div class="panel-box" style="text-align:center; padding: 48px 24px; border-bottom: 1px solid var(--border);">
        <h3>No openings match the active filters</h3>
        <p class="muted small">Reset filters or switch Role Scope / Location Priority to broaden results.</p>
        <div class="btn-row" style="justify-content:center; margin-top: 14px;">
          <button class="btn btn-secondary" id="empty-reset-btn">Reset Filters</button>
          <button class="btn btn-primary" id="empty-scrape-btn">Scrape Now</button>
        </div>
      </div>`;
    $('#empty-reset-btn')?.addEventListener('click', resetFilters);
    $('#empty-scrape-btn')?.addEventListener('click', () => triggerScrape('all'));
    $('#pagination-bar').classList.add('hidden');
    return;
  }

  list.innerHTML = state.jobs
    .map((job, idx) => {
      const stipendPill = fmtStipendPill(job);
      const bd = job.match_breakdown || {};
      const locTier = detectJobPriorityTier(job);
      const matchedSet = new Set([...(bd.matchedPrimary || []), ...(bd.matchedSecondary || [])].map((x) => x.toLowerCase()));
      const isFocused = idx === state.focusedIndex;
      const isSeen = state.seenIds.has(job.id);

      const skillsHtml = (job.skills || [])
        .slice(0, 7)
        .map((sk) => {
          const cls = matchedSet.has(sk.toLowerCase()) ? 'matched' : '';
          return `<span class="skill-chip ${cls}">${esc(sk)}</span>`;
        })
        .join('');

      const saveLabel = job.status === 'saved' ? 'Saved' : job.status !== 'new' ? job.status : 'Save';

      return `
        <article class="job-row spotlight-card ${isFocused ? 'focused' : ''} ${isSeen ? 'seen' : ''}" data-job-id="${esc(job.id)}" data-idx="${idx}">
          <div class="score-box">
            <div class="score-top">
              <span class="dot ${scoreDotClass(job.match_score)}"></span>
              <span class="score-val mono">${job.match_score}</span>
            </div>
            <span class="score-sub mono">match</span>
          </div>

          <div class="job-main">
            <div class="job-eyebrow">
              <span class="job-company">${esc(job.company)}</span>
              <span class="job-sep">/</span>
              <span>${esc(job.location || 'Unspecified')}</span>
              <span class="job-sep">/</span>
              <span class="mono">${esc(job.source_type)}</span>
              ${Array.isArray(job.also_on) && job.also_on.length ? `<span class="badge-tag mono" title="${esc(job.also_on.map((x) => x.label).join(', '))}">also on: ${esc(job.also_on.map((x) => x.label).slice(0, 3).join(', '))}</span>` : ''}
              ${job.department ? `<span class="job-sep">/</span><span>${esc(job.department)}</span>` : ''}
            </div>

            <div class="job-title-row">
              <h3 class="job-title">${esc(job.title)}</h3>
              ${renderPriorityPill(locTier)}
              ${renderRolePill(job.seniority)}
              ${stipendPill}
            </div>

            ${skillsHtml ? `<div class="skills-row">${skillsHtml}</div>` : ''}
            <div class="match-reason-line">${buildMatchReasonLine(job)}</div>
          </div>

          <div class="job-actions">
            <span class="posted-age mono">${timeAgo(job.posted_at || job.first_seen_at)}</span>
            <div class="action-pair">
              <button class="btn btn-secondary btn-sm act-save" data-id="${esc(job.id)}">${esc(saveLabel)}</button>
              <a class="btn btn-primary btn-sm act-apply" href="${esc(job.apply_url)}" target="_blank" rel="noopener noreferrer">Apply ↗</a>
            </div>
            <button class="btn btn-ghost btn-sm act-dismiss" data-id="${esc(job.id)}">Dismiss</button>
          </div>
        </article>`;
    })
    .join('');

  $$('.job-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.act-save, .act-apply, .act-dismiss')) return;
      state.focusedIndex = Number(row.dataset.idx || 0);
      setFocusedIndex(state.focusedIndex, { scroll: false });
      openJobDrawer(row.dataset.jobId);
    });
  });

  $$('.act-save').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      optimisticToggleSave(btn.dataset.id);
    });
  });

  $$('.act-dismiss').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      optimisticDismissJob(btn.dataset.id);
    });
  });

  const totalPages = Math.max(1, Math.ceil(state.total / f.limit));
  const curPage = Math.floor(f.offset / f.limit) + 1;
  const pBar = $('#pagination-bar');
  if (totalPages > 1) {
    pBar.classList.remove('hidden');
    $('#page-indicator').textContent = `Page ${curPage} / ${totalPages}`;
    $('#btn-prev-page').disabled = curPage <= 1;
    $('#btn-next-page').disabled = curPage >= totalPages;
  } else {
    pBar.classList.add('hidden');
  }
}

async function refreshSkillCloud() {
  try {
    const data = await api('/api/analytics');
    state.topSkills = (data.topSkills || []).slice(0, 14);
    const box = $('#f-skill-cloud');
    box.innerHTML = state.topSkills
      .map((item) => {
        const active = state.filters.skills.includes(item.skill) ? 'active' : '';
        return `<button class="skill-filter-chip ${active}" data-skill="${esc(item.skill)}">${esc(item.skill)}</button>`;
      })
      .join('');
    $$('.skill-filter-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const sk = chip.dataset.skill;
        if (state.filters.skills.includes(sk)) {
          state.filters.skills = state.filters.skills.filter((s) => s !== sk);
        } else {
          state.filters.skills.push(sk);
        }
        state.filters.offset = 0;
        refreshSkillCloud();
        loadJobs();
      });
    });
  } catch {
    // Non-critical
  }
}

function resetFilters() {
  state.filters = {
    q: '',
    minScore: 0,
    workMode: '',
    seniority: 'intern,junior',
    roleCategory: 'tech',
    locationPriority: '',
    sourceType: '',
    minSalary: 0,
    maxAgeDays: 0,
    hasSalaryOnly: false,
    visaOnly: false,
    savedOnly: false,
    hideDismissed: true,
    skills: [],
    sortBy: 'match',
    limit: 30,
    offset: 0,
  };
  state.focusedIndex = 0;
  $('#f-search').value = '';
  $('#f-min-score').value = '0';
  $('#f-min-score-val').textContent = '0%';
  $$('#f-work-mode .pill').forEach((p) => p.classList.toggle('active', p.dataset.value === ''));
  syncRoleScopeUI('intern,junior');
  if ($('#f-role-category')) $('#f-role-category').value = 'tech';
  syncLocationPriorityUI('');
  $('#f-source-type').value = '';
  $('#f-min-salary').value = '0';
  $('#f-max-age').value = '0';
  $('#f-has-salary').checked = false;
  $('#f-visa').checked = false;
  $('#f-hide-dismissed').checked = true;
  $('#f-sort').value = 'match';
  refreshSkillCloud();
  loadJobs();
}

async function openJobDrawer(jobId) {
  state.activeJobId = jobId;
  markJobSeen(jobId);
  const idx = state.jobs.findIndex((j) => j.id === jobId);
  if (idx >= 0) {
    state.focusedIndex = idx;
    $$('.job-row').forEach((r, i) => r.classList.toggle('focused', i === idx));
  }
  updateInspectorNavButtons();

  const data = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
  const { job, tailoring } = data;
  const locTier = detectJobPriorityTier(job);

  $('#d-source-badge').textContent =
    Array.isArray(job.also_on) && job.also_on.length
      ? `${job.source_type} (also on: ${job.also_on.map((x) => x.label).join(', ')})`
      : job.source_type;
  $('#d-company').textContent = job.company;
  $('#d-title').textContent = job.title;
  $('#d-apply-link').href = job.apply_url;
  $('#d-status-select').value = job.status || 'new';
  $('#d-notes-input').value = job.user_notes || '';
  $('#d-notes-status').textContent = '';

  const stipendPill = fmtStipendPill(job);
  $('#d-meta-row').innerHTML = `
    ${renderPriorityPill(locTier)}
    ${renderRolePill(job.seniority)}
    <span class="tag-pill">${esc(job.location || 'Unspecified')}</span>
    ${stipendPill}
    <span class="tag-pill mono">${timeAgo(job.posted_at || job.first_seen_at)}</span>
  `;

  const dims = job.match_breakdown?.dimensions || {};
  const dimItems = [
    ['Title & Level', dims.title],
    ['Skills & Stack', dims.skills],
    ['Location Priority', dims.location],
    ['Compensation', dims.salary],
    ['Experience Fit', dims.experience],
  ];

  $('#d-match-panel').innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
      <strong style="font-size:0.86rem;">Match Breakdown</strong>
      <span class="mono" style="font-size:0.86rem; font-weight:600;">${job.match_score} / 100</span>
    </div>
    ${dimItems
      .map(([label, d]) => {
        const earned = d?.earned ?? 0;
        const max = d?.max ?? 1;
        const pct = Math.min(100, Math.round((earned / Math.max(1, max)) * 100));
        return `
          <div class="match-dim-row">
            <span class="muted">${esc(label)}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
            <span class="bar-val mono">${earned}/${max}</span>
          </div>`;
      })
      .join('')}
  `;

  const mp = job.match_breakdown?.matchedPrimary || [];
  const ms = job.match_breakdown?.matchedSecondary || [];
  const miss = job.match_breakdown?.missingJobSkills || [];
  $('#d-skills-compare').innerHTML = `
    <div class="skills-row" style="margin-bottom:10px;">
      ${mp.map((s) => `<span class="skill-chip matched">${esc(s)}</span>`).join('')}
      ${ms.map((s) => `<span class="skill-chip matched">${esc(s)}</span>`).join('')}
      ${miss.map((s) => `<span class="skill-chip">${esc(s)}</span>`).join('')}
    </div>
  `;

  const gf = (job.green_flags || []).map((f) => `<span class="tag-pill accent-pill"><span class="dot accent"></span>${esc(f)}</span>`).join('');
  const rf = (job.red_flags || []).map((f) => `<span class="tag-pill"><span class="dot muted"></span>${esc(f)}</span>`).join('');
  $('#d-flags-row').innerHTML = `<div style="display:flex; flex-wrap:wrap; gap:6px;">${gf}${rf}</div>`;

  $('#d-description').innerHTML = job.description_html || `<p>${esc(job.description_text || 'No description provided.')}</p>`;

  $('#d-tailor-content').innerHTML = `
    <div class="tailor-box">
      <h4>ATS Keywords</h4>
      <div class="skills-row">
        ${(tailoring.atsKeywords || []).map((k) => `<span class="skill-chip matched">${esc(k)}</span>`).join('')}
      </div>
      <p class="muted small" style="margin-top:8px;">${esc(tailoring.gapAdvice)}</p>
    </div>

    <div class="tailor-box">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h4>Tailored Resume Summary</h4>
        <button class="btn btn-secondary btn-sm copy-btn" data-copy="${esc(tailoring.resumeSummary)}">Copy</button>
      </div>
      <pre>${esc(tailoring.resumeSummary)}</pre>
    </div>

    <div class="tailor-box">
      <h4>Bullet Suggestions</h4>
      <ul style="padding-left:18px; margin:8px 0;">
        ${(tailoring.bulletTemplates || []).map((b) => `<li style="margin-bottom:6px; font-size:0.84rem; color:var(--text-secondary);">${esc(b)}</li>`).join('')}
      </ul>
    </div>

    <div class="tailor-box">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h4>Cold Outreach Note</h4>
        <button class="btn btn-primary btn-sm copy-btn" data-copy="${esc(tailoring.outreachNote)}">Copy</button>
      </div>
      <pre>${esc(tailoring.outreachNote)}</pre>
    </div>
  `;

  $$('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        toast('Copied to clipboard');
      } catch {
        toast('Copy failed — copy manually');
      }
    });
  });

  $$('.drawer-tab').forEach((t) => t.classList.toggle('active', t.dataset.dtab === 'overview'));
  $$('.drawer-subpanel').forEach((p) => p.classList.toggle('active', p.id === 'dpanel-overview'));

  document.body.classList.toggle('inspector-split', state.tab === 'feed');
  $('#drawer-backdrop').classList.remove('hidden');
  $('#job-drawer').classList.remove('hidden');
}

function closeDrawer() {
  state.activeJobId = null;
  document.body.classList.remove('inspector-split');
  $('#drawer-backdrop').classList.add('hidden');
  $('#job-drawer').classList.add('hidden');
}

const CRM_STAGES = [
  { key: 'saved', label: 'Saved' },
  { key: 'applied', label: 'Applied' },
  { key: 'screen', label: 'Screen' },
  { key: 'interview', label: 'Interview' },
  { key: 'offer', label: 'Offer' },
  { key: 'rejected', label: 'Rejected' },
];

async function loadCrmBoard() {
  const data = await api('/api/jobs?seniority=all&roleCategory=all&status=saved,applied,screen,interview,offer,rejected&limit=200&hideDismissed=false');
  const jobs = data.jobs || [];
  const board = $('#kanban-board');

  board.innerHTML = CRM_STAGES.map((stage) => {
    const colJobs = jobs.filter((j) => j.status === stage.key);
    return `
      <div class="kanban-col">
        <div class="kanban-col-head">
          <span>${esc(stage.label)}</span>
          <span class="nav-badge mono">${colJobs.length}</span>
        </div>
        <div class="kanban-cards">
          ${
            colJobs.length === 0
              ? '<div class="muted small">Empty</div>'
              : colJobs
                  .map(
                    (j) => `
                  <div class="kanban-card" data-job-id="${esc(j.id)}">
                    <div class="kanban-card-title">${esc(j.title)}</div>
                    <div class="kanban-card-sub">${esc(j.company)} · <span class="mono">${j.match_score}%</span></div>
                    <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
                      <span class="badge-tag mono">${esc(j.source_type)}</span>
                      <select class="crm-move-select" data-id="${esc(j.id)}" style="width:auto; padding:3px 6px; font-size:0.73rem;">
                        ${CRM_STAGES.map((st) => `<option value="${st.key}" ${st.key === j.status ? 'selected' : ''}>${esc(st.label)}</option>`).join('')}
                        <option value="new">Back to Feed</option>
                      </select>
                    </div>
                  </div>`
                  )
                  .join('')
          }
        </div>
      </div>`;
  }).join('');

  $$('.kanban-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.crm-move-select')) return;
      openJobDrawer(card.dataset.jobId);
    });
  });

  $$('.crm-move-select').forEach((sel) => {
    sel.addEventListener('change', async () => {
      await api(`/api/jobs/${encodeURIComponent(sel.dataset.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: sel.value }),
      });
      toast(`Moved to ${sel.value}`);
      loadCrmBoard();
      loadJobs();
    });
  });
}

async function loadScraperConsole() {
  const [srcData, statusData, healthData, candData] = await Promise.all([
    api('/api/sources'),
    api('/api/scrape/status'),
    api('/api/sources/health').catch(() => ({ health: [] })),
    api('/api/sources/candidates').catch(() => ({ candidates: [] })),
  ]);
  const healthMap = new Map((healthData.health || []).map((h) => [h.id, h]));
  state.sources = (srcData.sources || []).map((s) => ({
    ...s,
    health: healthMap.get(s.id) || null,
  }));
  state.candidates = candData.candidates || [];

  $('#sched-enabled').checked = Boolean(statusData.schedulerEnabled);
  $('#sched-interval').value = String(statusData.intervalMins || 30);
  const unhealthyCount = (healthData.health || []).filter((h) => Number(h.error_streak || 0) > 0).length;
  $('#sched-meta').innerHTML = `
    <p class="muted small" style="margin-top:10px;">
      Due: <strong class="mono">${statusData.dueCount}</strong> sources ·
      State: <strong class="mono">${statusData.isRunning ? 'Running' : 'Idle'}</strong> ·
      Unhealthy: <strong class="mono">${unhealthyCount}</strong>
    </p>`;

  renderSourcesTable();
  renderCandidatesTable();
  renderLogsTable(statusData.recentLogs || []);
}

function renderCandidatesTable() {
  const tbody = $('#candidates-tbody');
  const countEl = $('#candidates-count');
  if (!tbody) return;
  const list = state.candidates || [];
  if (countEl) countEl.textContent = `${list.length} candidate${list.length === 1 ? '' : 's'}`;
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted small">No ATS candidates discovered yet.</td></tr>';
    return;
  }
  tbody.innerHTML = list
    .map(
      (c) => `
      <tr>
        <td><strong>${esc(c.name)}</strong></td>
        <td><span class="badge-tag mono">${esc(c.type)} · ${esc(c.board_token)}</span></td>
        <td><span class="status-dot mono"><span class="dot ${c.status === 'approved' ? 'accent' : 'muted'}"></span>${esc(c.status)}</span></td>
        <td class="mono">${c.jobs_found || 0}</td>
        <td class="muted small mono">${esc(c.discovered_from || 'scan')}</td>
        <td>
          <div class="btn-row">
            ${c.status !== 'approved' ? `<button class="btn btn-secondary btn-sm cand-approve" data-id="${esc(c.id)}">Approve</button>` : ''}
            ${c.status !== 'disabled' ? `<button class="btn btn-ghost btn-sm cand-disable" data-id="${esc(c.id)}">Disable</button>` : ''}
          </div>
        </td>
      </tr>`
    )
    .join('');

  $$('.cand-approve').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/sources/candidates/${encodeURIComponent(btn.dataset.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'approve', scrapeNow: true }),
      });
      toast('Discovered source approved & scraping');
      loadScraperConsole();
    });
  });

  $$('.cand-disable').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/sources/candidates/${encodeURIComponent(btn.dataset.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'disable' }),
      });
      toast('Discovered source disabled');
      loadScraperConsole();
    });
  });
}

function renderSourcesTable() {
  const filterText = ($('#source-search')?.value || '').toLowerCase().trim();
  const filtered = state.sources.filter(
    (s) => !filterText || s.name.toLowerCase().includes(filterText) || s.type.toLowerCase().includes(filterText)
  );

  $('#sources-tbody').innerHTML = filtered
    .map((s) => {
      const streak = Number(s.health?.error_streak || 0);
      const healthBadge =
        streak >= 5 && !s.enabled
          ? '<span class="muted small mono">auto-disabled (5/5)</span>'
          : streak > 0
            ? `<span class="muted small mono">streak ${streak}/5</span>`
            : '';
      return `
      <tr>
        <td><input type="checkbox" class="src-toggle" data-id="${esc(s.id)}" ${s.enabled ? 'checked' : ''} style="width:auto;" /></td>
        <td><strong>${esc(s.name)}</strong><div class="muted small mono">${esc(s.config?.slug || s.config?.url || s.id)}</div></td>
        <td><span class="badge-tag mono">T${s.tier} · ${esc(s.type)}</span></td>
        <td class="mono">${s.total_active_jobs || 0}</td>
        <td class="muted small mono">${s.last_scraped_at ? timeAgo(s.last_scraped_at) : 'never'}</td>
        <td><span class="status-dot mono"><span class="dot ${s.last_status === 'success' ? 'accent' : 'muted'}"></span>${esc(s.last_status || 'pending')}</span> ${healthBadge}</td>
        <td class="muted small mono">${s.last_duration_ms ? `${s.last_duration_ms}ms` : '—'}</td>
        <td>
          <div class="btn-row">
            <button class="btn btn-secondary btn-sm src-run-one" data-id="${esc(s.id)}">Scrape</button>
            <button class="btn btn-ghost btn-sm src-delete" data-id="${esc(s.id)}">Remove</button>
          </div>
        </td>
      </tr>`;
    })
    .join('');

  $$('.src-toggle').forEach((cb) => {
    cb.addEventListener('change', async () => {
      await api(`/api/sources/${encodeURIComponent(cb.dataset.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: cb.checked }),
      });
      toast(`Source ${cb.checked ? 'enabled' : 'paused'}`);
    });
  });

  $$('.src-run-one').forEach((btn) => {
    btn.addEventListener('click', () => triggerScrape('source', btn.dataset.id));
  });

  $$('.src-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/sources/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
      toast('Source removed');
      loadScraperConsole();
      loadJobs();
    });
  });
}

function renderLogsTable(logs) {
  $('#logs-tbody').innerHTML = logs
    .map(
      (l) => `
      <tr>
        <td class="muted small mono">${timeAgo(l.finished_at)}</td>
        <td><strong>${esc(l.source_name)}</strong></td>
        <td><span class="status-dot mono"><span class="dot ${l.status === 'success' ? 'accent' : 'muted'}"></span>${esc(l.status)}</span></td>
        <td class="mono">${l.fetched_count}</td>
        <td class="mono">${l.new_count}</td>
        <td class="mono">${l.updated_count}</td>
        <td class="muted small mono">${l.duration_ms}ms</td>
        <td class="muted small">${esc(l.error_message || 'OK')}</td>
      </tr>`
    )
    .join('');
}

async function triggerScrape(mode = 'all', sourceId = null) {
  try {
    const res = await api('/api/scrape/run', {
      method: 'POST',
      body: JSON.stringify({ mode, sourceId }),
    });
    if (res.status === 'already_running') {
      toast('Scrape cycle already running');
    } else {
      toast('Scrape started');
    }
  } catch (err) {
    toast(err.message);
  }
}

const PROFILE_PRESETS = {
  student_swe: {
    headline: 'Final-Year CS Student · Intern & Fresher SWE / Full-Stack',
    target_titles: ['Software Engineer Intern', 'Software Engineer', 'Software Development Engineer', 'SDE 1', 'New Grad Software Engineer', 'Full-Stack Engineer', 'Product Engineer'],
    primary_skills: ['TypeScript', 'JavaScript', 'Python', 'React', 'Next.js', 'Node.js', 'PostgreSQL', 'Docker', 'AWS'],
    secondary_skills: ['Go', 'Redis', 'GraphQL', 'Tailwind CSS', 'FastAPI', 'LLMs', 'CI/CD'],
    preferred_seniority: ['intern', 'junior'],
    preferred_locations: ['Bangalore', 'Bengaluru', 'Remote', 'India'],
    experience_years: 0.5,
    min_salary: 0,
  },
  student_ai: {
    headline: 'Final-Year CS Student · AI / ML Intern & Applied Research Grad',
    target_titles: ['AI Engineer Intern', 'Machine Learning Intern', 'AI Engineer', 'Machine Learning Engineer', 'Applied AI Engineer', 'Research Intern', 'Software Engineer Intern'],
    primary_skills: ['Python', 'PyTorch', 'LLMs', 'RAG', 'AI Agents', 'OpenAI API', 'LangChain', 'FastAPI', 'PostgreSQL'],
    secondary_skills: ['Docker', 'Kubernetes', 'Hugging Face', 'TypeScript', 'Pandas/NumPy', 'TensorFlow', 'AWS'],
    preferred_seniority: ['intern', 'junior'],
    preferred_locations: ['Bangalore', 'Bengaluru', 'Remote', 'India'],
    experience_years: 0.5,
    min_salary: 0,
  },
  student_backend: {
    headline: 'Final-Year CS Student · Backend & Distributed Systems Intern / SDE-1',
    target_titles: ['Backend Engineer Intern', 'Software Engineer Intern', 'Backend Engineer', 'SDE 1', 'Systems Engineer', 'Platform Engineer'],
    primary_skills: ['Go', 'Python', 'Java', 'PostgreSQL', 'Docker', 'Kubernetes', 'Redis', 'AWS', 'REST APIs'],
    secondary_skills: ['Kafka', 'gRPC', 'Microservices', 'Distributed Systems', 'Terraform', 'Linux', 'TypeScript'],
    preferred_seniority: ['intern', 'junior'],
    preferred_locations: ['Bangalore', 'Bengaluru', 'Remote', 'India'],
    experience_years: 0.5,
    min_salary: 0,
  },
};

function populateProfileForm(p) {
  state.profile = p;
  $('#prof-name').value = p.name || '';
  $('#prof-yoe').value = p.experience_years ?? 0.5;
  $('#prof-headline').value = p.headline || '';
  $('#prof-resume').value = p.resume_text || '';
  $('#prof-titles').value = (p.target_titles || []).join(', ');
  $('#prof-primary-skills').value = (p.primary_skills || []).join(', ');
  $('#prof-secondary-skills').value = (p.secondary_skills || []).join(', ');
  $('#prof-min-salary').value = p.min_salary ?? 0;
  $('#prof-locations').value = (p.preferred_locations || []).join(', ');
  $('#prof-target-companies').value = (p.target_companies || []).join(', ');
  $('#prof-excluded-skills').value = (p.excluded_skills || []).join(', ');
  $('#prof-visa').checked = Boolean(p.require_visa);

  $$('#prof-work-modes input').forEach((cb) => {
    cb.checked = (p.work_modes || []).includes(cb.value);
  });
  $$('#prof-seniority input').forEach((cb) => {
    cb.checked = (p.preferred_seniority || []).includes(cb.value);
  });

  const w = p.weights || { title: 30, skills: 35, location: 15, salary: 10, experience: 10 };
  $('#w-title').value = w.title;
  $('#w-title-v').textContent = w.title;
  $('#w-skills').value = w.skills;
  $('#w-skills-v').textContent = w.skills;
  $('#w-location').value = w.location;
  $('#w-location-v').textContent = w.location;
  $('#w-salary').value = w.salary;
  $('#w-salary-v').textContent = w.salary;
  $('#w-exp').value = w.experience;
  $('#w-exp-v').textContent = w.experience;
}

async function loadProfile() {
  const data = await api('/api/profile');
  populateProfileForm(data.profile);
}

function splitCsv(str) {
  return String(str || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function saveProfile() {
  const payload = {
    name: $('#prof-name').value.trim(),
    experience_years: Number($('#prof-yoe').value || 0),
    headline: $('#prof-headline').value.trim(),
    resume_text: $('#prof-resume').value,
    target_titles: splitCsv($('#prof-titles').value),
    primary_skills: splitCsv($('#prof-primary-skills').value),
    secondary_skills: splitCsv($('#prof-secondary-skills').value),
    min_salary: Number($('#prof-min-salary').value || 0),
    preferred_locations: splitCsv($('#prof-locations').value),
    target_companies: splitCsv($('#prof-target-companies').value),
    excluded_skills: splitCsv($('#prof-excluded-skills').value),
    require_visa: $('#prof-visa').checked,
    work_modes: $$('#prof-work-modes input:checked').map((c) => c.value),
    preferred_seniority: $$('#prof-seniority input:checked').map((c) => c.value),
    weights: {
      title: Number($('#w-title').value),
      skills: Number($('#w-skills').value),
      location: Number($('#w-location').value),
      salary: Number($('#w-salary').value),
      experience: Number($('#w-exp').value),
    },
  };

  const data = await api('/api/profile', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  populateProfileForm(data.profile);
  toast('Profile saved & re-scored');
  loadJobs();
}

async function loadAnalytics() {
  const d = await api('/api/analytics');
  const maxSkill = Math.max(1, ...(d.topSkills || []).map((x) => x.count));
  const maxSrc = Math.max(1, ...(d.bySource || []).map((x) => x.count));
  const maxSal = Math.max(1, ...(d.salaryBySeniority || []).map((x) => x.median));
  const maxBucket = Math.max(1, ...Object.values(d.scoreBuckets || { a: 1 }));

  $('#analytics-grid').innerHTML = `
    <div class="panel-box">
      <h3>Top In-Demand Skills</h3>
      <p class="muted small">Active jobs: <strong class="mono">${d.totalJobs}</strong> · Disclosed or benchmarked pay: <strong class="mono">${d.jobsWithSalary}</strong></p>
      <div style="margin-top:12px;">
        ${(d.topSkills || [])
          .slice(0, 18)
          .map(
            (s) => `
          <div class="bar-row">
            <span>${esc(s.skill)}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${Math.round((s.count / maxSkill) * 100)}%"></div></div>
            <span class="bar-val mono">${s.count}</span>
          </div>`
          )
          .join('')}
      </div>
    </div>

    <div class="panel-box">
      <h3>Yield by Platform</h3>
      <div style="margin-top:12px;">
        ${(d.bySource || [])
          .map(
            (s) => `
          <div class="bar-row">
            <span class="mono">${esc(s.source.toUpperCase())}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${Math.round((s.count / maxSrc) * 100)}%"></div></div>
            <span class="bar-val mono">${s.count}</span>
          </div>`
          )
          .join('')}
      </div>

      <div class="divider"></div>
      <h3>Score Distribution</h3>
      <div style="margin-top:10px;">
        ${Object.entries(d.scoreBuckets || {})
          .map(
            ([bucket, cnt]) => `
          <div class="bar-row">
            <span class="mono">${esc(bucket)}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${Math.round((cnt / maxBucket) * 100)}%"></div></div>
            <span class="bar-val mono">${cnt}</span>
          </div>`
          )
          .join('')}
      </div>
    </div>

    <div class="panel-box">
      <h3>Median Annualized Compensation by Level</h3>
      <div style="margin-top:12px;">
        ${
          (d.salaryBySeniority || []).length === 0
            ? '<p class="muted">No compensation data yet.</p>'
            : d.salaryBySeniority
                .map(
                  (s) => `
              <div class="bar-row">
                <span class="mono">${esc(s.seniority.toUpperCase())} (${s.count})</span>
                <div class="bar-track"><div class="bar-fill" style="width:${Math.round((s.median / maxSal) * 100)}%"></div></div>
                <span class="bar-val mono">$${Math.round(s.median / 1000)}k</span>
              </div>`
                )
                .join('')
        }
      </div>
    </div>

    <div class="panel-box">
      <h3>Top Hiring Companies</h3>
      <div style="margin-top:12px;">
        ${(d.topCompanies || [])
          .slice(0, 14)
          .map((c) => {
            const maxC = Math.max(1, d.topCompanies[0]?.count || 1);
            return `
            <div class="bar-row">
              <span>${esc(c.company)}</span>
              <div class="bar-track"><div class="bar-fill" style="width:${Math.round((c.count / maxC) * 100)}%"></div></div>
              <span class="bar-val mono">${c.count}</span>
            </div>`;
          })
          .join('')}
      </div>
    </div>
  `;
}

function renderMarkdownSafe(md = '') {
  const lines = md.split('\n');
  const out = [];
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('|')) {
      if (!inTable) {
        out.push('<table>');
        inTable = true;
      }
      if (/^\|[\s:-]+\|/.test(line)) continue;
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      const tag = i > 0 && lines[i + 1] && /^\|[\s:-]+\|/.test(lines[i + 1]) ? 'th' : 'td';
      out.push(`<tr>${cells.map((c) => `<${tag}>${inlineMd(c)}</${tag}>`).join('')}</tr>`);
      continue;
    } else if (inTable) {
      out.push('</table>');
      inTable = false;
    }

    if (line.startsWith('### ')) out.push(`<h3>${inlineMd(line.slice(4))}</h3>`);
    else if (line.startsWith('## ')) out.push(`<h2>${inlineMd(line.slice(3))}</h2>`);
    else if (line.startsWith('# ')) out.push(`<h1>${inlineMd(line.slice(2))}</h1>`);
    else if (line.startsWith('---')) out.push('<hr/>');
    else if (/^\s*[-*]\s+/.test(line)) out.push(`<p style="margin:4px 0 4px 14px;">• ${inlineMd(line.replace(/^\s*[-*]\s+/, ''))}</p>`);
    else if (/^\s*\d+\.\s+/.test(line)) out.push(`<p style="margin:4px 0 4px 10px;">${inlineMd(line)}</p>`);
    else if (line.trim() === '') out.push('');
    else out.push(`<p>${inlineMd(line)}</p>`);
  }
  if (inTable) out.push('</table>');
  return out.join('\n');
}

function inlineMd(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code class="mono">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

async function loadResearch() {
  const data = await api('/api/research');
  $('#research-content').innerHTML = renderMarkdownSafe(data.markdown || '');
}

function connectSse() {
  const evtSource = new EventSource('/api/events');
  evtSource.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleSseEvent(payload);
    } catch {
      // Ignore malformed SSE
    }
  };
}

function handleSseEvent(evt) {
  const banner = $('#live-banner');
  const dot = $('#daemon-dot');
  const label = $('#daemon-label');

  if (evt.type === 'connected') {
    const st = evt.data;
    dot.className = `status-led ${st.isRunning ? 'running' : st.schedulerEnabled ? '' : 'off'}`;
    label.textContent = st.isRunning
      ? 'Syncing...'
      : st.schedulerEnabled
        ? `Auto · ${st.intervalMins}m`
        : 'Paused';
  }

  if (evt.type === 'scrape:start') {
    banner.classList.remove('hidden');
    dot.className = 'status-led running';
    label.textContent = 'Syncing...';
    $('#live-banner-text').textContent = `Scraping ${evt.data.total} sources...`;
    $('#live-banner-stats').textContent = `0 / ${evt.data.total}`;
    $('#live-progress-fill').style.width = '2%';
  }

  if (evt.type === 'scrape:source_done') {
    const { result, progress } = evt.data;
    const pct = Math.round((progress.completed / Math.max(1, progress.total)) * 100);
    banner.classList.remove('hidden');
    $('#live-banner-text').textContent = `${result.name}: ${result.fetched} fetched, ${result.newCount} new`;
    $('#live-banner-stats').textContent = `${progress.completed} / ${progress.total}`;
    $('#live-progress-fill').style.width = `${pct}%`;
  }

  if (evt.type === 'scrape:complete') {
    banner.classList.add('hidden');
    dot.className = 'status-led';
    label.textContent = 'Synced';
    toast(`Scrape finished: ${evt.data.newJobs} new, ${evt.data.updatedJobs} updated`);
    loadJobs();
    refreshSkillCloud();
    if (state.tab === 'scraper') loadScraperConsole();
  }

  if (evt.type === 'scheduler:updated') {
    dot.className = `status-led ${evt.data.enabled ? '' : 'off'}`;
    label.textContent = evt.data.enabled ? `Auto · ${evt.data.intervalMins}m` : 'Paused';
  }
}

function bindEvents() {
  bindSpotlightHandlers();

  $$('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('#btn-theme-toggle').addEventListener('click', () => {
    const html = document.documentElement;
    html.dataset.theme = html.dataset.theme === 'dark' ? 'light' : 'dark';
  });

  $('#btn-global-scrape').addEventListener('click', () => triggerScrape('all'));
  $('#btn-scrape-all-2').addEventListener('click', () => triggerScrape('all'));
  $('#btn-scrape-ats').addEventListener('click', () => triggerScrape('ats'));
  $('#btn-scrape-aggs').addEventListener('click', () => triggerScrape('aggregators'));

  $$('#bento-role-scope .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filters.seniority = btn.dataset.seniority;
      state.filters.offset = 0;
      syncRoleScopeUI(btn.dataset.seniority);
      loadJobs();
    });
  });

  $$('#bento-loc-priority .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filters.locationPriority = btn.dataset.loc;
      state.filters.offset = 0;
      syncLocationPriorityUI(btn.dataset.loc);
      loadJobs();
    });
  });

  let searchTimer = null;
  $('#f-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filters.q = e.target.value;
      state.filters.offset = 0;
      loadJobs();
    }, 250);
  });

  // Quick Intent Toggle Pills (Hick's Law)
  $('#qf-high-fit').addEventListener('click', () => {
    state.filters.minScore = state.filters.minScore >= 80 ? 0 : 80;
    $('#f-min-score').value = String(state.filters.minScore);
    $('#f-min-score-val').textContent = `${state.filters.minScore}%`;
    state.filters.offset = 0;
    loadJobs();
  });

  $('#qf-disclosed').addEventListener('click', () => {
    state.filters.hasSalaryOnly = !state.filters.hasSalaryOnly;
    state.filters.offset = 0;
    loadJobs();
  });

  $('#qf-saved').addEventListener('click', () => {
    state.filters.savedOnly = !state.filters.savedOnly;
    state.filters.offset = 0;
    loadJobs();
  });

  // Power-User Home-Row Keyboard Triage (Superhuman / Linear style)
  document.addEventListener('keydown', async (e) => {
    const tag = (document.activeElement?.tagName || '').toUpperCase();
    const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (state.tab !== 'feed') switchTab('feed');
      $('#f-search')?.focus();
      return;
    }

    if (e.key === 'Escape') {
      if (isTyping) {
        document.activeElement.blur();
      } else if (state.activeJobId) {
        closeDrawer();
      }
      return;
    }

    if (isTyping) return;

    if (e.key === '/') {
      e.preventDefault();
      if (state.tab !== 'feed') switchTab('feed');
      $('#f-search')?.focus();
      return;
    }

    if (state.tab !== 'feed') return;

    const k = e.key.toLowerCase();
    if (k === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedIndex(state.focusedIndex + 1, { openIfInspectorOpen: true });
    } else if (k === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedIndex(state.focusedIndex - 1, { openIfInspectorOpen: true });
    } else if (e.key === 'Enter' || e.key === ' ') {
      const focusedJob = state.jobs[state.focusedIndex];
      if (!focusedJob) return;
      e.preventDefault();
      if (state.activeJobId === focusedJob.id) {
        closeDrawer();
      } else {
        openJobDrawer(focusedJob.id);
      }
    } else if (k === 's') {
      const focusedJob = state.jobs[state.focusedIndex];
      if (focusedJob) {
        e.preventDefault();
        await optimisticToggleSave(focusedJob.id);
      }
    } else if (k === 'x' || e.key === 'Backspace') {
      const focusedJob = state.jobs[state.focusedIndex];
      if (focusedJob) {
        e.preventDefault();
        await optimisticDismissJob(focusedJob.id);
      }
    } else if (k === 'a') {
      const focusedJob = state.jobs[state.focusedIndex];
      if (focusedJob?.apply_url) {
        e.preventDefault();
        window.open(focusedJob.apply_url, '_blank', 'noopener,noreferrer');
      }
    } else if (k === 'z' && state.lastUndo) {
      e.preventDefault();
      const fn = state.lastUndo;
      state.lastUndo = null;
      await fn();
    } else if (state.activeJobId && ['1', '2', '3'].includes(e.key)) {
      const map = { '1': 'overview', '2': 'tailor', '3': 'notes' };
      const targetTab = map[e.key];
      $$('.drawer-tab').forEach((t) => t.classList.toggle('active', t.dataset.dtab === targetTab));
      $$('.drawer-subpanel').forEach((p) => p.classList.toggle('active', p.id === `dpanel-${targetTab}`));
    }
  });

  $('#f-min-score').addEventListener('input', (e) => {
    $('#f-min-score-val').textContent = `${e.target.value}%`;
  });
  $('#f-min-score').addEventListener('change', (e) => {
    state.filters.minScore = Number(e.target.value);
    state.filters.offset = 0;
    loadJobs();
  });

  $$('#f-work-mode .pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      $$('#f-work-mode .pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      state.filters.workMode = pill.dataset.value;
      state.filters.offset = 0;
      loadJobs();
    });
  });

  $('#f-seniority').addEventListener('change', (e) => {
    state.filters.seniority = e.target.value;
    state.filters.offset = 0;
    syncRoleScopeUI(e.target.value);
    loadJobs();
  });
  $('#f-role-category')?.addEventListener('change', (e) => {
    state.filters.roleCategory = e.target.value;
    state.filters.offset = 0;
    loadJobs();
  });
  $('#f-source-type').addEventListener('change', (e) => {
    state.filters.sourceType = e.target.value;
    state.filters.offset = 0;
    loadJobs();
  });
  $('#f-min-salary').addEventListener('change', (e) => {
    state.filters.minSalary = Number(e.target.value);
    state.filters.offset = 0;
    loadJobs();
  });
  $('#f-max-age').addEventListener('change', (e) => {
    state.filters.maxAgeDays = Number(e.target.value);
    state.filters.offset = 0;
    loadJobs();
  });
  $('#f-has-salary').addEventListener('change', (e) => {
    state.filters.hasSalaryOnly = e.target.checked;
    state.filters.offset = 0;
    loadJobs();
  });
  $('#f-visa').addEventListener('change', (e) => {
    state.filters.visaOnly = e.target.checked;
    state.filters.offset = 0;
    loadJobs();
  });
  $('#f-hide-dismissed').addEventListener('change', (e) => {
    state.filters.hideDismissed = e.target.checked;
    state.filters.offset = 0;
    loadJobs();
  });
  $('#f-sort').addEventListener('change', (e) => {
    state.filters.sortBy = e.target.value;
    state.filters.offset = 0;
    loadJobs();
  });
  $('#btn-reset-filters').addEventListener('click', resetFilters);

  $('#btn-prev-page').addEventListener('click', () => {
    state.filters.offset = Math.max(0, state.filters.offset - state.filters.limit);
    loadJobs();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('#btn-next-page').addEventListener('click', () => {
    state.filters.offset += state.filters.limit;
    loadJobs();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  $('#btn-close-drawer').addEventListener('click', closeDrawer);
  $('#drawer-backdrop').addEventListener('click', closeDrawer);
  $('#btn-prev-job').addEventListener('click', () => {
    setFocusedIndex(state.focusedIndex - 1, { openIfInspectorOpen: true });
  });
  $('#btn-next-job').addEventListener('click', () => {
    setFocusedIndex(state.focusedIndex + 1, { openIfInspectorOpen: true });
  });

  $$('.drawer-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.drawer-tab').forEach((t) => t.classList.toggle('active', t === tab));
      $$('.drawer-subpanel').forEach((p) => p.classList.toggle('active', p.id === `dpanel-${tab.dataset.dtab}`));
    });
  });

  $('#d-status-select').addEventListener('change', async (e) => {
    if (!state.activeJobId) return;
    await api(`/api/jobs/${encodeURIComponent(state.activeJobId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: e.target.value }),
    });
    toast(`Status: ${e.target.value}`);
    loadJobs();
    if (state.tab === 'crm') loadCrmBoard();
  });

  $('#btn-save-notes').addEventListener('click', async () => {
    if (!state.activeJobId) return;
    await api(`/api/jobs/${encodeURIComponent(state.activeJobId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ user_notes: $('#d-notes-input').value }),
    });
    $('#d-notes-status').textContent = 'Saved';
    toast('Notes saved');
  });

  $('#btn-refresh-crm').addEventListener('click', loadCrmBoard);
  $('#btn-refresh-analytics').addEventListener('click', loadAnalytics);

  $('#btn-save-sched').addEventListener('click', async () => {
    await api('/api/scrape/schedule', {
      method: 'PUT',
      body: JSON.stringify({
        enabled: $('#sched-enabled').checked,
        intervalMins: Number($('#sched-interval').value),
      }),
    });
    toast('Schedule saved');
    loadScraperConsole();
  });

  $('#source-search').addEventListener('input', renderSourcesTable);

  $('#btn-add-source').addEventListener('click', async () => {
    const name = $('#add-src-name').value.trim();
    const type = $('#add-src-type').value;
    const slug = $('#add-src-slug').value.trim();
    if (!name || !slug) return toast('Enter company name and slug');
    try {
      await api('/api/sources', {
        method: 'POST',
        body: JSON.stringify({ name, type, slug, scrapeNow: true }),
      });
      $('#add-src-name').value = '';
      $('#add-src-slug').value = '';
      toast(`Added ${name} (${type})`);
      loadScraperConsole();
    } catch (err) {
      toast(err.message);
    }
  });

  $('#btn-discover-url').addEventListener('click', async () => {
    const url = $('#discover-url').value.trim();
    const resBox = $('#discover-result');
    if (!url) return toast('Enter a career URL');
    resBox.classList.remove('hidden');
    resBox.textContent = 'Scanning page for ATS endpoints & Schema.org JSON-LD...';
    try {
      const res = await api('/api/sources/discover', {
        method: 'POST',
        body: JSON.stringify({ url }),
      });
      if (res.outcome === 'ats_detected') {
        resBox.innerHTML = `<strong>Detected ${esc(res.detectedAts.type.toUpperCase())}:</strong> slug <code class="mono">${esc(res.detectedAts.slug)}</code> (${res.scrapeResult?.fetchedTotal ?? 0} jobs fetched)`;
        loadScraperConsole();
        loadJobs();
      } else if (res.outcome === 'json_ld_detected') {
        resBox.innerHTML = `<strong>Detected Schema.org JSON-LD:</strong> ${res.jobsFound} jobs at <code class="mono">${esc(res.targetUrl)}</code>`;
        loadScraperConsole();
        loadJobs();
      } else {
        resBox.textContent = res.message || 'No ATS signature detected.';
      }
    } catch (err) {
      resBox.textContent = `Error: ${err.message}`;
    }
  });

  $('#btn-import-url')?.addEventListener('click', async () => {
    const url = $('#import-url').value.trim();
    const resBox = $('#import-result');
    if (!url) return toast('Enter a URL to import');
    resBox.classList.remove('hidden');
    resBox.textContent = 'Running career discovery & JSON-LD ingestion...';
    try {
      const res = await api('/api/import/url', {
        method: 'POST',
        body: JSON.stringify({ url }),
      });
      if (res.outcome === 'ats_detected') {
        resBox.innerHTML = `<strong>ATS source added (${esc(res.detectedAts.type)}):</strong> ${res.scrapeResult?.fetchedTotal ?? 0} jobs fetched`;
        loadScraperConsole();
        loadJobs();
      } else if (res.outcome === 'json_ld_ingested') {
        resBox.innerHTML = `<strong>Ingested JSON-LD:</strong> ${res.jobsFound} parsed (${res.newCount} new, ${res.updatedCount} updated)`;
        loadScraperConsole();
        loadJobs();
      } else {
        resBox.textContent = res.message || 'No ATS or JSON-LD job postings found.';
      }
    } catch (err) {
      resBox.textContent = `Error: ${err.message}`;
    }
  });

  $('#btn-import-eml')?.addEventListener('click', async () => {
    const fileInput = $('#import-eml-file');
    const file = fileInput?.files?.[0];
    const resBox = $('#import-result');
    if (!file) return toast('Choose a .eml or .mbox file first');
    resBox.classList.remove('hidden');
    resBox.textContent = `Parsing ${file.name}...`;
    try {
      const content = await file.text();
      const res = await api('/api/import/eml', {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, content }),
      });
      resBox.innerHTML = `<strong>Imported ${esc(file.name)}:</strong> ${res.parsedCount} postings (${res.newCount} new, ${res.updatedCount} updated)`;
      loadScraperConsole();
      loadJobs();
    } catch (err) {
      resBox.textContent = `Error: ${err.message}`;
    }
  });

  $('#btn-save-profile').addEventListener('click', saveProfile);

  $('#btn-parse-resume').addEventListener('click', async () => {
    const text = $('#prof-resume').value.trim();
    if (!text) return toast('Paste resume text first');
    const res = await api('/api/profile/parse-resume', {
      method: 'POST',
      body: JSON.stringify({ resume_text: text }),
    });
    const ex = res.extracted;
    $('#prof-primary-skills').value = (ex.primary_skills || []).join(', ');
    $('#prof-secondary-skills').value = (ex.secondary_skills || []).join(', ');
    $('#prof-yoe').value = ex.experience_years ?? 0.5;
    $('#prof-titles').value = (ex.target_titles || []).join(', ');
    $$('#prof-seniority input').forEach((cb) => {
      cb.checked = (ex.preferred_seniority || []).includes(cb.value);
    });
    $('#parse-status').textContent = `Extracted ${ex.primary_skills.length + ex.secondary_skills.length} skills. Click Save & Re-Score.`;
    toast('Resume parsed');
  });

  $$('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = PROFILE_PRESETS[btn.dataset.preset];
      if (!preset) return;
      $('#prof-headline').value = preset.headline;
      $('#prof-titles').value = preset.target_titles.join(', ');
      $('#prof-primary-skills').value = preset.primary_skills.join(', ');
      $('#prof-secondary-skills').value = preset.secondary_skills.join(', ');
      $('#prof-locations').value = preset.preferred_locations.join(', ');
      $('#prof-yoe').value = preset.experience_years;
      $('#prof-min-salary').value = preset.min_salary;
      $$('#prof-seniority input').forEach((cb) => {
        cb.checked = preset.preferred_seniority.includes(cb.value);
      });
      toast('Preset loaded — click Save & Re-Score');
    });
  });

  [
    ['#w-title', '#w-title-v'],
    ['#w-skills', '#w-skills-v'],
    ['#w-location', '#w-location-v'],
    ['#w-salary', '#w-salary-v'],
    ['#w-exp', '#w-exp-v'],
  ].forEach(([inp, lbl]) => {
    $(inp).addEventListener('input', (e) => {
      $(lbl).textContent = e.target.value;
    });
  });
}

async function init() {
  bindEvents();
  connectSse();
  await Promise.all([loadJobs(), refreshSkillCloud()]);
}

init().catch((err) => {
  console.error(err);
  toast(`Initialization error: ${err.message}`);
});
