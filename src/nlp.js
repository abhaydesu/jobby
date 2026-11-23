// Deep NLP Job Intelligence Extractor
// Extracts skills (135+ taxonomy), normalized annual salaries, experience/seniority,
// work mode, visa sponsorship signals, and green/red flags.

const HTML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&ndash;': '–',
  '&mdash;': '—',
  '&bull;': '•',
  '&rsquo;': '’',
  '&lsquo;': '‘',
  '&rdquo;': '”',
  '&ldquo;': '“',
  '&hellip;': '...',
};

export function decodeHtmlEntities(str = '') {
  if (!str) return '';
  let out = String(str).replace(
    /&(amp|lt|gt|quot|apos|nbsp|ndash|mdash|bull|rsquo|lsquo|rdquo|ldquo|hellip|#39|#x27);/gi,
    (m) => HTML_ENTITIES[m.toLowerCase()] ?? m
  );
  out = out.replace(/&#(\d+);/g, (_, code) => {
    const num = Number(code);
    return Number.isFinite(num) && num > 0 && num < 0x10ffff ? String.fromCodePoint(num) : _;
  });
  out = out.replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
    const num = parseInt(hex, 16);
    return Number.isFinite(num) && num > 0 && num < 0x10ffff ? String.fromCodePoint(num) : _;
  });
  return out;
}

export function stripHtmlToText(html = '') {
  if (!html) return '';
  let text = String(html);
  // Some ATS APIs (like Greenhouse) double-encode HTML entities inside content
  if (/&lt;[a-z!/]/i.test(text)) {
    text = decodeHtmlEntities(text);
  }
  text = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ');
  text = decodeHtmlEntities(text);
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sanitizeHtml(html = '') {
  if (!html) return '';
  let clean = String(html);
  if (/&lt;[a-z!/]/i.test(clean)) {
    clean = decodeHtmlEntities(clean);
  }
  clean = clean
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');

  // If the input looks like plain text without block tags, convert line breaks
  if (!/<(p|div|ul|ol|li|h[1-6]|br)\b/i.test(clean)) {
    return clean
      .split(/\n{2,}/)
      .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
      .join('\n');
  }
  return clean.trim();
}

// 135+ Canonical Technical & Product Skills Taxonomy
// Each entry: [canonicalName, category, regexPattern]
export const SKILL_TAXONOMY = [
  // Languages
  ['TypeScript', 'Languages', /\b(typescript|ts)\b/i],
  ['JavaScript', 'Languages', /\b(javascript|ecmascript|es6)\b/i],
  ['Python', 'Languages', /\bpython\b/i],
  ['Go', 'Languages', /\b(golang)\b|\bGo\b(?=\s*[,/)|]|\s+(?:developer|engineer|backend|services|code|or|and))/],
  ['Rust', 'Languages', /\brust\b/i],
  ['Java', 'Languages', /\bjava\b(?!\s*script)/i],
  ['C++', 'Languages', /(?:^|[\s(/,])c\+\+(?:$|[\s),./;:])/i],
  ['C#', 'Languages', /(?:^|[\s(/,])c#(?:$|[\s),./;:])/i],
  ['C', 'Languages', /(?:^|[\s(/,])c\s*\/\s*c\+\+|\bembedded\s+c\b/i],
  ['Kotlin', 'Languages', /\bkotlin\b/i],
  ['Swift', 'Languages', /\bswift\b/i],
  ['Ruby', 'Languages', /\bruby\b/i],
  ['PHP', 'Languages', /\bphp\b/i],
  ['Scala', 'Languages', /\bscala\b/i],
  ['Elixir', 'Languages', /\belixir\b/i],
  ['SQL', 'Languages', /\b(sql|t-sql|pl\/sql)\b/i],
  ['Bash', 'Languages', /\b(bash|shell\s+scripting|zsh)\b/i],
  ['HTML/CSS', 'Languages', /\b(html5?|css3?|scss|sass)\b/i],

  // Frontend
  ['React', 'Frontend', /\b(react(?:\.js|js)?)\b/i],
  ['Next.js', 'Frontend', /\b(next\.js|nextjs)\b/i],
  ['React Native', 'Frontend', /\breact\s+native\b/i],
  ['Vue.js', 'Frontend', /\b(vue(?:\.js|js)?|nuxt(?:\.js)?)\b/i],
  ['Angular', 'Frontend', /\bangular(?:js)?\b/i],
  ['Svelte', 'Frontend', /\b(svelte|sveltekit)\b/i],
  ['Tailwind CSS', 'Frontend', /\b(tailwind(?:\s*css)?)\b/i],
  ['Redux', 'Frontend', /\b(redux|zustand|recoil)\b/i],
  ['Webpack/Vite', 'Frontend', /\b(webpack|vite|esbuild|turbopack|rollup)\b/i],
  ['WebGL/Three.js', 'Frontend', /\b(webgl|three\.js|threejs|canvas)\b/i],
  ['WebAssembly', 'Frontend', /\b(webassembly|wasm)\b/i],
  ['Accessibility (a11y)', 'Frontend', /\b(accessibility|wcag|a11y|aria)\b/i],
  ['iOS', 'Frontend', /\b(ios|uikit|swiftui|xcode)\b/i],
  ['Android', 'Frontend', /\b(android|jetpack\s+compose)\b/i],
  ['Flutter', 'Frontend', /\bflutter\b/i],

  // Backend & APIs
  ['Node.js', 'Backend', /\b(node\.js|nodejs)\b/i],
  ['Express', 'Backend', /\bexpress(?:\.js)?\b/i],
  ['NestJS', 'Backend', /\bnestjs\b/i],
  ['FastAPI', 'Backend', /\bfastapi\b/i],
  ['Django', 'Backend', /\bdjango\b/i],
  ['Flask', 'Backend', /\bflask\b/i],
  ['Spring Boot', 'Backend', /\bspring(?:\s+boot|\s+framework)?\b/i],
  ['Ruby on Rails', 'Backend', /\b(ruby\s+on\s+rails|rails)\b/i],
  ['.NET', 'Backend', /(?:^|[\s(/,])\.net(?:\s+core)?\b/i],
  ['Laravel', 'Backend', /\blaravel\b/i],
  ['GraphQL', 'Backend', /\bgraphql\b/i],
  ['REST APIs', 'Backend', /\b(rest(?:ful)?\s+apis?|openapi|swagger)\b/i],
  ['gRPC', 'Backend', /\b(grpc|protobuf|protocol\s+buffers)\b/i],
  ['WebSockets', 'Backend', /\b(websockets?|socket\.io|sse|server-sent\s+events)\b/i],
  ['WebRTC', 'Backend', /\bwebrtc\b/i],
  ['Microservices', 'Backend', /\bmicroservices?\b/i],
  ['Distributed Systems', 'Backend', /\bdistributed\s+systems?\b/i],
  ['Event-Driven Architecture', 'Backend', /\b(event[- ]driven|pub\/sub|message\s+queue)\b/i],

  // Databases & Storage
  ['PostgreSQL', 'Data & Storage', /\b(postgres(?:ql)?|pgvector)\b/i],
  ['MySQL', 'Data & Storage', /\b(mysql|mariadb)\b/i],
  ['SQLite', 'Data & Storage', /\bsqlite\b/i],
  ['MongoDB', 'Data & Storage', /\b(mongodb|mongoose)\b/i],
  ['Redis', 'Data & Storage', /\bredis\b/i],
  ['Elasticsearch', 'Data & Storage', /\b(elasticsearch|opensearch|elastic\s+stack)\b/i],
  ['DynamoDB', 'Data & Storage', /\bdynamodb\b/i],
  ['Cassandra', 'Data & Storage', /\bcassandra\b/i],
  ['ClickHouse', 'Data & Storage', /\bclickhouse\b/i],
  ['Snowflake', 'Data & Storage', /\bsnowflake\b/i],
  ['BigQuery', 'Data & Storage', /\bbigquery\b/i],
  ['Redshift', 'Data & Storage', /\bredshift\b/i],
  ['DuckDB', 'Data & Storage', /\bduckdb\b/i],
  ['Supabase', 'Data & Storage', /\bsupabase\b/i],
  ['Firebase', 'Data & Storage', /\bfirebase\b/i],
  ['Prisma', 'Data & Storage', /\bprisma\b/i],

  // Data Engineering & Streaming
  ['Kafka', 'Data & AI', /\b(kafka|confluent|redpanda)\b/i],
  ['Spark', 'Data & AI', /\b(apache\s+spark|pyspark|spark)\b/i],
  ['Airflow', 'Data & AI', /\bairflow\b/i],
  ['dbt', 'Data & AI', /\bdbt\b/i],
  ['Databricks', 'Data & AI', /\bdatabricks\b/i],
  ['Flink', 'Data & AI', /\b(apache\s+flink|flink)\b/i],
  ['Ray', 'Data & AI', /\b(ray\s+cluster|anyscale|ray\.io|pytorch\s+and\s+ray)\b/i],
  ['ETL/ELT', 'Data & AI', /\b(etl|elt|data\s+pipelines?|data\s+warehousing)\b/i],

  // AI / ML / LLM
  ['Machine Learning', 'Data & AI', /\b(machine\s+learning|ml\s+models?|ml\s+engineering)\b/i],
  ['Deep Learning', 'Data & AI', /\b(deep\s+learning|neural\s+networks?|transformers?)\b/i],
  ['LLMs', 'Data & AI', /\b(llms?|large\s+language\s+models?|foundation\s+models?|genai|generative\s+ai)\b/i],
  ['RAG', 'Data & AI', /\b(rag|retrieval[- ]augmented\s+generation|vector\s+(?:db|database|search))\b/i],
  ['AI Agents', 'Data & AI', /\b(ai\s+agents?|agentic|multi-agent|tool\s+calling)\b/i],
  ['PyTorch', 'Data & AI', /\bpytorch\b/i],
  ['TensorFlow', 'Data & AI', /\btensorflow\b/i],
  ['JAX', 'Data & AI', /\bjax\b/i],
  ['Scikit-learn', 'Data & AI', /\b(scikit-learn|sklearn)\b/i],
  ['Pandas/NumPy', 'Data & AI', /\b(pandas|numpy|polars)\b/i],
  ['LangChain', 'Data & AI', /\b(langchain|langgraph|llamaindex)\b/i],
  ['OpenAI API', 'Data & AI', /\b(openai|anthropic|claude\s+api|gemini\s+api)\b/i],
  ['Hugging Face', 'Data & AI', /\bhugging\s*face\b/i],
  ['NLP', 'Data & AI', /\b(nlp|natural\s+language\s+processing)\b/i],
  ['Computer Vision', 'Data & AI', /\b(computer\s+vision|opencv|diffusion\s+models?)\b/i],
  ['CUDA', 'Data & AI', /\b(cuda|triton|gpu\s+programming)\b/i],
  ['MLOps', 'Data & AI', /\b(mlops|mlflow|weights\s*&\s*biases|wandb|vllm|sagemaker)\b/i],

  // Cloud & DevOps
  ['AWS', 'Cloud & DevOps', /\b(aws|amazon\s+web\s+services|ec2|s3|ecs|eks|lambda)\b/i],
  ['GCP', 'Cloud & DevOps', /\b(gcp|google\s+cloud(?:\s+platform)?|gke|cloud\s+run)\b/i],
  ['Azure', 'Cloud & DevOps', /\b(microsoft\s+azure|azure)\b/i],
  ['Docker', 'Cloud & DevOps', /\b(docker|containers?|containerization)\b/i],
  ['Kubernetes', 'Cloud & DevOps', /\b(kubernetes|k8s|helm|istio)\b/i],
  ['Terraform', 'Cloud & DevOps', /\b(terraform|opentofu|pulumi|iac|infrastructure\s+as\s+code)\b/i],
  ['Linux', 'Cloud & DevOps', /\b(linux|unix|ubuntu|debian)\b/i],
  ['CI/CD', 'Cloud & DevOps', /\b(ci\/cd|github\s+actions|gitlab\s+ci|jenkins|circleci|buildkite)\b/i],
  ['Ansible', 'Cloud & DevOps', /\bansible\b/i],
  ['Cloudflare', 'Cloud & DevOps', /\b(cloudflare|workers)\b/i],
  ['Vercel', 'Cloud & DevOps', /\bvercel\b/i],
  ['Nginx', 'Cloud & DevOps', /\b(nginx|envoy|haproxy)\b/i],
  ['Serverless', 'Cloud & DevOps', /\bserverless\b/i],

  // Observability, Testing & Security
  ['Datadog', 'Observability & QA', /\bdatadog\b/i],
  ['Prometheus/Grafana', 'Observability & QA', /\b(prometheus|grafana|opentelemetry|otel|jaeger|sentry)\b/i],
  ['Playwright', 'Observability & QA', /\bplaywright\b/i],
  ['Cypress', 'Observability & QA', /\bcypress\b/i],
  ['Selenium', 'Observability & QA', /\bselenium\b/i],
  ['Jest/Vitest', 'Observability & QA', /\b(jest|vitest|pytest|unit\s+testing|integration\s+testing)\b/i],
  ['Security/Auth', 'Observability & QA', /\b(oauth2?|oidc|saml|sso|jwt|zero\s+trust|soc\s*2|appsec|cryptography)\b/i],

  // Product, Design & Leadership
  ['System Design', 'Architecture & Product', /\bsystem\s+design\b/i],
  ['Product Management', 'Architecture & Product', /\b(product\s+management|product\s+strategy|roadmap)\b/i],
  ['Figma', 'Architecture & Product', /\bfigma\b/i],
  ['UI/UX Design', 'Architecture & Product', /\b(ui\/ux|user\s+experience|design\s+systems?|prototyping)\b/i],
  ['Agile/Scrum', 'Architecture & Product', /\b(agile|scrum|kanban)\b/i],
  ['Git', 'Architecture & Product', /\b(git|github|gitlab)\b/i],
  ['Payments/Fintech', 'Architecture & Product', /\b(stripe|payments?|fintech|ledger|billing)\b/i],
  ['Blockchain/Web3', 'Architecture & Product', /\b(blockchain|solidity|ethereum|web3|smart\s+contracts?)\b/i],
];

const SKILL_LOOKUP = new Map(SKILL_TAXONOMY.map(([name, cat, rx]) => [name.toLowerCase(), { name, cat, rx }]));

export function normalizeSkillName(raw = '') {
  const clean = String(raw).trim();
  if (!clean) return '';
  const lower = clean.toLowerCase();
  const aliasMap = {
    ts: 'TypeScript',
    js: 'JavaScript',
    golang: 'Go',
    reactjs: 'React',
    'react.js': 'React',
    nextjs: 'Next.js',
    nodejs: 'Node.js',
    postgres: 'PostgreSQL',
    k8s: 'Kubernetes',
    llm: 'LLMs',
    genai: 'LLMs',
    'generative ai': 'LLMs',
    ml: 'Machine Learning',
    tailwind: 'Tailwind CSS',
    tailwindcss: 'Tailwind CSS',
    rest: 'REST APIs',
    'rest api': 'REST APIs',
    css: 'HTML/CSS',
    html: 'HTML/CSS',
    vue: 'Vue.js',
    vuejs: 'Vue.js',
    'c plus plus': 'C++',
    cpp: 'C++',
    csharp: 'C#',
    dotnet: '.NET',
  };
  if (aliasMap[lower]) return aliasMap[lower];
  if (SKILL_LOOKUP.has(lower)) return SKILL_LOOKUP.get(lower).name;
  return clean;
}

export function extractSkills(text = '', extraTags = []) {
  const found = new Set();
  const content = String(text || '');

  for (const [name, , rx] of SKILL_TAXONOMY) {
    if (rx.test(content)) {
      found.add(name);
    }
  }

  if (Array.isArray(extraTags)) {
    for (const tag of extraTags) {
      if (!tag) continue;
      const normalized = normalizeSkillName(tag);
      if (SKILL_LOOKUP.has(normalized.toLowerCase())) {
        found.add(normalized);
      } else {
        // Check if tag itself matches any taxonomy regex
        for (const [name, , rx] of SKILL_TAXONOMY) {
          if (rx.test(String(tag))) found.add(name);
        }
      }
    }
  }

  return Array.from(found);
}

export function getSkillCategory(skillName = '') {
  const hit = SKILL_LOOKUP.get(String(skillName).toLowerCase());
  return hit ? hit.cat : 'Other';
}

function parseAmountToken(rawNum, suffix = '') {
  const clean = Number(String(rawNum).replace(/,/g, ''));
  if (!Number.isFinite(clean)) return null;
  if (suffix && suffix.toLowerCase() === 'k') return Math.round(clean * 1000);
  if (clean < 1000 && clean >= 20 && !suffix) {
    // Could be hourly rate (handled separately) or implicit k in ranges like "150 - 180k"
    return clean;
  }
  return Math.round(clean);
}

export function extractSalary(text = '', structured = null) {
  if (structured && (structured.min || structured.max)) {
    let min = structured.min ? Number(structured.min) : null;
    let max = structured.max ? Number(structured.max) : null;
    const period = (structured.period || 'year').toLowerCase();
    const currency = (structured.currency || 'USD').toUpperCase();

    if (period === 'hour' || period === 'hourly') {
      if (min && min < 500) min = Math.round(min * 2080);
      if (max && max < 500) max = Math.round(max * 2080);
    } else if (period === 'month' || period === 'monthly') {
      if (min && min < 40000) min = Math.round(min * 12);
      if (max && max < 40000) max = Math.round(max * 12);
    }

    if ((min && min >= 20000 && min <= 1200000) || (max && max >= 20000 && max <= 1200000)) {
      return {
        min: min || max,
        max: max || min,
        currency,
        period: 'year',
        raw: structured.raw || `${currency} ${min || ''}${max && max !== min ? ` - ${max}` : ''}`,
        estimated: false,
        confidence: 'high',
        basis: 'Listed in job posting',
      };
    }
  }

  const content = String(text || '');
  if (!content) return { min: null, max: null, currency: 'USD', period: 'year', raw: '', estimated: false, confidence: 'none', basis: '' };

  const currencyMap = { '$': 'USD', '£': 'GBP', '€': 'EUR' };

  // 1. Annual salary range patterns: $140,000 - $185,000 | $140k - $180k | 140k-180k USD
  const annualRangeRx =
    /([$£€]|USD|EUR|GBP|CAD|AUD)?\s*(\d{2,3}(?:,\d{3})+|\d{2,3}\s*[kK])\s*(?:-|–|—|to)\s*([$£€]|USD|EUR|GBP|CAD|AUD)?\s*(\d{2,3}(?:,\d{3})+|\d{2,3}\s*[kK])(?:\s*(?:USD|EUR|GBP|CAD|AUD))?(?:\s*(?:per\s+year|\/\s*yr|\/\s*year|annually|base|salary|compensation))?/gi;

  let match;
  while ((match = annualRangeRx.exec(content)) !== null) {
    const sym1 = match[1] || match[3] || '';
    const token1 = match[2];
    const token2 = match[4];
    const hasK1 = /k/i.test(token1);
    const hasK2 = /k/i.test(token2);

    let v1 = parseAmountToken(token1.replace(/k/i, ''), hasK1 ? 'k' : hasK2 ? 'k' : '');
    let v2 = parseAmountToken(token2.replace(/k/i, ''), hasK2 ? 'k' : '');

    // Check same-clause context (stop at sentence boundary . ! ?) to avoid funding/revenue false positives
    const beforeRaw = content.slice(Math.max(0, match.index - 45), match.index);
    const beforeClause = beforeRaw.split(/[.!?\n]/).pop() || '';
    const afterRaw = content.slice(match.index + match[0].length, match.index + match[0].length + 45);
    const afterClause = afterRaw.split(/[.!?\n]/)[0] || '';
    const clause = `${beforeClause} ${afterClause}`;
    if (/\b(raised|funding|series\s+[a-e]|valuation|revenue|arr|users|customers|downloads)\b/i.test(clause)) {
      continue;
    }

    if (v1 && v2 && v1 >= 25000 && v2 >= v1 && v2 <= 950000) {
      const currency = currencyMap[sym1] || (sym1 ? sym1.toUpperCase() : 'USD');
      return {
        min: v1,
        max: v2,
        currency,
        period: 'year',
        raw: match[0].trim(),
        estimated: false,
        confidence: 'high',
        basis: 'Listed annual range in job post',
      };
    }
  }

  const inrMonthlyRx =
    /(?:₹|INR|Rs\.?)\s*(\d{1,3}(?:,\d{2,3})+|\d{2,3}\s*[kK]|\d{5,6})(?:\s*(?:-|–|—|to)\s*(?:₹|INR|Rs\.?)?\s*(\d{1,3}(?:,\d{2,3})+|\d{2,3}\s*[kK]|\d{5,6}))?\s*(?:\/\s*mo(?:nth)?|per\s+month|p\.?\s*m\.?|monthly|stipend)/gi;
  while ((match = inrMonthlyRx.exec(content)) !== null) {
    const t1 = match[1];
    const t2 = match[2] || t1;
    const m1 = parseAmountToken(t1.replace(/k/i, ''), /k/i.test(t1) ? 'k' : '');
    const m2 = parseAmountToken(t2.replace(/k/i, ''), /k/i.test(t2) ? 'k' : '');
    if (m1 && m2 && m1 >= 5000 && m2 >= m1 && m2 <= 400000) {
      return {
        min: Math.round(m1 * 12),
        max: Math.round(m2 * 12),
        currency: 'INR',
        period: 'year',
        raw: match[0].trim(),
        estimated: false,
        confidence: 'high',
        basis: 'Listed INR monthly stipend in job post',
      };
    }
  }

  const inrLpaRx =
    /(?:₹|INR|Rs\.?)?\s*(\d{1,2}(?:\.\d{1,2})?)\s*(?:(?:-|–|—|to)\s*(\d{1,2}(?:\.\d{1,2})?))?\s*(?:LPA|Lakhs?\s*(?:per\s+annum|p\.?\s*a\.?))/gi;
  while ((match = inrLpaRx.exec(content)) !== null) {
    const l1 = Number(match[1]);
    const l2 = Number(match[2] || l1);
    if (l1 >= 2 && l2 >= l1 && l2 <= 95) {
      return {
        min: Math.round(l1 * 100000),
        max: Math.round(l2 * 100000),
        currency: 'INR',
        period: 'year',
        raw: match[0].trim(),
        estimated: false,
        confidence: 'high',
        basis: 'Listed LPA CTC in job post',
      };
    }
  }

  // Annual INR CTC in lakh notation: "₹ 3,50,000 - 5,00,000", "INR 12,00,000 per annum"
  const inrAnnualRx =
    /(?:₹|INR|Rs\.?)\s*(\d{1,2},\d{2},\d{3}|\d{6,7})(?:\s*(?:-|–|—|to)\s*(?:₹|INR|Rs\.?)?\s*(\d{1,2},\d{2},\d{3}|\d{6,7}))?(?!\s*(?:\/\s*mo|per\s+month|p\.?\s*m\.?|monthly))/gi;
  while ((match = inrAnnualRx.exec(content)) !== null) {
    const a1 = Number(match[1].replace(/,/g, ''));
    const a2 = Number((match[2] || match[1]).replace(/,/g, ''));
    const ctx = content.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40);
    if (/\b(raised|funding|series\s+[a-e]|valuation|revenue|crore)\b/i.test(ctx)) continue;
    if (a1 >= 100000 && a2 >= a1 && a2 <= 9500000) {
      return {
        min: a1,
        max: a2,
        currency: 'INR',
        period: 'year',
        raw: match[0].trim(),
        estimated: false,
        confidence: 'high',
        basis: 'Listed INR annual CTC in job post',
      };
    }
  }

  const fxMonthlyRx =
    /([$£€])\s*(\d{1,2}(?:,\d{3})+|\d{1,2}(?:\.\d)?\s*[kK])(?:\s*(?:-|–|—|to)\s*([$£€])?\s*(\d{1,2}(?:,\d{3})+|\d{1,2}(?:\.\d)?\s*[kK]))?\s*(?:\/\s*mo(?:nth)?|per\s+month|monthly)/gi;
  while ((match = fxMonthlyRx.exec(content)) !== null) {
    const sym = match[1] || match[3] || '$';
    const t1 = match[2];
    const t2 = match[4] || t1;
    const m1 = parseAmountToken(t1.replace(/k/i, ''), /k/i.test(t1) ? 'k' : '');
    const m2 = parseAmountToken(t2.replace(/k/i, ''), /k/i.test(t2) ? 'k' : '');
    if (m1 && m2 && m1 >= 800 && m2 >= m1 && m2 <= 30000) {
      return {
        min: Math.round(m1 * 12),
        max: Math.round(m2 * 12),
        currency: currencyMap[sym] || 'USD',
        period: 'year',
        raw: match[0].trim(),
        estimated: false,
        confidence: 'high',
        basis: 'Listed monthly compensation in job post',
      };
    }
  }

  const hourlyRangeRx =
    /([$£€])\s*(\d{2,3}(?:\.\d{1,2})?)\s*(?:\/\s*hr|\/\s*hour|per\s+hour)?\s*(?:-|–|—|to)\s*([$£€])?\s*(\d{2,3}(?:\.\d{1,2})?)\s*(?:\/\s*hr|\/\s*hour|per\s+hour|an\s+hour)/gi;
  while ((match = hourlyRangeRx.exec(content)) !== null) {
    const h1 = Number(match[2]);
    const h2 = Number(match[4]);
    if (h1 >= 15 && h2 >= h1 && h2 <= 450) {
      const currency = currencyMap[match[1]] || 'USD';
      return {
        min: Math.round(h1 * 2080),
        max: Math.round(h2 * 2080),
        currency,
        period: 'year',
        raw: match[0].trim(),
        estimated: false,
        confidence: 'high',
        basis: 'Listed hourly pay range in job post',
      };
    }
  }

  const singleAnnualRx =
    /(?:salary|compensation|base\s+pay|ote|pay)\s*(?:of|:|is|around|up\s+to)?\s*([$£€])\s*(\d{2,3}(?:,\d{3})+|\d{2,3}\s*[kK])(?:\s*\+)?|([$£€])\s*(\d{2,3}(?:,\d{3})+|\d{2,3}\s*[kK])\s*(?:\/\s*yr|\/\s*year|per\s+year|annually)/gi;
  while ((match = singleAnnualRx.exec(content)) !== null) {
    const sym = match[1] || match[3] || '$';
    const rawNum = match[2] || match[4];
    const hasK = /k/i.test(rawNum);
    const val = parseAmountToken(rawNum.replace(/k/i, ''), hasK ? 'k' : '');
    if (val && val >= 25000 && val <= 950000) {
      return {
        min: val,
        max: val,
        currency: currencyMap[sym] || 'USD',
        period: 'year',
        raw: match[0].trim(),
        estimated: false,
        confidence: 'high',
        basis: 'Listed salary figure in job post',
      };
    }
  }

  return { min: null, max: null, currency: 'USD', period: 'year', raw: '', estimated: false, confidence: 'none', basis: '' };
}

// Geographic eligibility for an India-based candidate.
//   bangalore          — Bengaluru (onsite/hybrid/remote)
//   india              — elsewhere in India
//   remote             — remote and open to India (India-remote, worldwide, APAC, or unrestricted)
//   remote_restricted  — remote, but limited to another country/region (e.g. "Remote - US")
//   abroad             — onsite/hybrid outside India
//   unknown            — no usable location
const INDIA_CITY_RX = /\b(india|hyderabad|pune|mumbai|gurgaon|gurugram|noida|chennai|delhi|ncr|kolkata|ahmedabad|kochi|jaipur|indore|chandigarh|coimbatore|thiruvananthapuram|trivandrum|mysore|mysuru|bhubaneswar|nagpur|vadodara|lucknow)\b/i;
const GLOBAL_REMOTE_RX = /\b(anywhere|worldwide|world\s*wide|global(ly)?|international|apac|asia|any\s+location|all\s+locations|work\s+from\s+home|wfh)\b/i;
const FOREIGN_REGION_RX = /\b(us|u\.s\.?|usa|united\s+states|america|americas|north\s+america|latam|latin\s+america|canada|mexico|brazil|argentina|colombia|chile|uk|u\.k\.|united\s+kingdom|england|london|ireland|europe|european|eu|emea|germany|france|spain|portugal|netherlands|poland|romania|sweden|switzerland|italy|cet|est|pst|australia|new\s+zealand|anz|japan|singapore|philippines|south\s+africa|nigeria|kenya|israel|dubai|uae|[a-z .]+,\s*(ca|ny|wa|tx|ma|co|il|ga|nc|va|fl|or|az|pa|nj|ut|mn|mi|oh|md|dc))\b/i;
const BODY_RESTRICTION_RX = /\b(must|should|need\s+to|required\s+to)\s+(be\s+)?(located|based|reside|residing|live)\s+in\s+(the\s+)?(us|u\.s\.|usa|united\s+states|canada|uk|united\s+kingdom|europe|eu)\b|\b(us|usa|u\.s\.|uk|eu|canada)[- ]only\b|\bauthori[sz]ed\s+to\s+work\s+in\s+the\s+(us|u\.s\.|united\s+states)\b/i;

export function classifyLocationTier(location = '', workMode = '', text = '') {
  const loc = String(location || '').trim();
  const bodyHead = String(text || '').slice(0, 2500);
  if (/\b(bangalore|bengaluru|blr|karnataka)\b/i.test(loc)) return 'bangalore';
  const isRemote = workMode === 'remote' || /\b(remote|anywhere|worldwide|wfh|work\s+from\s+home|distributed)\b/i.test(loc);
  if (INDIA_CITY_RX.test(loc)) {
    if (/\b(bangalore|bengaluru)\b/i.test(bodyHead) && /^\s*india\s*$/i.test(loc)) return 'bangalore';
    return isRemote ? 'remote' : 'india';
  }

  if (isRemote) {
    // Strip remote markers so "Remote" itself is never read as a region
    const regionPart = loc.replace(/\b(remote|fully|100%|work\s+from\s+home|wfh|distributed|hybrid|onsite|on-site|job)\b/gi, ' ');
    const scopedAnywhere = /\banywhere\s+in\s+(?!the\s+world)/i.test(loc);
    if (GLOBAL_REMOTE_RX.test(loc) && !scopedAnywhere) return 'remote';
    if (FOREIGN_REGION_RX.test(regionPart)) return 'remote_restricted';
    if (BODY_RESTRICTION_RX.test(bodyHead)) return 'remote_restricted';
    // A remote role that names a specific non-Indian city ("San Francisco / Remote") is almost always country-bound
    if (/[a-z]{3,}/i.test(regionPart.replace(/[^a-z\s]/gi, ' ').trim())) return 'remote_restricted';
    return 'remote';
  }

  if (!loc || /^(unspecified|n\/a|tbd|multiple locations?|various)$/i.test(loc)) return 'unknown';
  return 'abroad';
}

/** Tiers a candidate based in India can realistically apply to. */
export const ELIGIBLE_LOCATION_TIERS = ['bangalore', 'india', 'remote', 'unknown'];

export function classifyRoleCategory(title = '', department = '', text = '') {
  const titleStr = String(title || '').trim();
  const deptStr = String(department || '').trim();
  const titleAndDept = `${titleStr} ${deptStr}`;

  const hasExplicitEngTitle = /\b(software|full[- ]?stack|front[- ]?end|back[- ]?end|\bsde\b|\bswe\b|\bmts\b|member\s+of\s+technical\s+staff|devops|\bsre\b|site\s+reliability|cloud\s+engineer|security\s+engineer|data\s+engineer|data\s+scientist|machine\s+learning|ml\s+engineer|ai\s+engineer|research\s+engineer|research\s+scientist|solutions?\s+engineer|sales\s+engineer|forward\s+deployed|customer\s+(?:experience|solutions)\s+engineer|design\s+engineer|product\s+manager|\bapm\b|product\s+designer|ui\/ux|ux\s+designer|qa\s+engineer|\bsdet\b|embedded|firmware|developer|programmer|architect)\b/i.test(titleStr);

  // Explicit non-technical roles checked FIRST unless the title also explicitly names an engineering/product track
  const nonTechTitleRx = /\b(payroll|accountant|accounts\s+(?:receivable|payable)|accounting|bookkeep(?:er|ing)|tax\b|auditor?|audit\b|paralegal|legal\s+counsel|general\s+counsel|human\s+resources|\bhr\b|hr\/ta|hr-manager|recruiter|recruiting|talent\s+acquisition|account\s+executive|account\s+manager|sales\s+(?:rep|representative|development|executive|associate|intern|talent)|business\s+development|\bbdr\b|\bsdr\b|customer\s+(?:support|service|success|care)|risk\s+operations|fraud\s+operations|verifications?\s+operations|product\s+support\s+operations|benefits\s+operations|receptionist|office\s+assistant|copywriter|content\s+(?:creator|moderator|reviewer|writer)|social\s+media|public\s+relations|real\s+estate|clinical|nurs(?:e|ing)|underwriter|go-to-market|programmatic\s+advertising|investment\s+&\s+strategy|wealth|finance\s+manager|vertrieb|finanz(?:buchhaltung)?|kaufmännisch|personal(?:entwicklung|beratung)|einkauf|buchhaltung|industrial\s+trainee)\b/i;

  if (!hasExplicitEngTitle && nonTechTitleRx.test(titleStr)) {
    return 'non_tech';
  }

  // Non-tech departments without technical title markers
  if (
    !hasExplicitEngTitle &&
    !/\b(engineer|developer|software|data|ai|ml|product|design|security|devops|cloud|research|analyst|sde|swe)\b/i.test(titleStr) &&
    /\b(human\s+resources|people|recruiting|talent|finance|legal|accounting|sales|customer\s+support|customer\s+success|facilities|workplace|marketing|communications)\b/i.test(deptStr)
  ) {
    return 'non_tech';
  }

  if (/\b(ai\b|artificial\s+intelligence|machine\s+learning|\bml\b|deep\s+learning|\bllms?\b|\bnlp\b|computer\s+vision|data\s+scien(?:tist|ce)|data\s+engineer|analytics\s+engineer|data\s+analyst|research\s+(?:engineer|scientist)|ml\s+research|ai\s+research|quant(?:itative)?\s+(?:researcher|developer|analyst|trader))\b/i.test(titleAndDept)) {
    return 'ai_data';
  }

  if (/\b(devops|\bsre\b|site\s+reliability|infrastructure\s+engineer|platform\s+engineer|cloud\s+(?:engineer|architect)|security\s+engineer|appsec|infosec|cybersecurity|network\s+engineer|release\s+engineer|build\s+engineer|devsecops)\b/i.test(titleStr)) {
    return 'devops_sec';
  }

  if (/\b(software|full[- ]?stack|front[- ]?end|back[- ]?end|\bsde\b|\bswe\b|\bmts\b|member\s+of\s+technical\s+staff|mobile\s+engineer|ios\s+(?:developer|engineer)|android\s+(?:developer|engineer)|flutter|react\s+native|systems?\s+engineer|embedded|firmware|kernel|compiler|distributed\s+systems|application\s+(?:engineer|developer)|web\s+developer|game\s+developer|\bqa\b|\bsdet\b|test\s+engineer|automation\s+engineer|robotics\s+engineer|engineer\b|developer\b|programmer|hardware\s+engineer|asic|fpga|verilog)\b/i.test(titleStr)) {
    return 'swe';
  }

  if (/\b(product\s+manager|\bapm\b|associate\s+product|technical\s+program\s+manager|program\s+manager|product\s+designer|ui\/ux|ux\s+designer|ui\s+designer|ux\s+researcher|design\s+engineer|solutions?\s+engineer|sales\s+engineer|forward\s+deployed|customer\s+(?:experience|solutions)\s+engineer|devrel|developer\s+(?:advocate|relations))\b/i.test(titleStr)) {
    return 'product_design';
  }

  // Fallback on text/department only if unambiguously engineering
  if (/\b(engineering|r&d|research\s+&\s+development)\b/i.test(deptStr) && !nonTechTitleRx.test(titleStr)) {
    return 'swe';
  }
  if (/\b(software\s+engineering|full[- ]?stack\s+development|backend\s+services)\b/i.test(String(text || '').slice(0, 600)) && !nonTechTitleRx.test(titleStr)) {
    return 'swe';
  }

  return 'other';
}

export function extractExperience(text = '', title = '') {
  // Underscores ("Java Lead_Vice President") would otherwise defeat \b word boundaries
  const titleStr = String(title || '').replace(/_/g, ' ');
  const content = String(text || '');

  // Extract Years of Experience (YOE)
  let minYoe = null;
  let maxYoe = null;

  const yoeRangeRx = /(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\+?\s*years?(?:\s+of)?(?:\s+\w+){0,3}\s+(?:experience|background)/gi;
  const yoeMinRx = /(?:minimum\s+(?:of\s+)?|at\s+least\s+|requires?\s+)?(\d{1,2})\+\s*years?(?:\s+of)?(?:\s+\w+){0,3}\s+(?:experience|in\s+|with\s+)/gi;

  const rMatch = yoeRangeRx.exec(content);
  if (rMatch) {
    const a = Number(rMatch[1]);
    const b = Number(rMatch[2]);
    if (a >= 0 && b >= a && b <= 20) {
      minYoe = a;
      maxYoe = b;
    }
  } else {
    // "3+ years …", then plus-less forms: "minimum 2 years", "0 years of experience"
    const mMatch =
      yoeMinRx.exec(content) ||
      /(?:minimum\s+(?:of\s+)?|at\s+least\s+|requires?\s+)(\d{1,2})\s*years?\b/i.exec(content) ||
      /\b(\d{1,2})\s*years?\s+of\s+(?:\w+\s+){0,2}experience\b/i.exec(content);
    if (mMatch) {
      const a = Number(mMatch[1]);
      if (a >= 0 && a <= 20) {
        minYoe = a;
      }
    }
  }

  const roleCategory = classifyRoleCategory(titleStr, '', content);

  // Classify seniority from title + body fresher cues (final-year/intern/new-grad aware)
  const internRx = /\b(interns?|internships?|co-?ops?|working\s+student|student\s+assistant|werkstudent|praktikum|stagiaire|apprentice|apprenticeship|trainee|fellowship|summer\s+20\d\d)\b/i;
  const execRx = /\b(vp|vice\s+president|chief|cto|ceo|cpo|cfo|head\s+of|director|associate\s+(?:director|vp|vice\s+president|partner|general\s+counsel))\b/i;
  const staffRx = /\b(staff|principal|distinguished|fellow|architect)\b/i;
  const leadRx = /\b(lead|tech\s+lead|team\s+lead|engineering\s+manager|manager)\b/i;
  const seniorRx = /\b(senior|sr\.?|iii|iv|v|l4|l5|l6|founding)\b/i;
  const midTitleRx = /\b(mid[- ]level|(?:software\s+engineer|engineer|developer|sde|swe|mts|member\s+of\s+technical\s+staff|analyst|scientist|designer)[- ]*(?:2|ii)|level\s*2|l3)\b/i;
  const juniorTitleRx = /\b(junior|jr\.?|entry[- ]level|early[- ]career|new\s+grad(?:uate)?|university\s+grad(?:uate)?|recent\s+grad(?:uate)?|graduate\s+(?:engineer|developer|analyst|program|trainee)|fresher|campus|associate\s+(?:(?:software|frontend|backend|full[- ]?stack|platform|cloud|devops|data|ml|ai|security|qa|quality|test|systems|solutions|technical|research|product|ux|ui|customer\s+experience)\s+)?(?:engineer|developer|scientist|analyst|designer|manager|researcher|architect|sde|swe|pm)|(?:software|engineering|product|data|ai|ml|technical|research|design)\s+associate|apm|sde[- ]?1|sde[- ]?i\b|swe[- ]?1|swe[- ]?i\b|engineer\s+i\b|developer\s+i\b|analyst\s+i\b|level\s*1\b|l1\b|l2\b|2026|2027)\b/i;
  const fresherBodyRx = /\b(new\s+grad(?:uate)?s?|recent\s+grad(?:uate)?s?|final[- ]year|pursuing\s+a\s+(?:bachelor|master|degree|b\.?tech|b\.?e|b\.?s)|0\s*(?:-|–|to)\s*[12]\+?\s*years|less\s+than\s+[12]\s+years|no\s+prior\s+experience|entry[- ]level|early[- ]career|university\s+recruiting|fresher)\b/i;

  const isExplicitEntryException = /\b(associate\s+product\s+manager|apm|junior\s+.*manager|inbound\s+product\s+manager\s*\(.*202\d\)|program\s+manager\s+intern)\b/i.test(titleStr);
  const hasSeniorTitle =
    execRx.test(titleStr) ||
    staffRx.test(titleStr) ||
    (leadRx.test(titleStr) && !isExplicitEntryException) ||
    seniorRx.test(titleStr);

  let seniority = 'unknown';
  if (internRx.test(titleStr)) {
    seniority = 'intern';
  } else if (execRx.test(titleStr)) {
    seniority = 'executive';
  } else if (staffRx.test(titleStr)) {
    seniority = 'staff';
  } else if (leadRx.test(titleStr) && !isExplicitEntryException) {
    seniority = 'lead';
  } else if (seniorRx.test(titleStr)) {
    seniority = 'senior';
  } else if (midTitleRx.test(titleStr)) {
    seniority = 'mid';
  } else if (juniorTitleRx.test(titleStr) && (minYoe === null || minYoe <= 2)) {
    seniority = 'junior';
  } else if (
    roleCategory !== 'non_tech' &&
    !hasSeniorTitle &&
    (minYoe === null || minYoe <= 1) &&
    (minYoe !== null || fresherBodyRx.test(content.slice(0, 2500)))
  ) {
    seniority = 'junior';
  } else if (minYoe !== null) {
    if (minYoe <= 1) seniority = roleCategory === 'non_tech' ? 'mid' : 'junior';
    else if (minYoe <= 4) seniority = 'mid';
    else if (minYoe <= 7) seniority = 'senior';
    else seniority = 'staff';
  }
  // A plain "Software Engineer" with no stated experience stays 'unknown' rather than an assumed 'mid':
  // startups and Indian product companies often hire freshers into such roles without saying so.

  return { min: minYoe, max: maxYoe, seniority };
}

export function extractEligibility(text = '', title = '') {
  const content = `${title || ''}\n${text || ''}`;
  const batches = new Set();

  const prefixBatchRx =
    /(?:class\s+of|batch(?:\s+of)?|pass[- ]?outs?(?:\s+of)?|graduat(?:ing|es?|ion)\s+(?:in|of|year|batch)?|cohort(?:\s+of)?)\s*[:\-]?\s*(202[2-9](?:\s*(?:\/|,|&|and|or|-|to)\s*202[2-9])*)/gi;
  let m;
  while ((m = prefixBatchRx.exec(content)) !== null) {
    for (const yr of m[1].match(/202[2-9]/g) || []) {
      batches.add(yr);
    }
  }

  const suffixBatchRx =
    /(202[2-9](?:\s*(?:\/|,|&|and|or|-|to)\s*202[2-9])*)\s*(?:batch|pass[- ]?outs?|graduating(?:\s+batch)?|grads?|graduates?)/gi;
  while ((m = suffixBatchRx.exec(content)) !== null) {
    for (const yr of m[1].match(/202[2-9]/g) || []) {
      batches.add(yr);
    }
  }

  let minCgpa = null;
  const cgpaBeforeRx = /(?:minimum|min\.?|at\s+least|cutoff|cut[- ]?off)?\s*(?:cgpa|cpi|gpa)\s*(?:of|>=|>|:|at\s+least|minimum)?\s*(\d(?:\.\d{1,2})?)(?:\s*\/\s*(4|10))?/gi;
  while ((m = cgpaBeforeRx.exec(content)) !== null) {
    const rawVal = Number(m[1]);
    const scale = m[2] ? Number(m[2]) : rawVal <= 4 ? 10 : 10;
    const normalized = m[2] === '4' ? Number(((rawVal / scale) * 10).toFixed(2)) : rawVal;
    if (normalized >= 4 && normalized <= 10) {
      minCgpa = minCgpa === null ? normalized : Math.max(minCgpa, normalized);
    }
  }
  const cgpaAfterRx = /(\d(?:\.\d{1,2})?)\s*\+?\s*(?:\/\s*(4|10)\s*)?(?:cgpa|cpi)/gi;
  while ((m = cgpaAfterRx.exec(content)) !== null) {
    const rawVal = Number(m[1]);
    const normalized = m[2] === '4' ? Number(((rawVal / 4) * 10).toFixed(2)) : rawVal;
    if (normalized >= 4 && normalized <= 10) {
      minCgpa = minCgpa === null ? normalized : Math.max(minCgpa, normalized);
    }
  }

  const degrees = [];
  const degreePatterns = [
    ['B.Tech', /\b(?:b\.?\s*tech|bachelor\s+of\s+technology)\b/i],
    ['B.E', /\bB\.E\.?\b|\bBE(?=\s*[/,&)])|\bbachelor\s+of\s+engineering\b/i],
    ['M.Tech', /\b(?:m\.?\s*tech|master\s+of\s+technology)\b/i],
    ['MCA', /\b(?:m\.?\s*c\.?\s*a|master\s+of\s+computer\s+applications)\b/i],
    ['BCA', /\b(?:b\.?\s*c\.?\s*a|bachelor\s+of\s+computer\s+applications)\b/i],
    ['B.Sc', /\bb\.?\s*sc\b/i],
    ['M.Sc', /\bm\.?\s*sc\b/i],
    ['MS', /\bm\.?\s*s\.?\s*(?:in|degree|computer|data|engineering)\b/i],
    ['PhD', /\b(?:ph\.?\s*d|doctorate)\b/i],
    ['Bachelor', /\bbachelor(?:'s|s)?\b/i],
    ['Master', /\bmaster(?:'s|s)?\b/i],
  ];
  for (const [label, rx] of degreePatterns) {
    if (rx.test(content)) degrees.push(label);
  }

  const branches = [];
  const branchPatterns = [
    ['CS', /\b(?:computer\s+science|cse?|cs\/it)\b/i],
    ['IT', /\binformation\s+technology\b|\bCS\/IT\b|\bIT(?=\s*[,/&)]|\s+(?:branch|stream|engineering|degree|student|grad))/],
    ['ECE', /\b(?:electronics(?:\s*(?:&|and)\s*communication)?|ece)\b/i],
    ['EE', /\b(?:electrical\s+engineering|EEE)\b/i],
    ['AI/DS', /\b(?:artificial\s+intelligence|data\s+science)\b/i],
  ];
  for (const [label, rx] of branchPatterns) {
    if (rx.test(content)) branches.push(label);
  }

  return {
    batches: Array.from(batches).sort(),
    minCgpa,
    degrees,
    branches,
  };
}

export function extractWorkMode(text = '', location = '', title = '', explicitRemote = null) {
  const loc = String(location || '');
  const ttl = String(title || '');
  const body = String(text || '');

  if (/\bhybrid\b/i.test(loc) || /\bhybrid\b/i.test(ttl)) return 'hybrid';
  if (explicitRemote === true || /\b(remote|anywhere|distributed|wfh|work\s+from\s+home)\b/i.test(loc) || /\bremote\b/i.test(ttl)) {
    if (/\bhybrid\b/i.test(loc) && !/\bfully\s+remote\b/i.test(body)) return 'hybrid';
    return 'remote';
  }

  // Explicit onsite / in-office cue in location overrides generic body prose
  if (/\b(in[- ]office|on[- ]?site|onsite)\b/i.test(loc)) {
    return /\bhybrid\b/i.test(body) ? 'hybrid' : 'onsite';
  }

  // Body heuristics (strict phrases to avoid matching "remote team" on onsite roles)
  if (/\b(100%\s+remote|fully\s+remote|remote[- ]first|work\s+from\s+anywhere|this\s+(?:role|position)\s+is\s+remote)\b/i.test(body)) {
    return 'remote';
  }
  if (/\b(hybrid\s+work|hybrid\s+schedule|days?\s+(?:a|per)\s+week\s+in[- ](?:office|person)|hybrid\s+role)\b/i.test(body)) {
    return 'hybrid';
  }
  if (/\b(on[- ]?site\s+only|in[- ]office\s+5\s+days|strictly\s+in[- ]person|this\s+is\s+an\s+on[- ]?site\s+role)\b/i.test(body)) {
    return 'onsite';
  }
  if (loc && !/^(unspecified|unknown)$/i.test(loc.trim()) && !/remote/i.test(loc)) {
    if (/\bhybrid\b/i.test(body)) return 'hybrid';
    return 'onsite';
  }
  if (/\bremote\b/i.test(body)) return 'remote';
  return 'unknown';
}

export function extractVisaSponsorship(text = '', explicitFlag = false) {
  if (explicitFlag) return true;
  const content = String(text || '');
  if (/\b(unable\s+to\s+sponsor|cannot\s+sponsor|no\s+visa\s+sponsorship|will\s+not\s+sponsor|without\s+(?:the\s+need\s+for\s+)?sponsorship)\b/i.test(content)) {
    return false;
  }
  return /\b(visa\s+sponsorship|h-?1b\s+sponsorship|sponsor\s+visas?|relocation\s+(?:and|&)\s+visa|sponsorship\s+(?:is\s+)?available)\b/i.test(content);
}

export function extractFlags({ sourceType, title = '', salaryMin, isSalaryEstimated, workMode, visaSponsorship, postedAt, experienceMin }, text = '') {
  const greenFlags = [];
  const redFlags = [];
  const body = String(text || '');
  const titleAndBody = `${title}\n${body}`;

  const atsTypes = new Set(['greenhouse', 'ashby', 'lever', 'smartrecruiters', 'workable', 'recruitee', 'rippling', 'pinpoint', 'workday', 'oracle_hcm', 'personio', 'teamtailor']);
  if (atsTypes.has(sourceType)) greenFlags.push('Direct ATS Posting');
  if (sourceType === 'simplify') greenFlags.push('Verified Early-Career Feed');
  if (sourceType === 'hackernews' || sourceType === 'yc') greenFlags.push('Direct Startup / Founder Post');
  if (salaryMin && !isSalaryEstimated) greenFlags.push('Transparent Salary');
  if (workMode === 'remote') greenFlags.push('Remote Friendly');
  if (visaSponsorship) greenFlags.push('Visa Sponsorship');
  if (/\b(?:class\s+of\s+|graduating\s+(?:in\s+)?|summer\s+|winter\s+|new\s+grad(?:uate)?\s+)?202[67]\b/i.test(titleAndBody)) {
    greenFlags.push('Class of 2026/2027 Eligible');
  }
  if (/\b(pre[- ]placement\s+offer|\bppo\b|return\s+(?:full[- ]time\s+)?offer|convert\s+to\s+full[- ]time|intern[- ]to[- ]full[- ]time|full[- ]time\s+conversion)\b/i.test(body)) {
    greenFlags.push('Intern-to-FTE / PPO Signal');
  }
  if (/\b(equity|stock\s+options|rsu|401\s*\(?k\)?|unlimited\s+pto)\b/i.test(body)) {
    greenFlags.push('Equity / Strong Benefits');
  }

  if (postedAt) {
    const ageMs = Date.now() - new Date(postedAt).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    if (Number.isFinite(ageHours) && ageHours <= 48 && ageHours >= -24) {
      greenFlags.push('Fresh (< 48h)');
    } else if (Number.isFinite(ageHours) && ageHours > 24 * 35) {
      redFlags.push('Stale (> 35d old)');
    }
  }

  if (/\b(unpaid|volunteer\s+basis|commission\s+only|equity\s+only)\b/i.test(body)) {
    redFlags.push('Unpaid / Equity-Only Signal');
  }
  if (/\b(security\s+clearance|ts\/sci|top\s+secret\s+clearance)\b/i.test(body)) {
    redFlags.push('Security Clearance Required');
  }
  if (/\b(24\/7\s+on[- ]call|heavy\s+on[- ]call|fast[- ]paced\s+wear\s+many\s+hats)\b/i.test(body)) {
    redFlags.push('High Workload / On-Call');
  }
  if (experienceMin && experienceMin >= 10) {
    redFlags.push('10+ Years Exp Required');
  }

  return { greenFlags, redFlags };
}
