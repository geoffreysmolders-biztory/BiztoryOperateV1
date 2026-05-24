// Biztory Blueprint Gap Scanner — backend
// v0.5: Sub-skills architecture
//   - skills/ folder holds modular sub-skill system prompts
//   - coordinator.js routes free-text intent to the right sub-skill (Haiku-class)
//   - /api/chat accepts a `skill` param and uses the matching system prompt
//   - All user messages sanitized + wrapped in <visitor_message> delimiters
//   - Server-side maxTurns cap

import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SKILLS, getSkill, DEFAULT_SKILL } from './skills/index.js';
import { routeIntent } from './coordinator.js';

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
const INJECTION_LOG = process.env.INJECTION_LOG || path.join(__dirname, 'injection-attempts.jsonl');
const MAX_TURNS = 7;
const MAX_USER_MSG_LENGTH = 2000;

if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY. Set it in Railway env vars.');
  process.exit(1);
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ---------- Sanitization + injection detection ----------

const INJECTION_PATTERNS = [
  /<!--[\s\S]*?-->/g,
  /ignore\s+(all\s+)?(prior|previous|above|earlier)\s+instructions?/i,
  /disregard\s+(all\s+)?(prior|previous|above)/i,
  /forget\s+(everything|all|the\s+above)/i,
  /system\s*prompt/i,
  /forward\s+.{0,40}(api\s*keys?|credentials|secrets?|tokens?)/i,
  /\bjailbreak\b/i,
  /act\s+as\s+if\s+you/i,
  /pretend\s+(you\s+are|to\s+be)/i,
  /new\s+instructions?\s*:/i,
];

function sanitizeUserMessage(text) {
  if (typeof text !== 'string') return '';
  const matches = INJECTION_PATTERNS
    .map(p => text.match(p))
    .filter(Boolean)
    .map(m => m[0].slice(0, 200));

  if (matches.length > 0) {
    try {
      fs.appendFileSync(INJECTION_LOG, JSON.stringify({
        timestamp: new Date().toISOString(),
        text: text.slice(0, 500),
        patterns: matches
      }) + '\n');
      console.log(`[injection-attempt] patterns=${matches.length} preview="${text.slice(0, 80)}"`);
    } catch (err) { /* logging is best-effort */ }
  }

  let clean = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?visitor_message[^>]*>/gi, '')
    .replace(/<\/?system[^>]*>/gi, '');

  return clean.trim().slice(0, MAX_USER_MSG_LENGTH);
}

// ---------- JSON extraction (defensive against model formatting drift) ----------

function extractJSON(text) {
  const trimmed = text.trim();
  const stripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
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

// ---------- /api/route-intent (coordinator) ----------

app.post('/api/route-intent', async (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== 'string' || text.trim().length === 0) {
    return res.json({ skill: DEFAULT_SKILL, confidence: 'low', rationale: 'empty input' });
  }
  const clean = sanitizeUserMessage(text);
  const route = await routeIntent(clean);
  console.log(`[coordinator] "${clean.slice(0, 60)}" → ${route.skill} (${route.confidence})`);
  res.json(route);
});

// ---------- /api/chat ----------

app.post('/api/chat', async (req, res) => {
  const { sessionId, history, skill: requestedSkill } = req.body || {};
  if (!Array.isArray(history) || history.length === 0) {
    return res.status(400).json({ error: 'history is required (non-empty array)' });
  }

  const skill = getSkill(requestedSkill);
  const turn = history.length;

  // Hard server-side cap on user turns
  const userTurns = history.filter(m => m.role === 'user').length;
  if (userTurns > MAX_TURNS) {
    console.log(`[max-turns] capped (skill=${skill.name}, userTurns=${userTurns}, session=${sessionId})`);
    return res.json({
      reply: "We've covered the ground we need. Take a look at your diagnosis in the artifact panel — and drop your email below if you'd like a 30-minute scoping call to discuss it.",
      artifact_update: null,
      final: true,
      gather_email: true,
      turn,
      skill: skill.name,
      capped: true
    });
  }

  // Sanitize + wrap user messages
  const messages = history.map(m => {
    if (m.role === 'user') {
      const clean = sanitizeUserMessage(m.content);
      return { role: 'user', content: `<visitor_message>\n${clean}\n</visitor_message>` };
    }
    return { role: m.role, content: m.content };
  });

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: skill.systemPrompt,
      messages
    });

    const raw = response.content?.[0]?.text || '';
    const parsed = extractJSON(raw);

    if (!parsed) {
      return res.json({
        reply: raw,
        artifact_update: null,
        final: false,
        turn,
        skill: skill.name
      });
    }

    res.json({
      reply: parsed.reply || '',
      artifact_update: parsed.artifact_update || null,
      final: !!parsed.final,
      gather_email: !!parsed.gather_email,
      turn,
      skill: skill.name
    });
  } catch (err) {
    console.error('Claude error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- /api/lead ----------

app.post('/api/lead', (req, res) => {
  const { sessionId, email, conversation, artifact, skill } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });

  const lead = {
    timestamp: new Date().toISOString(),
    sessionId,
    skill: skill || 'unknown',
    email,
    conversation,
    artifact
  };

  try {
    fs.appendFileSync(LEADS_FILE, JSON.stringify(lead) + '\n');
    console.log(`[lead] ${email} — skill=${skill} sessionId=${sessionId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Lead write error:', err.message);
    res.status(500).json({ error: 'Could not save lead' });
  }
});

// ---------- /admin/leads ----------

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

// ---------- /api/skills (introspection — useful for frontend & ops) ----------

app.get('/api/skills', (_req, res) => {
  res.json({
    default: DEFAULT_SKILL,
    skills: Object.values(SKILLS).map(s => ({
      name: s.name,
      displayName: s.displayName,
      scoringDimensions: s.scoringDimensions,
    })),
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true, model: MODEL, skills: Object.keys(SKILLS) }));

app.listen(PORT, () => {
  console.log(`Biztory Gap Scanner v0.5 listening on :${PORT}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Skills loaded: ${Object.keys(SKILLS).join(', ')}`);
  console.log(`Default skill: ${DEFAULT_SKILL}`);
  console.log(`Leads file: ${LEADS_FILE}`);
});
