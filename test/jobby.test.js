import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  stripHtmlToText,
  sanitizeHtml,
  extractSkills,
  extractSalary,
  extractExperience,
  extractWorkMode,
  extractVisaSponsorship,
  classifyLocationTier,
  classifyRoleCategory,
  estimateStipendBenchmark,
} from '../src/nlp.js';
import { scoreJobAgainstProfile, parseResumeText, generateJobTailoring } from '../src/matcher.js';
import { initDb, getProfile, updateProfile, upsertJobsBatch, queryJobs } from '../src/db.js';
import { normalizeJobPayload } from '../src/scrapers/normalize.js';
import { detectAtsFromText, extractJsonLdJobPostings } from '../src/scrapers/fingerprinter.js';
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
