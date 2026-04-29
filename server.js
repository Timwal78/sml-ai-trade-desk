require('dotenv').config();
const express = require('express');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 10000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'CHANGE_ME';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const AI_PROVIDER = (process.env.AI_PROVIDER || 'none').toLowerCase();
const PC_AGENT_URL = process.env.PC_AGENT_URL || '';
const DEDUP_WINDOW_MS = Number(process.env.DEDUP_WINDOW_MS || 60000);
const seen = new Map();

function cleanupSeen() {
  const now = Date.now();
  for (const [key, value] of seen.entries()) {
    if (now - value > DEDUP_WINDOW_MS) seen.delete(key);
  }
}

function dedupKey(payload) {
  return [payload.source, payload.ticker, payload.timeframe, payload.alert_type, payload.price, payload.score].join('|');
}

function validatePayload(payload) {
  const required = ['secret', 'ticker', 'timeframe', 'alert_type', 'bias', 'score', 'price'];
  for (const field of required) {
    if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
      return `Missing required field: ${field}`;
    }
  }
  if (payload.secret !== WEBHOOK_SECRET) return 'Invalid secret';
  return null;
}

function safe(value, fallback = 'n/a') {
  return value === undefined || value === null || value === '' ? fallback : String(value);
}

function buildDeskRead(payload, aiNote = '') {
  const emoji = payload.bias === 'LONG' ? '🟢' : payload.bias === 'PUTS' ? '🔴' : '🟡';
  const score = Number(payload.score || 0);
  const grade = payload.grade || (score >= 90 ? 'A+' : score >= 80 ? 'A' : score >= 70 ? 'B' : score >= 60 ? 'C' : 'WATCH');
  const lines = [
    `${emoji} **SML AI TRADE DESK**`,
    '',
    `**Ticker:** ${safe(payload.exchange, '') ? safe(payload.exchange) + ':' : ''}${safe(payload.ticker)}  |  **TF:** ${safe(payload.timeframe)}`,
    `**Alert:** ${safe(payload.alert_type)}  |  **Bias:** ${safe(payload.bias)}  |  **Score:** ${safe(payload.score)}/100 ${grade}`,
    `**Regime:** ${safe(payload.regime)}  |  **Action:** ${safe(payload.action)}`,
    '',
    `**Price/Entry:** ${safe(payload.entry, payload.price)}  |  **Stop:** ${safe(payload.stop)}`,
    `**Targets:** ${safe(payload.target_1)} / ${safe(payload.target_2)} / ${safe(payload.target_3)}  |  **R:R:** ${safe(payload.rr)}`,
    `**Volume:** ${safe(payload.volume_ratio)}x avg`,
    '',
    `**Reason:** ${safe(payload.reason)}`,
  ];
  if (aiNote) lines.push('', `**AI Desk Note:** ${aiNote}`);
  lines.push('', '_Not financial advice. Confirm liquidity, spread, and risk before entry._');
  return lines.join('\n');
}

async function postDiscord(content) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log('Discord webhook not set. Message would be:\n', content);
    return { skipped: true };
  }
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  });
  if (!res.ok) throw new Error(`Discord post failed: ${res.status} ${await res.text()}`);
  return { ok: true };
}

async function getAiNote(payload) {
  if (PC_AGENT_URL) {
    try {
      const res = await fetch(PC_AGENT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'tradingview_alert', payload })
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.note) return String(data.note).slice(0, 900);
        if (data.message) return String(data.message).slice(0, 900);
      }
    } catch (err) {
      console.warn('PC agent call failed:', err.message);
    }
  }

  if (AI_PROVIDER === 'openai' && process.env.OPENAI_API_KEY) {
    const prompt = `Give a concise trade desk risk note for this TradingView alert. No hype. No financial advice. JSON: ${JSON.stringify(payload)}`;
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 140 })
    });
    if (res.ok) {
      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim()?.slice(0, 900) || '';
    }
  }

  if (AI_PROVIDER === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
    const prompt = `Give a concise trade desk risk note for this TradingView alert. No hype. No financial advice. JSON: ${JSON.stringify(payload)}`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-3-5-haiku-latest', max_tokens: 140, messages: [{ role: 'user', content: prompt }] })
    });
    if (res.ok) {
      const data = await res.json();
      return data.content?.[0]?.text?.trim()?.slice(0, 900) || '';
    }
  }

  return '';
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'SML AI Trade Desk Render Bridge', time: new Date().toISOString() });
});

app.post('/webhook/test', async (_req, res) => {
  const payload = {
    secret: WEBHOOK_SECRET,
    source: 'SML AI Trade Desk v1',
    ticker: 'AMC',
    exchange: 'NYSE',
    timeframe: '240',
    price: 1.92,
    alert_type: 'BULLISH_BREAKOUT',
    bias: 'LONG',
    score: 87,
    grade: 'A',
    regime: 'BULL',
    entry: 1.92,
    stop: 1.82,
    target_1: 2.02,
    target_2: 2.12,
    target_3: 2.22,
    rr: 2,
    volume_ratio: 1.8,
    action: 'WATCH_LONG',
    reason: 'Test alert: sweep reclaim, BOS up, VWAP reclaim, volume expansion.'
  };
  const content = buildDeskRead(payload, 'Test mode confirmed. Render to Discord bridge is alive.');
  await postDiscord(content);
  res.json({ ok: true, sent: true });
});

app.post('/webhook/tradingview', async (req, res) => {
  try {
    const payload = req.body || {};
    const error = validatePayload(payload);
    if (error) return res.status(error === 'Invalid secret' ? 401 : 400).json({ ok: false, error });

    cleanupSeen();
    const key = dedupKey(payload);
    if (seen.has(key)) return res.json({ ok: true, duplicate: true });
    seen.set(key, Date.now());

    const aiNote = await getAiNote(payload);
    const content = buildDeskRead(payload, aiNote);
    await postDiscord(content);
    res.json({ ok: true, sent: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`SML AI Trade Desk listening on ${PORT}`));
