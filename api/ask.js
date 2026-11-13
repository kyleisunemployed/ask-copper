// Ask Copper: answers customer questions from the four Copper support PDFs, with page citations.
// With ANTHROPIC_API_KEY set (Vercel > Settings > Environment Variables), Claude writes the answer.
// Without a key, a keyword search over the same pages answers instead, so the site always works.
import { PAGES } from '../pages.js';

export const NOT_FOUND = "I couldn't find that in the Copper support documents. Try rephrasing, or contact the Copper Crew in the Copper app (Settings > Help).";
const DOC_IDS = ['home', 'notes', 'terms', 'plus'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const question = String((body && body.question) || '').trim().slice(0, 500);
  if (!question) return res.status(400).json({ error: 'Type a question first.' });

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return res.status(200).json(await askClaude(question));
    } catch (err) {
      console.error('Claude request failed, using keyword search instead:', err);
    }
  }
  return res.status(200).json(searchDocs(question));
}

/* ---------- Claude ---------- */
function buildDocsText() {
  return DOC_IDS.map((id) => {
    const pages = PAGES.filter((p) => p.doc === id);
    return `<document id="${id}" title="${pages[0].title}">\n` +
      pages.map((p) => `<page number="${p.page}">\n${p.text}\n</page>`).join('\n') +
      `\n</document>`;
  }).join('\n\n');
}

const RULES = `You are Ask Copper, the customer support assistant for Copper State Labs.
Answer the customer's question using ONLY the support documents provided below.

Rules:
1. Every fact in your answer must come from the documents. Never use outside knowledge, and never guess.
2. Cite the exact page or pages that support your answer, using the document id and page number shown in the documents.
3. If the documents do not answer the question, set "answer" to exactly NOT_FOUND and return no citations. Do not infer features or abilities the documents don't mention; if something isn't described, you couldn't find it.
4. Keep answers short and friendly: one to three sentences in plain language. Include specific numbers, steps, or settings paths when the documents give them.
5. Prefer the page that states the fact most directly (for example, an error-code table over a passing mention).

Respond with only a JSON object, no other text:
{"answer": "...", "citations": [{"doc": "home|notes|terms|plus", "page": 1}]}`;

async function askClaude(question) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
      max_tokens: 600,
      system: [
        { type: 'text', text: RULES + '\n\n' + buildDocsText(), cache_control: { type: 'ephemeral' } }
      ],
      messages: [{ role: 'user', content: question }]
    })
  });
  if (!response.ok) throw new Error(`Anthropic API ${response.status}: ${await response.text()}`);
  const data = await response.json();
  const text = (data.content || []).map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  const jsonText = text.replace(/```json|```/g, '').trim();
  const start = jsonText.indexOf('{'), end = jsonText.lastIndexOf('}');
  const parsed = JSON.parse(jsonText.slice(start, end + 1));

  const answer = String(parsed.answer || '').trim();
  if (!answer || answer === 'NOT_FOUND') return { answer: NOT_FOUND, citations: [], found: false, mode: 'claude' };

  // Keep only citations that point at a real page.
  const seen = new Set();
  const citations = (parsed.citations || [])
    .map((c) => PAGES.find((p) => p.doc === c.doc && p.page === Number(c.page)))
    .filter((p) => p && !seen.has(p.doc + p.page) && seen.add(p.doc + p.page))
    .map((p) => ({ doc: p.doc, title: p.title, page: p.page }));
  if (!citations.length) return { answer: NOT_FOUND, citations: [], found: false, mode: 'claude' };
  return { answer, citations, found: true, mode: 'claude' };
}

/* ---------- Keyword search (no API key needed) ---------- */
// A simple backup so the site still answers from the documents when no API key is set.
const STOP = new Set(('a about after all also am an and any are as at be been before but by can could copper did do does doing for from get got had has have how i if in into is it its just long me mean means my no not of on or our please should so than that the their them then there these they this to too up us was we what when where which who why will with would you your yours tell know want need much many').split(' '));
const DOC_HINTS = { home: ['home', 'speaker'], notes: ['notes', 'recorder'], plus: ['plus', 'subscription'], terms: ['terms', 'warranty', 'return', 'refund'] };

function stem(t) {
  if (t.length > 5 && t.endsWith('ed')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}
function tokens(text) {
  return (text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || []).map(stem);
}

const INDEX = PAGES.map((p) => {
  const toks = tokens(p.text);
  const tf = new Map();
  toks.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
  return { page: p, tf, len: toks.length };
});
const AVG = INDEX.reduce((a, d) => a + d.len, 0) / INDEX.length;

// Rebuild a table row whose columns were wrapped onto several lines.
function tidyRow(lines) {
  const first = lines[0].split('  |  ');
  const cols = first.map((c) => [c]);
  const spill = first.length >= 3 ? 1 : first.length - 1;
  lines.slice(1).forEach((line) => {
    const cells = line.split('  |  ');
    if (cells.length === first.length) cells.forEach((c, i) => cols[i].push(c));
    else cols[spill].push(line);
  });
  return cols.map((c) => c.join(' ')).join(': ');
}

// Split a page into answer-sized pieces: table rows and sentences.
function units(text) {
  const out = [];
  text.split(/\n\s*\n/).forEach((group, gi) => {
    if (gi === 0) return; // running header
    const lines = group.split('\n').filter(Boolean);
    if (!lines.length) return;
    if (lines[0].includes('  |  ')) { out.push(tidyRow(lines)); return; }
    lines.join(' ').split(/(?<=[.?!])\s+(?=[A-Z0-9"])/).forEach((s) => s.trim() && out.push(s.trim()));
  });
  return out;
}

export function searchDocs(question) {
  const raw = tokens(question);
  const q = [...new Set(raw.filter((t) => !STOP.has(t) && !['home', 'notes', 'plus'].includes(t)))];
  if (!q.length) return { answer: NOT_FOUND, citations: [], found: false, mode: 'search' };
  const hinted = Object.keys(DOC_HINTS).filter((d) => DOC_HINTS[d].some((h) => raw.includes(h)));

  const N = INDEX.length, k1 = 1.4, b = 0.6;
  const idf = Object.fromEntries(q.map((t) => {
    const df = INDEX.filter((d) => d.tf.has(t)).length;
    return [t, Math.log(1 + (N - df + 0.5) / (df + 0.5))];
  }));

  let best = null;
  for (const d of INDEX) {
    let score = 0, matched = 0;
    for (const t of q) {
      const tf = d.tf.get(t) || 0;
      if (!tf) continue;
      matched++;
      score += idf[t] * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * d.len / AVG));
    }
    if (matched / q.length < 0.6) continue;
    // A row or sentence that starts with the term (like "C-31" in an error table) is the definition.
    if (units(d.page.text).some((u) => q.includes(tokens(u)[0]))) score += 1.5;
    if (hinted.includes(d.page.doc)) score *= 1.4;
    if (!best || score > best.score) best = { d, score };
  }
  if (!best) return { answer: NOT_FOUND, citations: [], found: false, mode: 'search' };

  const page = best.d.page;
  const scored = units(page.text).map((u, i) => {
    const ut = tokens(u), set = new Set(ut);
    let s = q.reduce((a, t) => a + (set.has(t) ? idf[t] : 0), 0);
    if (q.includes(ut[0])) s += 1;
    return { u, i, s };
  }).filter((x) => x.s > 0);
  scored.sort((x, y) => y.s - x.s);
  const top = scored.slice(0, 2).filter((x, k) => k === 0 || x.s >= scored[0].s * 0.75).sort((x, y) => x.i - y.i);

  return {
    answer: `From the ${page.title}: ` + top.map((x) => x.u).join(' '),
    citations: [{ doc: page.doc, title: page.title, page: page.page }],
    found: true,
    mode: 'search'
  };
}
