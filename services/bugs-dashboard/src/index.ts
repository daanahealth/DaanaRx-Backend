// daanahealth-bugs-dashboard
// Tiny zero-dep Node http server. Pulls feedback rows from Supabase via the
// service-role key (server-side only — never exposed to the browser) and serves
// a dashboard UI.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.PORT || 3005);
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[bugs-dashboard] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
}

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

interface FeedbackRow {
  feedback_id: string;
  clinic_id: string | null;
  user_id: string | null;
  feedback_type: string;
  feedback_message: string;
  created_at: string;
  updated_at: string;
}

const FEEDBACK_CACHE: { at: number; rows: FeedbackRow[] } = { at: 0, rows: [] };
const CACHE_TTL_MS = 10_000;
// Hard ceiling on the upstream Supabase call. Without this, a slow/unreachable
// Supabase (or a cold start) leaves the request — and the connection — hanging
// indefinitely, which starves the tiny free-plan instance and makes even
// /health unresponsive. Fail fast instead.
const SUPABASE_TIMEOUT_MS = Number(process.env.SUPABASE_TIMEOUT_MS) || 8_000;

async function fetchFeedback(): Promise<FeedbackRow[]> {
  if (Date.now() - FEEDBACK_CACHE.at < CACHE_TTL_MS) return FEEDBACK_CACHE.rows;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase is not configured (missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  }
  const url = `${SUPABASE_URL}/rest/v1/feedback?select=*&order=created_at.desc&limit=500`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SUPABASE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const rows = (await res.json()) as FeedbackRow[];
    FEEDBACK_CACHE.at = Date.now();
    FEEDBACK_CACHE.rows = rows;
    return rows;
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`Supabase request timed out after ${SUPABASE_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function parseMessage(raw: string): { title: string; body: string } {
  // Match the submission format from FeedbackModal: "Title: foo\n\nbody"
  const m = raw.match(/^Title:\s*(.*?)\n\n([\s\S]*)$/);
  if (m) return { title: m[1].trim(), body: m[2].trim() };
  return { title: '(no title)', body: raw };
}

function summarize(rows: FeedbackRow[]) {
  const counts: Record<string, number> = { Bug: 0, 'Feature Request': 0, Other: 0 };
  for (const r of rows) {
    const t = r.feedback_type === 'Bug' ? 'Bug' : r.feedback_type?.toLowerCase().includes('feature') ? 'Feature Request' : 'Other';
    counts[t] = (counts[t] || 0) + 1;
  }
  return { total: rows.length, counts };
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'bugs-dashboard' }));
    return;
  }

  if (url.pathname === '/api/feedback') {
    let rows: FeedbackRow[];
    let stale = false;
    try {
      rows = await fetchFeedback();
    } catch (err) {
      // Graceful degradation: if we ever fetched successfully, serve the last
      // known-good snapshot rather than failing the whole dashboard. Only
      // surface an error when we have nothing cached at all.
      if (FEEDBACK_CACHE.rows.length > 0) {
        rows = FEEDBACK_CACHE.rows;
        stale = true;
        console.error('[bugs-dashboard] serving stale feedback after fetch error:', String(err));
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'feedback_unavailable', detail: String(err) }));
        return;
      }
    }
    const enriched = rows.map((r) => ({
      id: r.feedback_id,
      type: r.feedback_type,
      ...parseMessage(r.feedback_message || ''),
      user_id: r.user_id,
      clinic_id: r.clinic_id,
      created_at: r.created_at,
    }));
    const payload = {
      generated_at: new Date().toISOString(),
      stale,
      summary: summarize(rows),
      items: enriched,
    };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
    return;
  }

  // Static files
  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  if (file.includes('..')) {
    res.writeHead(403);
    res.end();
    return;
  }
  const full = path.join(PUBLIC_DIR, file);
  try {
    const data = await fs.readFile(full);
    const ext = path.extname(full);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    res.writeHead(500);
    res.end('Internal Error');
  });
});

server.listen(PORT, () => {
  console.log(`[bugs-dashboard] listening on :${PORT}`);
});
