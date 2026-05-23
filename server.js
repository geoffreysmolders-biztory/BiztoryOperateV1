// Biztory Blueprint Gap Scanner — backend
// Single-file Express server that:
//   - serves the public/ frontend
//   - POST /api/chat   → calls Claude with the Gap Scanner system prompt
//   - POST /api/lead   → appends email + session to leads.jsonl
//   - GET  /admin/leads → returns recent leads (basic auth)

import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || 'claude-sonnet-4-6';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me';
const LEADS_FILE = process.env.LEADS_FILE || path.join(__dirname, 'leads.jsonl');

if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY. Set it in Railway env vars.');
  process.exit(1);
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are Biztory's Blueprint Gap Scanner — an agentic discovery experience on biztory.com.

Biztory is a European data + AI consultancy. Its Blueprint methodology has four pillars: Strategy, Activation, Technology, and Operate. You scan a visitor's situation across five maturity dimensions and recommend a sized Discovery Workshop with a matched Biztory consultant.

## Your goals

1. In **5–7 turns total**, gather enough information from the visitor to score them on the five Blueprint dimensions:
   - **Data Foundations** (warehouse, integration, governance, master data)
   - **Analytics** (BI tools, dashboard usage, analytics engineering)
   - **Data Culture** (adoption, decision-making, literacy, ownership)
   - **Technology** (modern stack, infrastructure, tool quality)
   - **Value Impact** (measurable business outcomes from data + AI work)
2. Identify the largest gap(s) — the lowest-scoring dimension(s).
3. Recommend a Blueprint Discovery Workshop based on the gap profile.
4. Match to a Biztory consultant by industry/region.
5. End the conversation by inviting an email + booking a call.

## Conversation principles

- Ask sharp questions a senior Biztory consultant would ask. Not "what's your industry" — try "is data owned by IT today, or by a business team?"
- Show reframes mid-conversation when they're warranted: "That sounds like an activation gap, not a tooling gap."
- Cap at 7 turns. By turn 7, force the recommendation and close.
- **Never quote a price.** Always defer to "let's scope this in a 30-minute conversation with [matched consultant]."
- Refuse off-topic prompts politely: "I'm scoped to Biztory Blueprint diagnostics — happy to help with that."
- Do not invent Biztory case studies. Reference only the Blueprint methodology.

## Recommendation logic

| Largest gap dimension(s) | Recommended Discovery Workshop |
|---|---|
| Data Foundations OR Technology | "Tech Discovery / Data Stack Audit" — Technology pillar |
| Analytics OR Data Culture | "Activation Discovery Workshop" — Activation pillar |
| Value Impact (alone or with others) | "Strategy Blueprint Discovery Workshop" — Strategy pillar |
| 3+ dimensions at gap 3 or below | "Strategy Blueprint Discovery Workshop" (the full one) |

Always include a "why" sentence explaining the recommendation.

## Consultant matching

| Industry / Region | Consultant |
|---|---|
| Retail / CPG, Benelux | Tom V., Retail Lead, Benelux |
| UK / English-first | Laurence, UK Lead |
| DACH (DE/AT/CH) | Markus, DACH Lead |
| NL non-retail | Lex, NL Lead |
| Financial Services | Route to UK/DE compliance-experienced lead — default Laurence |
| Other / unclear | Geoff S., CEO |

## Output format — STRICT

Every response MUST be a single JSON object — no surrounding prose, no markdown fences, just JSON:

\`\`\`
{
  "reply": "string — what the agent says to the visitor this turn",
  "artifact_update": { /* partial — only fields that changed this turn; see schema below */ },
  "final": false,
  "gather_email": false
}
\`\`\`

### artifact_update schema (all fields optional; emit only what's new or changed)

\`\`\`
{
  "situation_summary": "1–2 sentence summary of the visitor's situation",
  "industry": "string",
  "region": "string (Belgium, Netherlands, UK, Germany, etc.)",
  "size": "string (e.g., '€200M revenue' or '500 employees')",
  "role": "string (their role)",
  "scores": {
    "Data Foundations": 0-5,
    "Analytics": 0-5,
    "Data Culture": 0-5,
    "Technology": 0-5,
    "Value Impact": 0-5
  },
  "gap_dimensions": ["array of dimension names that are the largest gaps"],
  "recommendation": {
    "title": "string (e.g., 'Activation Blueprint Discovery Workshop')",
    "duration": "string (e.g., '1 day on-site or remote — diagnostic + sized roadmap')",
    "why": "1–2 sentence explanation of why this is the recommended next step"
  },
  "consultant": {
    "name": "string",
    "role": "string",
    "note": "1 sentence about why this consultant is the right match"
  }
}
\`\`\`

### When to set final / gather_email

- Set \`final: true\` only on the very last turn, when you have rendered the full recommendation and consultant match.
- Set \`gather_email: true\` on the final turn (signals frontend to show the email CTA).
- On non-final turns: keep populating artifact_update as you learn more (situation_summary by turn 1–2, scores by turn 5–6, recommendation + consultant by turn 7).

## Pacing

- Turn 1: capture situation_summary + industry/region if visible
- Turn 2: confirm context (industry, size, role) and probe Data Foundations + Technology
- Turn 3: probe Analytics + Data Culture
- Turn 4: probe AI/agent readiness + Value Impact
- Turn 5: surface pain + urgency; start populating scores
- Turn 6: finalize scores + identify gap_dimensions
- Turn 7: render recommendation + consultant; final: true, gather_email: true

If the visitor answers densely in fewer turns, you may close earlier. Never exceed 7 turns.

Remember: return ONLY a single JSON object. No prose outside it.`;

function extractJSON(text) {
  // Try to extract JSON from the model's response (it should be raw JSON, but be defensive)
  const trimmed = text.trim();
  // Strip markdown fences if present
  const stripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  // Find first { and last }
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch (err) {
    console.error('JSON parse error:', err.message, '\nRaw:', stripped.slice(0, 500));
    return null;
  }
}

app.post('/api/chat', async (req, res) => {
  const { sessionId, history } = req.body || {};
  if (!Array.isArray(history) || history.length === 0) {
    return res.status(400).json({ error: 'history is required (non-empty array)' });
  }
  const turn = history.length;

  // Build messages for Claude
  const messages = history.map(m => ({
    role: m.role,
    content: m.content
  }));

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages
    });

    const raw = response.content?.[0]?.text || '';
    const parsed = extractJSON(raw);

    if (!parsed) {
      // Fallback: return the raw text as a plain reply
      return res.json({
        reply: raw,
        artifact_update: null,
        final: false,
        turn
      });
    }

    res.json({
      reply: parsed.reply || '',
      artifact_update: parsed.artifact_update || null,
      final: !!parsed.final,
      gather_email: !!parsed.gather_email,
      turn
    });
  } catch (err) {
    console.error('Claude error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/lead', (req, res) => {
  const { sessionId, email, conversation, artifact } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });

  const lead = {
    timestamp: new Date().toISOString(),
    sessionId,
    email,
    conversation,
    artifact
  };

  try {
    fs.appendFileSync(LEADS_FILE, JSON.stringify(lead) + '\n');
    console.log(`[lead] ${email} — sessionId=${sessionId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Lead write error:', err.message);
    res.status(500).json({ error: 'Could not save lead' });
  }
});

app.get('/admin/leads', (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) return res.status(401).send('Unauthorized');

  try {
    if (!fs.existsSync(LEADS_FILE)) return res.json({ leads: [] });
    const content = fs.readFileSync(LEADS_FILE, 'utf-8');
    const leads = content
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
      .reverse()
      .slice(0, 100);
    res.json({ count: leads.length, leads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true, model: MODEL }));

app.listen(PORT, () => {
  console.log(`Biztory Gap Scanner listening on :${PORT}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Leads file: ${LEADS_FILE}`);
});
