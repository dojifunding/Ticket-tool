// ═══════════════════════════════════════════════════════
//  SCRAPER — Multi-strategy web page content extraction
//  PRESERVES DOCUMENT STRUCTURE (headings, bold, lists)
//
//  Strategy 1: Jina AI Reader (markdown mode, preserves ##)
//  Strategy 2: Jina AI Reader (text mode, fallback)
//  Strategy 3: HTTP fetch with Googlebot UA + HTML→Markdown
//  Strategy 4: HTTP fetch with browser UA + HTML→Markdown
// ═══════════════════════════════════════════════════════

// ─── Strategy 1: Jina AI Reader ──────────────────────
async function fetchWithJina(url, format = 'markdown') {
  try {
    const jinaUrl = 'https://r.jina.ai/' + url;
    console.log('[Scraper] Jina Reader (' + format + '):', jinaUrl);

    const headers = {
      'Accept': format === 'markdown' ? 'text/markdown' : 'text/plain',
      'X-No-Cache': 'true',
      'X-Return-Format': format === 'markdown' ? 'markdown' : 'text',
      'X-With-Generated-Alt': 'false',
      'X-With-Images': 'false',
      'X-With-Links-Summary': 'false'
    };

    const response = await fetch(jinaUrl, {
      headers,
      signal: AbortSignal.timeout(45000)
    });

    if (!response.ok) {
      console.log('[Scraper] Jina returned', response.status);
      return null;
    }

    let text = await response.text();
    if (!text || text.trim().length < 50) return null;

    // Clean up Jina output — PRESERVE markdown structure (##, **, -, etc.)
    text = text
      .replace(/!\[.*?\]\(.*?\)/g, '')           // Remove markdown images
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1') // [text](url) → text (keep link text)
      .replace(/\n{4,}/g, '\n\n')                // Collapse excessive newlines
      .trim();

    return text;
  } catch (e) {
    console.log('[Scraper] Jina error:', e.message);
    return null;
  }
}

// ─── Strategy 2: HTTP fetch with bot UA ──────────────
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
      const text = htmlToMarkdown(html);
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
    const text = htmlToMarkdown(html);
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

// ─── HTML → Markdown (preserves document structure) ──
// Converts HTML headings, bold, lists to Markdown equivalents
// so that the AI splitter can properly detect sections
function htmlToMarkdown(html) {
  let text = html;

  // Remove non-content elements
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');
  text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // ═══ PRESERVE STRUCTURE — Convert HTML → Markdown ═══

  // Headings: <h1> → # , <h2> → ## , <h3> → ### , etc.
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n');
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n');
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n');
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n\n#### $1\n\n');
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n\n##### $1\n\n');
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n\n###### $1\n\n');

  // Bold: <strong>, <b> → **text**
  text = text.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**');

  // Italic: <em>, <i> → *text*
  text = text.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*');

  // Lists: <li> → - item
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1');

  // Paragraphs & divs: add line breaks
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<p[^>]*>/gi, '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/div>/gi, '\n');
  text = text.replace(/<div[^>]*>/gi, '');

  // Horizontal rules
  text = text.replace(/<hr[^>]*\/?>/gi, '\n\n---\n\n');

  // Tables: basic conversion
  text = text.replace(/<\/tr>/gi, '\n');
  text = text.replace(/<\/t[hd]>/gi, ' | ');
  text = text.replace(/<t[hdr][^>]*>/gi, '');
  text = text.replace(/<\/?table[^>]*>/gi, '\n');
  text = text.replace(/<\/?thead[^>]*>/gi, '');
  text = text.replace(/<\/?tbody[^>]*>/gi, '');

  // Blockquotes
  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n');

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (m, c) => String.fromCharCode(parseInt(c)))
    .replace(/&#x([0-9a-f]+);/gi, (m, c) => String.fromCharCode(parseInt(c, 16)))
    .replace(/&\w+;/g, ' ');

  // Clean up whitespace while preserving structure
  text = text
    .replace(/[ \t]+/g, ' ')           // Collapse spaces (not newlines)
    .replace(/\n /g, '\n')             // Remove leading spaces after newlines
    .replace(/ \n/g, '\n')             // Remove trailing spaces before newlines
    .replace(/\n{4,}/g, '\n\n\n')     // Max 3 consecutive newlines
    .trim();

  return text;
}

// ─── Detect if content has proper structure (headings) ──
function hasStructure(text) {
  const headingCount = (text.match(/^#{1,4}\s+.+$/gm) || []).length;
  const boldHeadingCount = (text.match(/^\*\*[^*\n]+\*\*\s*$/gm) || []).length;
  const numberedCount = (text.match(/^\d{1,2}\.\s+[A-Za-zÀ-ÿ]/gm) || []).length;
  const total = headingCount + boldHeadingCount;
  console.log('[Scraper] Structure check: ' + headingCount + ' headings, ' + boldHeadingCount + ' bold titles, ' + numberedCount + ' numbered sections');
  return (total >= 3 || numberedCount >= 5);
}

// ─── Post-process: add structure to unstructured text ──
// Handles TWO cases:
//   A) Text with newlines but no markdown headings → add ## to numbered lines
//   B) "Wall of text" (no newlines) → detect section patterns inline and insert breaks
function addStructureIfMissing(text) {
  if (hasStructure(text)) {
    return text;
  }

  console.log('[Scraper] Content lacks structure — analyzing...');

  // ═══ STEP 1: Detect if this is a "wall of text" (very few newlines) ═══
  const newlineCount = (text.match(/\n/g) || []).length;
  const isWallOfText = newlineCount < text.length / 500; // less than 1 newline per 500 chars
  console.log('[Scraper] Newlines: ' + newlineCount + ', chars: ' + text.length + ', wall-of-text: ' + isWallOfText);

  // ═══ STEP 2: Find ALL "N. Title" candidates in the text ═══
  // Pattern: a number 1-30 followed by ". " then an uppercase word OR digit-starting title
  // Handles: "1. Foreword", "18. 10K DRAWDOWN", "19. 30% Consistency", "20. 25K Static"
  const candidates = [];
  const candidateRegex = /(\d{1,2})\.\s+([A-ZÀ-Ÿ0-9][a-zà-ÿA-ZÀ-Ÿ0-9%\s,&()\/\-:]{2,}?)(?=\s+[A-ZÀ-Ÿa-zà-ÿ])/g;
  let match;
  while ((match = candidateRegex.exec(text)) !== null) {
    const num = parseInt(match[1]);
    if (num >= 1 && num <= 30) {
      // Extract a reasonable title (up to next sentence or 80 chars)
      let titleEnd = text.indexOf('. ', match.index + match[0].length);
      if (titleEnd === -1 || titleEnd - match.index > 120) titleEnd = match.index + 80;
      
      let title = match[0].trim();
      // Extend title with continuation words
      const afterMatch = text.substring(match.index + match[0].length, match.index + match[0].length + 100);
      const titleExtension = afterMatch.match(/^([A-ZÀ-Ÿa-zà-ÿ0-9%\s,&()\/\-:]+?)(?=\s+(?:At|We|You|The|In|Our|Your|This|Here|During|All|If|On|A\s|It|To|For|Once|From|No |Yes|Any|Whether|Trading|However))/);
      if (titleExtension) {
        title += titleExtension[1];
      }
      
      candidates.push({
        num,
        pos: match.index,
        title: title.trim(),
        raw: match[0]
      });
    }
  }

  console.log('[Scraper] Found ' + candidates.length + ' numbered section candidates');
  if (candidates.length < 3) {
    console.log('[Scraper] Too few candidates, skipping structure detection');
    return text;
  }

  // ═══ STEP 3: Identify MAIN sections (ascending sequence 1→N) ═══
  // Main sections go 1, 2, 3, ..., 21 in order throughout the document
  // Sub-items restart from 1 within a parent section (e.g., section 5 has sub-items 1-5)
  // Algorithm: find the longest ascending subsequence starting from 1
  
  const mainSections = [];
  let expectedNext = 1;
  
  for (const c of candidates) {
    if (c.num === expectedNext) {
      mainSections.push(c);
      expectedNext = c.num + 1;
    } else if (c.num > expectedNext && c.num <= expectedNext + 5) {
      // Allow gaps up to 5 (handles sections lost during scraping)
      mainSections.push(c);
      expectedNext = c.num + 1;
    }
    // If c.num < expectedNext → sub-item (number restarted within a section) → skip
    // If c.num > expectedNext + 5 → too far ahead, likely unrelated → skip
  }

  console.log('[Scraper] Identified ' + mainSections.length + ' main sections: ' + 
    mainSections.map(s => s.num + '. ' + s.title.substring(0, 30)).join(' | '));

  if (mainSections.length < 3) {
    console.log('[Scraper] Too few main sections detected, falling back to basic approach');
    // Basic approach: just add newlines before any "N. Title" at line start
    let result = text;
    result = result.replace(
      /(\n)(\d{1,2}\.\s+[A-ZÀ-Ÿ][^\n]{2,})/g,
      '\n\n## $2'
    );
    return result;
  }

  // ═══ STEP 4: Insert ## headings before each main section ═══
  // Work backwards to not mess up positions
  let result = text;
  const mainPositions = new Set(mainSections.map(s => s.pos));
  
  // Sort by position descending (so we insert from end to start)
  const sortedMain = [...mainSections].sort((a, b) => b.pos - a.pos);
  
  for (const section of sortedMain) {
    const before = result.substring(0, section.pos);
    const after = result.substring(section.pos);
    
    // Find the title end in the remaining text
    // Title is: "N. Words Until Content Starts"
    // We need to determine where the title ends and content begins
    const titleText = section.num + '. ' + section.title.replace(/^\d{1,2}\.\s*/, '');
    
    // Insert line break + heading marker
    result = before.trimEnd() + '\n\n## ' + after.trimStart();
  }

  // ═══ STEP 5: Also add line breaks before sub-items for readability ═══
  // Sub-numbered items (1. Sanctions, 2. Management) within sections
  // Don't promote to ## but add newlines
  if (isWallOfText) {
    // Add line breaks before patterns that look like sub-items
    // Pattern: ". N. Title" where N is a small number and is NOT a main section
    result = result.replace(
      /([.!?:])(\s+)(\d{1,2})\.\s+([A-ZÀ-Ÿ])/g,
      (match, punct, space, num, letter) => {
        const n = parseInt(num);
        // Check if this position is a main section (already has ##)
        if (mainPositions.has(match.index)) return match;
        // Sub-items: just add a newline for readability
        return punct + '\n' + num + '. ' + letter;
      }
    );
    
    // Also add line breaks before common section patterns
    // "Registration:", "Platform Connection:", "Evaluation Phase:", etc.
    result = result.replace(
      /([.!?])\s+([A-ZÀ-Ÿ][a-zà-ÿA-Z\s]{2,}:)\s/g,
      '$1\n$2 '
    );
  }

  // ═══ STEP 6: Clean up ═══
  result = result
    .replace(/\n{4,}/g, '\n\n')     // Max 2 consecutive newlines
    .replace(/## \s+/g, '## ')       // Clean heading spaces
    .trim();

  const headingCount = (result.match(/^## /gm) || []).length;
  console.log('[Scraper] Added ' + headingCount + ' markdown headings for main sections');

  return result;
}

// ─── Main: scrapeUrl ────────────────────────────────
async function scrapeUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch (e) { throw new Error('URL invalide : ' + url); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Seules les URLs HTTP/HTTPS sont supportées');

  console.log('[Scraper] Fetching:', url);

  // Strategy 1: Jina MARKDOWN first (preserves headings)
  let textMd = await fetchWithJina(url, 'markdown');
  const jinaMdLen = textMd ? textMd.length : 0;

  // Strategy 2: Jina TEXT (fallback, may have more content)
  let textPlain = await fetchWithJina(url, 'text');
  const jinaTextLen = textPlain ? textPlain.length : 0;

  // PREFER markdown if it has structure, even if slightly shorter
  let text = null;
  let method = '';

  if (textMd && jinaMdLen > 80) {
    if (hasStructure(textMd)) {
      // Markdown already has ## headings — use as-is
      text = textMd;
      method = 'jina-markdown';
      console.log('[Scraper] ✅ Jina markdown (' + jinaMdLen + ' chars) — has structure');
    } else {
      // Markdown lacks structure — enhance it
      const base = (textPlain && jinaTextLen > jinaMdLen * 0.8) 
        ? (jinaMdLen >= jinaTextLen ? textMd : textPlain) 
        : textMd;
      text = addStructureIfMissing(base);
      method = 'jina-enhanced';
      console.log('[Scraper] ✅ Jina enhanced (' + text.length + ' chars)');
    }
  } else if (textPlain && jinaTextLen > 80) {
    text = addStructureIfMissing(textPlain);
    method = 'jina-text-enhanced';
    console.log('[Scraper] ✅ Jina text enhanced (' + text.length + ' chars)');
  }

  if (text && text.length > 80) {
    if (text.length > 80000) text = text.substring(0, 80000) + '...';
    return { text, method };
  }

  // Strategy 3: Bot UA with HTML→Markdown
  text = await fetchWithBotUA(url);
  if (text && text.length > 80) {
    text = addStructureIfMissing(text);
    console.log('[Scraper] ✅ Bot UA:', text.length, 'chars');
    if (text.length > 80000) text = text.substring(0, 80000) + '...';
    return { text, method: 'bot-ua' };
  }

  // Strategy 4: Browser UA with HTML→Markdown
  text = await fetchWithBrowserUA(url);
  if (text && text.length > 80) {
    text = addStructureIfMissing(text);
    console.log('[Scraper] ✅ Browser UA:', text.length, 'chars');
    if (text.length > 80000) text = text.substring(0, 80000) + '...';
    return { text, method: 'http' };
  }

  throw new Error('Impossible d\'extraire le contenu de cette URL. Toutes les méthodes ont échoué (Jina Reader, Bot UA, HTTP). Essayez de copier-coller le contenu manuellement.');
}

module.exports = { scrapeUrl };
