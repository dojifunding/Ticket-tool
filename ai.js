// ─── AI Service — Multi-Provider Support ────────────
// Supports: Anthropic Claude, Google Gemini, OpenAI, Grok, Mistral
// API key is managed at PLATFORM level (env var)
// Tenant-level toggles control which features are enabled
// AI personality is driven by industry profiles (ai-profiles.js)
//
// ═══ CONFIGURATION (env vars) ═══
// Option 1: All-Gemini (recommended — cheapest)
//   AI_PROVIDER=gemini
//   GEMINI_API_KEY=AIza...
//
// Option 2: All-Claude (best quality)
//   AI_PROVIDER=anthropic
//   ANTHROPIC_API_KEY=sk-ant-...
//
// Option 3: Hybrid — Gemini fast + Claude smart
//   AI_PROVIDER_FAST=gemini
//   AI_PROVIDER_SMART=anthropic
//   GEMINI_API_KEY=AIza...
//   ANTHROPIC_API_KEY=sk-ant-...
//
// Option 4: OpenAI-compatible (Grok, Mistral, custom)
//   AI_PROVIDER=openai
//   OPENAI_API_KEY=sk-...
//   OPENAI_BASE_URL=https://api.openai.com/v1  (or Grok/Mistral URL)
// ═════════════════════════════════

const { buildTenantAiContext, getTenantGreeting } = require('./ai-profiles');

// ─── Provider Configurations ─────────────────────────
const PROVIDERS = {
  anthropic: {
    name: 'Anthropic Claude',
    apiUrl: 'https://api.anthropic.com/v1/messages',
    models: {
      smart: 'claude-sonnet-4-5-20250929',   // $3/$15
      fast:  'claude-haiku-4-5-20251001'      // $1/$5
    },
    getApiKey: () => process.env.ANTHROPIC_API_KEY,
    buildRequest: (model, systemPrompt, messages, maxTokens) => ({
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: { model, max_tokens: maxTokens, system: systemPrompt, messages }
    }),
    parseResponse: (data) => ({
      text: data.content[0].text,
      inputTokens: data.usage?.input_tokens || 0,
      outputTokens: data.usage?.output_tokens || 0
    })
  },

  gemini: {
    name: 'Google Gemini',
    // Native Gemini API — model name inserted at call time
    apiUrl: (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY || ''}`,
    models: {
      smart: 'gemini-2.5-flash',   // $0.30/$2.50 — best free-tier model
      fast:  'gemini-2.5-flash'    // $0.30/$2.50
    },
    getApiKey: () => process.env.GEMINI_API_KEY,
    buildRequest: (model, systemPrompt, messages, maxTokens) => ({
      headers: { 'Content-Type': 'application/json' },
      body: {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: messages.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        })),
        generationConfig: { maxOutputTokens: maxTokens }
      }
    }),
    parseResponse: (data) => {
      const parts = data.candidates?.[0]?.content?.parts || [];
      // Gemini 2.5 models include "thought" parts — skip them
      const textParts = parts.filter(p => !p.thought);
      const text = textParts.map(p => p.text || '').join('');
      const usage = data.usageMetadata || {};
      return {
        text: text || parts.map(p => p.text || '').join(''), // fallback to all parts
        inputTokens: usage.promptTokenCount || 0,
        outputTokens: usage.candidatesTokenCount || 0
      };
    }
  },

  openai: {
    name: 'OpenAI-Compatible',
    apiUrl: () => (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/chat/completions',
    models: {
      smart: 'gpt-4o',
      fast:  'gpt-4o-mini'
    },
    getApiKey: () => process.env.OPENAI_API_KEY,
    buildRequest: (model, systemPrompt, messages, maxTokens) => ({
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY
      },
      body: {
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages
        ]
      }
    }),
    parseResponse: (data) => ({
      text: data.choices[0].message.content,
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0
    })
  }
};

// ─── Provider Resolution ─────────────────────────────
function getProvider(tier = 'smart') {
  // Per-tier override: AI_PROVIDER_FAST=gemini, AI_PROVIDER_SMART=anthropic
  const tierEnv = tier === 'fast' ? process.env.AI_PROVIDER_FAST : process.env.AI_PROVIDER_SMART;
  const providerId = tierEnv || process.env.AI_PROVIDER || autoDetectProvider();
  return PROVIDERS[providerId] || PROVIDERS.anthropic;
}

function autoDetectProvider() {
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'anthropic';
}

function getApiKey() {
  // Check all possible keys
  return process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || null;
}

function getModel(tier = 'smart') {
  // Allow full model override via env
  if (tier === 'fast' && process.env.AI_MODEL_FAST) return process.env.AI_MODEL_FAST;
  if (tier === 'smart' && process.env.AI_MODEL_SMART) return process.env.AI_MODEL_SMART;
  // Legacy env var support
  if (tier === 'fast' && process.env.CLAUDE_MODEL_FAST) return process.env.CLAUDE_MODEL_FAST;
  if (process.env.CLAUDE_MODEL) return process.env.CLAUDE_MODEL;
  // Default from provider config
  const provider = getProvider(tier);
  return provider.models[tier] || provider.models.smart;
}

// Platform-level: is the API key configured?
function isConfigured() {
  return !!getApiKey();
}

// Tenant-level: is AI available for this tenant?
function isAvailableForTenant(tenant) {
  if (!isConfigured()) return false;
  if (!tenant) return isConfigured();
  return !!tenant.ai_enabled;
}

// Check if tenant has exceeded their AI calls limit
function checkAiCallsLimit(tenant) {
  if (!tenant || !tenant.ai_calls_limit || tenant.ai_calls_limit === -1) return true; // unlimited
  try {
    const { getDb } = require('./database');
    const db = getDb();
    const count = db.prepare("SELECT COUNT(*) as c FROM ai_usage_log WHERE created_at > datetime('now', '-30 days')").get()?.c || 0;
    return count < tenant.ai_calls_limit;
  } catch (e) {
    return true; // allow on error
  }
}

// ─── Universal AI Call ───────────────────────────────
async function callClaude(systemPrompt, userMessage, maxTokens = 2000, timeoutMs = 120000, modelTier = 'smart') {
  if (!getApiKey()) throw new Error('Le service IA est temporairement indisponible.');

  // Support multi-turn: userMessage can be string or messages array
  const messages = typeof userMessage === 'string'
    ? [{ role: 'user', content: userMessage }]
    : userMessage;

  const provider = getProvider(modelTier);
  const model = getModel(modelTier);
  const apiUrl = typeof provider.apiUrl === 'function' ? provider.apiUrl(model) : provider.apiUrl;
  const { headers, body } = provider.buildRequest(model, systemPrompt, messages, maxTokens);

  console.log('[AI] Calling', provider.name, '— model:', model, '(' + modelTier + '), messages:', messages.length, ', maxTokens:', maxTokens, ', timeout:', timeoutMs + 'ms');

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    const err = await response.text();
    console.error('[AI] API error:', response.status, err.substring(0, 300));
    try {
      const errData = JSON.parse(err);
      const msg = errData?.error?.message || err;
      if (msg.includes('credit balance') || msg.includes('billing') || msg.includes('quota')) {
        throw new Error('Le service IA est temporairement indisponible. Notre équipe a été notifiée.');
      }
      if (msg.includes('authentication') || msg.includes('api_key') || msg.includes('API key')) {
        throw new Error('Le service IA est temporairement indisponible. Notre équipe a été notifiée.');
      }
      if (msg.includes('rate_limit') || msg.includes('RATE_LIMIT') || response.status === 429) {
        throw new Error('Le service IA est surchargé. Réessayez dans quelques secondes.');
      }
      if (msg.includes('not_found') || msg.includes('model')) {
        throw new Error('Le service IA est temporairement indisponible. Notre équipe a été notifiée.');
      }
      throw new Error('Le service IA a rencontré une erreur. Réessayez.');
    } catch (parseErr) {
      if (parseErr.message.startsWith('Le service')) throw parseErr;
      throw new Error('Le service IA est temporairement indisponible.');
    }
  }

  const data = await response.json();
  const parsed = provider.parseResponse(data);
  const totalTokens = parsed.inputTokens + parsed.outputTokens;
  console.log('[AI] ✅ Response —', totalTokens, 'tokens (in:', parsed.inputTokens, '/ out:', parsed.outputTokens, ')');

  // Track usage for cost monitoring
  try {
    const { logAiUsage } = require('./database');
    logAiUsage('api_call', totalTokens, null, JSON.stringify({
      provider: provider.name,
      model,
      tier: modelTier,
      input_tokens: parsed.inputTokens,
      output_tokens: parsed.outputTokens
    }));
  } catch (e) { /* ignore tracking errors */ }

  return parsed.text;
}

// ─── Generate FAQ Article from Resources ─────────────
async function generateArticle(title, resources, lang = 'fr', tenant = null) {
  const langLabel = lang === 'en' ? 'English' : 'French';
  const profileContext = tenant ? buildTenantAiContext(tenant, lang) : '';

  const systemPrompt = `You are a professional help center article writer. Write clear, helpful, well-structured FAQ articles for a customer help center.

${profileContext}Rules:
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
async function generateArticleFromContent(content, lang = 'fr', options = {}) {
  const { outputLang, companyContext } = options;
  const preserveSource = !outputLang || outputLang === 'source';
  const langNames = { en: 'English', fr: 'French', es: 'Spanish', de: 'German' };
  const targetLangLabel = preserveSource ? null : (langNames[outputLang] || langNames[lang] || 'French');

  let langInstruction;
  if (preserveSource) {
    langInstruction = `- KEEP THE SAME LANGUAGE as the source content — do NOT translate
- If the source is in English, write everything in English
- If the source is in French, write everything in French`;
  } else {
    langInstruction = `- Write titles, excerpts, and content in ${targetLangLabel}`;
    if (companyContext) {
      langInstruction += `\n- DOMAIN CONTEXT: ${companyContext} — use appropriate specialized vocabulary`;
    }
  }

  const systemPrompt = `You are a FAQ article structurer for a customer help center.

TASK: Structure the provided content into individual FAQ articles.

CRITICAL RULE — 1 MAIN HEADING = 1 ARTICLE:
- Look at the document's structure: headings, bold titles, numbered sections
- Each MAIN/TOP-LEVEL heading = EXACTLY 1 FAQ article
- Sub-headings, sub-items, numbered lists WITHIN a section = they go INSIDE the same article as content
- Example: A section "5. Country Restrictions" with sub-items "1. Sanctions", "2. Management" = 1 article containing all sub-items
- NEVER split a section's content into multiple articles
- NEVER merge content from two different top-level sections into one article

ABSOLUTE RULES — CONTENT FIDELITY:
- **PRESERVE the original text EXACTLY as written** — do NOT paraphrase, rewrite, summarize, or rephrase
- Copy the source content VERBATIM into each article's content field
- Keep ALL details: numbers, percentages, amounts, conditions, lists, steps — everything
- The ONLY modification allowed is adding Markdown formatting (## headings, **bold**, - bullets) to improve readability
- Do NOT add information that is not in the source
- Do NOT remove information that IS in the source

LANGUAGE RULES:
${langInstruction}

FORMATTING RULES:
- Title: use the section's own heading, rephrased as a clear question or topic name if needed
- Excerpt: 1 sentence summary
- Content: the FULL ORIGINAL text including all sub-items, with Markdown formatting
- Category: assign from: getting-started, account, billing, features, troubleshooting, integrations, rules, trading
- Return ONLY valid JSON, no other text

Return: [{"title":"...","excerpt":"...","content":"...","category_suggestion":"slug"}]`;

  const userMsg = `Structure this content into FAQ articles. PRESERVE ALL ORIGINAL TEXT VERBATIM:\n\n${(content || '').substring(0, 20000)}`;

  const result = await callClaude(systemPrompt, userMsg, 8000);
  try {
    const clean = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('[AI] Failed to parse article generation response:', e.message);
    return [{ title: 'Generated Article', excerpt: '', content: result, category_suggestion: 'general' }];
  }
}

// ─── Suggest Reply for Support Ticket ────────────────
async function suggestTicketReply(ticket, messages, faqArticles, lang = 'fr', kbContext = '', staffResponses = [], tenant = null) {
  const langLabel = lang === 'en' ? 'English' : 'French';
  const profileContext = tenant ? buildTenantAiContext(tenant, lang) : '';

  const systemPrompt = `You are a professional, empathetic customer support agent. Suggest a reply to a customer support ticket.

${profileContext}Rules:
- Write in ${langLabel}
- Be professional, warm, and helpful

CRITICAL — RESPONSE STYLE:
- GO STRAIGHT TO THE ANSWER in the first sentence. No preamble, no filler.
- NEVER start with "Cher [nom]", "Bonjour [nom]", "Merci pour votre message/question...", "Nous vous remercions...", "Thank you for reaching out..." or any similar greeting/preamble
- NEVER restate or summarize the customer's question before answering
- First sentence = the answer or the most important information
- Be CONCISE: give the key information directly, then add details only if needed
- NEVER add generic disclaimers like "Les informations ne constituent pas un conseil...", "Pour toute décision financière, consultez..." or "N'hésitez pas à nous contacter pour toute question"
- Don't use overly formal language, be natural and direct
- Keep the response complete but concise (3-6 sentences) — NEVER cut off mid-sentence

CRITICAL — SOURCE PRIORITY (follow this order STRICTLY):
1. FAQ ARTICLES are your #1 source of truth — if a FAQ article covers the topic, USE IT and cite the specific details from it
2. KNOWLEDGE BASE is your #2 source — use it only if FAQ articles don't cover the topic
3. PAST STAFF RESPONSES are examples of tone/style — learn from them but don't contradict FAQ/KB
4. If NEITHER FAQ nor KB covers the topic: say "Je n'ai pas trouvé d'information spécifique sur ce sujet dans notre base de connaissances."

CRITICAL — NEVER FABRICATE:
- NEVER claim that a rule, feature, or policy does NOT exist
- NEVER say "there is no such rule", "this doesn't apply", "we don't have this"
- If the FAQ/KB doesn't mention it, say you don't have information about it
- NEVER contradict what is written in a FAQ article

CRITICAL: Answer the customer's LATEST question/message, not older ones
Return ONLY the reply text, nothing else`;

  let context = `TICKET: ${ticket.reference} — ${ticket.subject}
Description: ${(ticket.description || '').substring(0, 2000)}
Priority: ${ticket.priority}
Category: ${ticket.category}`;

  if (ticket.client_name) context += `\nClient: ${ticket.client_name}`;

  if (messages && messages.length > 0) {
    context += '\n\nCONVERSATION HISTORY (answer the LAST customer message):';
    messages.slice(-8).forEach(m => {
      context += `\n[${m.full_name} (${m.user_role})]: ${m.content.substring(0, 500)}`;
    });
  }

  if (staffResponses && staffResponses.length > 0) {
    context += '\n\nPAST STAFF RESPONSES FOR SIMILAR ISSUES (learn from their tone and approach):';
    staffResponses.forEach(r => {
      context += `\n---\n[${r.staff_name}] for "${r.ticket_subject}": ${r.content.substring(0, 400)}`;
    });
  }

  if (kbContext) {
    context += '\n\nKNOWLEDGE BASE (secondary source — use only if FAQ doesn\'t cover the topic):\n' + kbContext.substring(0, 6000);
  }

  // FAQ articles LAST = recency bias makes AI prioritize them
  if (faqArticles && faqArticles.length > 0) {
    context += '\n\n════════════════════════════════════════════';
    context += '\n⚠️ FAQ ARTICLES — PRIMARY SOURCE OF TRUTH ⚠️';
    context += '\nSearch these articles for the answer. If an article covers the topic, base your answer on it.';
    context += '\n════════════════════════════════════════════';
    faqArticles.forEach((a, i) => {
      const articleUrl = a.company_slug ? `/help/c/${a.company_slug}/article/${a.slug}` : `/help/article/${a.slug}`;
      // Send title + excerpt for all, full content truncated to fit context
      const contentLen = faqArticles.length > 15 ? 800 : 2000;
      context += `\n\n--- FAQ #${i + 1}: "${a.title}" (link: ${articleUrl}) ---\n${a.excerpt ? 'Summary: ' + a.excerpt + '\n' : ''}${a.content.substring(0, contentLen)}`;
    });
  }

  return await callClaude(systemPrompt, context, 2000, 30000, 'fast');
}

// ─── Improve/Rewrite Text ────────────────────────────
async function improveText(text, instruction, lang = 'fr') {
  const langLabel = lang === 'en' ? 'English' : 'French';
  const systemPrompt = `You are a professional editor. Improve the provided text according to the given instruction. Write in ${langLabel}. Return ONLY the improved text, nothing else.`;

  return await callClaude(systemPrompt, `Instruction: ${instruction}\n\nText to improve:\n${text}`, 2000, 120000, 'fast');
}

// ─── Translate Article ──────────────────────────────
async function translateArticle(title, content, excerpt, targetLangs, companyContext = '') {
  const langNames = { en: 'English', es: 'Spanish', de: 'German', fr: 'French', it: 'Italian', pt: 'Portuguese' };
  const targets = targetLangs.filter(l => langNames[l]);
  if (targets.length === 0) return {};

  let domainInstruction = '';
  if (companyContext) {
    domainInstruction = `\n\nDOMAIN/INDUSTRY CONTEXT:\n${companyContext}\n- Use the correct specialized vocabulary for this domain when translating\n- For example: financial terms (drawdown, equity, payout), trading terms (lot size, leverage, margin), medical terms, legal terms, etc.\n- Keep industry-specific terms that are commonly used untranslated if they are standard jargon in the target language (e.g. "drawdown" stays "drawdown" in French financial context)`;
  }

  const systemPrompt = `You are a professional translator for a customer help center. Translate the article below into the requested languages.

RULES:
- Keep Markdown formatting intact (##, **, -, etc.)
- Keep technical terms, product names, and brand names unchanged
- Adapt expressions naturally (don't translate literally)
- Use professional, domain-appropriate vocabulary${domainInstruction}
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
    const result = await callClaude(systemPrompt, userMsg, 3000, 60000, 'fast');
    const clean = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    console.log('[AI] Translation raw response (first 200):', clean.substring(0, 200));
    const parsed = JSON.parse(clean);
    console.log('[AI] Translation parsed languages:', Object.keys(parsed).join(', '));
    return parsed;
  } catch (e) {
    console.error('[AI] Translation error:', e.message);
    return {};
  }
}

// ─── Batch Translate Multiple Articles (parallel) ───
async function batchTranslateArticles(articles, targetLangs, companyContext = '') {
  const CONCURRENCY = 3;
  const results = [];

  for (let i = 0; i < articles.length; i += CONCURRENCY) {
    const batch = articles.slice(i, i + CONCURRENCY);
    const promises = batch.map(a =>
      translateArticle(a.title, a.content, a.excerpt || '', targetLangs, companyContext)
        .then(translations => ({ id: a.id, translations }))
        .catch(e => ({ id: a.id, translations: {}, error: e.message }))
    );
    const batchResults = await Promise.all(promises);
    results.push(...batchResults);
  }

  return results;
}

// ─── Startup Config Log ──────────────────────────────
function logConfig() {
  const fastProvider = getProvider('fast');
  const smartProvider = getProvider('smart');
  const fastModel = getModel('fast');
  const smartModel = getModel('smart');
  console.log('[AI] ═══════════════════════════════════════');
  console.log('[AI] Provider config:');
  console.log('[AI]   FAST  →', fastProvider.name, '/', fastModel);
  console.log('[AI]   SMART →', smartProvider.name, '/', smartModel);
  console.log('[AI] ═══════════════════════════════════════');
}

module.exports = {
  isConfigured,
  isAvailableForTenant,
  checkAiCallsLimit,
  logConfig,
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
async function livechatReply(chatHistory, knowledgeContext, faqContext, lang = 'fr', companyName = '', chatbotContext = '', tenant = null) {
  const langLabel = lang === 'en' ? 'English' : 'French';
  const name = companyName || 'notre entreprise';

  // Build tenant-specific AI personality from profile
  const profileContext = tenant ? buildTenantAiContext(tenant, lang) : '';

  const systemPrompt = `You are a friendly, professional AI support agent for ${name}. Your name is "Assistant".

${profileContext}${chatbotContext ? `COMPANY CONTEXT:\n${chatbotContext}\n\n` : ''}Rules:
- Write in ${langLabel}
- Be warm, helpful, and clear

CRITICAL — RESPONSE STYLE:
- GO STRAIGHT TO THE ANSWER. No preamble, no filler, no "thank you for your question"
- NEVER start with "Nous vous remercions de votre question...", "Merci pour votre question...", "C'est une excellente question...", "Thank you for asking..." or similar
- NEVER start with a long intro paragraph that restates or summarizes the question
- First sentence = the answer or the most important information
- Be CONCISE: give the key information directly, then add details if needed
- Keep simple answers short (2-4 sentences)
- For complex topics, provide complete answers but still start with the key point first
- NEVER cut off mid-sentence or mid-paragraph
- NEVER add generic disclaimers like "Les informations fournies ne constituent pas un conseil en investissement", "Pour toute décision financière, consultez votre conseiller..." — these are unnecessary and unhelpful
- NEVER end with generic advice like "N'hésitez pas à nous contacter" unless the user specifically needs further assistance

- Use the KNOWLEDGE BASE and FAQ ARTICLES provided to answer questions accurately
- If the answer is in the knowledge base or FAQ, provide it directly and confidently
- IMPORTANT: You represent ${name}, NOT "ProjectHub" — ProjectHub is just the software platform. Answer questions about ${name}'s products, services, and rules as if you are ${name}'s support team
- When you use information from a FAQ article, ALWAYS include a link to it at the end using the EXACT link provided next to each FAQ article title (e.g. 🔗 [Article title](link))

CRITICAL — SOURCE PRIORITY:
1. FAQ ARTICLES (below) are your #1 source — if a FAQ article covers the topic, USE IT FIRST
2. KNOWLEDGE BASE is secondary — use it only if no FAQ covers the topic
3. If NEITHER covers it, say you don't have specific information

CRITICAL — WHEN YOU DON'T KNOW:
- If the question is about a topic, company, product, or service NOT covered in the KNOWLEDGE BASE or FAQ ARTICLES below, you MUST respond ONLY with a short message like:
  "Je n'ai pas d'informations spécifiques concernant [sujet] dans ma base de connaissances. Souhaitez-vous que je vous mette en contact avec un agent humain ?"
- NEVER give generic advice, recommendations, disclaimers, or general knowledge when the answer is not in your knowledge base
- NEVER say things like "Les règles peuvent varier...", "Je vous recommande de consulter...", "Les informations que je fournis ne constituent pas..."
- NEVER improvise, speculate, or add information from your general training — ONLY use what is in the KNOWLEDGE BASE and FAQ ARTICLES sections below
- Your ONLY sources of truth are the KNOWLEDGE BASE and FAQ ARTICLES below — nothing else
- CRITICAL — NEVER FABRICATE: NEVER claim that a rule, feature, or policy does NOT exist. If the KB/FAQ doesn't mention it, say you don't have information — do NOT say "there is no such rule" or "this doesn't apply" or "we don't have this policy"

Other rules:
- If you're unsure or the question is complex/specific, suggest the user talk to a human agent
- Don't say "I don't have information about this" if the answer IS in the knowledge base or FAQ below — read them carefully
- Don't use complex markdown formatting — keep it simple: **bold** for key info is OK, but avoid headers (#), tables, or excessive bullet lists
- Prefer short paragraphs over long bullet lists
- Use line breaks to separate ideas
- If the user greets you AND this is the FIRST exchange (no prior assistant messages in history), greet back warmly and ask how you can help
- IMPORTANT: Do NOT say "Bonjour", "Hello", or any greeting if you have already greeted in the conversation history. Jump straight to answering the question.
- IMPORTANT: Only answer the user's LATEST message. Do NOT repeat or summarize answers you already gave in previous messages. If the conversation history contains prior Q&A, ignore those topics and focus solely on the new question.

KNOWLEDGE BASE (secondary source):
${knowledgeContext || 'No specific knowledge available.'}

════════════════════════════════════════════
⚠️ FAQ ARTICLES — PRIMARY SOURCE OF TRUTH ⚠️
If an article below covers the topic, USE IT as your main source. NEVER contradict a FAQ article.
════════════════════════════════════════════
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

  return await callClaude(systemPrompt, messages, 2500, 30000, 'fast');
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

  // Store up to 80K chars of raw content
  if (text.length > 80000) text = text.substring(0, 80000) + '\n...(contenu tronqué)';

  return { raw: text, processed: text, url, method: result.method };
}

// ─── Analyze Image ───────────────────────────────────
async function analyzeImage(base64Data, mimeType, instruction) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('Le service IA est temporairement indisponible.');

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
    console.error('[AI] Vision API error:', response.status, err.substring(0, 200));
    throw new Error('Le service IA est temporairement indisponible.');
  }

  const data = await response.json();
  return data.content[0].text;
}

// ─── Generate Article from Knowledge Base ────────────
async function generateFromKB(kbEntries, lang = 'fr', categoryList = '', options = {}) {
  const { outputLang, companyContext } = options;
  // outputLang: 'source' (keep original, DEFAULT) | 'fr' | 'en' etc.
  const preserveSource = !outputLang || outputLang === 'source';
  const cats = categoryList || 'getting-started, account, billing, features, troubleshooting, integrations, rules, trading';

  // ═══════════════════════════════════════════════════════
  //  STEP 1: SPLIT KB CONTENT INTO SECTIONS
  //  Priority: deterministic splitter (tested, reliable) → AI fallback
  //  Rule: each main section = one FAQ article
  // ═══════════════════════════════════════════════════════
  const { splitKbIntoSections } = require('./database');
  const sections = [];

  for (const kb of kbEntries) {
    let content = kb.content;
    const len = content.length;
    console.log('[AI] KB entry "' + kb.title + '": ' + len + ' chars');

    // ─── Clean Jina metadata ───
    content = content
      .replace(/^Title:.*\n/i, '')
      .replace(/^URL Source:.*\n/i, '')
      .replace(/^Markdown Content:\s*\n/i, '')
      .replace(/^\s*\n/, '')
      .trim();

    // Short entries = single section
    if (len < 800) {
      sections.push({ source: kb.title, text: content });
      console.log('[AI]   → Short entry, kept as-is');
      continue;
    }

    console.log('[AI]   → Preview (300 chars):', JSON.stringify(content.substring(0, 300)));

    // ═══ STRATEGY 1: Deterministic splitter (most reliable) ═══
    const detSections = splitKbIntoSections(content);
    if (detSections.length >= 3) {
      console.log('[AI]   → ✅ Deterministic split: ' + detSections.length + ' sections');
      detSections.forEach((s, i) => {
        const preview = s.substring(0, 60).replace(/\n/g, ' ');
        console.log('[AI]     ' + (i + 1) + '. (' + s.length + 'ch) ' + preview + '...');
      });
      for (const s of detSections) {
        if (s.trim().length > 30) {
          sections.push({ source: kb.title, text: s.trim().substring(0, 8000) });
        }
      }
      continue;
    }

    // ═══ STRATEGY 2: AI structure analysis (fallback) ═══
    let aiSections = null;
    try {
      console.log('[AI]   → Deterministic split insufficient (' + detSections.length + '), trying AI analysis...');
      const docPreview = content.substring(0, 20000);

      const structureResult = await callClaude(
        `You are a document structure analyzer. Your job is to identify the MAIN section titles of a web page.

TASK: Find ONLY the TOP-LEVEL / MAIN section headings. These are the primary divisions of the document.

CRITICAL — MAIN vs SUB:
- MAIN sections are the primary numbered headings that organize the whole page (e.g. "1. Foreword", "2. How It Works", "19. 30% Consistency Rule")
- SUB-items are smaller items INSIDE a main section (e.g. inside "5. Country Restrictions" there might be "1. Sanctions", "2. Management Capacity" — these are SUB-items, NOT main sections)
- ONLY return MAIN section titles, NEVER sub-items
- Main sections typically follow an ascending sequence: 1, 2, 3, ... up to N
- If numbers restart (1, 2, 3 again inside a later section), those are sub-items → SKIP them

HOW TO IDENTIFY MAIN SECTIONS:
- Markdown headings: ## Title (level 2 headings, not ### or deeper)
- Top-level numbered titles in ascending order: "1. Title", "2. Title", ..., "21. Title"
- Bold top-level titles: "**Main Title**"
- The document's primary organizational structure

RULES:
- Copy each title EXACTLY as it appears
- List them IN ORDER of appearance
- Return ONLY top-level headings (typically 5-30 for a rules/policy page)
- NEVER include sub-items, bullet points, or nested headings

Return ONLY a valid JSON array of strings:
["exact title 1", "exact title 2", ...]`,
        `Find ONLY the MAIN/TOP-LEVEL section titles (not sub-items) in this document:\n\n${docPreview}`,
        2000, 30000, 'fast'
      );

      const cleanResult = structureResult.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const titles = JSON.parse(cleanResult);

      if (Array.isArray(titles) && titles.length >= 2) {
        console.log('[AI]   → AI found ' + titles.length + ' section titles:');
        titles.forEach((t, i) => console.log('[AI]     ' + (i + 1) + '. ' + t.substring(0, 80)));

        // ─── Use titles as split points ───
        aiSections = [];
        let searchContent = content;

        for (let t = 0; t < titles.length; t++) {
          const title = titles[t];
          // Clean title for searching (remove markdown formatting for matching)
          const cleanTitle = title.replace(/^#{1,4}\s*/, '').replace(/^\*\*/g, '').replace(/\*\*$/g, '').trim();

          // Build flexible search pattern for this title
          // Match: "## 1. Title", "**1. Title**", "1. Title", "Title" etc.
          const escapedTitle = cleanTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // Allow optional markdown prefix, optional numbering, then the title text
          const patterns = [
            new RegExp('(?:^|\\n)(#{1,4}\\s*(?:\\d{1,2}\\.\\s*)?' + escapedTitle + ')', 'i'),
            new RegExp('(?:^|\\n)(\\*\\*\\s*(?:\\d{1,2}\\.\\s*)?' + escapedTitle + '\\s*\\*\\*)', 'i'),
            new RegExp('(?:^|\\n)(' + escapedTitle + ')', 'i'),
            // Also try with the full original title including formatting
            new RegExp('(?:^|\\n)(' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'i'),
          ];

          let matchIdx = -1;
          let matchLen = 0;
          for (const pattern of patterns) {
            const match = searchContent.match(pattern);
            if (match) {
              matchIdx = searchContent.indexOf(match[0]);
              if (matchIdx >= 0 && match[0].startsWith('\n')) {
                matchIdx += 1; // skip the \n
                matchLen = match[0].length - 1;
              } else {
                matchLen = match[0].length;
              }
              break;
            }
          }

          if (matchIdx >= 0) {
            // Everything before this title = end of previous section
            if (matchIdx > 0 && t > 0) {
              const prevText = searchContent.substring(0, matchIdx).trim();
              if (prevText.length > 30) {
                aiSections.push(prevText);
              }
            } else if (matchIdx > 0 && t === 0) {
              // Content before first title (preamble)
              const preamble = searchContent.substring(0, matchIdx).trim();
              if (preamble.length > 100) {
                aiSections.push(preamble);
              }
            }
            // Move past this split point
            searchContent = searchContent.substring(matchIdx);
          } else {
            console.log('[AI]     ⚠️ Title not found in content: "' + cleanTitle.substring(0, 60) + '"');
          }
        }

        // Don't forget the last section (content after last title)
        if (searchContent.trim().length > 30) {
          aiSections.push(searchContent.trim());
        }

        console.log('[AI]   → AI structure split: ' + aiSections.length + ' sections from ' + titles.length + ' titles');
      }
    } catch (aiErr) {
      console.error('[AI]   → AI structure analysis error:', aiErr.message);
    }

    // ═══ USE AI SECTIONS IF GOOD, OTHERWISE STRATEGY 3 ═══
    if (aiSections && aiSections.length >= 2) {
      for (const s of aiSections) {
        sections.push({ source: kb.title, text: s.substring(0, 8000) });
      }
      console.log('[AI]   → ✅ Using AI-detected structure: ' + aiSections.length + ' sections');
      continue;
    }

    // ═══ STRATEGY 3: REGEX FALLBACK (for when both fail) ═══
    console.log('[AI]   → AI structure analysis insufficient, trying regex...');
    const strategies = {};
    strategies['md_h2'] = content.split(/\n(?=##\s+)/).filter(s => s.trim().length > 30);
    strategies['md_any'] = content.split(/\n(?=#{1,4}\s+)/).filter(s => s.trim().length > 30);
    strategies['numbered'] = content.split(/\n(?=\s*\u200B?\d{1,2}\.[\s]*[A-Za-zÀ-ÿ0-9])/).filter(s => s.trim().length > 30);
    strategies['md_numbered'] = content.split(/\n(?=#{1,3}\s*\d{1,2}\.)/).filter(s => s.trim().length > 30);
    strategies['bold'] = content.split(/\n(?=\*\*[^*]{3,}\*\*)/).filter(s => s.trim().length > 30);
    strategies['bold_numbered'] = content.split(/\n(?=\*\*\s*\d{1,2}\.)/).filter(s => s.trim().length > 30);
    strategies['numbered_unicode'] = content.split(/\n(?=[\s\u00A0\u200B\u200C\u200D\uFEFF]*\d{1,2}\.\s*[A-Za-zÀ-ÿ0-9])/).filter(s => s.trim().length > 30);
    strategies['bold_heading'] = content.split(/\n(?=\*\*[^*\n]{3,}\*\*\s*\n)/).filter(s => s.trim().length > 30);

    let bestName = 'none';
    let bestParts = [];
    for (const [name, result] of Object.entries(strategies)) {
      if (result.length > bestParts.length) {
        bestParts = result;
        bestName = name;
      }
    }
    console.log('[AI]   → Regex best: "' + bestName + '" with ' + bestParts.length + ' sections');

    if (bestParts.length >= 2) {
      for (const p of bestParts) {
        const trimmed = p.trim();
        if (trimmed.length > 30) {
          sections.push({ source: kb.title, text: trimmed.substring(0, 8000) });
        }
      }
      continue;
    }

    // ═══ STRATEGY 4: LAST RESORT — paragraph chunking ═══
    console.log('[AI]   → No structure found, paragraph chunking...');
    const paragraphs = content.split(/\n\n+/).filter(s => s.trim().length > 30);
    if (paragraphs.length >= 4) {
      let chunk = '';
      let chunkCount = 0;
      for (const p of paragraphs) {
        if (chunk.length + p.length > 2500 && chunk.length > 300) {
          sections.push({ source: kb.title, text: chunk.trim() });
          chunk = '';
          chunkCount++;
        }
        chunk += p + '\n\n';
      }
      if (chunk.trim().length > 50) { sections.push({ source: kb.title, text: chunk.trim() }); chunkCount++; }
      console.log('[AI]   → Created ' + chunkCount + ' paragraph chunks');
    } else {
      // Force chunk
      const chunkSize = 2500;
      for (let i = 0; i < len; i += chunkSize) {
        let end = Math.min(i + chunkSize, len);
        if (end < len) {
          const bp = Math.max(content.lastIndexOf('.', end), content.lastIndexOf('\n', end));
          if (bp > i + 500) end = bp + 1;
        }
        const chunk = content.substring(i, end).trim();
        if (chunk.length > 50) sections.push({ source: kb.title, text: chunk });
        i = end - 1;
      }
      console.log('[AI]   → Force-chunked into ~' + Math.ceil(len / chunkSize) + ' pieces');
    }
  }

  const totalContentLen = kbEntries.reduce((s, e) => s + e.content.length, 0);
  console.log('[AI] KB TOTAL: ' + sections.length + ' sections from ' + kbEntries.length + ' entries (' + totalContentLen + ' chars)');

  // ─── Step 2: Batch sections & call AI ───
  // CRITICAL: 2 sections per batch = AI treats each section as separate article
  const BATCH_SIZE = 2;
  const batches = [];
  for (let i = 0; i < sections.length; i += BATCH_SIZE) {
    batches.push(sections.slice(i, i + BATCH_SIZE));
  }

  const langNames = { en: 'English', fr: 'French', es: 'Spanish', de: 'German' };
  const targetLangLabel = preserveSource ? null : (langNames[outputLang] || langNames[lang] || 'French');

  // Build language instruction
  let langInstruction;
  if (preserveSource) {
    langInstruction = `- KEEP THE SAME LANGUAGE as the source content — do NOT translate anything
- If the source is in English, write titles, excerpts, and content in English
- If the source is in French, write titles, excerpts, and content in French
- NEVER translate the content to another language`;
  } else {
    langInstruction = `- Write titles and excerpts in ${targetLangLabel}
- Translate the CONTENT into ${targetLangLabel} while preserving ALL details, numbers, and meaning
- Use professional, domain-appropriate vocabulary for the translation`;
    if (companyContext) {
      langInstruction += `\n- TRANSLATION CONTEXT — This company's industry/domain: ${companyContext}\n- Use the correct specialized vocabulary for this domain when translating (e.g. financial terms, trading jargon, medical terminology, etc.)`;
    }
  }

  const systemPrompt = `You are a FAQ article structurer for a customer help center.

TASK: Convert EACH section below into EXACTLY ONE FAQ article. No more, no less.

CRITICAL RULE — EXACTLY 1 ARTICLE PER SECTION:
- Each section you receive = EXACTLY 1 article. Period.
- NEVER split a section into multiple articles
- NEVER create extra articles for sub-headings, sub-items, or bullet points within a section
- Sub-headings, numbered sub-items, bullet lists within a section = they all go INSIDE the same article as content
- Example: If section "5. Country Restrictions" contains sub-items "1. Sanctions", "2. Management", "3. Fraud" → that is still 1 single article with all sub-items in the content
- If you receive 2 sections, return EXACTLY 2 articles

ABSOLUTE RULES — CONTENT FIDELITY:
- **PRESERVE the original text EXACTLY as written** — do NOT paraphrase, rewrite, summarize, or rephrase
- Copy the source content VERBATIM into the article content field
- Keep ALL details: numbers, percentages, amounts, conditions, lists, steps, examples — EVERYTHING
- If the source says "30 days", you write "30 days" — NOT "approximately one month"
- Do NOT add information that is not in the source
- Do NOT remove ANY information that IS in the source

LANGUAGE RULES:
${langInstruction}

FORMATTING RULES:
- Title: use the section's own heading/title, rephrased as a clear question or topic name if needed
- Excerpt: 1 sentence summary of the section
- Content: the FULL ORIGINAL text with Markdown formatting (## for sub-headings, **bold**, - bullets) for readability. Include ALL sub-items, ALL details.
- Category: assign from: ${cats}

Return ONLY a valid JSON array with EXACTLY as many objects as sections provided:
[{"title":"...","excerpt":"...","content":"...","category_suggestion":"slug"}]`;

  const allArticles = [];
  const maxBatches = Math.min(batches.length, 30);

  // Helper: process one batch
  async function processBatch(b) {
    const batch = batches[b];
    let batchText = '';
    batch.forEach((s, i) => {
      batchText += `\n\n========== SECTION ${i + 1} — CONVERT TO EXACTLY 1 ARTICLE ==========\n(Source: ${s.source})\n\n${s.text.substring(0, 6000)}\n`;
    });
    console.log('[AI] KB batch', b + 1, '/', maxBatches, '—', batchText.length, 'chars,', batch.length, 'sections');
    const langNote = preserveSource ? 'KEEP THE ORIGINAL LANGUAGE — do NOT translate.' : `Translate to ${targetLangLabel}.`;
    const result = await callClaude(systemPrompt, `Create EXACTLY ${batch.length} FAQ articles — one per section. PRESERVE ALL ORIGINAL TEXT. ${langNote} NEVER split a section into multiple articles:\n${batchText}`, 8000, 90000);
    const clean = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    try {
      const articles = JSON.parse(clean);
      if (Array.isArray(articles)) {
        const valid = articles.filter(a => a.title && a.content && a.content.length > 30);
        console.log('[AI] KB batch', b + 1, '→', valid.length, 'articles ✅');
        return valid;
      }
    } catch (parseErr) {
      const match = clean.match(/\[[\s\S]*\]/);
      if (match) {
        try {
          const articles = JSON.parse(match[0]);
          const valid = articles.filter(a => a.title && a.content);
          console.log('[AI] KB batch', b + 1, '→', valid.length, 'articles (recovered)');
          return valid;
        } catch (e) {}
      }
      console.error('[AI] KB batch', b + 1, 'JSON parse error:', parseErr.message);
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

  console.log('[AI] KB generation complete:', allArticles.length, 'articles from', maxBatches, 'batches (' + sections.length + ' sections)');

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
