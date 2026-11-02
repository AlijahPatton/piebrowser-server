// PieBrowser server - Vercel serverless function.
// Put this file at api/page.js in your repo. No other files or packages needed.
// Roku calls:  https://YOUR-APP.vercel.app/api/page?q=<url or search words>

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_BYTES = 1500000;

function candidates(q) {
  if (/^https?:\/\//i.test(q)) return [q];
  if (/^\S+\.\S+$/.test(q)) return ['https://' + q];
  const e = encodeURIComponent(q);
  return [
    'https://html.duckduckgo.com/html/?q=' + e,
    'https://www.bing.com/search?q=' + e,
    'https://lite.duckduckgo.com/lite/?q=' + e,
  ];
}

// Basic protection so nobody can use this server to poke at private networks.
function blockedHost(h) {
  h = h.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') ||
    /^(0\.|10\.|127\.|169\.254\.|192\.168\.)/.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)
  );
}

async function fetchOne(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https links work.');
  if (blockedHost(u.hostname)) throw new Error('That address is not allowed.');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const finalUrl = r.url || url;
    if (blockedHost(new URL(finalUrl).hostname)) throw new Error('That address is not allowed.');
    const type = (r.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, url: finalUrl, type, text: buf.subarray(0, MAX_BYTES).toString('utf8') };
  } finally {
    clearTimeout(timer);
  }
}

function decode(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&mdash;|&ndash;/g, '-')
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&hellip;/g, '...')
    .replace(/&bull;|&middot;/g, '-')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&(?!amp;)[a-z]{2,8};/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...');
}

function clean(s) {
  return decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function toText(html) {
  return decode(
    html
      .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/[\r\n]+/g, ' ')
      .replace(/<\/?(br|p|div|li|tr|h[1-6]|ul|ol|table|section|article|header|footer|blockquote|pre)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  ).replace(/[ \t\f]+/g, ' ');
}

// Same page size the Roku screen is built for: about 12 lines of ~85 characters.
function paginate(text) {
  const pages = [];
  let cur = '';
  let used = 0;
  for (let ln of text.split('\n')) {
    ln = ln.trim();
    if (!ln) continue;
    if (ln.length > 600) ln = ln.slice(0, 600);
    const need = 1 + Math.floor(ln.length / 85);
    if (used + need > 12 && cur) {
      pages.push(cur);
      cur = '';
      used = 0;
    }
    cur = cur ? cur + '\n' + ln : ln;
    used += need;
    if (pages.length >= 40) break;
  }
  if (cur && pages.length < 40) pages.push(cur);
  return pages;
}

function realTarget(u) {
  const h = u.hostname.replace(/^www\./, '');
  if (h.endsWith('duckduckgo.com') && u.searchParams.get('uddg')) return u.searchParams.get('uddg');
  if (h === 'bing.com' && u.pathname.startsWith('/ck/a')) {
    const v = u.searchParams.get('u');
    if (v && v.startsWith('a1')) {
      try {
        return Buffer.from(v.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      } catch (e) { /* fall through */ }
    }
  }
  return u.href;
}

function getLinks(html, base) {
  const labels = [];
  const urls = [];
  const seen = new Set();
  const host = new URL(base).hostname;
  let re = /<a\s([^>]*)>([\s\S]*?)<\/a>/gi;
  let onlyClass = null;
  if (host === 'html.duckduckgo.com') onlyClass = 'result__a';
  else if (host === 'lite.duckduckgo.com') onlyClass = 'result-link';
  else if (host.endsWith('bing.com')) re = /<h2[^>]*>\s*<a\s([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && labels.length < 10) {
    const attrs = m[1];
    if (onlyClass && attrs.indexOf(onlyClass) === -1) continue;
    const hm = /href\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (!hm) continue;
    const label = clean(m[2]);
    if (label.length < 3) continue;
    let target;
    try {
      target = realTarget(new URL(decode(hm[1]), base));
      new URL(target);
    } catch (e) {
      continue;
    }
    if (!/^https?:\/\//i.test(target) || seen.has(target) || target === base) continue;
    seen.add(target);
    labels.push(label.slice(0, 60));
    urls.push(target);
  }
  return { labels, urls };
}

function parsePage(html, base) {
  const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = (tm && clean(tm[1])) || new URL(base).hostname;
  const links = getLinks(html, base);
  return { url: base, title, pages: paginate(toText(html)), linkLabels: links.labels, linkUrls: links.urls };
}

async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=60');
  const send = (obj) => res.status(200).send(JSON.stringify(obj));
  const q = String((req.query && req.query.q) || '').trim();
  if (!q) return send({ error: 'PieBrowser server is running. Add ?q=something to try it.' });

  const started = Date.now();
  const list = candidates(q);
  let lastErr = 'No response.';
  for (const c of list) {
    if (Date.now() - started > 4500) break;
    try {
      const r = await fetchOne(c);
      const host = new URL(r.url).hostname;
      if (list.length > 1 && (r.status >= 400 || r.status === 202 || /anomaly-modal|anomaly\.js/i.test(r.text))) {
        lastErr = 'HTTP ' + r.status + ' from ' + host;
        continue;
      }
      if (r.type && !/text|html|xml/.test(r.type)) return send({ error: 'This link is not a web page (' + r.type + ').' });
      if (!r.text.trim()) {
        lastErr = 'Empty response from ' + host + ' (HTTP ' + r.status + ')';
        continue;
      }
      return send(parsePage(r.text, r.url));
    } catch (e) {
      lastErr = (e && e.name === 'AbortError') ? 'Timed out.' : String((e && e.message) || e);
    }
  }
  return send({ error: 'Server could not load it: ' + lastErr });
}

module.exports = handler;
module.exports.parsePage = parsePage; // exposed only for testing
