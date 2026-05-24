// Haiku-class intent classifier — routes free-text first messages to the right sub-skill.
// Returns { skill, confidence, rationale }. Defaults to gap-scanner on parse error.

import Anthropic from '@anthropic-ai/sdk';

const COORDINATOR_MODEL = process.env.COORDINATOR_MODEL || 'claude-haiku-4-5-20251001';

const COORDINATOR_SYSTEM_PROMPT = `You are an intent router for biztory.com — a European data + AI consultancy. A visitor has just submitted their first free-text message. You decide which Biztory sub-skill should handle the conversation.

Return ONLY a JSON object (no markdown, no prose):

{
  "skill": "gap-scanner | methodology-walker | ai-readiness-scan | digital-workforce-scoping",
  "confidence": "high | medium | low",
  "rationale": "1 short sentence why"
}

## The four skills

**gap-scanner** — General Blueprint maturity diagnostic. Default for unclear intent. Use when the visitor describes their data situation, current BI/data pain, or wants a recommendation but isn't specifically asking about AI agents or operations at scale.
  - Triggers: "we use Tableau/Snowflake/Power BI…", "our dashboards…", "we're stuck on…", "what should we do about…", "our BI team…", general data complaint.

**methodology-walker** — Educational tour. Use when the visitor seems to be exploring, wants to understand what Biztory does, asks about methodology, or generally wants info before committing to a diagnostic.
  - Triggers: "what do you do?", "tell me about Biztory", "I'm researching consultancies", "first time hearing about you", "just curious", "what's the Blueprint?".

**ai-readiness-scan** — Specifically focused on AI / agent maturity. Use when the visitor mentions AI agents, copilots, automation, GenAI, ML in production, AI pilots, agent deployment.
  - Triggers: "we want to start with AI agents", "we tried Agentforce / Copilot / GPT", "AI pilot", "build an agent", "automate with AI", "GenAI strategy", "AI roadmap".

**digital-workforce-scoping** — Focused on operating/running agents at scale. Use when the visitor mentions managed services, scaling agents, running agent fleets, productionizing AI ops, multiple agents in production, n8n at scale.
  - Triggers: "we have N agents in production", "running our agent fleet", "managed AI services", "industrialise our AI ops", "ops layer for agents", "multiple workflows in production".

## Rules

- Be decisive. If multiple skills could apply, pick the MOST SPECIFIC one.
- Default to gap-scanner on genuinely unclear intent.
- Confidence "high" only if the message is unambiguous.
- "low" confidence still gets a skill choice — the routing always proceeds.
- Return ONLY the JSON object. No surrounding text, no markdown.`;

let _client = null;
function getClient() {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

function extractJSON(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(trimmed.slice(start, end + 1)); }
  catch { return null; }
}

const VALID_SKILLS = ['gap-scanner', 'methodology-walker', 'ai-readiness-scan', 'digital-workforce-scoping'];

/**
 * Route a visitor's free-text first message to a sub-skill.
 * @param {string} text — sanitized visitor message
 * @returns {Promise<{ skill: string, confidence: string, rationale: string }>}
 */
export async function routeIntent(text) {
  // Defensive defaults
  const fallback = { skill: 'gap-scanner', confidence: 'low', rationale: 'defaulted (coordinator unavailable)' };
  if (typeof text !== 'string' || text.trim().length === 0) return fallback;

  try {
    const client = getClient();
    const response = await client.messages.create({
      model: COORDINATOR_MODEL,
      max_tokens: 200,
      system: COORDINATOR_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `<visitor_message>\n${text}\n</visitor_message>` }
      ],
    });

    const raw = response.content?.[0]?.text || '';
    const parsed = extractJSON(raw);

    if (!parsed || !VALID_SKILLS.includes(parsed.skill)) {
      console.warn('[coordinator] invalid route, defaulting:', raw.slice(0, 200));
      return fallback;
    }

    return {
      skill: parsed.skill,
      confidence: parsed.confidence || 'medium',
      rationale: parsed.rationale || '(no rationale)',
    };
  } catch (err) {
    console.error('[coordinator] error, defaulting:', err.message);
    return fallback;
  }
}
