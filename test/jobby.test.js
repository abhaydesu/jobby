import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {
  stripHtmlToText,
  sanitizeHtml,
  extractSkills,
  extractSalary,
  extractExperience,
  extractEligibility,
  extractWorkMode,
  extractVisaSponsorship,
  classifyLocationTier,
  classifyRoleCategory,
  estimateStipendBenchmark,
} from '../src/nlp.js';
import { scoreJobAgainstProfile, parseResumeText, generateJobTailoring } from '../src/matcher.js';
import { initDb, getProfile, updateProfile, upsertJobsBatch, queryJobs, recordSourceHealth, getSourcesHealth, getSourceCandidates, expireStaleJobs } from '../src/db.js';
import { normalizeJobPayload, fetchWithHardening, computeDedupeHash, normalizeCityAliases, canonicalizeApplyUrl } from '../src/scrapers/normalize.js';
import { detectAtsFromText, extractJsonLdJobPostings } from '../src/scrapers/fingerprinter.js';
import { resolveOffsiteAtsUrls, scanJobsForAtsCandidates, verifyPendingCandidates } from '../src/scrapers/autodiscover.js';
import { parseJobAlertEmail } from '../src/importer.js';
import { parseWorkdayListings, parseOracleHcm, parsePersonioXml, parseTeamtailorRss } from '../src/scrapers/ats.js';
import {
  parseAmazonJobs,
  parseGoogleCareersHtml,
  parseAtlassianListings,
  parseAppleCareersHtml,
  parseInternshalaHtml,
  parseInstahyreJson,
  parseLinkedInGuestCards,
  scrapeLinkedInGuest,
} from '../src/scrapers/aggregators.js';
import { createApp } from '../src/server.js';

test('NLP: HTML stripping and XSS sanitization', () => {
  const dirty = '<p>Build <strong>TypeScript</strong> APIs.</p><script>alert(1)</script><img src=x onerror="evil()">';
  const cleanHtml = sanitizeHtml(dirty);
  assert.ok(!cleanHtml.includes('<script>'));
  assert.ok(!cleanHtml.includes('onerror'));
  assert.ok(cleanHtml.includes('<strong>TypeScript</strong>'));

  const encoded = '&lt;p&gt;Hello &amp; welcome&lt;/p&gt;';
  assert.equal(stripHtmlToText(encoded), 'Hello & welcome');
});

test('NLP: skill extraction handles edge cases and avoids Go false positives', () => {
  const prose = 'We are going to build good software with TypeScript, React, PostgreSQL, C++, and Go services on Kubernetes.';
  const skills = extractSkills(prose);
  assert.ok(skills.includes('TypeScript'));
  assert.ok(skills.includes('React'));
  assert.ok(skills.includes('PostgreSQL'));
  assert.ok(skills.includes('C++'));
  assert.ok(skills.includes('Go'));
  assert.ok(skills.includes('Kubernetes'));

  const falseGo = 'You will have a good time going forward with Python and Django.';
  const skillsNoGo = extractSkills(falseGo);
  assert.ok(!skillsNoGo.includes('Go'));
  assert.ok(skillsNoGo.includes('Python'));
  assert.ok(skillsNoGo.includes('Django'));
});

test('NLP: salary extractor parses annual/hourly ranges and ignores funding noise', () => {
  const fundingText = 'We just raised $50M Series B at a $400M valuation! Compensation is $160,000 - $205,000 per year.';
  const sal = extractSalary(fundingText);
  assert.equal(sal.min, 160000);
  assert.equal(sal.max, 205000);
  assert.equal(sal.currency, 'USD');

  const hourly = extractSalary('Contract rate: $75/hr - $95/hr.');
  assert.equal(hourly.min, 75 * 2080);
  assert.equal(hourly.max, 95 * 2080);
  assert.equal(hourly.estimated, false);

  const inrMo = extractSalary('Stipend: ₹50,000 - ₹80,000/month during internship.');
  assert.equal(inrMo.currency, 'INR');
  assert.equal(inrMo.min, 50000 * 12);
  assert.equal(inrMo.max, 80000 * 12);
  assert.equal(inrMo.estimated, false);

  const inrLpa = extractSalary('CTC: 14 - 18 LPA for freshers.');
  assert.equal(inrLpa.currency, 'INR');
  assert.equal(inrLpa.min, 1400000);
  assert.equal(inrLpa.max, 1800000);
});

test('NLP: experience, seniority, work mode, and visa sponsorship', () => {
  const exp = extractExperience('Requires 5-8 years of experience building distributed systems.', 'Senior Backend Engineer');
  assert.equal(exp.min, 5);
  assert.equal(exp.max, 8);
  assert.equal(exp.seniority, 'senior');

  assert.equal(extractWorkMode('This is a 100% remote position', 'Anywhere', 'Software Engineer'), 'remote');
  assert.equal(extractWorkMode('3 days a week in-office', 'San Francisco, CA', 'Hybrid Product Engineer'), 'hybrid');

  assert.equal(extractVisaSponsorship('Visa sponsorship available for qualified candidates.'), true);
  assert.equal(extractVisaSponsorship('We are unable to sponsor visas at this time.'), false);
});

test('Matcher: 100-point scoring, resume parser, and tailoring generator', () => {
  const profile = {
    name: 'Alex',
    target_titles: ['Full-Stack Engineer', 'Senior Software Engineer'],
    primary_skills: ['TypeScript', 'React', 'Node.js', 'PostgreSQL', 'AWS'],
    secondary_skills: ['Docker', 'LLMs'],
    excluded_skills: ['PHP'],
    target_companies: ['Acme AI'],
    excluded_companies: [],
    experience_years: 5,
    preferred_seniority: ['senior'],
    work_modes: ['remote'],
    preferred_locations: ['Remote', 'US'],
    min_salary: 150000,
    weights: { title: 30, skills: 35, location: 15, salary: 10, experience: 10 },
  };

  const strongJob = {
    title: 'Senior Full-Stack Engineer',
    company: 'Acme AI',
    location: 'Remote (US)',
    work_mode: 'remote',
    seniority: 'senior',
    experience_min: 4,
    salary_min: 165000,
    salary_max: 200000,
    skills: ['TypeScript', 'React', 'Node.js', 'PostgreSQL', 'Docker', 'Kubernetes'],
    description_text: 'Build TypeScript React Node.js PostgreSQL apps with Kubernetes.',
    visa_sponsorship: true,
  };

  const weakJob = {
    title: 'WordPress PHP Intern',
    company: 'Legacy Shop',
    location: 'London, UK',
    work_mode: 'onsite',
    seniority: 'intern',
    experience_min: 0,
    salary_min: 30000,
    salary_max: 40000,
    skills: ['PHP'],
    description_text: 'WordPress PHP maintenance on site.',
    visa_sponsorship: false,
  };

  const strongScore = scoreJobAgainstProfile(strongJob, profile);
  const weakScore = scoreJobAgainstProfile(weakJob, profile);

  assert.ok(strongScore.score >= 85, `Expected strong match >= 85, got ${strongScore.score}`);
  assert.ok(weakScore.score <= 25, `Expected weak match <= 25, got ${weakScore.score}`);
  assert.ok(strongScore.breakdown.matchedPrimary.includes('TypeScript'));
  assert.ok(strongScore.breakdown.missingJobSkills.includes('Kubernetes'));

  const parsed = parseResumeText(
    'Senior Full-Stack Engineer (2019 - 2026). Built production TypeScript, React, Next.js, Python, FastAPI, PostgreSQL, and AWS microservices.'
  );
  assert.ok(parsed.primary_skills.includes('TypeScript'));
  assert.ok(parsed.primary_skills.includes('Python'));
  assert.ok(parsed.experience_years >= 6);

  const tailoring = generateJobTailoring(strongJob, profile);
  assert.ok(tailoring.outreachNote.includes('Acme AI'));
  assert.ok(tailoring.atsKeywords.includes('TypeScript'));
});

test('Fingerprinter: detects Greenhouse, Ashby, Lever, and Schema.org JobPosting JSON-LD', () => {
  assert.deepEqual(detectAtsFromText('https://boards.greenhouse.io/stripe/jobs/123'), {
    type: 'greenhouse',
    slug: 'stripe',
  });
  assert.deepEqual(detectAtsFromText('<iframe src="https://jobs.ashbyhq.com/linear"></iframe>'), {
    type: 'ashby',
    slug: 'linear',
  });
  assert.deepEqual(detectAtsFromText('https://jobs.lever.co/mistral'), {
    type: 'lever',
    slug: 'mistral',
  });

  const htmlWithLd = `
    <html><head>
    <script type="application/ld+json">
    {
      "@context": "https://schema.org/",
      "@type": "JobPosting",
      "title": "Staff Distributed Systems Engineer",
      "hiringOrganization": { "name": "CloudNova" },
      "jobLocationType": "TELECOMMUTE",
      "baseSalary": { "currency": "USD", "value": { "minValue": 190000, "maxValue": 230000, "unitText": "YEAR" } },
      "description": "<p>Work on Rust, Go, and Kubernetes.</p>",
      "url": "https://cloudnova.example/jobs/1"
    }
    </script></head></html>`;
  const ldJobs = extractJsonLdJobPostings(htmlWithLd, 'custom-cloudnova', 'https://cloudnova.example/careers');
  assert.equal(ldJobs.length, 1);
  assert.equal(ldJobs[0].title, 'Staff Distributed Systems Engineer');
  assert.equal(ldJobs[0].work_mode, 'remote');
  assert.equal(ldJobs[0].salary_min, 190000);
});

test('Database: deduplication preserves CRM state and FTS5 search + profile rescoring work', () => {
  const db = initDb(':memory:');
  const job1 = normalizeJobPayload({
    sourceId: 'gh-test',
    sourceType: 'greenhouse',
    externalId: '101',
    title: 'Senior Full-Stack Engineer',
    company: 'TestCorp',
    location: 'Remote',
    explicitRemote: true,
    descriptionHtml: '<p>TypeScript, React, Node.js, PostgreSQL, AWS. Salary $160,000 - $190,000.</p>',
    applyUrl: 'https://boards.greenhouse.io/testcorp/jobs/101',
  });

  const firstInsert = upsertJobsBatch(db, [job1], 'gh-test');
  assert.equal(firstInsert.newCount, 1);

  db.prepare("UPDATE jobs SET status = 'saved', user_notes = 'Great team' WHERE id = ?").run(job1.id);

  // Re-ingest duplicate from another board -> should update without creating duplicate or wiping status
  const job1Dup = normalizeJobPayload({
    sourceId: 'agg-remotive',
    sourceType: 'remotive',
    externalId: 'rem-999',
    title: 'Senior Full-Stack Engineer',
    company: 'TestCorp Inc.',
    location: 'Remote',
    explicitRemote: true,
    descriptionHtml: '<p>TypeScript, React, Node.js, PostgreSQL, AWS.</p>',
    applyUrl: 'https://remotive.com/job/999',
  });
  const secondInsert = upsertJobsBatch(db, [job1Dup], 'agg-remotive');
  assert.equal(secondInsert.newCount, 0);
  assert.equal(secondInsert.updatedCount, 1);

  const res = queryJobs(db, { q: 'PostgreSQL', minScore: 40, seniority: 'all' });
  assert.equal(res.total, 1);
  assert.equal(res.jobs[0].status, 'saved');
  assert.equal(res.jobs[0].user_notes, 'Great team');

  updateProfile(db, { target_titles: ['Dentist'], primary_skills: ['Dentistry'], work_modes: ['onsite'] });
  const afterRescore = queryJobs(db, { seniority: 'all' });
  assert.ok(afterRescore.jobs[0].match_score < res.jobs[0].match_score);
  db.close();
});

test('Final-Year Intern/Fresher filter & Bangalore/Remote priority ordering', () => {
  assert.equal(classifyLocationTier('Bengaluru, India', 'onsite'), 'bangalore');
  assert.equal(classifyLocationTier('San Francisco, CA', 'remote'), 'remote');
  assert.equal(classifyLocationTier('Hyderabad, India', 'hybrid'), 'india');
  assert.equal(classifyLocationTier('Berlin, Germany', 'onsite'), 'global');

  const expNewGrad = extractExperience('Ideal for final-year students pursuing a Bachelor degree.', 'Software Engineer (2026)');
  assert.equal(expNewGrad.seniority, 'junior');

  const db = initDb(':memory:');
  const seniorRole = normalizeJobPayload({
    sourceId: 'gh-test',
    sourceType: 'greenhouse',
    externalId: 's1',
    title: 'Staff Distributed Systems Engineer',
    company: 'BigCo',
    location: 'Bengaluru, India',
    descriptionHtml: '<p>8+ years experience in Go and Kubernetes.</p>',
    applyUrl: 'https://example.com/s1',
  });
  const berlinIntern = normalizeJobPayload({
    sourceId: 'gh-test',
    sourceType: 'greenhouse',
    externalId: 'i1',
    title: 'Software Engineer Intern',
    company: 'EuroCo',
    location: 'Berlin, Germany',
    descriptionHtml: '<p>TypeScript, React, Python, PostgreSQL, AWS, Docker.</p>',
    applyUrl: 'https://example.com/i1',
  });
  const remoteFresher = normalizeJobPayload({
    sourceId: 'gh-test',
    sourceType: 'greenhouse',
    externalId: 'f1',
    title: 'Software Engineer - New Grad',
    company: 'RemoteCo',
    location: 'Remote',
    explicitRemote: true,
    descriptionHtml: '<p>TypeScript, React, Node.js.</p>',
    applyUrl: 'https://example.com/f1',
  });
  const blrIntern = normalizeJobPayload({
    sourceId: 'gh-test',
    sourceType: 'greenhouse',
    externalId: 'b1',
    title: 'Backend Engineer Intern',
    company: 'Razorpay',
    location: 'Bengaluru, India',
    descriptionHtml: '<p>Python, Go, PostgreSQL.</p>',
    applyUrl: 'https://example.com/b1',
  });

  upsertJobsBatch(db, [seniorRole, berlinIntern, remoteFresher, blrIntern], 'gh-test');

  // Default queryJobs hides Staff/Senior roles and orders Bangalore -> Remote -> Global
  const defaultFeed = queryJobs(db, {});
  assert.equal(defaultFeed.total, 3);
  assert.equal(defaultFeed.jobs[0].company, 'Razorpay');
  assert.equal(defaultFeed.jobs[1].company, 'RemoteCo');
  assert.equal(defaultFeed.jobs[2].company, 'EuroCo');

  // Explicit Bangalore filter works
  const blrOnly = queryJobs(db, { locationPriority: 'bangalore' });
  assert.equal(blrOnly.total, 1);
  assert.equal(blrOnly.jobs[0].company, 'Razorpay');

  // Explicit seniority=all reveals Staff role too
  const allRoles = queryJobs(db, { seniority: 'all' });
  assert.equal(allRoles.total, 4);

  // Every normalized job has an approximate stipend (listed or researched)
  assert.ok(defaultFeed.jobs.every((j) => j.salary_min > 0 && j.salary_max >= j.salary_min));
  const stripeBench = estimateStipendBenchmark({
    title: 'Software Engineer, Intern',
    company: 'Stripe',
    location: 'Bengaluru',
    workMode: 'onsite',
    seniority: 'intern',
    sourceType: 'greenhouse',
  });
  assert.equal(stripeBench.currency, 'INR');
  assert.equal(stripeBench.estimated, true);
  assert.ok(stripeBench.min >= 100000 * 12);

  // hasSalaryOnly filters strictly to explicitly listed pay (excluding researched estimates)
  const listedJob = normalizeJobPayload({
    sourceId: 'gh-test',
    sourceType: 'greenhouse',
    externalId: 'listed-1',
    title: 'Frontend Engineer Intern',
    company: 'StartupXYZ',
    location: 'Bengaluru, India',
    descriptionHtml: '<p>Stipend: ₹45,000 - ₹60,000/month. React, TypeScript.</p>',
    applyUrl: 'https://example.com/listed-1',
  });
  upsertJobsBatch(db, [listedJob], 'gh-test');
  const listedOnly = queryJobs(db, { hasSalaryOnly: true });
  assert.equal(listedOnly.total, 1);
  assert.equal(listedOnly.jobs[0].company, 'StartupXYZ');
  assert.equal(listedOnly.jobs[0].is_salary_estimated, false);

  db.close();
});

test('HTTP API: end-to-end server routes work properly', async () => {
  const { db, server } = createApp({ dbPath: ':memory:' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const job = normalizeJobPayload({
      sourceId: 'ashby-linear',
      sourceType: 'ashby',
      externalId: 'lin-1',
      title: 'Product Engineer (New Grad)',
      company: 'Linear',
      location: 'Remote',
      explicitRemote: true,
      descriptionHtml: '<p>TypeScript, React, GraphQL, Node.js. $170k - $210k.</p>',
      applyUrl: 'https://jobs.ashbyhq.com/linear/lin-1',
    });
    upsertJobsBatch(db, [job], 'ashby-linear');

    const health = await fetch(`${baseUrl}/api/health`).then((r) => r.json());
    assert.equal(health.ok, true);

    const list = await fetch(`${baseUrl}/api/jobs?q=Linear`).then((r) => r.json());
    assert.equal(list.total, 1);
    assert.equal(list.jobs[0].company, 'Linear');

    const detail = await fetch(`${baseUrl}/api/jobs/${job.id}`).then((r) => r.json());
    assert.equal(detail.job.id, job.id);
    assert.ok(detail.tailoring.outreachNote.includes('Linear'));

    const patched = await fetch(`${baseUrl}/api/jobs/${job.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'applied', user_notes: 'Applied directly' }),
    }).then((r) => r.json());
    assert.equal(patched.job.status, 'applied');

    const analytics = await fetch(`${baseUrl}/api/analytics`).then((r) => r.json());
    assert.equal(analytics.totalJobs, 1);

    const research = await fetch(`${baseUrl}/api/research`).then((r) => r.json());
    assert.ok(research.markdown.includes('Greenhouse'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('Role discipline classification, tightened Associate seniority, Indiana/India guard & ATS patterns', () => {
  assert.equal(classifyRoleCategory('Software Engineer Intern', 'Engineering'), 'swe');
  assert.equal(classifyRoleCategory('Machine Learning Engineer', 'AI Research'), 'ai_data');
  assert.equal(classifyRoleCategory('Associate Product Manager', 'Product'), 'product_design');
  assert.equal(classifyRoleCategory('Cloud Security Engineer', 'Infrastructure'), 'devops_sec');
  assert.equal(classifyRoleCategory('Payroll Industrial Trainee', 'Finance'), 'non_tech');
  assert.equal(classifyRoleCategory('Credit Risk Operations Associate', 'Risk Operations'), 'non_tech');
  assert.equal(classifyRoleCategory('Accountant, Accounts Receivable', 'Finance'), 'non_tech');
  assert.equal(classifyRoleCategory('HR/TA - Associate', 'People'), 'non_tech');

  // Tightened Associate regex prevents non-tech ops/recruiter associates from triggering CS fresher seniority
  const riskOpsExp = extractExperience('1+ years of experience in risk operations.', 'Credit Risk Operations Associate');
  assert.notEqual(riskOpsExp.seniority, 'junior');

  // Indianapolis / Indiana must never classify as India
  assert.equal(classifyLocationTier('Indianapolis, IN', 'onsite'), 'global');
  assert.equal(classifyLocationTier('Indiana', 'onsite'), 'global');

  // New Rippling & Pinpoint fingerprinter signatures
  assert.deepEqual(detectAtsFromText('https://ats.rippling.com/rippling/jobs/abc-123'), {
    type: 'rippling',
    slug: 'rippling',
  });
  assert.deepEqual(detectAtsFromText('https://acme.pinpointhq.com/postings.json'), {
    type: 'pinpoint',
    slug: 'acme',
  });

  const db = initDb(':memory:');
  const profile = getProfile(db);

  const sweIntern = normalizeJobPayload({
    sourceId: 'gh-test',
    sourceType: 'greenhouse',
    externalId: 'swe-blr',
    title: 'Software Engineer Intern',
    company: 'Stripe',
    location: 'Bengaluru, India',
    descriptionHtml: '<p>TypeScript, React, Node.js, PostgreSQL.</p>',
    applyUrl: 'https://example.com/swe-blr',
  });
  const payrollTrainee = normalizeJobPayload({
    sourceId: 'gh-test',
    sourceType: 'greenhouse',
    externalId: 'payroll-blr',
    title: 'Payroll Industrial Trainee',
    company: 'Rubrik',
    location: 'Bengaluru, India',
    descriptionHtml: '<p>Manage payroll reconciliation and compliance going forward.</p>',
    applyUrl: 'https://example.com/payroll-blr',
  });
  const indianaNewGrad = normalizeJobPayload({
    sourceId: 'simplify-newgrad',
    sourceType: 'simplify',
    externalId: 'indiana-1',
    title: 'Software Engineer - New Grad',
    company: 'US Corp',
    location: 'Indianapolis, IN',
    descriptionHtml: '<p>Java, SQL.</p>',
    applyUrl: 'https://example.com/indiana-1',
  });

  // Non-tech role in Bengaluru should be penalized well below CS fresher SWE role
  const sweScore = scoreJobAgainstProfile(sweIntern, profile);
  const payrollScore = scoreJobAgainstProfile(payrollTrainee, profile);
  assert.ok(sweScore.score >= 85, `Expected SWE intern >= 85, got ${sweScore.score}`);
  assert.ok(payrollScore.score < 55, `Expected Payroll trainee < 55, got ${payrollScore.score}`);

  upsertJobsBatch(db, [sweIntern, payrollTrainee, indianaNewGrad], 'gh-test');

  // Default roleCategory='tech' excludes Payroll Trainee
  const techOnly = queryJobs(db, { roleCategory: 'tech' });
  assert.equal(techOnly.total, 2);
  assert.ok(techOnly.jobs.every((j) => j.title !== 'Payroll Industrial Trainee'));

  // roleCategory='all' includes all functions
  const allFuncs = queryJobs(db, { roleCategory: 'all' });
  assert.equal(allFuncs.total, 3);

  // locationPriority='india' must include Bengaluru SWE intern and exclude Indianapolis
  const indiaOnly = queryJobs(db, { locationPriority: 'india', roleCategory: 'all' });
  assert.ok(indiaOnly.jobs.every((j) => !j.location.includes('Indianapolis')));
  assert.equal(indiaOnly.total, 2);

  db.close();
});

test('Fetch hardening: retries 429/Retry-After, caches ETag 304, and source_health auto-disables at 5 errors', async () => {
  const db = initDb(':memory:');
  let calls = 0;
  const delays = [];
  const fakeFetch = async (url, init) => {
    calls += 1;
    if (calls === 1) {
      return new Response('rate limit', { status: 429, headers: { 'Retry-After': '1' } });
    }
    if (calls === 2) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ETag: '"v1"' } });
    }
    assert.equal(init.headers['If-None-Match'], '"v1"');
    return new Response(null, { status: 304 });
  };

  const first = await fetchWithHardening('https://api.example.com/jobs', {
    db,
    minGapMs: 0,
    baseDelayMs: 10,
    fetchImpl: fakeFetch,
    sleepImpl: async (ms) => delays.push(ms),
  });
  assert.equal(JSON.parse(first.text).ok, true);
  assert.equal(calls, 2);
  assert.equal(delays[0], 1000);

  const second = await fetchWithHardening('https://api.example.com/jobs', {
    db,
    minGapMs: 0,
    fetchImpl: fakeFetch,
    sleepImpl: async () => {},
  });
  assert.equal(second.status, 304);
  assert.equal(second.fromCache, true);
  assert.equal(JSON.parse(second.text).ok, true);

  db.prepare("INSERT INTO sources (id, name, type, tier, config, enabled) VALUES ('src-test', 'Test Source', 'greenhouse', 1, '{}', 1)").run();
  for (let i = 1; i <= 4; i++) {
    const res = recordSourceHealth(db, { sourceId: 'src-test', ok: false, error: 'timeout', durationMs: 500 });
    assert.equal(res.errorStreak, i);
    assert.equal(res.autoDisabled, false);
  }
  const fifth = recordSourceHealth(db, { sourceId: 'src-test', ok: false, error: 'timeout', durationMs: 500 });
  assert.equal(fifth.errorStreak, 5);
  assert.equal(fifth.autoDisabled, true);
  const src = db.prepare("SELECT enabled FROM sources WHERE id = 'src-test'").get();
  assert.equal(src.enabled, 0);

  const healthList = getSourcesHealth(db);
  assert.equal(healthList[0].id, 'src-test');
  assert.equal(healthList[0].error_streak, 5);

  const recovered = recordSourceHealth(db, { sourceId: 'src-test', ok: true, jobsCount: 12, durationMs: 250 });
  assert.equal(recovered.errorStreak, 0);
  db.close();
});

test('Workday parser normalizes real CXS search + detail fixture with Bengaluru detection', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/workday.json', import.meta.url), 'utf8'));
  const detailMap = new Map([[fixture.jobPostings[0].externalPath, fixture.detail]]);
  const parsed = parseWorkdayListings(fixture, detailMap, {
    id: 'wd-walmart',
    name: 'Walmart Global Tech',
    config: { tenant: 'walmart', wdNum: 504, site: 'WalmartExternal', companyName: 'Walmart' },
  });
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].source_type, 'workday');
  assert.equal(parsed[0].seniority, 'intern');
  assert.ok(parsed[0].apply_url.includes('WalmartExternal'));
  assert.ok(parsed[0].description_text.includes('Bengaluru'));
  assert.equal(classifyLocationTier(parsed[0].location, parsed[0].work_mode, parsed[0].description_text), 'bangalore');
});

test('Oracle HCM, Personio XML, Teamtailor RSS parsers & extended ATS fingerprinter', () => {
  const oracleFx = JSON.parse(fs.readFileSync(new URL('./fixtures/oracle-hcm.json', import.meta.url), 'utf8'));
  const oracleJobs = parseOracleHcm(oracleFx, {
    id: 'oracle-jpmc',
    name: 'JPMorgan Chase',
    config: { host: 'jpmc.fa.oraclecloud.com', site: 'CX_1001', companyName: 'JPMorgan Chase' },
  });
  assert.equal(oracleJobs.length, 3);
  assert.equal(oracleJobs[0].source_type, 'oracle_hcm');
  assert.ok(oracleJobs[0].apply_url.includes('jpmc.fa.oraclecloud.com'));

  const personioXml = fs.readFileSync(new URL('./fixtures/personio.xml', import.meta.url), 'utf8');
  const personioJobs = parsePersonioXml(personioXml, {
    id: 'personio-main',
    name: 'Personio',
    config: { slug: 'personio', companyName: 'Personio' },
  });
  assert.equal(personioJobs.length, 2);
  assert.equal(personioJobs[0].source_type, 'personio');
  assert.equal(personioJobs[0].location, 'Berlin');

  const ttXml = fs.readFileSync(new URL('./fixtures/teamtailor.xml', import.meta.url), 'utf8');
  const ttJobs = parseTeamtailorRss(ttXml, {
    id: 'teamtailor-main',
    name: 'Teamtailor',
    config: { host: 'career.teamtailor.com', companyName: 'Teamtailor' },
  });
  assert.equal(ttJobs.length, 3);
  assert.equal(ttJobs[0].source_type, 'teamtailor');
  assert.equal(ttJobs[0].work_mode, 'hybrid');

  assert.equal(detectAtsFromText('https://walmart.wd504.myworkdayjobs.com/WalmartExternal')?.type, 'workday');
  assert.equal(detectAtsFromText('https://zepto.keka.com/careers/jobs')?.type, 'keka');
  assert.equal(detectAtsFromText('https://company.darwinbox.in/ms/candidate/careers')?.type, 'darwinbox');
  assert.equal(detectAtsFromText('https://careers.qualcomm.com/careers?domain=qualcomm.com')?.type, 'eightfold');
  assert.equal(detectAtsFromText('https://acmecorp.jobs.personio.de/xml')?.type, 'personio');
  assert.equal(detectAtsFromText('https://acme.teamtailor.com/jobs')?.type, 'teamtailor');
  assert.equal(detectAtsFromText('https://acme.freshteam.com/jobs')?.type, 'freshteam');
  assert.equal(detectAtsFromText('https://acme.bamboohr.com/careers')?.type, 'bamboohr');
  assert.equal(detectAtsFromText('https://acme.breezy.hr/p/123')?.type, 'breezy');
  assert.equal(detectAtsFromText('https://careers-apac-atlassian.icims.com/jobs/123')?.type, 'icims');
});

test('Big Tech parsers normalize real Amazon, Google, Atlassian, and Apple fixtures', () => {
  const amazonFx = JSON.parse(fs.readFileSync(new URL('./fixtures/amazon.json', import.meta.url), 'utf8'));
  const amazonJobs = parseAmazonJobs(amazonFx, { id: 'bigtech-amazon' });
  assert.equal(amazonJobs.length, 3);
  assert.equal(amazonJobs[0].source_type, 'amazon');
  assert.equal(amazonJobs[0].seniority, 'intern');
  assert.ok(amazonJobs[0].skills.includes('Python'));

  const googleHtml = fs.readFileSync(new URL('./fixtures/google.html', import.meta.url), 'utf8');
  const googleJobs = parseGoogleCareersHtml(googleHtml, { id: 'bigtech-google' });
  assert.equal(googleJobs.length, 3);
  assert.equal(googleJobs[0].company, 'Google');
  assert.ok(googleJobs[0].location.includes('Bengaluru'));

  const atlassianFx = JSON.parse(fs.readFileSync(new URL('./fixtures/atlassian.json', import.meta.url), 'utf8'));
  const atlassianJobs = parseAtlassianListings(atlassianFx, { id: 'bigtech-atlassian' });
  assert.equal(atlassianJobs.length, 3);
  assert.equal(atlassianJobs[2].title, 'Data Platform Engineer');
  assert.ok(atlassianJobs[2].location.includes('Bengaluru'));

  const appleHtml = fs.readFileSync(new URL('./fixtures/apple.html', import.meta.url), 'utf8');
  const appleJobs = parseAppleCareersHtml(appleHtml, { id: 'bigtech-apple' });
  assert.equal(appleJobs.length, 3);
  assert.equal(appleJobs[2].title, 'MBA Internships');
  assert.equal(appleJobs[2].seniority, 'intern');
});

test('Indian boards parsers normalize real Internshala HTML and Instahyre JSON fixtures', () => {
  const isHtml = fs.readFileSync(new URL('./fixtures/internshala.html', import.meta.url), 'utf8');
  const isJobs = parseInternshalaHtml(isHtml, { id: 'india-internshala' });
  assert.ok(isJobs.length >= 2);
  assert.equal(isJobs[0].source_type, 'internshala');
  assert.equal(isJobs[0].company, 'Astrorize');
  assert.equal(isJobs[0].seniority, 'intern');
  assert.equal(isJobs[0].salary_currency, 'INR');
  assert.equal(isJobs[0].is_salary_estimated, false);
  assert.equal(isJobs[0].salary_min, 18000 * 12);

  const ihJson = JSON.parse(fs.readFileSync(new URL('./fixtures/instahyre.json', import.meta.url), 'utf8'));
  const ihJobs = parseInstahyreJson(ihJson, { id: 'india-instahyre' });
  assert.equal(ihJobs.length, 3);
  assert.equal(ihJobs[0].source_type, 'instahyre');
  assert.equal(ihJobs[0].company, 'D. E. Shaw');
  assert.ok(ihJobs[0].skills.includes('Python'));
});

test('LinkedIn guest parser & rate/429 backoff caps work properly', async () => {
  const liHtml = fs.readFileSync(new URL('./fixtures/linkedin-guest.html', import.meta.url), 'utf8');
  const jobs = parseLinkedInGuestCards(liHtml, { id: 'agg-linkedin-guest' });
  assert.equal(jobs.length, 3);
  assert.equal(jobs[0].source_type, 'linkedin_guest');
  assert.equal(jobs[0].company, 'Honeywell Technologies');
  assert.equal(jobs[0].seniority, 'intern');
  assert.ok(jobs[0].location.includes('Bengaluru'));

  const db = initDb(':memory:');
  let reqCount = 0;
  const mock429Fetch = async () => {
    reqCount += 1;
    return new Response('Too many requests', { status: 429 });
  };
  await scrapeLinkedInGuest(
    { id: 'agg-linkedin-guest', db },
    { keywords: ['SDE intern', 'ML intern'], locations: ['Bengaluru'], fetchImpl: mock429Fetch, delayMs: 0, sleepImpl: async () => {} }
  );
  assert.equal(reqCount, 1);
  const backoffUntil = Number(db.prepare("SELECT value FROM settings WHERE key = 'linkedin_backoff_until'").get()?.value || 0);
  assert.ok(backoffUntil > Date.now() + 5 * 3600 * 1000);

  db.prepare("DELETE FROM settings WHERE key = 'linkedin_backoff_until'").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('linkedin_run_timestamps', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify([Date.now(), Date.now() - 1000, Date.now() - 2000, Date.now() - 3000]));
  let blockedReqs = 0;
  const capped = await scrapeLinkedInGuest(
    { id: 'agg-linkedin-guest', db },
    { keywords: ['SDE intern'], locations: ['Bengaluru'], fetchImpl: async () => { blockedReqs += 1; return new Response(''); }, delayMs: 0 }
  );
  assert.equal(capped.length, 0);
  assert.equal(blockedReqs, 0);
  db.close();
});

test('POST /api/ingest enforces localhost + shared token and ingests extension jobs', async () => {
  const { server, db } = createApp({ dbPath: ':memory:' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const cfgRes = await fetch(`${baseUrl}/api/ingest/config`);
    assert.equal(cfgRes.status, 200);
    const { ingestToken } = await cfgRes.json();
    assert.ok(ingestToken && ingestToken.length >= 32);

    const payload = {
      sourceTag: 'wellfound_ext',
      pageUrl: 'https://wellfound.com/jobs',
      jobs: [
        {
          externalId: 'wf-9001',
          title: 'Backend Engineering Intern',
          company: 'Razorpay',
          location: 'Bengaluru, India',
          descriptionText: 'Node.js, TypeScript, SQL internship in Bengaluru. Stipend Rs 50,000/month.',
          applyUrl: 'https://wellfound.com/jobs/wf-9001',
        },
      ],
    };

    const unauth = await fetch(`${baseUrl}/api/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Jobby-Token': 'wrong-token' },
      body: JSON.stringify(payload),
    });
    assert.equal(unauth.status, 401);

    const okRes = await fetch(`${baseUrl}/api/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Jobby-Token': ingestToken,
        Origin: 'chrome-extension://abcdefghijklmnop',
      },
      body: JSON.stringify(payload),
    });
    assert.equal(okRes.status, 200);
    const body = await okRes.json();
    assert.equal(body.ok, true);
    assert.equal(body.received, 1);
    assert.equal(body.newCount, 1);

    const q = queryJobs(db, { q: 'Razorpay' });
    assert.equal(q.total, 1);
    assert.equal(q.jobs[0].source_type, 'wellfound_ext');
    assert.equal(q.jobs[0].seniority, 'intern');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('Auto-discovery scans ATS patterns, resolves offsite apply URLs, and promotes verified candidates', async () => {
  const { server, db } = createApp({ dbPath: ':memory:' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const extJob = normalizeJobPayload({
      sourceId: 'ext-linkedin-ext',
      sourceType: 'linkedin_ext',
      externalId: 'li-ext-1',
      title: 'Software Engineer Intern',
      company: 'AcmeCloud',
      location: 'Bengaluru, India',
      descriptionText: 'Apply directly via https://boards.greenhouse.io/acmecloud/jobs/4421001 and https://zepto.keka.com/careers/jobs',
      applyUrl: 'https://www.linkedin.com/jobs/view/999111',
    });

    resolveOffsiteAtsUrls([extJob]);
    assert.equal(extJob.apply_url, 'https://boards.greenhouse.io/acmecloud/jobs/4421001');

    const discovered = scanJobsForAtsCandidates(db, [extJob], 'ext-linkedin-ext');
    assert.ok(discovered.length >= 2);
    assert.ok(discovered.some((c) => c.type === 'greenhouse' && c.board_token === 'acmecloud'));
    assert.ok(discovered.some((c) => c.type === 'keka' && c.board_token === 'zepto'));

    const mockScrapeFn = async (src) => {
      if (src.type === 'greenhouse') {
        return [
          normalizeJobPayload({
            sourceId: src.id,
            sourceType: 'greenhouse',
            externalId: 'gh-ac-1',
            title: 'Graduate Software Engineer',
            company: 'AcmeCloud',
            location: 'Bengaluru, India',
            descriptionText: 'TypeScript and Python.',
            applyUrl: 'https://boards.greenhouse.io/acmecloud/jobs/4421002',
          }),
        ];
      }
      return [];
    };

    const promoted = await verifyPendingCandidates(db, { scrapeFn: mockScrapeFn, limit: 5 });
    assert.equal(promoted.length, 1);
    assert.equal(promoted[0].id, 'greenhouse-acmecloud');
    const srcRow = db.prepare("SELECT enabled, last_status FROM sources WHERE id = 'greenhouse-acmecloud'").get();
    assert.equal(srcRow.enabled, 1);
    assert.equal(srcRow.last_status, 'success');

    const candRes = await fetch(`${baseUrl}/api/sources/candidates`).then((r) => r.json());
    const kekaCand = candRes.candidates.find((c) => c.type === 'keka');
    assert.ok(kekaCand);

    const disableRes = await fetch(`${baseUrl}/api/sources/candidates/${encodeURIComponent(kekaCand.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'disable' }),
    });
    assert.equal(disableRes.status, 200);
    const updated = getSourceCandidates(db, 'disabled');
    assert.ok(updated.some((c) => c.id === kekaCand.id));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('Manual URL and EML/mbox importers ingest job alert emails and Schema.org JSON-LD pages', async () => {
  const mboxSample = [
    'From alerts@linkedin.com Mon Jan 12 09:00:00 2026',
    'From: LinkedIn Job Alerts <jobs-noreply@linkedin.com>',
    'Subject: "software engineer intern" in Bengaluru',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '<html><body><table><tr><td>',
    '<a href=3D"https://www.linkedin.com/comm/jobs/view/3988123456?trk=3Demail">Software Engineer Intern</a>',
    '<p>Atlassian - Bengaluru, India</p>',
    '<p>Stipend: Rs 80,000/month</p>',
    '</td></tr></table></body></html>',
    '',
    'From alerts@naukri.com Tue Jan 13 09:00:00 2026',
    'From: Naukri Alerts <alerts@naukri.com>',
    'Subject: New Internships from Internshala & Naukri',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<div><a href="https://internshala.com/internship/detail/backend-node-intern-at-finbox123">Backend Node.js Intern</a><p>FinBox · Bengaluru</p></div>',
    '<div><a href="https://www.naukri.com/job-listings-sde-1-fresher-zepto-bengaluru-12345">SDE 1 (Fresher)</a><p>Zepto · Bengaluru, India</p></div>',
    '<div><a href="https://wellfound.com/jobs/299100-ml-intern">ML Intern</a><p>Sarvam AI · Bengaluru</p></div>',
  ].join('\r\n');

  const emailJobs = parseJobAlertEmail(mboxSample);
  assert.equal(emailJobs.length, 4);
  assert.ok(emailJobs.some((j) => j.source_type === 'linkedin_email' && j.company === 'Atlassian'));
  assert.ok(emailJobs.some((j) => j.source_type === 'internshala_email' && j.title.includes('Backend')));
  assert.ok(emailJobs.some((j) => j.source_type === 'naukri_email' && j.title.includes('SDE 1')));
  assert.ok(emailJobs.some((j) => j.source_type === 'wellfound_email' && j.title === 'ML Intern'));

  const mockCareerServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Associate Software Engineer',
      hiringOrganization: { name: 'Groww' },
      jobLocation: { '@type': 'Place', address: { addressLocality: 'Bengaluru', addressCountry: 'IN' } },
      description: 'Java, Spring Boot, Microservices for 2026 new grads.',
      url: 'https://groww.in/careers/ase-1',
    })}</script></body></html>`);
  });

  const { server, db } = createApp({ dbPath: ':memory:' });
  await Promise.all([
    new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
    new Promise((resolve) => mockCareerServer.listen(0, '127.0.0.1', resolve)),
  ]);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const careerUrl = `http://127.0.0.1:${mockCareerServer.address().port}/careers`;

  try {
    const emlRes = await fetch(`${baseUrl}/api/import/eml`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: mboxSample,
    });
    assert.equal(emlRes.status, 200);
    const emlData = await emlRes.json();
    assert.equal(emlData.ok, true);
    assert.equal(emlData.parsedCount, 4);
    assert.equal(emlData.newCount, 4);

    const urlRes = await fetch(`${baseUrl}/api/import/url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: careerUrl, name: 'Groww' }),
    });
    assert.equal(urlRes.status, 200);
    const urlData = await urlRes.json();
    assert.equal(urlData.ok, true);
    assert.equal(urlData.outcome, 'json_ld_ingested');
    assert.equal(urlData.jobsFound, 1);

    const q = queryJobs(db, { q: 'Groww' });
    assert.equal(q.total, 1);
    assert.equal(q.jobs[0].seniority, 'junior');
  } finally {
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => mockCareerServer.close(resolve)),
    ]);
    db.close();
  }
});

test('City alias dedup, canonical URL multi-source merge with job_sources, and 14d aggregator expiry', () => {
  assert.equal(normalizeCityAliases('Bangalore, Karnataka, India'), 'bengaluru');
  assert.equal(normalizeCityAliases('BLR Urban'), 'bengaluru');
  assert.equal(normalizeCityAliases('Gurgaon, Haryana'), 'gurugram');

  const h1 = computeDedupeHash('Stripe', 'Software Engineer Intern', 'Bangalore, Karnataka');
  const h2 = computeDedupeHash('Stripe Inc.', 'Software Engineer Intern', 'Bengaluru Urban, IN');
  assert.equal(h1, h2);

  assert.equal(
    canonicalizeApplyUrl('https://boards.greenhouse.io/stripe/jobs/12345/?utm_source=linkedin&ref=abc#top'),
    'https://boards.greenhouse.io/stripe/jobs/12345'
  );

  const db = initDb(':memory:');
  db.prepare("INSERT INTO sources (id, name, type, tier, config, enabled) VALUES ('gh-stripe', 'Stripe', 'greenhouse', 1, '{}', 1)").run();
  db.prepare("INSERT INTO sources (id, name, type, tier, config, enabled) VALUES ('agg-linkedin-guest', 'LinkedIn Guest', 'linkedin_guest', 3, '{}', 1)").run();
  db.prepare("INSERT INTO sources (id, name, type, tier, config, enabled) VALUES ('simplify-internships', 'SimplifyJobs', 'simplify', 2, '{}', 1)").run();

  const linkedinJob = normalizeJobPayload({
    sourceId: 'agg-linkedin-guest',
    sourceType: 'linkedin_guest',
    externalId: 'li-stripe-1',
    title: 'Software Engineer Intern',
    company: 'Stripe',
    location: 'BLR, India',
    descriptionText: 'Backend internship on LinkedIn.',
    applyUrl: 'https://boards.greenhouse.io/stripe/jobs/12345?utm_source=linkedin',
  });
  upsertJobsBatch(db, [linkedinJob], 'agg-linkedin-guest');

  const ghJob = normalizeJobPayload({
    sourceId: 'gh-stripe',
    sourceType: 'greenhouse',
    externalId: '12345',
    title: 'Software Engineer Intern',
    company: 'Stripe',
    location: 'Bengaluru, India',
    descriptionText: 'Direct Greenhouse listing with TypeScript and Go.',
    applyUrl: 'https://boards.greenhouse.io/stripe/jobs/12345?ref=direct',
  });
  upsertJobsBatch(db, [ghJob], 'gh-stripe');

  const simpJob = normalizeJobPayload({
    sourceId: 'simplify-internships',
    sourceType: 'simplify',
    externalId: 'simp-stripe-1',
    title: 'Software Engineer Intern',
    company: 'Stripe',
    location: 'Bangalore',
    descriptionText: 'Listed on Simplify too.',
    applyUrl: 'https://boards.greenhouse.io/stripe/jobs/12345',
  });
  upsertJobsBatch(db, [simpJob], 'simplify-internships');

  const res = queryJobs(db, { q: 'Stripe' });
  assert.equal(res.total, 1);
  assert.equal(res.jobs[0].source_type, 'greenhouse');
  assert.equal(res.jobs[0].source_id, 'gh-stripe');
  const labels = res.jobs[0].also_on.map((x) => x.label).sort();
  assert.deepEqual(labels, ['LinkedIn', 'Simplify']);

  const bySecondarySource = queryJobs(db, { sourceType: 'linkedin_guest' });
  assert.equal(bySecondarySource.total, 1);
  assert.equal(bySecondarySource.jobs[0].id, res.jobs[0].id);

  const oldIso = new Date(Date.now() - 16 * 86400 * 1000).toISOString();
  const savedOld = normalizeJobPayload({
    sourceId: 'simplify-internships',
    sourceType: 'simplify',
    externalId: 'saved-old-1',
    title: 'New Grad Backend Engineer',
    company: 'Vercel',
    location: 'Remote',
    descriptionText: 'Node.js, TypeScript.',
    applyUrl: 'https://vercel.com/careers/old-1',
  });
  upsertJobsBatch(db, [savedOld], 'simplify-internships');
  db.prepare("UPDATE jobs SET last_seen_at = ? WHERE id = ?").run(oldIso, res.jobs[0].id);
  db.prepare("UPDATE jobs SET last_seen_at = ?, status = 'saved' WHERE external_id = 'saved-old-1'").run(oldIso);

  const expiredCount = expireStaleJobs(db, 14);
  assert.equal(expiredCount, 1);
  const afterExpire = queryJobs(db, {});
  assert.equal(afterExpire.total, 1);
  assert.equal(afterExpire.jobs[0].company, 'Vercel');
  db.close();
});

test('NLP additions: SDE-2 mid-level cue, eligibility penalty & batch filter, and salary confidence', () => {
  assert.equal(extractExperience('Building backend distributed systems.', 'Software Engineer 2').seniority, 'mid');
  assert.equal(extractExperience('Backend services', 'SDE 2').seniority, 'mid');
  assert.equal(extractExperience('Systems team', 'SWE II').seniority, 'mid');

  const elig = extractEligibility(
    'Open to 2025/2026 passouts from B.Tech / B.E / M.Tech / MCA in CS/IT/ECE with minimum 7.5 CGPA.',
    'Graduate Software Engineer'
  );
  assert.deepEqual(elig.batches, ['2025', '2026']);
  assert.equal(elig.minCgpa, 7.5);
  assert.ok(elig.degrees.includes('B.Tech'));
  assert.ok(elig.degrees.includes('M.Tech'));
  assert.ok(elig.degrees.includes('MCA'));
  assert.ok(elig.branches.includes('CS'));
  assert.ok(elig.branches.includes('IT'));
  assert.ok(elig.branches.includes('ECE'));

  const highPay = extractSalary('Stipend: ₹60,000/month in Bengaluru.');
  assert.equal(highPay.confidence, 'high');
  const medPay = estimateStipendBenchmark({ title: 'Software Engineer Intern', company: 'Groww', location: 'Bengaluru, India', seniority: 'intern' });
  assert.equal(medPay.confidence, 'med');
  assert.ok(medPay.basis.includes('groww'));
  const lowPay = estimateStipendBenchmark({ title: 'Software Engineer Intern', company: 'Stealth Startup', location: 'Bengaluru, India', seniority: 'intern', sourceType: 'workday' });
  assert.equal(lowPay.confidence, 'low');

  const job2026 = normalizeJobPayload({
    sourceId: 'gh-razorpay',
    sourceType: 'greenhouse',
    externalId: 'elig-2026',
    title: 'Software Engineer Intern',
    company: 'Groww',
    location: 'Bengaluru, India',
    descriptionText: 'Eligible for 2026 batch B.Tech CS/IT with 7.0+ CGPA. TypeScript, React, Node.js, PostgreSQL.',
    applyUrl: 'https://boards.greenhouse.io/groww/jobs/1',
  });
  assert.equal(job2026.salary_confidence, 'med');

  const job2025 = normalizeJobPayload({
    sourceId: 'gh-razorpay',
    sourceType: 'greenhouse',
    externalId: 'elig-2025',
    title: 'Software Engineer Intern - Platform',
    company: 'Groww',
    location: 'Bengaluru, India',
    descriptionText: 'Strictly for 2025 passouts B.Tech CS with 8.5 CGPA. TypeScript, React, Node.js, PostgreSQL.',
    applyUrl: 'https://boards.greenhouse.io/groww/jobs/2',
  });

  const profile2026 = {
    name: 'Test Student',
    headline: '2026 CS Student',
    target_titles: ['Software Engineer Intern'],
    primary_skills: ['TypeScript', 'React', 'Go', 'Kubernetes'],
    secondary_skills: [],
    excluded_skills: [],
    excluded_companies: [],
    target_companies: [],
    experience_years: 0.5,
    preferred_seniority: ['intern', 'junior'],
    work_modes: ['remote', 'hybrid', 'onsite'],
    preferred_locations: ['Bengaluru', 'Remote'],
    min_salary: 0,
    require_visa: 0,
    graduation_year: '2026',
    cgpa: 7.8,
    degree: 'B.Tech',
  };

  const fitScore = scoreJobAgainstProfile(job2026, profile2026);
  const mismatchScore = scoreJobAgainstProfile(job2025, profile2026);
  assert.equal(fitScore.breakdown.eligibility.fit, 'fit');
  assert.equal(mismatchScore.breakdown.eligibility.fit, 'batch_mismatch');
  assert.equal(fitScore.breakdown.bonusPts - mismatchScore.breakdown.bonusPts, 25);
  assert.ok(fitScore.score > mismatchScore.score);

  const db = initDb(':memory:');
  upsertJobsBatch(db, [job2026, job2025], 'gh-razorpay');
  const filtered2026 = queryJobs(db, { batch: '2026' });
  assert.equal(filtered2026.total, 1);
  assert.equal(filtered2026.jobs[0].external_id, 'elig-2026');

  const oldFirstSeen = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  db.prepare('UPDATE jobs SET first_seen_at = ? WHERE external_id = ?').run(oldFirstSeen, 'elig-2025');
  const freshOnly = queryJobs(db, { firstSeenHours: 24, sortBy: 'first_seen' });
  assert.equal(freshOnly.total, 1);
  assert.equal(freshOnly.jobs[0].external_id, 'elig-2026');
  db.close();
});
