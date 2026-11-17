// 100-Point Multi-Dimensional Profile Matching Engine,
// Resume Text Parser & Job Tailoring Generator

import { extractSkills, extractExperience, extractWorkMode, classifyLocationTier, classifyRoleCategory, SKILL_TAXONOMY } from './nlp.js';

const CANONICAL_SKILL_RX = new Map(SKILL_TAXONOMY.map(([name, , rx]) => [name.toLowerCase(), rx]));

function hasSkillInDescription(skillLower, descText) {
  if (!skillLower || !descText) return false;
  const canonicalRx = CANONICAL_SKILL_RX.get(skillLower);
  if (canonicalRx) return canonicalRx.test(descText);
  const escaped = skillLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(descText);
}

const STOP_WORDS = new Set([
  'the', 'and', 'or', 'for', 'of', 'in', 'to', 'a', 'an', 'with', 'at', 'on', 'by', 'is', 'as', 'sr', 'jr',
]);

function tokenizeTitle(str = '') {
  return String(str)
    .toLowerCase()
    .replace(/[^\w\s+/#.-]/g, ' ')
    .split(/[\s/,-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function normalizeWeights(weights = {}) {
  const raw = {
    title: Number(weights.title ?? 30),
    skills: Number(weights.skills ?? 35),
    location: Number(weights.location ?? 15),
    salary: Number(weights.salary ?? 10),
    experience: Number(weights.experience ?? 10),
  };
  const sum = raw.title + raw.skills + raw.location + raw.salary + raw.experience || 100;
  return {
    title: (raw.title / sum) * 100,
    skills: (raw.skills / sum) * 100,
    location: (raw.location / sum) * 100,
    salary: (raw.salary / sum) * 100,
    experience: (raw.experience / sum) * 100,
  };
}

export function scoreJobAgainstProfile(job, profile) {
  const w = normalizeWeights(profile?.weights);
  const jobTitle = String(job.title || '');
  const jobTitleLower = jobTitle.toLowerCase();
  const jobSkills = Array.isArray(job.skills) ? job.skills : [];
  const jobSkillsLower = new Set(jobSkills.map((s) => s.toLowerCase()));
  const jobDescRaw = String(job.description_text || '');
  const roleCategory = job.role_category || classifyRoleCategory(jobTitle, job.department, jobDescRaw);

  // 1. Title & Role Alignment
  const targetTitles = Array.isArray(profile?.target_titles) ? profile.target_titles : [];
  let titleRatio = 0.35; // neutral baseline if no target titles set
  let bestMatchedTitle = '';
  if (targetTitles.length > 0) {
    const jobTokens = new Set(tokenizeTitle(jobTitle));
    let bestScore = 0;
    for (const t of targetTitles) {
      const targetLower = String(t).toLowerCase().trim();
      if (!targetLower) continue;
      if (jobTitleLower.includes(targetLower)) {
        bestScore = 1.0;
        bestMatchedTitle = t;
        break;
      }
      const tTokens = tokenizeTitle(targetLower);
      if (tTokens.length === 0) continue;
      const overlap = tTokens.filter((tok) => jobTokens.has(tok)).length;
      const jaccardLike = overlap / tTokens.length;
      if (jaccardLike > bestScore) {
        bestScore = jaccardLike;
        bestMatchedTitle = t;
      }
    }
    titleRatio = bestScore;
  }

  // Seniority alignment nudges titleRatio slightly
  const prefSeniority = Array.isArray(profile?.preferred_seniority) ? profile.preferred_seniority : [];
  let seniorityMatch = 'neutral';
  if (prefSeniority.length > 0 && job.seniority && job.seniority !== 'unknown') {
    if (prefSeniority.includes(job.seniority)) {
      seniorityMatch = 'exact';
      titleRatio = Math.min(1, titleRatio + 0.12);
    } else if (
      (job.seniority === 'intern' || job.seniority === 'executive') &&
      !prefSeniority.includes(job.seniority)
    ) {
      seniorityMatch = 'mismatch';
      titleRatio = Math.max(0, titleRatio - 0.35);
    } else {
      seniorityMatch = 'adjacent';
      titleRatio = Math.max(0, titleRatio - 0.1);
    }
  }

  if (roleCategory === 'non_tech') {
    titleRatio = 0;
  }

  // 2. Skills & Stack Alignment
  const primarySkills = Array.isArray(profile?.primary_skills) ? profile.primary_skills : [];
  const secondarySkills = Array.isArray(profile?.secondary_skills) ? profile.secondary_skills : [];
  const excludedSkills = Array.isArray(profile?.excluded_skills) ? profile.excluded_skills : [];

  const matchedPrimary = [];
  const matchedSecondary = [];
  const userAllSkillsLower = new Set();

  for (const s of primarySkills) {
    const lower = String(s).toLowerCase().trim();
    if (!lower) continue;
    userAllSkillsLower.add(lower);
    if (jobSkillsLower.has(lower) || hasSkillInDescription(lower, jobDescRaw)) {
      matchedPrimary.push(s);
    }
  }
  for (const s of secondarySkills) {
    const lower = String(s).toLowerCase().trim();
    if (!lower) continue;
    userAllSkillsLower.add(lower);
    if (jobSkillsLower.has(lower) || hasSkillInDescription(lower, jobDescRaw)) {
      matchedSecondary.push(s);
    }
  }

  const missingJobSkills = jobSkills.filter((s) => !userAllSkillsLower.has(s.toLowerCase()));

  let skillsRatio = 0.5;
  if (jobSkills.length > 0 && primarySkills.length > 0) {
    // Evaluate both: how much of the job's stack you cover + how many of your primary skills appear
    const jobCoverage = (matchedPrimary.length + matchedSecondary.length * 0.6) / Math.max(1, Math.min(jobSkills.length, 6));
    const userCoverage = matchedPrimary.length / Math.max(1, Math.min(primarySkills.length, 5));
    skillsRatio = Math.min(1, jobCoverage * 0.65 + userCoverage * 0.35 + (matchedSecondary.length > 0 ? 0.1 : 0));
  } else if (primarySkills.length > 0) {
    // Job didn't list standard tech skills (e.g. non-tech or sparse post)
    const descOverlap = matchedPrimary.length / Math.max(1, Math.min(primarySkills.length, 4));
    skillsRatio = Math.min(1, 0.25 + descOverlap * 0.75);
  }

  const excludedHits = [];
  for (const ex of excludedSkills) {
    const lower = String(ex).toLowerCase().trim();
    if (!lower) continue;
    if (jobTitleLower.includes(lower) || jobSkillsLower.has(lower)) {
      excludedHits.push(ex);
    }
  }

  // 3. Location & Work Mode Fit (with Bangalore & Remote Priority)
  const prefModes = Array.isArray(profile?.work_modes) ? profile.work_modes : ['remote', 'hybrid'];
  const prefLocations = Array.isArray(profile?.preferred_locations) ? profile.preferred_locations : [];
  const jobLocLower = String(job.location || '').toLowerCase();
  const locationTier = classifyLocationTier(job.location, job.work_mode, job.description_text);

  let locationRatio = 0.45;
  let modeFit = 'unknown';
  if (prefModes.includes(job.work_mode)) {
    locationRatio = job.work_mode === 'remote' ? 0.95 : 0.8;
    modeFit = 'matched';
  } else if (job.work_mode === 'unknown') {
    locationRatio = 0.55;
    modeFit = 'unknown';
  } else {
    locationRatio = 0.2;
    modeFit = 'mismatch';
  }

  let locationMatched = null;
  if (locationTier === 'bangalore') {
    locationRatio = 1.0;
    locationMatched = 'Bengaluru';
    modeFit = 'priority_bangalore';
  } else if (locationTier === 'remote') {
    locationRatio = 1.0;
    locationMatched = 'Remote';
    modeFit = 'priority_remote';
  } else if (locationTier === 'india') {
    locationRatio = Math.max(locationRatio, 0.8);
    locationMatched = 'India';
  } else if (prefLocations.length > 0 && jobLocLower) {
    for (const loc of prefLocations) {
      const l = String(loc).toLowerCase().trim();
      if (!l) continue;
      if (jobLocLower.includes(l)) {
        locationRatio = 1.0;
        locationMatched = loc;
        break;
      }
    }
  }

  // 4. Compensation Fit
  const minSalary = Number(profile?.min_salary || 0);
  let salaryRatio = 0.65; // partial neutral credit when unlisted so unlisted ATS roles still rank fairly
  let salaryFit = 'unlisted';
  const jobMax = Number(job.salary_max || job.salary_min || 0);
  const jobMin = Number(job.salary_min || job.salary_max || 0);
  if (minSalary > 0 && jobMax > 0) {
    if (jobMax >= minSalary) {
      salaryRatio = jobMin >= minSalary ? 1.0 : 0.9;
      salaryFit = 'meets_target';
    } else {
      const ratio = jobMax / minSalary;
      salaryRatio = Math.max(0.1, Math.min(0.8, ratio * 0.85));
      salaryFit = 'below_target';
    }
  } else if (jobMax > 0) {
    salaryRatio = 1.0;
    salaryFit = 'listed';
  }

  // 5. Experience Fit
  const userYoe = Number(profile?.experience_years ?? 4);
  let expRatio = 0.75;
  let expFit = 'neutral';
  if (job.experience_min !== null && job.experience_min !== undefined) {
    const diff = userYoe - Number(job.experience_min);
    if (diff >= 0 && diff <= 5) {
      expRatio = 1.0;
      expFit = 'ideal';
    } else if (diff >= -1 && diff < 0) {
      expRatio = 0.85;
      expFit = 'stretch';
    } else if (diff < -1) {
      expRatio = Math.max(0.15, 0.7 + diff * 0.15);
      expFit = 'under_yoe';
    } else {
      expRatio = 0.8;
      expFit = 'overqualified';
    }
  } else if (seniorityMatch === 'exact') {
    expRatio = 1.0;
    expFit = 'ideal';
  } else if (seniorityMatch === 'mismatch') {
    expRatio = 0.25;
    expFit = 'seniority_mismatch';
  }

  // Compute Weighted Score
  const titlePts = Math.round(titleRatio * w.title);
  const skillsPts = Math.round(skillsRatio * w.skills);
  const locationPts = Math.round(locationRatio * w.location);
  const salaryPts = Math.round(salaryRatio * w.salary);
  const expPts = Math.round(expRatio * w.experience);

  let rawScore = titlePts + skillsPts + locationPts + salaryPts + expPts;

  // Target / Excluded Company Adjustments & Visa Requirement
  const companyLower = String(job.company || '').toLowerCase();
  const targetCompanies = Array.isArray(profile?.target_companies) ? profile.target_companies : [];
  const excludedCompanies = Array.isArray(profile?.excluded_companies) ? profile.excluded_companies : [];

  let bonusPts = 0;
  if (locationTier === 'bangalore') {
    bonusPts += 12;
  } else if (locationTier === 'remote') {
    bonusPts += 10;
  } else if (locationTier === 'india') {
    bonusPts += 4;
  }

  const isFresherProfile =
    prefSeniority.length > 0 &&
    prefSeniority.every((s) => s === 'intern' || s === 'junior');
  if (isFresherProfile && job.seniority && !prefSeniority.includes(job.seniority)) {
    bonusPts -= 45;
  }

  if (roleCategory === 'non_tech') {
    bonusPts -= 38;
  } else if (roleCategory !== 'other') {
    bonusPts += 4;
  }

  if (targetCompanies.some((c) => c && companyLower.includes(String(c).toLowerCase().trim()))) {
    bonusPts += 8;
  }
  if (excludedCompanies.some((c) => c && companyLower.includes(String(c).toLowerCase().trim()))) {
    bonusPts -= 50;
  }
  if (excludedHits.length > 0) {
    bonusPts -= excludedHits.length * 12;
  }
  if (profile?.require_visa && !job.visa_sponsorship && job.work_mode !== 'remote') {
    bonusPts -= 10;
  }

  const finalScore = Math.max(0, Math.min(100, Math.round(rawScore + bonusPts)));

  return {
    score: finalScore,
    breakdown: {
      locationTier,
      roleCategory,
      dimensions: {
        title: { earned: titlePts, max: Math.round(w.title), matchedTitle: bestMatchedTitle || null, seniorityMatch },
        skills: { earned: skillsPts, max: Math.round(w.skills) },
        location: { earned: locationPts, max: Math.round(w.location), modeFit, locationMatched },
        salary: { earned: salaryPts, max: Math.round(w.salary), salaryFit },
        experience: { earned: expPts, max: Math.round(w.experience), expFit },
      },
      bonusPts,
      matchedPrimary,
      matchedSecondary,
      missingJobSkills: missingJobSkills.slice(0, 12),
      excludedHits,
    },
  };
}

export function parseResumeText(resumeText = '') {
  const text = String(resumeText || '');
  const extractedSkills = extractSkills(text, []);
  const exp = extractExperience(text, '');
  const mode = extractWorkMode(text, '', '');

  // Estimate total years from date ranges like "2019 - 2026" or "2020 - Present"
  let estimatedYoe = exp.min;
  const yearMatches = text.match(/\b(200\d|201\d|202\d)\b/g);
  if (yearMatches && yearMatches.length >= 2) {
    const years = yearMatches.map(Number).sort((a, b) => a - b);
    const span = new Date().getFullYear() - years[0];
    if (span >= 1 && span <= 25) {
      estimatedYoe = estimatedYoe ? Math.max(estimatedYoe, span) : span;
    }
  }

  // Infer target titles from extracted skills & title mentions
  const inferredTitles = new Set();
  const titleChecks = [
    ['Full-Stack Engineer', /\b(full[- ]stack)\b/i],
    ['Senior Software Engineer', /\b(software\s+engineer|swe)\b/i],
    ['Backend Engineer', /\b(backend|back-end|distributed\s+systems)\b/i],
    ['Frontend Engineer', /\b(frontend|front-end|ui\s+engineer)\b/i],
    ['AI / ML Engineer', /\b(ai\s+engineer|machine\s+learning|llm|ml\s+engineer)\b/i],
    ['Platform / DevOps Engineer', /\b(devops|sre|platform\s+engineer|site\s+reliability)\b/i],
    ['Data Engineer', /\b(data\s+engineer|etl|analytics\s+engineer)\b/i],
    ['Product Manager', /\b(product\s+manager)\b/i],
    ['Product Designer', /\b(product\s+designer|ux\s+designer)\b/i],
  ];
  for (const [label, rx] of titleChecks) {
    if (rx.test(text)) inferredTitles.add(label);
  }
  if (inferredTitles.size === 0) {
    if (extractedSkills.some((s) => ['PyTorch', 'LLMs', 'RAG', 'Machine Learning'].includes(s))) {
      inferredTitles.add('AI / ML Engineer');
    }
    if (extractedSkills.some((s) => ['React', 'Next.js', 'TypeScript'].includes(s))) {
      inferredTitles.add('Full-Stack Engineer');
    }
    inferredTitles.add('Software Engineer');
  }

  const yoe = estimatedYoe ?? 4;
  let preferredSeniority = ['mid', 'senior'];
  if (yoe <= 1) preferredSeniority = ['junior', 'mid'];
  else if (yoe >= 6) preferredSeniority = ['senior', 'staff', 'lead'];

  return {
    primary_skills: extractedSkills.slice(0, 14),
    secondary_skills: extractedSkills.slice(14, 24),
    experience_years: yoe,
    target_titles: Array.from(inferredTitles),
    preferred_seniority: preferredSeniority,
    work_modes: mode === 'onsite' ? ['hybrid', 'onsite'] : ['remote', 'hybrid'],
  };
}

export function generateJobTailoring(job, profile) {
  const scored = scoreJobAgainstProfile(job, profile);
  const { matchedPrimary, matchedSecondary, missingJobSkills } = scored.breakdown;
  const topMatched = [...matchedPrimary, ...matchedSecondary].slice(0, 6);
  const company = job.company || 'your team';
  const title = job.title || 'this role';
  const userYoe = profile?.experience_years ?? 4;

  const atsKeywords = Array.from(new Set([...(job.skills || []), ...matchedPrimary])).slice(0, 15);

  const resumeSummary =
    `Results-driven engineer with ${userYoe}+ years of experience building scalable production systems` +
    (topMatched.length ? ` using ${topMatched.slice(0, 4).join(', ')}` : '') +
    `. Proven track record shipping high-reliability architecture aligned with ${company}'s needs for ${title}.`;

  const bulletTemplates = [
    `Architected and scaled end-to-end production services using ${topMatched.slice(0, 3).join(', ') || 'modern full-stack technologies'}, improving latency and system reliability under high concurrency.`,
    `Led cross-functional execution from technical design through deployment, incorporating automated testing, observability, and CI/CD best practices relevant to ${title}.`,
    missingJobSkills.length > 0
      ? `Rapidly adopted adjacent ecosystem tools and collaborated closely with infrastructure/product teams to bridge gaps across ${missingJobSkills.slice(0, 2).join(' and ')}.`
      : `Delivered measurable product impact with clean APIs, resilient data pipelines, and strong developer ergonomics.`,
  ];

  const gapAdvice = missingJobSkills.length
    ? `This posting mentions ${missingJobSkills.slice(0, 4).join(', ')}, which ${missingJobSkills.length === 1 ? 'is' : 'are'} not currently in your core profile. Emphasize transferable architectural experience in your cover note or add concrete project examples where you used comparable tools.`
    : `Your skill profile strongly covers the core technical stack detected in this posting. Focus on quantifying scale, ownership, and business impact.`;

  const outreachNote =
    `Hi Hiring Team at ${company},\n\n` +
    `I'm excited to apply for the ${title} opening${job.location ? ` (${job.location})` : ''}. ` +
    `With ${userYoe}+ years of hands-on experience in ${topMatched.slice(0, 4).join(', ') || 'software engineering'}, ` +
    `I've focused on shipping resilient, user-centric systems that align directly with what ${company} is building.\n\n` +
    `I'd welcome the chance to share more about my recent work and how I can contribute immediately to the team.\n\n` +
    `Best,\n${profile?.name || 'Candidate'}`;

  return {
    matchScore: scored.score,
    atsKeywords,
    strengths: topMatched,
    missingSkills: missingJobSkills,
    gapAdvice,
    resumeSummary,
    bulletTemplates,
    outreachNote,
  };
}
