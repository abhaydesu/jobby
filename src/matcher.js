// 100-Point Multi-Dimensional Profile Matching Engine,
// Resume Text Parser & Job Tailoring Generator

import { extractSkills, extractExperience, extractEligibility, extractWorkMode, classifyLocationTier, classifyRoleCategory, SKILL_TAXONOMY } from './nlp.js';

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
  } else if (locationTier === 'abroad' || locationTier === 'remote_restricted') {
    // Outside India / remote-but-country-locked: not realistically reachable for an India-based fresher
    locationRatio = 0;
    modeFit = locationTier;
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

  // Small tie-breaking nudges only — big bonuses saturate everything at 100 and destroy ranking
  let bonusPts = 0;
  if (locationTier === 'bangalore') {
    bonusPts += 4;
  } else if (locationTier === 'remote') {
    bonusPts += 3;
  } else if (locationTier === 'india') {
    bonusPts += 2;
  } else if (locationTier === 'abroad' || locationTier === 'remote_restricted') {
    bonusPts -= 30;
  }

  const isFresherProfile =
    prefSeniority.length > 0 &&
    prefSeniority.every((s) => s === 'intern' || s === 'junior');
  if (isFresherProfile && job.seniority && !prefSeniority.includes(job.seniority)) {
    // Unstated level is a "maybe", not a mismatch
    bonusPts -= job.seniority === 'unknown' ? 10 : 45;
  }

  if (roleCategory === 'non_tech') {
    bonusPts -= 38;
  }
  if (isFresherProfile && Number(job.experience_min) >= 2) {
    bonusPts -= 15;
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

  const eligibility = job.eligibility || extractEligibility(job.description_text || '', job.title || '');
  const resumeBatchMatch = /\b202[567]\b/.exec(`${profile?.headline || ''} ${profile?.resume_text || ''}`);
  const profileBatch = String(profile?.graduation_year || resumeBatchMatch?.[0] || '2026');
  const profileCgpa = profile?.cgpa != null ? Number(profile.cgpa) : null;
  const profileDegree = String(profile?.degree || 'B.Tech');

  let eligibilityFit = 'open';
  let eligibilityNote = '';
  if (eligibility.batches?.length > 0 && !eligibility.batches.includes(profileBatch)) {
    eligibilityFit = 'batch_mismatch';
    eligibilityNote = `Requires batch ${eligibility.batches.join('/')}`;
    bonusPts -= 25;
  } else if (eligibility.minCgpa && profileCgpa !== null && profileCgpa < eligibility.minCgpa) {
    eligibilityFit = 'cgpa_mismatch';
    eligibilityNote = `Requires ${eligibility.minCgpa}+ CGPA`;
    bonusPts -= 20;
  } else if (
    eligibility.degrees?.length > 0 &&
    !eligibility.degrees.some((d) => ['B.Tech', 'B.E', 'Bachelor'].includes(d) || d.toLowerCase() === profileDegree.toLowerCase()) &&
    eligibility.degrees.some((d) => ['PhD', 'M.Tech', 'MCA'].includes(d))
  ) {
    eligibilityFit = 'degree_mismatch';
    eligibilityNote = `Requires ${eligibility.degrees.join('/')}`;
    bonusPts -= 20;
  } else if (eligibility.batches?.length || eligibility.minCgpa || eligibility.degrees?.length || eligibility.branches?.length) {
    eligibilityFit = 'fit';
  }

  const salaryConfidence = job.salary_confidence || (job.is_salary_estimated ? 'low' : job.salary_min ? 'high' : 'none');
  const salaryBasis = job.salary_basis || (job.is_salary_estimated ? 'Market estimate' : job.salary_min ? 'Listed in job post' : '');

  const finalScore = Math.max(0, Math.min(100, Math.round(rawScore + bonusPts)));

  return {
    score: finalScore,
    breakdown: {
      locationTier,
      roleCategory,
      eligibility: {
        ...eligibility,
        fit: eligibilityFit,
        note: eligibilityNote,
      },
      salaryConfidence,
      salaryBasis,
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

  // Only trust explicit "N years of experience" statements. Year ranges on a student resume are
  // almost always education (e.g. "B.Tech 2023 – 2027"), not work experience.
  const estimatedYoe = exp.min;

  // Infer target titles from extracted skills & title mentions
  const inferredTitles = new Set();
  const titleChecks = [
    ['Full-Stack Engineer', /\b(full[- ]stack)\b/i],
    ['Software Engineer', /\b(software\s+engineer|swe|sde)\b/i],
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

  const isStudent = /\b(b\.?\s?tech|b\.?e\.?|bachelor|undergraduate|final[- ]year|student|expected\s+(graduation|20\d\d))\b/i.test(text);
  const yoe = estimatedYoe ?? (isStudent ? 0 : 2);
  let preferredSeniority = ['mid', 'senior'];
  if (yoe < 1 || isStudent) preferredSeniority = ['intern', 'junior'];
  else if (yoe <= 2) preferredSeniority = ['junior', 'mid'];
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
