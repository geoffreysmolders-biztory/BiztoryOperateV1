# Biztory Blueprint Gap Scanner

Public agentic discovery experience for biztory.com. A visitor describes their data situation; the agent scans across five Blueprint maturity dimensions, identifies the largest gaps, and recommends a sized Discovery Workshop with a matched Biztory consultant. **Never quotes a price** — that's the scoping agent's job (next step).

Stack: Node 20 + Express + Anthropic SDK (Claude Sonnet 4.6). Single-file frontend in `public/index.html`. No DB.

## Local dev

```bash
cd gap-scanner
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY
npm run dev
# open http://localhost:3000
```

## Railway deploy (5 min)

1. **Push to GitHub** (or to a new Railway-connected repo).
2. **In Railway:** New Project → Deploy from GitHub repo → pick this folder.
3. **Variables tab — set:**
   - `ANTHROPIC_API_KEY` — your Anthropic API key
   - `MODEL` — `claude-sonnet-4-6` (or leave unset; that's the default)
   - `ADMIN_TOKEN` — any long random string (used to view leads)
4. **Deploy.** Railway auto-detects Node, runs `npm install`, then `npm start`.
5. **Custom domain (optional):** Railway → Settings → Domains → add `gapscan.biztory.com` or similar.

### Persisting leads across redeploys

Railway redeploys wipe `/tmp` (where `leads.jsonl` lives by default). To persist:
- Railway → Volumes → mount a volume at `/data`
- Set env var `LEADS_FILE=/data/leads.jsonl`

(For the demo phase this is optional — you can read leads via `/admin/leads?token=<ADMIN_TOKEN>` between redeploys.)

## Endpoints

- `GET /` — serves `public/index.html` (the agent UI)
- `POST /api/chat` — body `{ sessionId, history: [{role, content}] }` → returns `{ reply, artifact_update, final, gather_email, turn }`
- `POST /api/lead` — body `{ sessionId, email, conversation, artifact }` → appends to `leads.jsonl`
- `GET /admin/leads?token=<ADMIN_TOKEN>` — returns the last 100 leads as JSON
- `GET /healthz` — health check

## How it works

1. Visitor opens the page → sees the opening prompt: *"Tell me about your data situation in one or two sentences…"*
2. Each user message is sent to `/api/chat` with the full conversation history.
3. The backend calls Claude with a strict system prompt (in `server.js`) that returns **structured JSON**:
   - `reply` — what to say to the visitor
   - `artifact_update` — partial fields to update in the right-side artifact panel
   - `final` — true when the recommendation is complete
   - `gather_email` — true on the final turn (signals frontend to show email CTA)
4. The frontend updates the artifact panel in real time (situation summary → maturity scores → radar chart → recommendation → consultant card).
5. When `final: true`, the email CTA appears. On submit, a lead is written to `leads.jsonl`.

## Cost shape

- Each completed scan: ~€0.05–€0.15 (Claude Sonnet 4.6, ~5–7 turns, ~10–15k tokens total).
- Railway hobby tier: $5–10/month idle, scales with traffic.
- No per-visitor licenses.

## What's deliberately out of scope (v0)

- HubSpot integration (manual review of `leads.jsonl` for now)
- Slack notifications
- Email sending (the artifact says "we'll email you" but no transactional email yet — wire SendGrid/Postmark in v1)
- Real consultant photos (uses initials avatar)
- Booking integration (the "Book a 30-min call" button is a stub — wire to Calendly/HubSpot Meetings in v1)
- Multilingual (English only)
- A/B testing infrastructure
- Production-quality auth on `/admin/leads` (a static token is fine for the demo phase)

## Next steps after first live demo

1. **Internal pilot week** — 5–10 Biztory people run real scenarios; review `leads.jsonl` daily; tighten the system prompt where the agent reasons poorly.
2. **One friendly external** — ideally a prospect Tom is already talking to. Compare agent's diagnosis to Tom's manual diagnosis.
3. **Wire HubSpot + email** — turn the lead capture into a real deal-creation flow.
4. **Extend into scoping agent** — once the pricing rubric is signed off, the same conversational flow extends into a sized + priced engagement scope.
