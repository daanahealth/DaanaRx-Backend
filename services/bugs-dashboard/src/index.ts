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

async function fetchFeedback(): Promise<FeedbackRow[]> {
  if (Date.now() - FEEDBACK_CACHE.at < CACHE_TTL_MS) return FEEDBACK_CACHE.rows;
  const url = `${SUPABASE_URL}/rest/v1/feedback?select=*&order=created_at.desc&limit=500`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as FeedbackRow[];
  FEEDBACK_CACHE.at = Date.now();
  FEEDBACK_CACHE.rows = rows;
  return rows;
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
    try {
      const rows = await fetchFeedback();
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
        summary: summarize(rows),
        items: enriched,
      };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
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
