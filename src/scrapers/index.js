// Master Scraper Registry, Concurrency Pool, and Seeded 95+ Multi-Tier Sources

import {
  scrapeGreenhouse,
  scrapeAshby,
  scrapeLever,
  scrapeSmartRecruiters,
  scrapeWorkable,
  scrapeRecruitee,
  scrapeRippling,
  scrapePinpoint,
  scrapeWorkday,
  scrapeOracleHcm,
  scrapePersonio,
  scrapeTeamtailor,
} from './ats.js';
import {
  scrapeRemotive,
  scrapeArbeitnow,
  scrapeRemoteOK,
  scrapeTheMuse,
  scrapeHimalayas,
  scrapeJobicy,
  scrapeWeWorkRemotely,
  scrapeHackerNewsWhoIsHiring,
  scrapeYCJobs,
  scrapeSimplifyGithub,
  scrapeAmazonJobs,
  scrapeGoogleCareers,
  scrapeAtlassian,
  scrapeAppleCareers,
  scrapeInternshala,
  scrapeInstahyre,
  scrapeLinkedInGuest,
} from './aggregators.js';
import { scrapeCustomUrl } from './fingerprinter.js';
import { upsertJobsBatch, recordSourceHealth } from '../db.js';

export const DEFAULT_SOURCES = [
  // Tier 2: Dedicated Early-Career & Intern/New-Grad Repositories + Startup Feeds
  { id: 'simplify-internships', name: 'SimplifyJobs Summer Internships', type: 'simplify', tier: 2, config: { repo: 'Summer2027-Internships', defaultSeniority: 'intern', category: 'Internships' } },
  { id: 'simplify-newgrad', name: 'SimplifyJobs New Grad Roles', type: 'simplify', tier: 2, config: { repo: 'New-Grad-Positions', defaultSeniority: 'junior', category: 'New Grad' } },
  { id: 'agg-hn-hiring', name: "HN 'Who is Hiring?' (Monthly)", type: 'hackernews', tier: 2, config: { category: 'Startups' } },
  { id: 'agg-yc-jobs', name: 'Y Combinator Jobs (HN Feed)', type: 'yc', tier: 2, config: { category: 'YC Startups' } },

  // Tier 3: Global & Remote Aggregators (Broadest reach across thousands of companies)
  { id: 'agg-remotive', name: 'Remotive (Global Remote)', type: 'remotive', tier: 3, config: { category: 'Global Remote' } },
  { id: 'agg-arbeitnow', name: 'Arbeitnow (ATS & Visa Board)', type: 'arbeitnow', tier: 3, config: { category: 'EU & Remote' } },
  { id: 'agg-remoteok', name: 'RemoteOK (Tech Remote)', type: 'remoteok', tier: 3, config: { category: 'Tech Remote' } },
  { id: 'agg-himalayas', name: 'Himalayas (Remote Tech)', type: 'himalayas', tier: 3, config: { category: 'Remote Tech' } },
  { id: 'agg-jobicy', name: 'Jobicy (Remote Jobs)', type: 'jobicy', tier: 3, config: { category: 'Remote' } },
  { id: 'agg-wwr', name: 'We Work Remotely (RSS)', type: 'wwr', tier: 3, config: { category: 'Remote' } },

  // Tier 1: Direct Greenhouse ATS Boards (Global Leaders + Bengaluru/India Engineering Hubs)
  { id: 'gh-stripe', name: 'Stripe', type: 'greenhouse', tier: 1, config: { slug: 'stripe', companyName: 'Stripe' } },
  { id: 'gh-anthropic', name: 'Anthropic', type: 'greenhouse', tier: 1, config: { slug: 'anthropic', companyName: 'Anthropic' } },
  { id: 'gh-cloudflare', name: 'Cloudflare', type: 'greenhouse', tier: 1, config: { slug: 'cloudflare', companyName: 'Cloudflare' } },
  { id: 'gh-vercel', name: 'Vercel', type: 'greenhouse', tier: 1, config: { slug: 'vercel', companyName: 'Vercel' } },
  { id: 'gh-figma', name: 'Figma', type: 'greenhouse', tier: 1, config: { slug: 'figma', companyName: 'Figma' } },
  { id: 'gh-databricks', name: 'Databricks', type: 'greenhouse', tier: 1, config: { slug: 'databricks', companyName: 'Databricks' } },
  { id: 'gh-scaleai', name: 'Scale AI', type: 'greenhouse', tier: 1, config: { slug: 'scaleai', companyName: 'Scale AI' } },
  { id: 'gh-discord', name: 'Discord', type: 'greenhouse', tier: 1, config: { slug: 'discord', companyName: 'Discord' } },
  { id: 'gh-coinbase', name: 'Coinbase', type: 'greenhouse', tier: 1, config: { slug: 'coinbase', companyName: 'Coinbase' } },
  { id: 'gh-brex', name: 'Brex', type: 'greenhouse', tier: 1, config: { slug: 'brex', companyName: 'Brex' } },
  { id: 'gh-gusto', name: 'Gusto', type: 'greenhouse', tier: 1, config: { slug: 'gusto', companyName: 'Gusto' } },
  { id: 'gh-hackerrank', name: 'HackerRank', type: 'greenhouse', tier: 1, config: { slug: 'hackerrank', companyName: 'HackerRank' } },
  { id: 'gh-enterpret', name: 'Enterpret', type: 'greenhouse', tier: 1, config: { slug: 'enterpret', companyName: 'Enterpret' } },
  { id: 'gh-singlestore', name: 'SingleStore', type: 'greenhouse', tier: 1, config: { slug: 'singlestore', companyName: 'SingleStore' } },
  { id: 'gh-rubrik', name: 'Rubrik', type: 'greenhouse', tier: 1, config: { slug: 'rubrik', companyName: 'Rubrik' } },
  { id: 'gh-datadog', name: 'Datadog', type: 'greenhouse', tier: 1, config: { slug: 'datadog', companyName: 'Datadog' } },
  { id: 'gh-gitlab', name: 'GitLab', type: 'greenhouse', tier: 1, config: { slug: 'gitlab', companyName: 'GitLab' } },
  { id: 'gh-reddit', name: 'Reddit', type: 'greenhouse', tier: 1, config: { slug: 'reddit', companyName: 'Reddit' } },
  { id: 'gh-robinhood', name: 'Robinhood', type: 'greenhouse', tier: 1, config: { slug: 'robinhood', companyName: 'Robinhood' } },
  { id: 'gh-duolingo', name: 'Duolingo', type: 'greenhouse', tier: 1, config: { slug: 'duolingo', companyName: 'Duolingo' } },
  { id: 'gh-instacart', name: 'Instacart', type: 'greenhouse', tier: 1, config: { slug: 'instacart', companyName: 'Instacart' } },
  { id: 'gh-asana', name: 'Asana', type: 'greenhouse', tier: 1, config: { slug: 'asana', companyName: 'Asana' } },
  { id: 'gh-airtable', name: 'Airtable', type: 'greenhouse', tier: 1, config: { slug: 'airtable', companyName: 'Airtable' } },
  { id: 'gh-grafanalabs', name: 'Grafana Labs', type: 'greenhouse', tier: 1, config: { slug: 'grafanalabs', companyName: 'Grafana Labs' } },
  { id: 'gh-mongodb', name: 'MongoDB', type: 'greenhouse', tier: 1, config: { slug: 'mongodb', companyName: 'MongoDB' } },
  { id: 'gh-elastic', name: 'Elastic', type: 'greenhouse', tier: 1, config: { slug: 'elastic', companyName: 'Elastic' } },
  { id: 'gh-cockroachlabs', name: 'Cockroach Labs', type: 'greenhouse', tier: 1, config: { slug: 'cockroachlabs', companyName: 'Cockroach Labs' } },
  { id: 'gh-sourcegraph', name: 'Sourcegraph', type: 'greenhouse', tier: 1, config: { slug: 'sourcegraph91', companyName: 'Sourcegraph' } },
  { id: 'gh-okta', name: 'Okta', type: 'greenhouse', tier: 1, config: { slug: 'okta', companyName: 'Okta' } },
  { id: 'gh-zscaler', name: 'Zscaler', type: 'greenhouse', tier: 1, config: { slug: 'zscaler', companyName: 'Zscaler' } },
  { id: 'gh-purestorage', name: 'Pure Storage', type: 'greenhouse', tier: 1, config: { slug: 'purestorage', companyName: 'Pure Storage' } },
  { id: 'gh-inmobi', name: 'InMobi', type: 'greenhouse', tier: 1, config: { slug: 'inmobi', companyName: 'InMobi' } },
  { id: 'gh-fivetran', name: 'Fivetran', type: 'greenhouse', tier: 1, config: { slug: 'fivetran', companyName: 'Fivetran' } },
  { id: 'gh-twilio', name: 'Twilio', type: 'greenhouse', tier: 1, config: { slug: 'twilio', companyName: 'Twilio' } },
  { id: 'gh-druva', name: 'Druva', type: 'greenhouse', tier: 1, config: { slug: 'druva', companyName: 'Druva' } },
  { id: 'gh-toast', name: 'Toast', type: 'greenhouse', tier: 1, config: { slug: 'toast', companyName: 'Toast' } },
  { id: 'gh-groww', name: 'Groww', type: 'greenhouse', tier: 1, config: { slug: 'groww', companyName: 'Groww' } },
  { id: 'gh-devrev', name: 'DevRev', type: 'greenhouse', tier: 1, config: { slug: 'devrev', companyName: 'DevRev' } },
  { id: 'gh-highradius', name: 'HighRadius', type: 'greenhouse', tier: 1, config: { slug: 'highradius', companyName: 'HighRadius' } },
  { id: 'gh-zenoti', name: 'Zenoti', type: 'greenhouse', tier: 1, config: { slug: 'zenoti', companyName: 'Zenoti' } },
  { id: 'gh-observeai', name: 'Observe.AI', type: 'greenhouse', tier: 1, config: { slug: 'observeai', companyName: 'Observe.AI' } },
  { id: 'gh-coursera', name: 'Coursera', type: 'greenhouse', tier: 1, config: { slug: 'coursera', companyName: 'Coursera' } },
  { id: 'gh-togetherai', name: 'Together AI', type: 'greenhouse', tier: 1, config: { slug: 'togetherai', companyName: 'Together AI' } },
  { id: 'gh-tenstorrent', name: 'Tenstorrent', type: 'greenhouse', tier: 1, config: { slug: 'tenstorrent', companyName: 'Tenstorrent' } },
  { id: 'gh-newrelic', name: 'New Relic', type: 'greenhouse', tier: 1, config: { slug: 'newrelic', companyName: 'New Relic' } },
  { id: 'gh-mixpanel', name: 'Mixpanel', type: 'greenhouse', tier: 1, config: { slug: 'mixpanel', companyName: 'Mixpanel' } },
  { id: 'gh-waymo', name: 'Waymo', type: 'greenhouse', tier: 1, config: { slug: 'waymo', companyName: 'Waymo' } },
  { id: 'gh-canonical', name: 'Canonical', type: 'greenhouse', tier: 1, config: { slug: 'canonical', companyName: 'Canonical' } },
  { id: 'gh-tailscale', name: 'Tailscale', type: 'greenhouse', tier: 1, config: { slug: 'tailscale', companyName: 'Tailscale' } },
  { id: 'gh-arizeai', name: 'Arize AI', type: 'greenhouse', tier: 1, config: { slug: 'arizeai', companyName: 'Arize AI' } },
  { id: 'gh-intercom', name: 'Intercom', type: 'greenhouse', tier: 1, config: { slug: 'intercom', companyName: 'Intercom' } },
  { id: 'gh-pinterest', name: 'Pinterest', type: 'greenhouse', tier: 1, config: { slug: 'pinterest', companyName: 'Pinterest' } },
  { id: 'gh-lyft', name: 'Lyft', type: 'greenhouse', tier: 1, config: { slug: 'lyft', companyName: 'Lyft' } },
  { id: 'gh-affirm', name: 'Affirm', type: 'greenhouse', tier: 1, config: { slug: 'affirm', companyName: 'Affirm' } },
  { id: 'gh-razorpay', name: 'Razorpay', type: 'greenhouse', tier: 1, config: { slug: 'razorpaysoftwareprivatelimited', companyName: 'Razorpay', timeoutMs: 25000, weight: 2, pollIntervalMinutes: 30 } },

  // Tier 1: Direct Ashby HQ ATS Boards
  { id: 'ashby-openai', name: 'OpenAI', type: 'ashby', tier: 1, config: { slug: 'openai', companyName: 'OpenAI' } },
  { id: 'ashby-linear', name: 'Linear', type: 'ashby', tier: 1, config: { slug: 'linear', companyName: 'Linear' } },
  { id: 'ashby-ramp', name: 'Ramp', type: 'ashby', tier: 1, config: { slug: 'ramp', companyName: 'Ramp' } },
  { id: 'ashby-perplexity', name: 'Perplexity AI', type: 'ashby', tier: 1, config: { slug: 'perplexity', companyName: 'Perplexity AI' } },
  { id: 'ashby-supabase', name: 'Supabase', type: 'ashby', tier: 1, config: { slug: 'supabase', companyName: 'Supabase' } },
  { id: 'ashby-notion', name: 'Notion', type: 'ashby', tier: 1, config: { slug: 'notion', companyName: 'Notion' } },
  { id: 'ashby-posthog', name: 'PostHog', type: 'ashby', tier: 1, config: { slug: 'posthog', companyName: 'PostHog' } },
  { id: 'ashby-elevenlabs', name: 'ElevenLabs', type: 'ashby', tier: 1, config: { slug: 'elevenlabs', companyName: 'ElevenLabs' } },
  { id: 'ashby-vanta', name: 'Vanta', type: 'ashby', tier: 1, config: { slug: 'vanta', companyName: 'Vanta' } },
  { id: 'ashby-modal', name: 'Modal Labs', type: 'ashby', tier: 1, config: { slug: 'modal', companyName: 'Modal' } },
  { id: 'ashby-replit', name: 'Replit', type: 'ashby', tier: 1, config: { slug: 'replit', companyName: 'Replit' } },
  { id: 'ashby-langchain', name: 'LangChain', type: 'ashby', tier: 1, config: { slug: 'langchain', companyName: 'LangChain' } },
  { id: 'ashby-cohere', name: 'Cohere', type: 'ashby', tier: 1, config: { slug: 'cohere', companyName: 'Cohere' } },
  { id: 'ashby-aiprise', name: 'AiPrise', type: 'ashby', tier: 1, config: { slug: 'aiprise', companyName: 'AiPrise' } },
  { id: 'ashby-cynlr', name: 'CynLr', type: 'ashby', tier: 1, config: { slug: 'cynlr', companyName: 'CynLr' } },
  { id: 'ashby-commure', name: 'Commure', type: 'ashby', tier: 1, config: { slug: 'commure', companyName: 'Commure' } },
  { id: 'ashby-composio', name: 'Composio', type: 'ashby', tier: 1, config: { slug: 'composio', companyName: 'Composio' } },
  { id: 'ashby-sarvam', name: 'Sarvam AI', type: 'ashby', tier: 1, config: { slug: 'sarvam', companyName: 'Sarvam AI' } },
  { id: 'ashby-bolna', name: 'Bolna AI', type: 'ashby', tier: 1, config: { slug: 'bolna', companyName: 'Bolna AI' } },
  { id: 'ashby-smallest', name: 'Smallest.ai', type: 'ashby', tier: 1, config: { slug: 'Smallest', companyName: 'Smallest.ai' } },
  { id: 'ashby-broccoli', name: 'Broccoli AI', type: 'ashby', tier: 1, config: { slug: 'broccoli', companyName: 'Broccoli AI' } },
  { id: 'ashby-harvey', name: 'Harvey AI', type: 'ashby', tier: 1, config: { slug: 'harvey', companyName: 'Harvey AI' } },
  { id: 'ashby-clickhouse', name: 'ClickHouse', type: 'ashby', tier: 1, config: { slug: 'clickhouse', companyName: 'ClickHouse' } },
  { id: 'ashby-cognition', name: 'Cognition', type: 'ashby', tier: 1, config: { slug: 'cognition', companyName: 'Cognition' } },
  { id: 'ashby-cursor', name: 'Cursor', type: 'ashby', tier: 1, config: { slug: 'cursor', companyName: 'Cursor' } },
  { id: 'ashby-sierra', name: 'Sierra AI', type: 'ashby', tier: 1, config: { slug: 'sierra', companyName: 'Sierra AI' } },
  { id: 'ashby-baseten', name: 'Baseten', type: 'ashby', tier: 1, config: { slug: 'baseten', companyName: 'Baseten' } },
  { id: 'ashby-exa', name: 'Exa AI', type: 'ashby', tier: 1, config: { slug: 'exa', companyName: 'Exa AI' } },
  { id: 'ashby-deepgram', name: 'Deepgram', type: 'ashby', tier: 1, config: { slug: 'deepgram', companyName: 'Deepgram' } },
  { id: 'ashby-livekit', name: 'LiveKit', type: 'ashby', tier: 1, config: { slug: 'livekit', companyName: 'LiveKit' } },
  { id: 'ashby-twenty', name: 'Twenty', type: 'ashby', tier: 1, config: { slug: 'twenty', companyName: 'Twenty' } },
  { id: 'ashby-render', name: 'Render', type: 'ashby', tier: 1, config: { slug: 'render', companyName: 'Render' } },
  { id: 'ashby-firecrawl', name: 'Firecrawl', type: 'ashby', tier: 1, config: { slug: 'firecrawl', companyName: 'Firecrawl' } },

  // Tier 1: Direct Lever ATS Boards
  { id: 'lever-palantir', name: 'Palantir', type: 'lever', tier: 1, config: { slug: 'palantir', companyName: 'Palantir' } },
  { id: 'lever-spotify', name: 'Spotify', type: 'lever', tier: 1, config: { slug: 'spotify', companyName: 'Spotify' } },
  { id: 'lever-zoox', name: 'Zoox', type: 'lever', tier: 1, config: { slug: 'zoox', companyName: 'Zoox' } },
  { id: 'lever-zeta', name: 'Zeta Suite', type: 'lever', tier: 1, config: { slug: 'zeta', companyName: 'Zeta' } },
  { id: 'lever-hevo', name: 'Hevo Data', type: 'lever', tier: 1, config: { slug: 'hevodata', companyName: 'Hevo Data' } },
  { id: 'lever-meesho', name: 'Meesho', type: 'lever', tier: 1, config: { slug: 'meesho', companyName: 'Meesho' } },
  { id: 'lever-cred', name: 'CRED', type: 'lever', tier: 1, config: { slug: 'cred', companyName: 'CRED' } },
  { id: 'lever-paytm', name: 'Paytm', type: 'lever', tier: 1, config: { slug: 'paytm', companyName: 'Paytm' } },

  // Tier 1: Direct SmartRecruiters & Rippling Boards
  { id: 'sr-servicenow', name: 'ServiceNow', type: 'smartrecruiters', tier: 1, config: { slug: 'ServiceNow', companyName: 'ServiceNow' } },
  { id: 'sr-grab', name: 'Grab', type: 'smartrecruiters', tier: 1, config: { slug: 'Grab', companyName: 'Grab' } },
  { id: 'sr-bosch', name: 'Bosch', type: 'smartrecruiters', tier: 1, config: { slug: 'BoschGroup', companyName: 'Bosch' } },
  { id: 'sr-wise', name: 'Wise', type: 'smartrecruiters', tier: 1, config: { slug: 'Wise', companyName: 'Wise' } },
  { id: 'sr-westerndigital', name: 'Western Digital', type: 'smartrecruiters', tier: 1, config: { slug: 'WesternDigital', companyName: 'Western Digital' } },
  { id: 'sr-nielseniq', name: 'NielsenIQ', type: 'smartrecruiters', tier: 1, config: { slug: 'NielsenIQ', companyName: 'NielsenIQ' } },
  { id: 'rippling-main', name: 'Rippling', type: 'rippling', tier: 1, config: { slug: 'rippling', companyName: 'Rippling' } },

  { id: 'wd-nvidia', name: 'NVIDIA', type: 'workday', tier: 1, config: { tenant: 'nvidia', wdNum: 5, site: 'NVIDIAExternalCareerSite', companyName: 'NVIDIA', timeoutMs: 35000, weight: 3, pollIntervalMinutes: 45 } },
  { id: 'wd-intel', name: 'Intel', type: 'workday', tier: 1, config: { tenant: 'intel', wdNum: 1, site: 'External', companyName: 'Intel', timeoutMs: 35000, weight: 3, pollIntervalMinutes: 45 } },
  { id: 'wd-cisco', name: 'Cisco', type: 'workday', tier: 1, config: { tenant: 'cisco', wdNum: 5, site: 'Cisco_Careers', companyName: 'Cisco', timeoutMs: 35000, weight: 3, pollIntervalMinutes: 45 } },
  { id: 'wd-salesforce', name: 'Salesforce', type: 'workday', tier: 1, config: { tenant: 'salesforce', wdNum: 12, site: 'External_Career_Site', companyName: 'Salesforce', timeoutMs: 35000, weight: 3, pollIntervalMinutes: 45 } },
  { id: 'wd-walmart', name: 'Walmart Global Tech', type: 'workday', tier: 1, config: { tenant: 'walmart', wdNum: 504, site: 'WalmartExternal', companyName: 'Walmart', timeoutMs: 35000, weight: 3, pollIntervalMinutes: 45 } },
  { id: 'wd-adobe', name: 'Adobe', type: 'workday', tier: 1, config: { tenant: 'adobe', wdNum: 5, site: 'external_experienced', companyName: 'Adobe', timeoutMs: 35000, weight: 3, pollIntervalMinutes: 45 } },
  { id: 'wd-target', name: 'Target', type: 'workday', tier: 1, config: { tenant: 'target', wdNum: 5, site: 'targetcareers', companyName: 'Target', timeoutMs: 35000, weight: 2, pollIntervalMinutes: 45 } },
  { id: 'wd-broadcom', name: 'Broadcom', type: 'workday', tier: 1, config: { tenant: 'broadcom', wdNum: 1, site: 'External_Career', companyName: 'Broadcom', timeoutMs: 35000, weight: 2, pollIntervalMinutes: 45 } },
  { id: 'wd-morganstanley', name: 'Morgan Stanley', type: 'workday', tier: 1, config: { tenant: 'ms', wdNum: 5, site: 'External', companyName: 'Morgan Stanley', timeoutMs: 35000, weight: 3, pollIntervalMinutes: 45 } },
  { id: 'wd-hp', name: 'HP', type: 'workday', tier: 1, config: { tenant: 'hp', wdNum: 5, site: 'ExternalCareerSite', companyName: 'HP', timeoutMs: 35000, weight: 2, pollIntervalMinutes: 45 } },
  { id: 'wd-mastercard', name: 'Mastercard', type: 'workday', tier: 1, config: { tenant: 'mastercard', wdNum: 1, site: 'CorporateCareers', companyName: 'Mastercard', timeoutMs: 35000, weight: 2, pollIntervalMinutes: 45 } },
  { id: 'wd-paypal', name: 'PayPal', type: 'workday', tier: 1, config: { tenant: 'paypal', wdNum: 1, site: 'jobs', companyName: 'PayPal', timeoutMs: 35000, weight: 2, pollIntervalMinutes: 45 } },

  { id: 'oracle-jpmc', name: 'JPMorgan Chase', type: 'oracle_hcm', tier: 1, config: { host: 'jpmc.fa.oraclecloud.com', site: 'CX_1001', companyName: 'JPMorgan Chase', timeoutMs: 30000, weight: 3, pollIntervalMinutes: 45 } },
  { id: 'oracle-dell', name: 'Dell Technologies', type: 'oracle_hcm', tier: 1, config: { host: 'enterpriseplatform.dell.com', site: 'careers', companyName: 'Dell Technologies', timeoutMs: 30000, weight: 2, pollIntervalMinutes: 45 } },
  { id: 'oracle-corp', name: 'Oracle', type: 'oracle_hcm', tier: 1, config: { host: 'eeho.fa.us2.oraclecloud.com', site: 'CX_45001', companyName: 'Oracle', timeoutMs: 30000, weight: 3, pollIntervalMinutes: 45 } },
  { id: 'personio-main', name: 'Personio', type: 'personio', tier: 1, config: { slug: 'personio', companyName: 'Personio', timeoutMs: 20000, weight: 1, pollIntervalMinutes: 60 } },
  { id: 'teamtailor-main', name: 'Teamtailor', type: 'teamtailor', tier: 1, config: { host: 'career.teamtailor.com', companyName: 'Teamtailor', timeoutMs: 20000, weight: 1, pollIntervalMinutes: 60 } },
  { id: 'sr-bosch-india', name: 'Bosch India', type: 'smartrecruiters', tier: 1, config: { slug: 'BoschGroup', query: 'Bengaluru', companyName: 'Bosch', timeoutMs: 25000, weight: 2, pollIntervalMinutes: 45 } },

  { id: 'bigtech-amazon', name: 'Amazon Jobs (India & Interns)', type: 'amazon', tier: 1, config: { companyName: 'Amazon', timeoutMs: 30000, weight: 3, pollIntervalMinutes: 45 } },
  { id: 'bigtech-google', name: 'Google Careers (India)', type: 'google', tier: 1, config: { companyName: 'Google', timeoutMs: 30000, weight: 3, pollIntervalMinutes: 45 } },
  { id: 'bigtech-atlassian', name: 'Atlassian (India & Remote)', type: 'atlassian', tier: 1, config: { companyName: 'Atlassian', timeoutMs: 35000, weight: 3, pollIntervalMinutes: 45 } },
  { id: 'bigtech-apple', name: 'Apple Careers (India)', type: 'apple', tier: 1, config: { companyName: 'Apple', timeoutMs: 30000, weight: 2, pollIntervalMinutes: 45 } },
  { id: 'india-internshala', name: 'Internshala (CS Bengaluru & Remote)', type: 'internshala', tier: 2, config: { category: 'India Internships', timeoutMs: 25000, weight: 2, pollIntervalMinutes: 30 } },
  { id: 'india-instahyre', name: 'Instahyre (India Startups)', type: 'instahyre', tier: 2, config: { category: 'India Tech', timeoutMs: 25000, weight: 2, pollIntervalMinutes: 30 } },
  { id: 'agg-linkedin-guest', name: 'LinkedIn Guest (Fresher BLR/India/Remote)', type: 'linkedin_guest', tier: 3, config: { category: 'Global & India', timeoutMs: 90000, weight: 3, pollIntervalMinutes: 360 } },
];

const LARGE_BOARD_IDS = new Set([
  'gh-stripe', 'gh-databricks', 'gh-cloudflare', 'gh-coinbase', 'gh-gitlab',
  'gh-robinhood', 'gh-elastic', 'gh-anthropic', 'gh-datadog', 'gh-mongodb',
  'gh-zscaler', 'gh-okta', 'gh-purestorage', 'gh-toast', 'gh-waymo', 'gh-canonical',
  'ashby-openai', 'ashby-notion', 'ashby-harvey', 'lever-spotify', 'lever-zoox',
  'lever-palantir', 'lever-paytm', 'rippling-main', 'simplify-internships', 'simplify-newgrad',
]);

export function resolveSourceScheduleMeta(s) {
  const isLarge = LARGE_BOARD_IDS.has(s.id);
  const timeoutMs = s.timeoutMs ?? s.config?.timeoutMs ?? (isLarge ? 45000 : 20000);
  const weight = s.weight ?? s.config?.weight ?? (isLarge ? 3 : s.tier === 1 ? 2 : 1);
  const pollIntervalMinutes = s.pollIntervalMinutes ?? s.config?.pollIntervalMinutes ?? (s.tier === 1 ? 30 : 20);
  return { timeoutMs, weight, pollIntervalMinutes };
}

export function seedDefaultSources(db) {
  const deadIds = [
    'gh-retool', 'lever-plaid', 'lever-mistral', 'gh-postman',
    'gh-confluent', 'gh-browserstack', 'ashby-truefoundry', 'ashby-cal',
    'lever-hasura', 'lever-appsmith', 'agg-themuse', 'ashby-deel',
    'sr-visa', 'workable-canonical',
  ];
  const placeholders = deadIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM jobs_fts WHERE job_id IN (SELECT id FROM jobs WHERE source_id IN (${placeholders}))`).run(...deadIds);
  db.prepare(`DELETE FROM jobs WHERE source_id IN (${placeholders})`).run(...deadIds);
  db.prepare(`DELETE FROM sources WHERE id IN (${placeholders})`).run(...deadIds);

  const upsert = db.prepare(`
    INSERT INTO sources (id, name, type, tier, config, enabled, scrape_interval_mins)
    VALUES (?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      config = excluded.config,
      scrape_interval_mins = excluded.scrape_interval_mins
  `);
  for (const s of DEFAULT_SOURCES) {
    const meta = resolveSourceScheduleMeta(s);
    const enrichedConfig = { ...s.config, ...meta };
    upsert.run(s.id, s.name, s.type, s.tier, JSON.stringify(enrichedConfig), meta.pollIntervalMinutes);
  }
}

const ADAPTER_MAP = {
  greenhouse: scrapeGreenhouse,
  ashby: scrapeAshby,
  lever: scrapeLever,
  smartrecruiters: scrapeSmartRecruiters,
  workable: scrapeWorkable,
  recruitee: scrapeRecruitee,
  rippling: scrapeRippling,
  pinpoint: scrapePinpoint,
  workday: scrapeWorkday,
  oracle_hcm: scrapeOracleHcm,
  personio: scrapePersonio,
  teamtailor: scrapeTeamtailor,
  remotive: scrapeRemotive,
  arbeitnow: scrapeArbeitnow,
  remoteok: scrapeRemoteOK,
  themuse: scrapeTheMuse,
  himalayas: scrapeHimalayas,
  jobicy: scrapeJobicy,
  wwr: scrapeWeWorkRemotely,
  hackernews: scrapeHackerNewsWhoIsHiring,
  yc: scrapeYCJobs,
  simplify: scrapeSimplifyGithub,
  amazon: scrapeAmazonJobs,
  google: scrapeGoogleCareers,
  atlassian: scrapeAtlassian,
  apple: scrapeAppleCareers,
  internshala: scrapeInternshala,
  instahyre: scrapeInstahyre,
  linkedin_guest: scrapeLinkedInGuest,
  custom: scrapeCustomUrl,
};

export function hydrateSourceRow(row) {
  if (!row) return null;
  let config = {};
  try {
    config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config || {};
  } catch {
    config = {};
  }
  const meta = resolveSourceScheduleMeta({ ...row, config });
  return {
    ...row,
    config,
    ...meta,
    enabled: Boolean(row.enabled),
  };
}

export async function scrapeSingleSource(db, sourceRow, runId = 'manual') {
  const source = hydrateSourceRow(sourceRow);
  source.db = db;
  const adapter = ADAPTER_MAP[source.type];
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  if (!adapter) {
    const errMsg = `No adapter registered for source type "${source.type}"`;
    db.prepare(
      'UPDATE sources SET last_scraped_at = ?, last_status = ?, last_error = ?, last_duration_ms = ? WHERE id = ?'
    ).run(startedAt, 'error', errMsg, 0, source.id);
    recordSourceHealth(db, { sourceId: source.id, ok: false, error: errMsg, durationMs: 0 });
    return { sourceId: source.id, name: source.name, status: 'error', fetched: 0, newCount: 0, updatedCount: 0, error: errMsg, durationMs: 0 };
  }

  try {
    const jobs = await adapter(source);
    const validJobs = Array.isArray(jobs) ? jobs.filter((j) => j && j.title && j.apply_url) : [];
    const { newCount, updatedCount } = upsertJobsBatch(db, validJobs, source.id);
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - t0;

    db.prepare(`
      UPDATE sources SET
        last_scraped_at = ?, last_status = 'success', last_error = '',
        last_duration_ms = ?, jobs_found_last = ?
      WHERE id = ?
    `).run(finishedAt, durationMs, validJobs.length, source.id);

    recordSourceHealth(db, {
      sourceId: source.id,
      ok: true,
      jobsCount: validJobs.length,
      durationMs,
    });

    db.prepare(`
      INSERT INTO scrape_logs (run_id, source_id, source_name, started_at, finished_at, duration_ms, status, fetched_count, new_count, updated_count, error_message)
      VALUES (?, ?, ?, ?, ?, ?, 'success', ?, ?, ?, '')
    `).run(runId, source.id, source.name, startedAt, finishedAt, durationMs, validJobs.length, newCount, updatedCount);

    return {
      sourceId: source.id,
      name: source.name,
      type: source.type,
      status: 'success',
      fetched: validJobs.length,
      newCount,
      updatedCount,
      durationMs,
      error: '',
    };
  } catch (err) {
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - t0;
    const errMsg = err?.message ? String(err.message).slice(0, 300) : 'Unknown scrape error';

    db.prepare(`
      UPDATE sources SET
        last_scraped_at = ?, last_status = 'error', last_error = ?,
        last_duration_ms = ?, jobs_found_last = COALESCE(NULLIF(jobs_found_last, 0), total_active_jobs)
      WHERE id = ?
    `).run(finishedAt, errMsg, durationMs, source.id);

    recordSourceHealth(db, {
      sourceId: source.id,
      ok: false,
      error: errMsg,
      durationMs,
    });

    db.prepare(`
      INSERT INTO scrape_logs (run_id, source_id, source_name, started_at, finished_at, duration_ms, status, fetched_count, new_count, updated_count, error_message)
      VALUES (?, ?, ?, ?, ?, ?, 'error', 0, 0, 0, ?)
    `).run(runId, source.id, source.name, startedAt, finishedAt, durationMs, errMsg);

    return {
      sourceId: source.id,
      name: source.name,
      type: source.type,
      status: 'error',
      fetched: 0,
      newCount: 0,
      updatedCount: 0,
      durationMs,
      error: errMsg,
    };
  }
}

export async function runConcurrentPool(items, concurrency, fn) {
  const ordered = [...items].sort((a, b) => {
    const wa = resolveSourceScheduleMeta(hydrateSourceRow(a) || a).weight;
    const wb = resolveSourceScheduleMeta(hydrateSourceRow(b) || b).weight;
    return wb - wa;
  });
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < ordered.length) {
      const current = ordered[idx++];
      results.push(await fn(current));
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, ordered.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
