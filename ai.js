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
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

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
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
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
  improveText
};
