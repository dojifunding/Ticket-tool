// ─── AI Service — Anthropic Claude Integration ──────
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

function getApiKey() {
  return process.env.ANTHROPIC_API_KEY || null;
}

function isConfigured() {
  return !!getApiKey();
}

async function callClaude(systemPrompt, userMessage, maxTokens = 2000) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  // Support multi-turn: userMessage can be string or messages array
  const messages = typeof userMessage === 'string'
    ? [{ role: 'user', content: userMessage }]
    : userMessage;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages
    })
  });

  if (!response.ok) {
    const err = await response.text();
    // Parse API error for user-friendly messages
    try {
      const errData = JSON.parse(err);
      const msg = errData?.error?.message || err;
      if (msg.includes('credit balance') || msg.includes('billing')) {
        throw new Error('BILLING: Crédit API Anthropic insuffisant. Rechargez vos crédits sur console.anthropic.com → Plans & Billing.');
      }
      if (msg.includes('authentication') || msg.includes('api_key')) {
        throw new Error('AUTH: Clé API Anthropic invalide. Vérifiez ANTHROPIC_API_KEY dans les variables d\'environnement.');
      }
      if (msg.includes('rate_limit') || response.status === 429) {
        throw new Error('RATE_LIMIT: Trop de requêtes. Réessayez dans quelques secondes.');
      }
      throw new Error(msg);
    } catch (parseErr) {
      if (parseErr.message.startsWith('BILLING:') || parseErr.message.startsWith('AUTH:') || parseErr.message.startsWith('RATE_LIMIT:')) throw parseErr;
      throw new Error(`Claude API error ${response.status}: ${err.substring(0, 200)}`);
    }
  }

  const data = await response.json();
  return data.content[0].text;
}

// ─── Generate FAQ Article from Resources ─────────────
async function generateArticle(title, resources, lang = 'fr') {
  const langLabel = lang === 'en' ? 'English' : 'French';
  const systemPrompt = `You are a professional help center article writer. Write clear, helpful, well-structured FAQ articles for a customer help center.

Rules:
- Write in ${langLabel}
- Use clear headings with ## for sections
- Use simple, accessible language
- Include step-by-step instructions when relevant
- Add helpful tips in **bold**
- Keep paragraphs short (2-3 sentences max)
- End with a "Still need help?" section suggesting to contact support
- Format in Markdown`;

  const userMsg = `Write a complete help center article with the title: "${title}"

Based on these resources/information:
${resources}

Generate a comprehensive, well-structured article.`;

  return await callClaude(systemPrompt, userMsg, 3000);
}

// ─── Generate Article from Uploaded Content ──────────
async function generateArticleFromContent(content, lang = 'fr') {
  const langLabel = lang === 'en' ? 'English' : 'French';
  const systemPrompt = `You are a professional help center article writer. Analyze the provided content and create one or more FAQ articles from it.

Rules:
- Write in ${langLabel}
- Return a JSON array of articles, each with: { "title": "...", "excerpt": "...", "content": "...", "category_suggestion": "..." }
- Content should be in Markdown format
- Make articles clear, helpful, and well-structured
- Suggest a category from: getting-started, account, billing, features, troubleshooting, integrations
- Return ONLY valid JSON, no other text`;

  const userMsg = `Analyze this content and generate help center articles from it:\n\n${content}`;

  const result = await callClaude(systemPrompt, userMsg, 4000);
  try {
    // Clean potential markdown wrapping
    const clean = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('[AI] Failed to parse article generation response:', e.message);
    return [{ title: 'Generated Article', excerpt: '', content: result, category_suggestion: 'general' }];
  }
}

// ─── Suggest Reply for Support Ticket ────────────────
async function suggestTicketReply(ticket, messages, faqArticles, lang = 'fr') {
  const langLabel = lang === 'en' ? 'English' : 'French';
  const systemPrompt = `You are a professional, empathetic customer support agent. Suggest a reply to a customer support ticket.

Rules:
- Write in ${langLabel}
- Be professional, warm, and helpful
- Reference relevant FAQ articles if provided
- Provide a concrete solution or clear next steps
- Keep the response concise (3-6 sentences)
- If you reference an FAQ article, mention it naturally (e.g., "As explained in our guide on [topic]...")
- Don't use overly formal language, be natural
- Return ONLY the reply text, nothing else`;

  let context = `TICKET: ${ticket.reference} — ${ticket.subject}
Description: ${ticket.description}
Priority: ${ticket.priority}
Category: ${ticket.category}`;

  if (ticket.client_name) context += `\nClient: ${ticket.client_name}`;

  if (messages && messages.length > 0) {
    context += '\n\nCONVERSATION HISTORY:';
    messages.slice(-5).forEach(m => {
      context += `\n[${m.full_name} (${m.user_role})]: ${m.content}`;
    });
  }

  if (faqArticles && faqArticles.length > 0) {
    context += '\n\nRELEVANT FAQ ARTICLES:';
    faqArticles.forEach(a => {
      context += `\n- "${a.title}": ${a.excerpt || a.content.substring(0, 200)}`;
    });
  }

  return await callClaude(systemPrompt, context, 1000);
}

// ─── Improve/Rewrite Text ────────────────────────────
async function improveText(text, instruction, lang = 'fr') {
  const langLabel = lang === 'en' ? 'English' : 'French';
  const systemPrompt = `You are a professional editor. Improve the provided text according to the given instruction. Write in ${langLabel}. Return ONLY the improved text, nothing else.`;

  return await callClaude(systemPrompt, `Instruction: ${instruction}\n\nText to improve:\n${text}`, 2000);
}

module.exports = {
  isConfigured,
  generateArticle,
  generateArticleFromContent,
  suggestTicketReply,
  improveText,
  livechatReply,
  extractFromUrl,
  analyzeImage
};

// ─── Livechat AI Agent ───────────────────────────────
async function livechatReply(chatHistory, knowledgeContext, faqContext, lang = 'fr') {
  const langLabel = lang === 'en' ? 'English' : 'French';
  const systemPrompt = `You are a friendly, professional AI support agent for our company's help center. Your name is "Assistant ProjectHub".

Rules:
- Write in ${langLabel}
- Be warm, helpful, concise (2-4 sentences per response)
- Use the KNOWLEDGE BASE and FAQ ARTICLES provided to answer questions accurately
- If the answer is in the knowledge base or FAQ, provide it directly
- If you're unsure or the question is complex/specific, suggest the user talk to a human agent
- Never invent information not in the knowledge base
- Don't use markdown formatting — write plain text for chat
- If the user greets you, greet back warmly and ask how you can help
- End ambiguous answers with "Would you like me to connect you with a human agent?" (in the appropriate language)

KNOWLEDGE BASE:
${knowledgeContext || 'No specific knowledge available.'}

FAQ ARTICLES:
${faqContext || 'No FAQ articles available.'}`;

  // Build multi-turn messages from chat history
  const messages = chatHistory.map(m => ({
    role: m.sender_type === 'visitor' ? 'user' : 'assistant',
    content: m.content
  }));

  return await callClaude(systemPrompt, messages, 500);
}

// ─── Extract Content from URL ────────────────────────
async function extractFromUrl(url) {
  // Validate URL
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch (e) { throw new Error('Invalid URL format'); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Only HTTP/HTTPS URLs are supported');

  let html;
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000) // 20s timeout
    });

    if (!response.ok) throw new Error(`Server returned HTTP ${response.status} ${response.statusText}`);

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/') && !contentType.includes('html') && !contentType.includes('json') && !contentType.includes('xml')) {
      throw new Error(`Unsupported content type: ${contentType}. Only HTML/text pages are supported.`);
    }

    html = await response.text();
  } catch (e) {
    if (e.name === 'TimeoutError' || e.message.includes('timeout')) {
      throw new Error('Connection timeout (20s). The site may be slow or blocking automated access.');
    }
    if (e.message.includes('fetch failed') || e.message.includes('ENOTFOUND')) {
      throw new Error(`Cannot reach ${parsedUrl.hostname}. Check the URL or try again later.`);
    }
    throw new Error(`Failed to fetch: ${e.message}`);
  }

  if (!html || html.trim().length < 50) {
    throw new Error('Page returned empty or very short content. It may require JavaScript to render (SPA).');
  }

  // HTML to text conversion
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length < 30) {
    throw new Error('Could not extract meaningful text. The page may use JavaScript rendering (React/Vue SPA) which cannot be parsed server-side.');
  }

  // Truncate
  if (text.length > 15000) text = text.substring(0, 15000) + '...';

  console.log('[KB] Extracted', text.length, 'chars from', url);

  // Summarize with AI if available
  if (isConfigured() && text.length > 200) {
    try {
      const summary = await callClaude(
        'You are a content extractor. Summarize the following web page content into clear, structured knowledge that could be used to answer customer questions. Keep all important facts, pricing, features, policies, rules. Remove navigation, ads, and irrelevant content. Output in the same language as the source. If the content is already concise, keep it mostly as-is.',
        `URL: ${url}\n\nExtracted page content:\n${text}`,
        3000
      );
      return { raw: text, processed: summary, url };
    } catch (e) {
      console.error('[KB] AI summarization failed, using raw text:', e.message);
      return { raw: text, processed: text, url };
    }
  }

  return { raw: text, processed: text, url };
}

// ─── Analyze Image ───────────────────────────────────
async function analyzeImage(base64Data, mimeType, instruction) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } },
          { type: 'text', text: instruction || 'Extract all text and useful information from this image. Structure it clearly for use as a knowledge base entry.' }
        ]
      }]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude Vision API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.content[0].text;
}
