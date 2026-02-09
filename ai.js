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
  const text = data.content[0].text;
  const usage = data.usage || {};
  const totalTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
  console.log('[AI] ✅ Response —', totalTokens, 'tokens (in:', usage.input_tokens, '/ out:', usage.output_tokens, ')');

  // Track usage for cost monitoring
  try {
    const { logAiUsage } = require('./database');
    logAiUsage('api_call', totalTokens, null, JSON.stringify({
      model: getModel(),
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0
    }));
  } catch (e) { /* ignore tracking errors */ }

  return text;
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

// ─── Translate Article ──────────────────────────────
async function translateArticle(title, content, excerpt, targetLangs) {
  const langNames = { en: 'English', es: 'Spanish', de: 'German', fr: 'French', it: 'Italian', pt: 'Portuguese' };
  const targets = targetLangs.filter(l => langNames[l]);
  if (targets.length === 0) return {};

  const systemPrompt = `You are a professional translator for a customer help center. Translate the article below into the requested languages.

RULES:
- Keep Markdown formatting intact (##, **, -, etc.)
- Keep technical terms, product names, and brand names unchanged
- Adapt expressions naturally (don't translate literally)
- Return ONLY valid JSON with this exact structure:
{
  ${targets.map(l => `"${l}": { "title": "...", "content": "...", "excerpt": "..." }`).join(',\n  ')}
}
- NO text outside the JSON`;

  const userMsg = `Translate this article into ${targets.map(l => langNames[l]).join(', ')}:

TITLE: ${title}
EXCERPT: ${excerpt || ''}
CONTENT:
${content.substring(0, 4000)}`;

  try {
    const result = await callClaude(systemPrompt, userMsg, 3000, 60000);
    const clean = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('[AI] Translation error:', e.message);
    return {};
  }
}

// ─── Batch Translate Multiple Articles (parallel) ───
async function batchTranslateArticles(articles, targetLangs) {
  const CONCURRENCY = 3;
  const results = [];

  for (let i = 0; i < articles.length; i += CONCURRENCY) {
    const batch = articles.slice(i, i + CONCURRENCY);
    const promises = batch.map(a =>
      translateArticle(a.title, a.content, a.excerpt || '', targetLangs)
        .then(translations => ({ id: a.id, translations }))
        .catch(e => ({ id: a.id, translations: {}, error: e.message }))
    );
    const batchResults = await Promise.all(promises);
    results.push(...batchResults);
  }

  return results;
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
  analyzeTicketPatterns,
  translateArticle,
  batchTranslateArticles
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
  const cats = categoryList || 'getting-started, account, billing, features, troubleshooting, integrations, rules, trading';

  // ─── Step 1: Split ALL KB entries into individual sections ───
  const sections = [];
  for (const kb of kbEntries) {
    if (kb.content.length < 600) {
      sections.push({ source: kb.title, text: kb.content });
      continue;
    }

    // Try multiple splitting strategies for robustness
    let parts = [];

    // Strategy 1: Markdown headings (## Title, ### Title)
    const mdParts = kb.content.split(/\n(?=#{1,3}\s)/).filter(s => s.trim().length > 30);
    if (mdParts.length > 3) { parts = mdParts; }

    // Strategy 2: Numbered sections (1. Title, 20. Title) — case-insensitive
    if (parts.length <= 3) {
      const numParts = kb.content.split(/\n(?=\d{1,2}\.\s+\S)/).filter(s => s.trim().length > 30);
      if (numParts.length > parts.length) parts = numParts;
    }

    // Strategy 3: Bold headings (**Title**)
    if (parts.length <= 3) {
      const boldParts = kb.content.split(/\n(?=\*\*[^*]+\*\*)/).filter(s => s.trim().length > 30);
      if (boldParts.length > parts.length) parts = boldParts;
    }

    // Strategy 4: UPPERCASE headings or special chars
    if (parts.length <= 3) {
      const upParts = kb.content.split(/\n(?=[A-Z★◆■●▶][A-Z\s★◆■●▶]{4,})/).filter(s => s.trim().length > 30);
      if (upParts.length > parts.length) parts = upParts;
    }

    // Strategy 5: Double newlines (last resort for unstructured docs)
    if (parts.length <= 3) {
      const paraParts = kb.content.split(/\n\n+/).filter(s => s.trim().length > 50);
      if (paraParts.length > 3) {
        // Group paragraphs into chunks of ~1500 chars
        let chunk = '';
        for (const p of paraParts) {
          if (chunk.length + p.length > 1500 && chunk.length > 200) {
            sections.push({ source: kb.title, text: chunk.trim() });
            chunk = '';
          }
          chunk += p + '\n\n';
        }
        if (chunk.trim().length > 50) sections.push({ source: kb.title, text: chunk.trim() });
        continue; // Skip the merge step below
      }
    }

    // Fallback: single large chunk
    if (parts.length <= 1) {
      sections.push({ source: kb.title, text: kb.content.substring(0, 4000) });
      continue;
    }

    console.log('[AI] KB "' + kb.title + '": split into', parts.length, 'sections');

    // Keep each section independent (don't merge) — but cap at 3000 chars each
    for (const p of parts) {
      if (p.trim().length > 30) {
        sections.push({ source: kb.title, text: p.trim().substring(0, 3000) });
      }
    }
  }

  console.log('[AI] KB total: ' + sections.length + ' sections from ' + kbEntries.length + ' entries');

  // ─── Step 2: Batch sections & call AI in PARALLEL ───
  const BATCH_SIZE = 6; // More sections per batch = fewer API calls
  const batches = [];
  for (let i = 0; i < sections.length; i += BATCH_SIZE) {
    batches.push(sections.slice(i, i + BATCH_SIZE));
  }

  const systemPrompt = `You are a FAQ article generator for a customer help center.

TASK: Convert the knowledge base sections below into customer-friendly FAQ articles.

RULES:
- Write in ${langLabel}
- Generate 1-3 FAQ articles per section — each about ONE specific topic
- Titles should be questions or clear topics (e.g. "Quels sont les frais d'activation ?")
- Each article: 100-400 words, Markdown formatted (## headings, **bold**, bullet lists)
- Include a short excerpt (1 sentence) for each article
- Assign a category from: ${cats}
- Return ONLY a valid JSON array:
[{"title":"...","excerpt":"...","content":"...","category_suggestion":"slug"}]
- NO text outside the JSON`;

  const allArticles = [];
  const maxBatches = Math.min(batches.length, 8);

  // Helper: process one batch
  async function processBatch(b) {
    const batch = batches[b];
    let batchText = '';
    batch.forEach((s, i) => {
      batchText += `--- SECTION ${i + 1} (${s.source}) ---\n${s.text.substring(0, 2000)}\n\n`;
    });
    console.log('[AI] KB batch', b + 1, '/', maxBatches, '—', batchText.length, 'chars');
    const result = await callClaude(systemPrompt, `Generate FAQ articles from these sections:\n\n${batchText}`, 3000, 60000);
    const clean = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const articles = JSON.parse(clean);
    if (Array.isArray(articles)) {
      const valid = articles.filter(a => a.title && a.content);
      console.log('[AI] KB batch', b + 1, '→', valid.length, 'articles');
      return valid;
    }
    return [];
  }

  // Run batches in parallel, 3 at a time
  const CONCURRENCY = 3;
  for (let start = 0; start < maxBatches; start += CONCURRENCY) {
    const chunk = [];
    for (let b = start; b < Math.min(start + CONCURRENCY, maxBatches); b++) {
      chunk.push(processBatch(b).catch(e => {
        console.error('[AI] KB batch', b + 1, 'error:', e.message);
        return [];
      }));
    }
    const results = await Promise.all(chunk);
    results.forEach(r => allArticles.push(...r));
  }

  console.log('[AI] KB generation complete:', allArticles.length, 'articles from', maxBatches, 'batches');

  if (allArticles.length === 0) {
    return [{ title: 'Erreur de génération', excerpt: '', content: 'L\'IA n\'a pas pu générer d\'articles. Réessayez.', category_suggestion: 'general' }];
  }

  return allArticles;
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
