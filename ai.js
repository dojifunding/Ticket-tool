// ─── AI Service — Anthropic Claude Integration ──────
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

function getApiKey() {
  return process.env.ANTHROPIC_API_KEY || null;
}

function getModel() {
  return process.env.CLAUDE_MODEL || DEFAULT_MODEL;
}

function isConfigured() {
  return !!getApiKey();
}

async function callClaude(systemPrompt, userMessage, maxTokens = 2000, timeoutMs = 120000) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  // Support multi-turn: userMessage can be string or messages array
  const messages = typeof userMessage === 'string'
    ? [{ role: 'user', content: userMessage }]
    : userMessage;

  const model = getModel();
  console.log('[AI] Calling Claude — model:', model, ', messages:', messages.length, ', maxTokens:', maxTokens, ', timeout:', timeoutMs + 'ms');

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    const err = await response.text();
    console.error('[AI] API error:', response.status, err.substring(0, 300));
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
      if (msg.includes('not_found') || msg.includes('model')) {
        throw new Error('MODEL: Modèle non trouvé. Vérifiez votre accès API.');
      }
      throw new Error(msg);
    } catch (parseErr) {
      if (parseErr.message.startsWith('BILLING:') || parseErr.message.startsWith('AUTH:') || parseErr.message.startsWith('RATE_LIMIT:') || parseErr.message.startsWith('MODEL:')) throw parseErr;
      throw new Error(`Claude API error ${response.status}: ${err.substring(0, 200)}`);
    }
  }

  const data = await response.json();
  console.log('[AI] ✅ Response received:', data.content?.[0]?.text?.substring(0, 60));
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
${(resources || '').substring(0, 12000)}

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
- Generate 3-8 articles max
- Suggest a category from: getting-started, account, billing, features, troubleshooting, integrations
- Return ONLY valid JSON, no other text`;

  const userMsg = `Analyze this content and generate help center articles from it:\n\n${(content || '').substring(0, 12000)}`;

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
async function suggestTicketReply(ticket, messages, faqArticles, lang = 'fr', kbContext = '', staffResponses = []) {
  const langLabel = lang === 'en' ? 'English' : 'French';
  const systemPrompt = `You are a professional, empathetic customer support agent. Suggest a reply to a customer support ticket.

Rules:
- Write in ${langLabel}
- Be professional, warm, and helpful
- Reference relevant FAQ articles or knowledge base if provided
- LEARN from past successful staff responses: match their tone, style, and approach
- Provide a concrete solution or clear next steps
- Keep the response concise (3-6 sentences)
- If you reference an FAQ article, mention it naturally
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

  if (kbContext) {
    context += '\n\nKNOWLEDGE BASE (use this to answer accurately):\n' + kbContext.substring(0, 4000);
  }

  if (staffResponses && staffResponses.length > 0) {
    context += '\n\nPAST STAFF RESPONSES FOR SIMILAR ISSUES (learn from their tone and approach):';
    staffResponses.forEach(r => {
      context += `\n---\n[${r.staff_name}] for "${r.ticket_subject}": ${r.content.substring(0, 300)}`;
    });
  }

  return await callClaude(systemPrompt, context, 1000, 25000);
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
  analyzeImage,
  generateFromKB,
  analyzeTicketPatterns
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
- Don't use complex markdown formatting — keep it simple: **bold** for key info is OK, but avoid headers (#), tables, or excessive bullet lists
- Prefer short paragraphs over long bullet lists
- Use line breaks to separate ideas
- If the user greets you, greet back warmly and ask how you can help
- End ambiguous answers with "Would you like me to connect you with a human agent?" (in the appropriate language)

KNOWLEDGE BASE:
${knowledgeContext || 'No specific knowledge available.'}

FAQ ARTICLES:
${faqContext || 'No FAQ articles available.'}`;

  // Build multi-turn messages — ensure proper alternation and starts with 'user'
  const messages = [];
  let lastRole = null;

  for (const m of chatHistory) {
    const role = m.sender_type === 'visitor' ? 'user' : 'assistant';

    // Skip system messages
    if (m.sender_type !== 'visitor' && m.sender_type !== 'ai') continue;

    // Ensure alternation: merge consecutive same-role messages
    if (role === lastRole && messages.length > 0) {
      messages[messages.length - 1].content += '\n' + m.content;
    } else {
      messages.push({ role, content: m.content });
      lastRole = role;
    }
  }

  // API requires first message to be 'user' — remove leading assistant messages
  while (messages.length > 0 && messages[0].role === 'assistant') {
    messages.shift();
  }

  // Must have at least one user message
  if (messages.length === 0) {
    return lang === 'fr' ? 'Comment puis-je vous aider ?' : 'How can I help you?';
  }

  // API requires messages to end with 'user'
  while (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
    messages.pop();
  }

  return await callClaude(systemPrompt, messages, 500, 25000);
}

// ─── Extract Content from URL ────────────────────────
async function extractFromUrl(url) {
  const { scrapeUrl } = require('./scraper');

  const result = await scrapeUrl(url);
  let text = result.text;

  console.log('[KB] Extracted', text.length, 'chars via', result.method, 'from', url);

  // For KB: keep the full raw text — don't summarize (avoids losing information)
  // Just clean up formatting artifacts
  text = text
    .replace(/\n{4,}/g, '\n\n')       // Collapse excessive newlines
    .replace(/[ \t]{3,}/g, ' ')         // Collapse excessive spaces
    .trim();

  // Store up to 20K chars of raw content
  if (text.length > 60000) text = text.substring(0, 60000) + '\n...(contenu tronqué)';

  return { raw: text, processed: text, url, method: result.method };
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

// ─── Generate Article from Knowledge Base ────────────
async function generateFromKB(kbEntries, lang = 'fr', categoryList = '') {
  const langLabel = lang === 'en' ? 'English' : 'French';

  // Pre-split large KB entries into numbered sections
  const sections = [];
  for (const kb of kbEntries) {
    if (kb.content.length < 800) {
      sections.push({ source: kb.title, text: kb.content });
      continue;
    }
    // Split on numbered headings: "1. ", "20. ", "## ", etc.
    const parts = kb.content.split(/\n(?=\d{1,2}\.\s+[A-Z0-9★◆■])|(?=\n#{1,3}\s)/g).filter(s => s.trim().length > 30);
    if (parts.length <= 1) {
      sections.push({ source: kb.title, text: kb.content.substring(0, 6000) });
    } else {
      parts.forEach(p => sections.push({ source: kb.title, text: p.trim() }));
    }
  }

  // Build context: each section as a numbered block, capped at 14K
  let kbText = '';
  const maxTotal = 14000;
  sections.forEach((s, i) => {
    const block = `--- SECTION ${i + 1} (from "${s.source}") ---\n${s.text}\n\n`;
    if (kbText.length + block.length <= maxTotal) kbText += block;
  });

  const cats = categoryList || 'getting-started, account, billing, features, troubleshooting, integrations, rules, trading';

  const systemPrompt = `You are a FAQ article generator for a customer help center. Your CRITICAL job is to split knowledge base content into MULTIPLE SEPARATE FAQ articles.

ABSOLUTE RULES:
1. Generate MULTIPLE articles (5-15 articles). NEVER generate just 1 article.
2. Each article must focus on ONE specific topic or question a customer would ask.
3. Article titles must be written as customer questions or clear topic names. Examples:
   - "Comment fonctionne le compte 25K Static ?"
   - "Quels sont les frais d'activation ?"
   - "Règles de drawdown et perte maximale"
4. Each article is SHORT: 150-400 words max. NOT a full dump of the source material.
5. Assign each article to a category from: ${cats}
6. Write in ${langLabel}
7. Use Markdown: ## for sub-headings, **bold** for key info, bullet lists for rules/steps
8. Add a short excerpt (1 sentence summary) for each article
9. Return ONLY a valid JSON array, no other text:
[
  { "title": "...", "excerpt": "...", "content": "...", "category_suggestion": "slug-here" },
  { "title": "...", "excerpt": "...", "content": "...", "category_suggestion": "slug-here" }
]

THINK: What would a customer search for? Each answer = 1 article. Split by topic, not by section number.`;

  const userMsg = `Split this knowledge base content into MULTIPLE FAQ articles (at least 5):\n\n${kbText}`;

  const result = await callClaude(systemPrompt, userMsg, 4096);
  try {
    const clean = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const articles = JSON.parse(clean);
    // Validate: must be array with multiple items
    if (!Array.isArray(articles) || articles.length === 0) {
      throw new Error('Not an array');
    }
    return articles;
  } catch (e) {
    console.error('[AI] Failed to parse KB article generation:', e.message);
    // Try to salvage by splitting the single result
    return [{ title: 'Generated Article', excerpt: '', content: result.substring(0, 2000), category_suggestion: 'general' }];
  }
}

// ─── Analyze Ticket/Chat Patterns → Suggest Articles ─
async function analyzeTicketPatterns(recentQuestions, existingArticleTitles, lang = 'fr') {
  const langLabel = lang === 'en' ? 'English' : 'French';
  const systemPrompt = `You are an AI analyst for a customer support team. Analyze recent customer questions and detect recurring patterns that should become FAQ articles.

Rules:
- Write in ${langLabel}
- Compare questions against EXISTING articles to avoid duplicates
- Only suggest articles for topics asked 2+ times that are NOT already covered
- Return a JSON array (can be empty []): [{ "title": "...", "excerpt": "...", "content": "...", "category_suggestion": "...", "frequency": N, "sample_questions": ["..."] }]
- Content in Markdown format, well-structured
- Be specific — don't suggest generic articles
- frequency = estimated number of times this topic was asked
- Return ONLY valid JSON, no other text
- If no new articles are needed, return []`;

  const userMsg = `EXISTING FAQ ARTICLES (do NOT duplicate these):
${existingArticleTitles.map(t => '- ' + t).join('\n') || '(none)'}

RECENT CUSTOMER QUESTIONS (from tickets and livechat):
${recentQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Analyze these questions and suggest new FAQ articles for recurring topics not yet covered.`;

  const result = await callClaude(systemPrompt, userMsg, 4000);
  try {
    const clean = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('[AI] Failed to parse pattern analysis:', e.message);
    return [];
  }
}
