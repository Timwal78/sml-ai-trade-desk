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
    `${emoji} **SML INSTITUTIONAL TRADE DESK v3**`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    '',
    `**${safe(payload.exchange)}:${safe(payload.ticker)}** | TF: ${safe(payload.timeframe)} | ${safe(payload.alert_type)}`,
    `**Bias:** ${safe(payload.bias)} | **Score:** ${safe(payload.score)}/100 **${grade}** | **Regime:** ${safe(payload.regime)}`,
    '',
  ];
 
  // Squeeze section
  if (payload.squeeze_state) {
    lines.push(`**SQUEEZE:** ${safe(payload.squeeze_state)} | **Mom:** ${safe(payload.squeeze_momentum)} (${safe(payload.squeeze_mom_val)}) | **Fired:** ${safe(payload.squeeze_fired)}`);
  }
 
  // Institutional quant section
  const hasQuant = payload.adx || payload.z_score || payload.cmf;
  if (hasQuant) {
    lines.push('');
    lines.push('**— INSTITUTIONAL QUANT —**');
    if (payload.adx) lines.push(`**ADX:** ${safe(payload.adx)} ${safe(payload.adx_trend)} | **Z-Score:** ${safe(payload.z_score)} | **CMF:** ${safe(payload.cmf)}`);
    if (payload.vol_delta_pct) lines.push(`**Vol Delta:** ${safe(payload.vol_delta_pct)}% | **Vol Z:** ${safe(payload.vol_z_score)} | **Anomaly:** ${safe(payload.vol_anomaly)}`);
    if (payload.rel_strength_bull) lines.push(`**RS vs Bench:** ${payload.rel_strength_bull === 'YES' ? 'OUTPERFORM' : 'UNDERPERFORM'} | **Corr:** ${safe(payload.correlation_bench)}`);
  }
 
  // Options section
  const hasOptions = payload.implied_move || payload.iv_regime;
  if (hasOptions) {
    lines.push('');
    lines.push('**— OPTIONS DESK —**');
    lines.push(`**IV Rank:** ${safe(payload.iv_rank_proxy)}% | **RVol:** ${safe(payload.realized_vol)}% | **Regime:** ${safe(payload.iv_regime)}`);
    lines.push(`**Implied Move:** ±${safe(payload.implied_move)} (${safe(payload.implied_move_pct)}%) | **Exp Range:** ${safe(payload.opt_lower_exp)} — ${safe(payload.opt_upper_exp)}`);
    lines.push(`**ATM:** ${safe(payload.opt_atm_strike)} | **OTM Call:** ${safe(payload.opt_otm_call)} | **OTM Put:** ${safe(payload.opt_otm_put)}`);
    lines.push(`**Options Play:** ${safe(payload.opt_action)} | **Theta/Day:** ${safe(payload.theta_decay_daily)}`);
  }
 
  // Fundamentals
  if (payload.fund_grade && payload.fund_grade !== 'N/A') {
    lines.push('');
    lines.push('**— FUNDAMENTALS (BUFFETT) —**');
    lines.push(`**Grade:** ${safe(payload.fund_grade)} | **EPS:** ${safe(payload.fund_eps)} | **P/E:** ${safe(payload.fund_pe)} | **ROE:** ${safe(payload.fund_roe)}% | **Margin:** ${safe(payload.fund_margin)}%`);
    if (payload.fund_rev_growth) lines.push(`**Rev Growth:** ${safe(payload.fund_rev_growth)}%`);
  }
 
  // Trade levels
  lines.push('');
  lines.push('**— TRADE LEVELS —**');
  lines.push(`**Entry:** ${safe(payload.entry, payload.price)} | **Stop:** ${safe(payload.stop)} | **R:R:** ${safe(payload.rr)}`);
  lines.push(`**Targets:** ${safe(payload.target_1)} / ${safe(payload.target_2)} / ${safe(payload.target_3)}`);
  lines.push(`**Volume:** ${safe(payload.volume_ratio)}x avg | **RSI:** ${safe(payload.rsi)} | **ATR:** ${safe(payload.atr)}`);
  lines.push(`**Action:** ${safe(payload.action)}`);
 
  lines.push('', `**Why:** ${safe(payload.reason)}`);
 
  if (aiNote) lines.push('', `**AI Desk Note:** ${aiNote}`);
  lines.push('', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('_Not financial advice. Confirm liquidity, spread, and risk before entry._');
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
    const prompt = `You are an institutional trade desk analyst. Give a concise risk note for this alert. Include: key risk factors, whether the statistical and options data supports the directional bias, and one sentence on position sizing guidance. No hype. No financial advice. JSON: ${JSON.stringify(payload)}`;
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 200 })
    });
    if (res.ok) {
      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim()?.slice(0, 900) || '';
    }
  }
 
  if (AI_PROVIDER === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
    const prompt = `You are an institutional trade desk analyst. Give a concise risk note for this alert. Include: key risk factors, whether the statistical and options data supports the directional bias, and one sentence on position sizing guidance. No hype. No financial advice. JSON: ${JSON.stringify(payload)}`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-3-5-haiku-latest', max_tokens: 200, messages: [{ role: 'user', content: prompt }] })
    });
    if (res.ok) {
      const data = await res.json();
      return data.content?.[0]?.text?.trim()?.slice(0, 900) || '';
    }
  }
 
  return '';
}
 
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'SML AI Trade Desk v3 — SqueezeOS Institutional', time: new Date().toISOString() });
});
 
// Connectivity test — NO fake signal data. Manifesto compliant.
app.post('/webhook/test', async (_req, res) => {
  const content = [
    '🔧 **SML INSTITUTIONAL TRADE DESK v3 — CONNECTIVITY TEST**',
    '',
    'Server is alive. Discord bridge is operational.',
    `Tested at: ${new Date().toISOString()}`,
    '',
    '_Deploy Pine Script v3 and create a TradingView alert for live institutional signals._'
  ].join('\n');
 
  await postDiscord(content);
  res.json({ ok: true, test: true, message: 'Connectivity test only. No fake data sent.' });
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
 
app.listen(PORT, () => console.log(`SML AI Trade Desk v3 — SqueezeOS Institutional listening on ${PORT}`));
