import { normalizeJobPayload } from './scrapers/normalize.js';
import { detectAllAtsFromText } from './scrapers/fingerprinter.js';

function decodeHtmlEntities(str = '') {
  return String(str)
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function stripTags(html = '') {
  return decodeHtmlEntities(
    String(html)
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(tr|p|div|li|td|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

export function decodeQuotedPrintable(input = '') {
  const unfolded = String(input).replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < unfolded.length; i += 1) {
    if (unfolded[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(unfolded.slice(i + 1, i + 3))) {
      bytes.push(parseInt(unfolded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = unfolded.charCodeAt(i);
      if (code < 128) {
        bytes.push(code);
      } else {
        for (const b of Buffer.from(unfolded[i], 'utf8')) {
          bytes.push(b);
        }
      }
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodeBodyTransfer(body = '', encoding = '') {
  const enc = String(encoding || '').trim().toLowerCase();
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
  if (enc === 'base64') {
    try {
      return Buffer.from(String(body).replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch {
      return body;
    }
  }
  return body;
}

function parseHeaders(rawHeaders = '') {
  const unfolded = String(rawHeaders).replace(/\r?\n[ \t]+/g, ' ');
  const map = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    map[key] = val;
  }
  return map;
}

function splitHeaderBody(rawPart = '') {
  const match = /\r?\n\r?\n/.exec(rawPart);
  if (!match) return { headers: {}, body: rawPart };
  return {
    headers: parseHeaders(rawPart.slice(0, match.index)),
    body: rawPart.slice(match.index + match[0].length),
  };
}

function collectMimeBodies(rawMessage, acc = { html: [], text: [], meta: null }) {
  const { headers, body } = splitHeaderBody(rawMessage);
  if (!acc.meta) {
    acc.meta = {
      subject: headers.subject || '',
      from: headers.from || '',
      date: headers.date || null,
    };
  }
  const ct = String(headers['content-type'] || 'text/plain').toLowerCase();
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(headers['content-type'] || '');
  if (ct.includes('multipart/') && boundaryMatch) {
    const boundary = boundaryMatch[1] || boundaryMatch[2];
    const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sections = body.split(new RegExp(`--${escaped}(?:--)?\\r?\\n?`));
    for (const sec of sections) {
      const trimmed = sec.trim();
      if (!trimmed || trimmed === '--') continue;
      collectMimeBodies(trimmed, acc);
    }
    return acc;
  }

  const decoded = decodeBodyTransfer(body, headers['content-transfer-encoding'] || '');
  if (ct.includes('text/html')) {
    acc.html.push(decoded);
  } else {
    acc.text.push(decoded);
  }
  return acc;
}

function splitMbox(raw = '') {
  const normalized = String(raw || '').replace(/\r\n/g, '\n');
  if (/^From \S+/m.test(normalized)) {
    return normalized
      .split(/^From [^\n]+\n/m)
      .map((s) => s.trim())
      .filter((s) => s.length > 20 && s.includes(':'));
  }
  return [String(raw || '')].filter((s) => s.trim().length > 0);
}

const NOISE_LINK_RX = /\b(unsubscribe|privacy|manage alerts|email settings|help center|view in browser|edit alert|see all jobs|update your preferences|opt out|logo|avatar)\b/i;

function inferProviderFromUrlOrMeta(url, meta) {
  const u = String(url || '').toLowerCase();
  const metaBlob = `${meta?.from || ''} ${meta?.subject || ''}`.toLowerCase();
  if (u.includes('linkedin.com')) return 'linkedin_email';
  if (u.includes('naukri.com')) return 'naukri_email';
  if (u.includes('wellfound.com') || u.includes('angel.co')) return 'wellfound_email';
  if (u.includes('internshala.com')) return 'internshala_email';
  if (metaBlob.includes('linkedin')) return 'linkedin_email';
  if (metaBlob.includes('naukri')) return 'naukri_email';
  if (metaBlob.includes('wellfound')) return 'wellfound_email';
  if (metaBlob.includes('internshala')) return 'internshala_email';
  return 'email_import';
}

function isJobAlertLink(href, label, meta) {
  const u = String(href || '');
  if (!/^https?:\/\//i.test(u)) return false;
  if (NOISE_LINK_RX.test(label) || NOISE_LINK_RX.test(u)) return false;
  if (/linkedin\.com\/(?:comm\/)?jobs\/view\//i.test(u)) return true;
  if (/naukri\.com\/job-listings/i.test(u)) return true;
  if (/wellfound\.com\/(?:jobs|l)\//i.test(u)) return true;
  if (/internshala\.com\/(?:internship|job)\/detail/i.test(u)) return true;
  if (detectAllAtsFromText(u).length > 0) return true;
  const metaBlob = `${meta?.subject || ''} ${meta?.from || ''}`.toLowerCase();
  if (/(job alert|jobs for you|recommended jobs|internships|new jobs)/i.test(metaBlob) && label.length >= 6 && label.length <= 120) {
    return /\/jobs?\//i.test(u) || /\/internship/i.test(u) || /\/job-listings/i.test(u);
  }
  return false;
}

function extractContextCompanyLocation(contextText = '', defaultCompany = 'Company') {
  const lines = contextText
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 2 && l.length <= 140);

  let company = defaultCompany;
  let location = 'India';
  for (const line of lines.slice(1, 5)) {
    if (/^[₹$€£]/.test(line) || /\b(stipend|lpa|per month|apply|posted|ago)\b/i.test(line)) continue;
    if (line.includes('·') || line.includes(' - ') || line.includes(' | ')) {
      const parts = line.split(/[·|\-]+/).map((p) => p.trim()).filter(Boolean);
      if (parts[0] && parts[0].length <= 60) company = parts[0];
      if (parts[1] && parts[1].length <= 80) location = parts[1];
      break;
    }
    if (company === defaultCompany && line.length <= 50 && !/\b(intern|engineer|developer|analyst)\b/i.test(line)) {
      company = line;
    } else if (location === 'India' && /\b(bengaluru|bangalore|mumbai|delhi|hyderabad|pune|chennai|remote|india|gurgaon|noida)\b/i.test(line)) {
      location = line;
    }
  }
  return { company, location };
}

function cleanTrackingUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname.includes('linkedin.com') && /\/jobs\/view\/(\d+)/.test(parsed.pathname)) {
      const idMatch = /\/jobs\/view\/(\d+)/.exec(parsed.pathname);
      return `https://www.linkedin.com/jobs/view/${idMatch[1]}`;
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

export function parseJobAlertEmail(rawContent = '', { sourceId = 'email-import' } = {}) {
  const messages = splitMbox(rawContent);
  const collected = [];
  const seenUrls = new Set();

  for (const msg of messages) {
    const parsed = collectMimeBodies(msg);
    const meta = parsed.meta || {};
    let postedAt = null;
    if (meta.date) {
      const dt = new Date(meta.date);
      if (!Number.isNaN(dt.getTime())) postedAt = dt.toISOString();
    }

    for (const html of parsed.html) {
      const anchorRx = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      while ((m = anchorRx.exec(html)) !== null) {
        const rawHref = decodeHtmlEntities(m[1]).trim();
        const label = stripTags(m[2]).replace(/\s+/g, ' ').trim();
        if (!label || !isJobAlertLink(rawHref, label, meta)) continue;
        const applyUrl = cleanTrackingUrl(rawHref);
        if (seenUrls.has(applyUrl)) continue;
        seenUrls.add(applyUrl);

        const afterSnippet = stripTags(html.slice(m.index, Math.min(html.length, m.index + m[0].length + 600)));
        const sourceType = inferProviderFromUrlOrMeta(applyUrl, meta);
        const { company, location } = extractContextCompanyLocation(afterSnippet, 'Unknown');

        collected.push(
          normalizeJobPayload({
            sourceId,
            sourceType,
            externalId: applyUrl,
            title: label,
            company,
            location,
            descriptionText: afterSnippet,
            applyUrl,
            postedAt,
          })
        );
      }
    }

    for (const textBody of parsed.text) {
      const lines = textBody.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const urlMatch = /(https?:\/\/[^\s<>)]+)/i.exec(lines[i]);
        if (!urlMatch) continue;
        const rawUrl = urlMatch[1].replace(/[.,;)\]]+$/, '');
        const prevLine = lines.slice(Math.max(0, i - 3), i).map((l) => l.trim()).filter(Boolean).pop() || '';
        const label = lines[i].replace(urlMatch[1], '').replace(/[:\-|]+$/g, '').trim() || prevLine;
        if (!label || !isJobAlertLink(rawUrl, label, meta)) continue;
        const applyUrl = cleanTrackingUrl(rawUrl);
        if (seenUrls.has(applyUrl)) continue;
        seenUrls.add(applyUrl);

        const blockText = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join('\n');
        const sourceType = inferProviderFromUrlOrMeta(applyUrl, meta);
        const { company, location } = extractContextCompanyLocation(blockText, 'Unknown');

        collected.push(
          normalizeJobPayload({
            sourceId,
            sourceType,
            externalId: applyUrl,
            title: label,
            company,
            location,
            descriptionText: blockText,
            applyUrl,
            postedAt,
          })
        );
      }
    }
  }

  return collected;
}
