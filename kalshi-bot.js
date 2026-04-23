cat > /root/kalshi-bot/kalshi-bot.js << 'CHUNK1'
#!/usr/bin/env node
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const Database = require('better-sqlite3');

const CONFIG = {
  kalshiApiKey: process.env.KALSHI_API_KEY,
  kalshiPrivateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH || '/root/kalshi-bot/private_key.pem',
  kalshiBaseUrl: process.env.KALSHI_ENV === 'demo'
    ? 'https://demo-api.kalshi.co/trade-api/v2'
    : 'https://trading-api.kalshi.com/trade-api/v2',
  signalUrl: process.env.SIGNAL_URL || 'http://localhost:3000/api/v1/signals/quick',
  signalSecret: process.env.ADMIN_SECRET || 'campione_admin_2026',
  minSignalStrength: parseInt(process.env.MIN_SIGNAL_STRENGTH) || 4,
  betSizeUsd: parseFloat(process.env.BET_SIZE_USD) || 5.00,
  maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS) || 3,
  stopLossThreshold: parseFloat(process.env.STOP_LOSS_THRESHOLD) || 25.00,
  signalCheckIntervalMs: 5 * 60 * 1000,
  positionCheckIntervalMs: 60 * 1000,
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  dbPath: process.env.KALSHI_DB_PATH || '/root/kalshi-bot/trades.db',
};

const db = new Database(CONFIG.dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kalshi_order_id TEXT,
    market_ticker TEXT NOT NULL,
    side TEXT NOT NULL,
    signal_direction TEXT,
    signal_strength INTEGER,
    contracts INTEGER NOT NULL,
    price_dollars REAL NOT NULL,
    cost_dollars REAL NOT NULL,
    status TEXT DEFAULT 'open',
    pnl_dollars REAL DEFAULT 0,
    opened_at INTEGER NOT NULL,
    closed_at INTEGER,
    notes TEXT
  );
  CREATE TABLE IF NOT EXISTS bot_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

function log(level, message) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${message}`);
  try {
    db.prepare('INSERT INTO bot_log (level, message, created_at) VALUES (?, ?, ?)').run(level, message, Date.now());
  } catch(e) {}
}

async function sendTelegram(message) {
  if (!CONFIG.telegramToken || !CONFIG.telegramChatId) return;
  try {
    const body = JSON.stringify({ chat_id: CONFIG.telegramChatId, text: message, parse_mode: 'HTML' });
    const url = new URL(`https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`);
    await new Promise((resolve, reject) => {
      const opts = { hostname: url.hostname, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
      const req = https.request(opts, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.write(body); req.end();
    });
  } catch(e) { log('WARN', `Telegram failed: ${e.message}`); }
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function kalshiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now().toString();
    const pathWithoutQuery = path.split('?')[0];
    const msgStr = timestamp + method.toUpperCase() + pathWithoutQuery;
    const privateKey = fs.readFileSync(CONFIG.kalshiPrivateKeyPath, 'utf8');
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(msgStr);
    signer.end();
    const signature = signer.sign({
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
    }).toString('base64');
    const headers = {
      'KALSHI-ACCESS-KEY': CONFIG.kalshiApiKey,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
      'Content-Type': 'application/json'
    };
    const urlObj = new URL(CONFIG.kalshiBaseUrl + path);
    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const opts = { hostname: urlObj.hostname, path: urlObj.pathname + (urlObj.search||''),
      method: method.toUpperCase(), headers };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
CHUNK1 
cat >> /root/kalshi-bot/kalshi-bot.js << 'CHUNK2'

async function getBalance() {
  try {
    const res = await kalshiRequest('GET', '/portfolio/balance');
    if (res.status !== 200) return null;
    return parseFloat(res.body.balance?.available_balance_cents || 0) / 100;
  } catch(e) { log('ERROR', `getBalance failed: ${e.message}`); return null; }
}

async function getBtcHourlyMarket() {
  try {
    const res = await kalshiRequest('GET', '/markets?series_ticker=KXBTC&status=open&limit=10');
    if (res.status !== 200) { log('WARN', `Markets API ${res.status}`); return null; }
    const markets = res.body.markets || [];
    const sorted = markets.sort((a, b) => new Date(a.close_time) - new Date(b.close_time));
    return sorted[0] || null;
  } catch(e) { log('ERROR', `getBtcHourlyMarket failed: ${e.message}`); return null; }
}

async function placeOrder(ticker, side, contracts, priceDecimal) {
  try {
    const body = {
      ticker, side, action: 'buy', type: 'limit', count: contracts,
      yes_price_dollars: side === 'yes' ? priceDecimal.toFixed(4) : (1 - priceDecimal).toFixed(4),
      client_order_id: `campione-${Date.now()}`
    };
    const res = await kalshiRequest('POST', '/portfolio/orders', body);
    if (res.status === 200 || res.status === 201) return res.body.order;
    log('WARN', `Order failed ${res.status}: ${JSON.stringify(res.body)}`);
    return null;
  } catch(e) { log('ERROR', `placeOrder failed: ${e.message}`); return null; }
}

async function checkOpenPositions() {
  try {
    const openTrades = db.prepare('SELECT * FROM trades WHERE status = "open"').all();
    if (!openTrades.length) return;
    for (const trade of openTrades) {
      const res = await kalshiRequest('GET', `/markets/${trade.market_ticker}`);
      if (res.status !== 200) continue;
      const market = res.body.market;
      if (!market) continue;
      if (market.status === 'finalized' || market.result) {
        const won = market.result === trade.side;
        const pnl = won ? (1 - trade.price_dollars) * trade.contracts : -trade.cost_dollars;
        db.prepare('UPDATE trades SET status = ?, pnl_dollars = ?, closed_at = ? WHERE id = ?')
          .run(won ? 'won' : 'lost', pnl, Date.now(), trade.id);
        const emoji = won ? '✅' : '❌';
        await sendTelegram(`${emoji} <b>TRADE ${won ? 'WON' : 'LOST'}</b>\n\nMarket: ${trade.market_ticker}\nSide: ${trade.side.toUpperCase()}\nP&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\nSignal: ${trade.signal_direction} (strength ${trade.signal_strength})`);
        log('INFO', `Trade ${trade.id} ${won ? 'WON' : 'LOST'} $${pnl.toFixed(2)}`);
      }
    }
  } catch(e) { log('ERROR', `checkOpenPositions failed: ${e.message}`); }
}

async function getWhaleSignal() {
  try {
    const res = await httpGet(CONFIG.signalUrl, { 'x-admin-secret': CONFIG.signalSecret });
    if (res.status !== 200) return null;
    return res.body;
  } catch(e) { log('WARN', `Signal fetch failed: ${e.message}`); return null; }
}

async function pnlSummary() {
  try {
    const stats = db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN status='lost' THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) as open,
        ROUND(SUM(pnl_dollars),2) as total_pnl
      FROM trades
    `).get();
    const balance = await getBalance();
    const winRate = (stats.wins + stats.losses) > 0
      ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(0) : 0;
    await sendTelegram(
      `📊 <b>KALSHI BOT — HOURLY SUMMARY</b>\n\n` +
      `Balance: $${balance?.toFixed(2) || '?'}\n` +
      `Total P&L: ${stats.total_pnl >= 0 ? '+' : ''}$${stats.total_pnl}\n\n` +
      `Trades: ${stats.total} total\n` +
      `✅ Wins: ${stats.wins} | ❌ Losses: ${stats.losses} | 🔄 Open: ${stats.open}\n` +
      `Win Rate: ${winRate}%\n\n` +
      `📡 Campione Infrastructure`
    );
  } catch(e) { log('ERROR', `pnlSummary failed: ${e.message}`); }
}
CHUNK2
cat >> /root/kalshi-bot/kalshi-bot.js << 'CHUNK3'

let botPaused = false;

async function tradingLoop() {
  if (botPaused) { log('INFO', 'Bot paused — skipping cycle'); return; }
  try {
    const balance = await getBalance();
    if (balance === null) { log('WARN', 'Could not fetch balance — skipping'); return; }
    if (balance < CONFIG.stopLossThreshold) {
      botPaused = true;
      log('WARN', `Balance $${balance.toFixed(2)} below stop loss — BOT PAUSED`);
      await sendTelegram(`🛑 <b>BOT PAUSED — STOP LOSS HIT</b>\n\nBalance: $${balance.toFixed(2)}\nThreshold: $${CONFIG.stopLossThreshold}\n\nManual review required.`);
      return;
    }
    const openCount = db.prepare('SELECT COUNT(*) as cnt FROM trades WHERE status = "open"').get().cnt;
    if (openCount >= CONFIG.maxOpenPositions) {
      log('INFO', `Max open positions (${CONFIG.maxOpenPositions}) reached — skipping`);
      return;
    }
    const signal = await getWhaleSignal();
    if (!signal || !signal.success) { log('INFO', 'No signal data'); return; }
    log('INFO', `Signal: ${signal.overall} strength:${signal.strength} bull:${signal.bullish} bear:${signal.bearish} whales:${signal.whales1h}`);
    if (signal.strength < CONFIG.minSignalStrength) {
      log('INFO', `Strength ${signal.strength} below min ${CONFIG.minSignalStrength} — no trade`);
      return;
    }
    if (signal.overall === 'NEUTRAL' || signal.overall === 'NO DATA') {
      log('INFO', `Signal ${signal.overall} — no trade`); return;
    }
    const market = await getBtcHourlyMarket();
    if (!market) { log('WARN', 'No open BTC hourly market found'); return; }
    log('INFO', `Target market: ${market.ticker} closes: ${market.close_time}`);
    const side = signal.overall === 'LONG' ? 'yes' : 'no';
    const marketPrice = parseFloat(market.yes_bid_dollars || market.yes_price_dollars || 0.50);
    const contracts = Math.floor(CONFIG.betSizeUsd / marketPrice);
    if (contracts < 1) { log('WARN', `Bet size too small for price $${marketPrice}`); return; }
    const cost = contracts * marketPrice;
    log('INFO', `Placing ${side.toUpperCase()}: ${contracts} contracts @ $${marketPrice} = $${cost.toFixed(2)}`);
    const order = await placeOrder(market.ticker, side, contracts, marketPrice);
    if (!order) { log('WARN', 'Order placement failed'); return; }
    db.prepare(`INSERT INTO trades (kalshi_order_id, market_ticker, side, signal_direction, signal_strength, contracts, price_dollars, cost_dollars, opened_at, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(order.order_id || 'unknown', market.ticker, side, signal.overall, signal.strength,
        contracts, marketPrice, cost, Date.now(),
        `bull:${signal.bullish} bear:${signal.bearish} whales:${signal.whales1h}`);
    await sendTelegram(
      `🐋 <b>TRADE OPENED</b>\n\n` +
      `Signal: ${signal.overall === 'LONG' ? '🟢 STRONG LONG' : '🔴 STRONG SHORT'} (strength ${signal.strength})\n` +
      `Market: ${market.ticker}\n` +
      `Side: ${side.toUpperCase()}\n` +
      `Contracts: ${contracts} @ $${marketPrice}\n` +
      `Cost: $${cost.toFixed(2)}\n` +
      `Balance: $${balance.toFixed(2)}\n` +
      `Expires: ${new Date(market.close_time).toLocaleTimeString()}\n\n` +
      `Whales: ${signal.whales1h} in last hour | Bull: ${signal.bullish} Bear: ${signal.bearish}`
    );
    log('INFO', `Trade opened: ${side.toUpperCase()} ${contracts} contracts on ${market.ticker}`);
  } catch(e) { log('ERROR', `Trading loop error: ${e.message}`); }
}

async function startup() {
  log('INFO', '=== Kalshi Bot v1.0 Starting ===');
  log('INFO', `Environment: ${process.env.KALSHI_ENV || 'production'}`);
  log('INFO', `Min signal strength: ${CONFIG.minSignalStrength}`);
  log('INFO', `Bet size: $${CONFIG.betSizeUsd}`);
  log('INFO', `Stop loss: $${CONFIG.stopLossThreshold}`);
  if (!CONFIG.kalshiApiKey) { log('ERROR', 'KALSHI_API_KEY not set'); process.exit(1); }
  if (!fs.existsSync(CONFIG.kalshiPrivateKeyPath)) { log('ERROR', `Private key not found at ${CONFIG.kalshiPrivateKeyPath}`); process.exit(1); }
  const signal = await getWhaleSignal();
  if (signal) log('INFO', `Signal endpoint OK: ${signal.overall} strength:${signal.strength}`);
  else log('WARN', 'Signal endpoint not responding');
  const balance = await getBalance();
  if (balance !== null) log('INFO', `Kalshi balance: $${balance.toFixed(2)}`);
  else log('WARN', 'Could not fetch Kalshi balance — check credentials');
  await sendTelegram(
    `🚀 <b>Kalshi Bot LIVE</b>\n\n` +
    `Mode: ${process.env.KALSHI_ENV || 'production'}\n` +
    `Strategy: XRPL Whale Signals → BTC Hourly Markets\n` +
    `Min Signal Strength: ${CONFIG.minSignalStrength}/5\n` +
    `Bet Size: $${CONFIG.betSizeUsd} per trade\n` +
    `Stop Loss: $${CONFIG.stopLossThreshold}\n` +
    `Balance: $${balance?.toFixed(2) || '?'}\n\n` +
    `📡 Campione Infrastructure`
  );
  await tradingLoop();
  setInterval(tradingLoop, CONFIG.signalCheckIntervalMs);
  setInterval(checkOpenPositions, CONFIG.positionCheckIntervalMs);
  setInterval(pnlSummary, 60 * 60 * 1000);
  log('INFO', 'Bot running. Checking signals every 5 minutes.');
}

startup().catch(e => { console.error('Fatal startup error:', e); process.exit(1); });
CHUNK3
