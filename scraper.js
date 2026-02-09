// ═══════════════════════════════════════════════════════
//  SCRAPER — Multi-strategy web page content extraction
//  Strategy 1: Jina AI Reader (free, no key, bypasses CF)
//  Strategy 2: HTTP fetch with Googlebot UA
//  Strategy 3: HTTP fetch with browser UA
// ═══════════════════════════════════════════════════════

// ─── Strategy 1: Jina AI Reader ──────────────────────
// Free API: https://r.jina.ai/{url} → returns Markdown text
// Handles: Cloudflare, SPAs, JavaScript rendering
async function fetchWithJina(url) {
  try {
    const jinaUrl = 'https://r.jina.ai/' + url;
    console.log('[Scraper] Jina Reader:', jinaUrl);

    const response = await fetch(jinaUrl, {
      headers: {
        'Accept': 'text/plain',
        'X-No-Cache': 'true',
        'X-Return-Format': 'text'
      },
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      console.log('[Scraper] Jina returned', response.status);
      return null;
    }

    let text = await response.text();
    if (!text || text.trim().length < 50) return null;

    // Clean up Jina output (remove markdown images, links formatting)
    text = text
      .replace(/!\[.*?\]\(.*?\)/g, '')           // Remove markdown images
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1') // [text](url) → text
      .replace(/^#+\s*/gm, '')                    // Remove markdown headers markers
      .replace(/\*\*([^*]+)\*\*/g, '$1')          // **bold** → bold
      .replace(/\*([^*]+)\*/g, '$1')              // *italic* → italic
      .replace(/\n{3,}/g, '\n\n')                 // Collapse multiple newlines
      .trim();

    return text;
  } catch (e) {
    console.log('[Scraper] Jina error:', e.message);
    return null;
  }
}

// ─── Strategy 2: HTTP fetch with bot UA ──────────────
// Some sites allow Googlebot/Facebook crawler
async function fetchWithBotUA(url) {
  const botUAs = [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Twitterbot/1.0',
  ];

  for (const ua of botUAs) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(12000)
      });
      if (!r.ok) continue;
      const html = await r.text();
      if (isCloudflareChallenge(html)) continue;
      const text = htmlToText(html);
      if (text && text.length > 80) return text;
    } catch (e) { continue; }
  }
  return null;
}

// ─── Strategy 3: HTTP fetch with browser UA ──────────
async function fetchWithBrowserUA(url) {
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'identity',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) return null;
    const html = await r.text();
    if (isCloudflareChallenge(html)) return null;
    const text = htmlToText(html);
    if (text && text.length > 80) return text;
    return null;
  } catch (e) { return null; }
}

// ─── Helpers ─────────────────────────────────────────
function isCloudflareChallenge(html) {
  return html.includes('cf-browser-verification') ||
         html.includes('challenge-platform') ||
         html.includes('Just a moment') ||
         html.includes('Checking if the site connection is secure') ||
         html.includes('cf-turnstile');
}

function htmlToText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Main: scrapeUrl ─────────────────────────────────
async function scrapeUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch (e) { throw new Error('URL invalide : ' + url); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Seules les URLs HTTP/HTTPS sont supportées');

  console.log('[Scraper] Fetching:', url);

  // Strategy 1: Jina AI Reader (best — handles CF, SPAs, JS rendering)
  let text = await fetchWithJina(url);
  if (text && text.length > 80) {
    console.log('[Scraper] ✅ Jina:', text.length, 'chars');
    if (text.length > 25000) text = text.substring(0, 25000) + '...';
    return { text, method: 'jina' };
  }

  // Strategy 2: Bot UA
  text = await fetchWithBotUA(url);
  if (text && text.length > 80) {
    console.log('[Scraper] ✅ Bot UA:', text.length, 'chars');
    if (text.length > 25000) text = text.substring(0, 25000) + '...';
    return { text, method: 'bot-ua' };
  }

  // Strategy 3: Browser UA
  text = await fetchWithBrowserUA(url);
  if (text && text.length > 80) {
    console.log('[Scraper] ✅ Browser UA:', text.length, 'chars');
    if (text.length > 25000) text = text.substring(0, 25000) + '...';
    return { text, method: 'http' };
  }

  throw new Error('Impossible d\'extraire le contenu de cette URL. Toutes les méthodes ont échoué (Jina Reader, Bot UA, HTTP). Essayez de copier-coller le contenu manuellement.');
}

module.exports = { scrapeUrl };
