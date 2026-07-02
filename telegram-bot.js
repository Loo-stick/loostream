const https = require('https');
const http = require('http');
const fs = require('fs');
const dns = require('dns');
const { spawn } = require('child_process');

// Prefer IPv4 — host has no working IPv6 route to Telegram
dns.setDefaultResultOrder('ipv4first');

// Configuration paths
const TELEGRAM_CONFIG_PATH = process.env.TELEGRAM_CONFIG || './config/telegram.json';
const DOMAINS_CONFIG_PATH = process.env.DOMAINS_CONFIG || './config/allowed-domains.json';
const MOVIX_ENDPOINTS_PATH = process.env.MOVIX_ENDPOINTS_CONFIG || './config/movix-endpoints.json';
const FLEMMIX_ENDPOINTS_PATH = process.env.FLEMMIX_ENDPOINTS_CONFIG || './config/flemmix-endpoints.json';
const EXTRACTOR_DOMAINS_PATH = process.env.EXTRACTOR_DOMAINS_CONFIG || './config/extractor-domains.json';
const {
  deduceExtractor,
  parseUnrecognizedHostLine,
  addDomainToExtractorConfig,
} = require('./telegram-bot-domains');
const LOOSTREAM_CONTAINER = process.env.LOOSTREAM_CONTAINER || 'loostream';
const MOVIX_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const FLEMMIX_CHANNEL = process.env.FLEMMIX_CHANNEL || 'flemmixwiflix';
const FLEMMIX_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

// Load Telegram config (from file or env)
function loadTelegramConfig() {
  // Try config file first
  try {
    if (fs.existsSync(TELEGRAM_CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(TELEGRAM_CONFIG_PATH, 'utf-8'));
      if (config.botToken && config.chatId) {
        console.log('[Config] Loaded Telegram config from file');
        return { botToken: config.botToken, chatId: config.chatId };
      }
    }
  } catch (e) {
    console.error('[Config] Error reading config file:', e.message);
  }

  // Fallback to environment variables
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    console.log('[Config] Using environment variables');
    return {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID
    };
  }

  return null;
}

let telegramConfig = loadTelegramConfig();
let botStarted = false;

if (!telegramConfig) {
  console.log('[Bot] No Telegram config found. Waiting for config...');
  console.log('[Bot] Create config/telegram.json with botToken and chatId');

  // Watch for config file creation (with debounce)
  const configDir = require('path').dirname(TELEGRAM_CONFIG_PATH);
  let debounceTimer = null;

  if (fs.existsSync(configDir)) {
    fs.watch(configDir, (eventType, filename) => {
      if (filename === 'telegram.json' && !botStarted) {
        // Debounce: wait 500ms before processing
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          console.log('[Config] Config file changed, reloading...');
          telegramConfig = loadTelegramConfig();
          if (telegramConfig && !botStarted) {
            console.log('[Bot] Config loaded! Starting bot...');
            botStarted = true;
            startBot();
          }
        }, 500);
      }
    });
  }

  // Keep process alive waiting for config
  setInterval(() => {
    if (!telegramConfig && !botStarted) {
      telegramConfig = loadTelegramConfig();
      if (telegramConfig) {
        console.log('[Bot] Config found! Starting bot...');
        botStarted = true;
        startBot();
      }
    }
  }, 10000);
} else {
  botStarted = true;
  startBot();
}

function startBot() {
  const BOT_TOKEN = telegramConfig.botToken;
  const CHAT_ID = telegramConfig.chatId;

// Track sent alerts to avoid duplicates
const sentAlerts = new Set();
const ALERT_COOLDOWN = 300000; // 5 minutes

// Telegram API helper
function telegramRequest(method, data) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      family: 4,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    // Guard against a silently hung connection. getUpdates is a long-poll
    // (timeout:30s); without an HTTP-level timeout a stalled socket never fires
    // 'error'/'end', the Promise never settles, and the pollUpdates loop dies
    // forever (setTimeout(pollUpdates,…) is never reached). 40s > the 30s poll.
    req.setTimeout(40000, () => {
      req.destroy(new Error('Telegram request timeout'));
    });
    req.write(postData);
    req.end();
  });
}

// Common multi-part TLDs where the eTLD is 2 labels instead of 1
const MULTI_PART_TLDS = new Set([
  'co.uk', 'co.jp', 'co.kr', 'co.in', 'co.za', 'co.il', 'co.nz',
  'com.au', 'com.br', 'com.cn', 'com.mx', 'com.tw', 'com.tr', 'com.sg',
  'com.hk', 'com.ar', 'com.my', 'com.ph', 'com.ua', 'com.vn',
  'net.au', 'net.br', 'net.cn',
  'org.uk', 'org.br', 'org.cn',
  'ac.uk', 'gov.uk', 'edu.au',
]);

// Compute the effective base domain (eTLD+1) from a hostname.
// moov265724.moovtop.fr -> moovtop.fr
// cdn.a.co.uk -> a.co.uk
// Returns null if equal to input (already base).
function extractBaseDomain(hostname) {
  const parts = hostname.split('.');
  if (parts.length < 2) return null;

  const last2 = parts.slice(-2).join('.');
  if (parts.length >= 3 && MULTI_PART_TLDS.has(last2)) {
    const last3 = parts.slice(-3).join('.');
    return last3 !== hostname ? last3 : null;
  }
  return last2 !== hostname ? last2 : null;
}

// Send alert with inline buttons
async function sendDomainAlert(domain, fullUrl) {
  const alertKey = domain;

  // Check cooldown
  if (sentAlerts.has(alertKey)) {
    return;
  }

  sentAlerts.add(alertKey);
  setTimeout(() => sentAlerts.delete(alertKey), ALERT_COOLDOWN);

  const baseDomain = extractBaseDomain(domain);

  let message = `🚫 <b>Domaine bloqué</b>\n\n` +
    `<code>${domain}</code>\n`;
  if (baseDomain) {
    message += `└ racine: <code>${baseDomain}</code>\n`;
  }
  message += `\nURL: <code>${fullUrl.substring(0, 100)}${fullUrl.length > 100 ? '...' : ''}</code>`;

  const buttons = [];
  buttons.push([{ text: `✅ Whitelist ${domain}`, callback_data: `add:${domain}` }]);
  if (baseDomain) {
    buttons.push([{ text: `✅ Whitelist ${baseDomain} (couvre les subdomains)`, callback_data: `add:${baseDomain}` }]);
  }
  buttons.push([{ text: '❌ Ignorer', callback_data: `ignore:${domain}` }]);

  try {
    await telegramRequest('sendMessage', {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
    console.log(`[Telegram] Alert sent for: ${domain}${baseDomain ? ` (+base ${baseDomain})` : ''}`);
  } catch (e) {
    console.error('[Telegram] Failed to send alert:', e.message);
  }
}

// Trigger config reload on loostream
function reloadLoostream() {
  return new Promise((resolve) => {
    const req = http.get('http://loostream:7002/proxy/domains?reload=true', (res) => {
      console.log(`[Config] Loostream reload triggered (status: ${res.statusCode})`);
      resolve(true);
    });
    req.on('error', (e) => {
      console.error('[Config] Failed to reload loostream:', e.message);
      resolve(false);
    });
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Fetch from loostream API
function fetchLoostreamApi(endpoint) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://loostream:7002${endpoint}`, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

// Format stats message
async function sendStatsMessage() {
  try {
    const stats = await fetchLoostreamApi('/api/stats');

    const message = `📊 <b>Statistiques LooStream</b>\n\n` +
      `⏱ Uptime: ${stats.uptime}\n\n` +
      `<b>Requêtes:</b>\n` +
      `• Total: ${stats.requests.total}\n` +
      `• Streams: ${stats.requests.streams}\n\n` +
      `<b>Streams servis par source:</b>\n` +
      `• Movix: ${stats.streamsServed.movix}\n` +
      `• NetMirror: ${stats.streamsServed.netmirror}\n` +
      `• StreamFlix: ${stats.streamsServed.streamflix}\n\n` +
      `<b>Taux de succès:</b>\n` +
      `• Movix: ${stats.sources.movix.requests > 0 ? Math.round(stats.sources.movix.success / stats.sources.movix.requests * 100) : 0}%\n` +
      `• NetMirror: ${stats.sources.netmirror.requests > 0 ? Math.round(stats.sources.netmirror.success / stats.sources.netmirror.requests * 100) : 0}%\n` +
      `• StreamFlix: ${stats.sources.streamflix.requests > 0 ? Math.round(stats.sources.streamflix.success / stats.sources.streamflix.requests * 100) : 0}%`;

    await telegramRequest('sendMessage', {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    });
  } catch (e) {
    await telegramRequest('sendMessage', {
      chat_id: CHAT_ID,
      text: `❌ Erreur lors de la récupération des stats: ${e.message}`,
      parse_mode: 'HTML'
    });
  }
}

// Format health message
async function sendHealthMessage() {
  try {
    const health = await fetchLoostreamApi('/api/health');

    const statusEmoji = {
      'up': '🟢',
      'down': '🔴',
      'degraded': '🟡'
    };

    const overallEmoji = health.overall === 'healthy' ? '✅' : (health.overall === 'down' ? '🔴' : '⚠️');

    let message = `${overallEmoji} <b>État des sources</b>\n\n`;

    for (const [source, data] of Object.entries(health.sources)) {
      const emoji = statusEmoji[data.status] || '❓';
      const latency = data.latency ? ` (${data.latency}ms)` : '';
      const error = data.error ? ` - ${data.error}` : '';
      message += `${emoji} <b>${source}</b>: ${data.status}${latency}${error}\n`;
    }

    await telegramRequest('sendMessage', {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    });
  } catch (e) {
    await telegramRequest('sendMessage', {
      chat_id: CHAT_ID,
      text: `❌ Erreur lors du health check: ${e.message}`,
      parse_mode: 'HTML'
    });
  }
}

// Track source status for alerts. Flap damping: a new status must persist for
// CONFIRM_THRESHOLD consecutive checks (5 min each) before we commit it and alert,
// so a single transient TLS blip on a source no longer spams the chat.
const CONFIRM_THRESHOLD = 2;
// source -> { confirmed, pending, count } — null until first check seeds it.
const sourceState = {};
const lastScraperMetricsStatus = { movix: 'ok', netmirror: 'ok', streamflix: 'ok', faklum: 'ok' };

const SCRAPER_EMOJI = { ok: '🟢', warning: '🟡', down: '🔴' };
function formatAge(ms) {
  if (!ms) return 'jamais';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}min`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}j`;
}

async function periodicScraperMetricsCheck() {
  try {
    const stats = await fetchLoostreamApi('/api/stats');
    if (!stats?.metrics) return;

    for (const [scraper, m] of Object.entries(stats.metrics)) {
      const prev = lastScraperMetricsStatus[scraper];
      const curr = m.status;
      if (prev === curr) continue;

      // Escalation
      if ((prev === 'ok' && curr !== 'ok') || (prev === 'warning' && curr === 'down')) {
        await telegramRequest('sendMessage', {
          chat_id: CHAT_ID,
          text: `${SCRAPER_EMOJI[curr]} <b>Scraper ${scraper} → ${curr.toUpperCase()}</b>\n\n` +
            `Raison: ${m.statusReason || 'inconnue'}\n` +
            `Fenêtre: ${m.success}✓ ${m.empty}∅ ${m.errors}⚠ (${m.window} req)\n` +
            `Dernier succès: ${formatAge(m.lastSuccessAt)}`,
          parse_mode: 'HTML'
        });
      }
      // Recovery
      else if ((prev !== 'ok' && curr === 'ok') || (prev === 'down' && curr === 'warning')) {
        await telegramRequest('sendMessage', {
          chat_id: CHAT_ID,
          text: `${SCRAPER_EMOJI[curr]} <b>Scraper ${scraper} récupère → ${curr.toUpperCase()}</b>\n\n` +
            `Fenêtre: ${m.success}✓ ${m.empty}∅ ${m.errors}⚠ (${m.window} req)`,
          parse_mode: 'HTML'
        });
      }

      lastScraperMetricsStatus[scraper] = curr;
      console.log(`[Metrics] ${scraper}: ${prev} → ${curr} (${m.statusReason || 'ok'})`);
    }
  } catch (e) {
    console.error('[Metrics] Check error:', e.message);
  }
}

// Poll scraper metrics every 10 minutes (first check 90s after startup)
setInterval(periodicScraperMetricsCheck, 10 * 60 * 1000);
setTimeout(periodicScraperMetricsCheck, 90000);

// Periodic health check with alerts
async function periodicHealthCheck() {
  try {
    const health = await fetchLoostreamApi('/api/health');

    for (const [source, data] of Object.entries(health.sources)) {
      const currentStatus = data.status;
      let st = sourceState[source];

      // Seed on first observation — no alert.
      if (!st) {
        sourceState[source] = { confirmed: currentStatus, pending: currentStatus, count: CONFIRM_THRESHOLD };
        continue;
      }

      // Count consecutive readings of the same status.
      if (currentStatus === st.pending) st.count++;
      else { st.pending = currentStatus; st.count = 1; }

      // Only commit (and alert) once a new status has persisted long enough.
      if (currentStatus !== st.confirmed && st.count >= CONFIRM_THRESHOLD) {
        const prevStatus = st.confirmed;
        st.confirmed = currentStatus;

        if (currentStatus === 'down') {
          await telegramRequest('sendMessage', {
            chat_id: CHAT_ID,
            text: `🔴 <b>ALERTE: ${source} est DOWN!</b>\n\nErreur: ${data.error || 'Inconnue'}`,
            parse_mode: 'HTML'
          });
          console.log(`[Health] Alert: ${source} is DOWN`);
        } else if (prevStatus === 'down' && currentStatus === 'up') {
          await telegramRequest('sendMessage', {
            chat_id: CHAT_ID,
            text: `🟢 <b>${source} est de retour!</b>\n\nLatence: ${data.latency}ms`,
            parse_mode: 'HTML'
          });
          console.log(`[Health] ${source} recovered`);
        }
      }
    }
  } catch (e) {
    console.error('[Health] Periodic check error:', e.message);
  }
}

// Start periodic health check (every 5 minutes)
setInterval(periodicHealthCheck, 5 * 60 * 1000);
// Run first check after 30 seconds
setTimeout(periodicHealthCheck, 30000);

// Add domain to whitelist
async function addDomainToWhitelist(domain) {
  try {
    let config = { domains: [] };

    if (fs.existsSync(DOMAINS_CONFIG_PATH)) {
      const data = fs.readFileSync(DOMAINS_CONFIG_PATH, 'utf-8');
      config = JSON.parse(data);
    }

    if (!config.domains.includes(domain)) {
      config.domains.push(domain);
      fs.writeFileSync(DOMAINS_CONFIG_PATH, JSON.stringify(config, null, 2));
      console.log(`[Config] Added domain: ${domain}`);

      // Trigger reload on loostream container
      await reloadLoostream();

      return true;
    }
    return false;
  } catch (e) {
    console.error('[Config] Error adding domain:', e.message);
    return false;
  }
}

// Handle Telegram callback queries (button clicks)
async function handleCallbackQuery(query) {
  const { id, data, message } = query;

  // Domaines d'extracteurs rotés
  if (data.startsWith('xadd:')) {
    const rest = data.slice(5);
    const sep = rest.indexOf(':');
    const extractor = rest.slice(0, sep);
    const xdomain = rest.slice(sep + 1);
    const ok = addExtractorDomain(extractor, xdomain);
    await telegramRequest('answerCallbackQuery', {
      callback_query_id: id,
      text: ok
        ? `✅ ${xdomain} ajouté à ${extractor}`
        : `ℹ️ ${xdomain} déjà présent`,
    });
    await telegramRequest('editMessageText', {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: ok
        ? `✅ <code>${xdomain}</code> ajouté à <b>${extractor}</b> (rechargé)`
        : `ℹ️ <code>${xdomain}</code> était déjà dans <b>${extractor}</b>`,
      parse_mode: 'HTML',
    });
    return;
  }
  if (data.startsWith('xign:')) {
    const xdomain = data.slice(5);
    await telegramRequest('answerCallbackQuery', {
      callback_query_id: id,
      text: `🔇 ${xdomain} ignoré`,
    });
    await telegramRequest('editMessageText', {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: `🔇 <code>${xdomain}</code> ignoré`,
      parse_mode: 'HTML',
    });
    return;
  }

  const [action, domain] = data.split(':');

  let responseText = '';

  if (action === 'add') {
    const added = await addDomainToWhitelist(domain);
    responseText = added
      ? `✅ ${domain} ajouté à la whitelist (rechargé)`
      : `ℹ️ ${domain} déjà dans la whitelist`;
  } else if (action === 'ignore') {
    responseText = `🔇 ${domain} ignoré`;
  }

  // Answer callback
  await telegramRequest('answerCallbackQuery', {
    callback_query_id: id,
    text: responseText
  });

  // Update message
  await telegramRequest('editMessageText', {
    chat_id: message.chat.id,
    message_id: message.message_id,
    text: `${message.text}\n\n${responseText}`,
    parse_mode: 'HTML'
  });
}

// Poll for Telegram updates
let lastUpdateId = 0;

async function pollUpdates() {
  try {
    const result = await telegramRequest('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: 30
    });

    if (result.ok && result.result.length > 0) {
      for (const update of result.result) {
        lastUpdateId = update.update_id;

        const senderChatId = String(
          update.message?.chat?.id ??
          update.callback_query?.message?.chat?.id ??
          ''
        );
        if (senderChatId !== String(CHAT_ID)) {
          console.warn(`[Telegram] Ignoring update from unauthorized chat: ${senderChatId}`);
          continue;
        }

        if (update.callback_query) {
          await handleCallbackQuery(update.callback_query);
        }

        // Handle /status command
        if (update.message?.text === '/status') {
          let config = { domains: [] };
          if (fs.existsSync(DOMAINS_CONFIG_PATH)) {
            config = JSON.parse(fs.readFileSync(DOMAINS_CONFIG_PATH, 'utf-8'));
          }
          await telegramRequest('sendMessage', {
            chat_id: CHAT_ID,
            text: `📊 <b>Status LooStream</b>\n\n` +
              `Domaines whitelistés: ${config.domains.length}\n` +
              `Alertes en cooldown: ${sentAlerts.size}`,
            parse_mode: 'HTML'
          });
        }

        // Handle /domains command
        if (update.message?.text === '/domains') {
          let config = { domains: [] };
          if (fs.existsSync(DOMAINS_CONFIG_PATH)) {
            config = JSON.parse(fs.readFileSync(DOMAINS_CONFIG_PATH, 'utf-8'));
          }
          const domainList = config.domains.map(d => `• ${d}`).join('\n');
          await telegramRequest('sendMessage', {
            chat_id: CHAT_ID,
            text: `📋 <b>Domaines whitelistés</b>\n\n${domainList}`,
            parse_mode: 'HTML'
          });
        }

        // Handle /stats command
        if (update.message?.text === '/stats') {
          await sendStatsMessage();
        }

        // Handle /health command
        if (update.message?.text === '/health') {
          await sendHealthMessage();
        }

        // Handle /movix command (manual endpoint check)
        if (update.message?.text === '/movix') {
          await telegramRequest('sendMessage', {
            chat_id: CHAT_ID,
            text: '🔍 Vérification des endpoints Movix...',
            parse_mode: 'HTML'
          });
          await checkMovixEndpoints({ manual: true });
        }

        // Handle /flemmix command (manual endpoint check)
        if (update.message?.text === '/flemmix') {
          await telegramRequest('sendMessage', {
            chat_id: CHAT_ID,
            text: '🔍 Vérification du domaine Flemmix...',
            parse_mode: 'HTML'
          });
          await checkFlemmixEndpoints({ manual: true });
        }
      }
    }
  } catch (e) {
    console.error('[Telegram] Poll error:', e.message);
  }

  // Continue polling
  setTimeout(pollUpdates, 1000);
}

// --- Domaines d'extracteurs rotés ---

function triggerExtractorDomainsReload() {
  const req = http.get('http://loostream:7002/api/extractor-domains?reload=true', (res) => {
    res.resume();
    console.log(`[ExtractorDomains] Reload déclenché (HTTP ${res.statusCode})`);
  });
  req.on('error', (e) => console.error('[ExtractorDomains] Reload échoué:', e.message));
  req.setTimeout(5000, () => req.destroy());
}

function addExtractorDomain(extractor, domain) {
  let raw = {};
  try {
    if (fs.existsSync(EXTRACTOR_DOMAINS_PATH)) {
      raw = JSON.parse(fs.readFileSync(EXTRACTOR_DOMAINS_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error('[ExtractorDomains] Lecture/parse échoué, abandon:', e.message);
    return false;
  }
  const { config, added } = addDomainToExtractorConfig(raw, extractor, domain);
  if (added) {
    fs.writeFileSync(EXTRACTOR_DOMAINS_PATH, JSON.stringify(config, null, 2));
    console.log(`[ExtractorDomains] ${domain} ajouté à ${extractor}`);
    triggerExtractorDomainsReload();
  }
  return added;
}

function handleUnrecognizedHost(info) {
  const alertKey = `xdom:${info.host}`;
  if (sentAlerts.has(alertKey)) return;
  const extractor = deduceExtractor(info.server);
  if (!extractor) return; // label inconnu/générique => silencieux
  sentAlerts.add(alertKey);
  setTimeout(() => sentAlerts.delete(alertKey), ALERT_COOLDOWN);
  sendExtractorDomainAlert(info.host, info.server, info.title, extractor);
}

async function sendExtractorDomainAlert(host, server, title, extractor) {
  let message = `⚠️ <b>Domaine d'extracteur inconnu</b>\n\n` +
    `<code>${host}</code>\n` +
    `serveur : « ${server} »`;
  if (title) message += `  —  film : ${title}`;
  const buttons = [
    [{ text: `➕ Ajouter à ${extractor}`, callback_data: `xadd:${extractor}:${host}` }],
    [{ text: '❌ Ignorer', callback_data: `xign:${host}` }],
  ];
  try {
    await telegramRequest('sendMessage', {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons },
    });
    console.log(`[ExtractorDomains] Alerte envoyée: ${host} -> ${extractor}`);
  } catch (e) {
    console.error('[ExtractorDomains] Envoi alerte échoué:', e.message);
  }
}

// Monitor Docker logs
function monitorLogs() {
  console.log(`[Monitor] Watching logs for container: ${LOOSTREAM_CONTAINER}`);

  const docker = spawn('docker', ['logs', '-f', '--tail', '0', LOOSTREAM_CONTAINER]);

  docker.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      // Match: [Proxy] Blocked request: Domain not whitelisted: example.com - https://...
      const match = line.match(/Domain not whitelisted: ([^\s]+) - (.+)/);
      if (match) {
        const [, domain, url] = match;
        sendDomainAlert(domain, url);
      }
      const unrec = parseUnrecognizedHostLine(line);
      if (unrec) {
        handleUnrecognizedHost(unrec);
      }
    }
  });

  docker.stderr.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      const match = line.match(/Domain not whitelisted: ([^\s]+) - (.+)/);
      if (match) {
        const [, domain, url] = match;
        sendDomainAlert(domain, url);
      }
      const unrec = parseUnrecognizedHostLine(line);
      if (unrec) {
        handleUnrecognizedHost(unrec);
      }
    }
  });

  docker.on('close', (code) => {
    console.log(`[Monitor] Docker logs closed with code ${code}, restarting in 5s...`);
    setTimeout(monitorLogs, 5000);
  });

  docker.on('error', (err) => {
    console.error('[Monitor] Docker error:', err.message);
    setTimeout(monitorLogs, 5000);
  });
}

// Start
console.log('[Bot] LooStream Telegram Alert Bot starting...');
console.log(`[Bot] Domains config: ${DOMAINS_CONFIG_PATH}`);

// Send startup message
telegramRequest('sendMessage', {
  chat_id: CHAT_ID,
  text: '🟢 <b>LooStream Alert Bot démarré</b>\n\n' +
    'Commandes:\n' +
    '/status - Whitelist status\n' +
    '/domains - Liste des domaines\n' +
    '/stats - Statistiques détaillées\n' +
    '/health - État des sources\n' +
    '/movix - Check endpoints Movix\n' +
    '/flemmix - Check domaine Flemmix',
  parse_mode: 'HTML'
}).then(() => {
  console.log('[Bot] Startup message sent');
});

// ============================================
// MOVIX ENDPOINT WATCHER
// ============================================

function httpGetText(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      family: 4,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        const next = new URL(res.headers.location, url).toString();
        resolve(httpGetText(next, redirects - 1));
        return;
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function detectMovixEndpoints() {
  // 1. Scrape public Telegram channel preview
  const tgHtml = await httpGetText('https://t.me/s/movix_site');
  const msgRegex = /data-post="movix_site\/(\d+)"[\s\S]*?tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/g;
  const messages = [];
  let m;
  while ((m = msgRegex.exec(tgHtml)) !== null) {
    const id = parseInt(m[1], 10);
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    messages.push({ id, text });
  }
  messages.sort((a, b) => b.id - a.id);

  let frontendDomain = null;
  for (const msg of messages) {
    const match = msg.text.match(/https?:\/\/(movix\.[a-z]{2,})/i);
    if (match) { frontendDomain = match[1].toLowerCase(); break; }
  }
  if (!frontendDomain) throw new Error('No movix domain found in channel');

  // 2. Follow HTML-level redirects (meta refresh + window.location.replace)
  let currentUrl = `https://${frontendDomain}/`;
  for (let i = 0; i < 5; i++) {
    const html = await httpGetText(currentUrl);
    const metaMatch = html.match(/<meta\s+http-equiv=["']refresh["']\s+content=["']\s*\d+\s*;\s*url=([^"'>]+)/i);
    const jsMatch = html.match(/window\.location\.replace\(["']([^"']+)["']\)/);
    const next = metaMatch ? metaMatch[1] : (jsMatch ? jsMatch[1] : null);
    if (next && !next.startsWith(currentUrl)) {
      currentUrl = new URL(next, currentUrl).toString();
      continue;
    }
    break;
  }
  const finalHost = new URL(currentUrl).hostname.replace(/^www\./, '');

  // 3. Fetch JS bundle and extract API URL
  const appHtml = await httpGetText(`https://${finalHost}/`);
  const bundleMatch = appHtml.match(/src=["'](\/assets\/index-[^"']+\.js)["']/);
  if (!bundleMatch) throw new Error(`No JS bundle found on ${finalHost}`);
  const bundleJs = await httpGetText(`https://${finalHost}${bundleMatch[1]}`);
  const apiMatch = bundleJs.match(/https:\/\/api\.movix\.[a-z]{2,}/);
  if (!apiMatch) throw new Error(`No api.movix.* URL found in bundle on ${finalHost}`);

  return {
    api: apiMatch[0],
    referer: `https://${finalHost}/`,
    origin: `https://${finalHost}`,
  };
}

function readMovixConfig() {
  try {
    if (fs.existsSync(MOVIX_ENDPOINTS_PATH)) {
      return JSON.parse(fs.readFileSync(MOVIX_ENDPOINTS_PATH, 'utf-8'));
    }
  } catch {}
  return null;
}

async function triggerMovixReload() {
  return new Promise((resolve) => {
    const req = http.get(`http://${LOOSTREAM_CONTAINER}:7002/api/movix/endpoints?reload=true`, (res) => {
      console.log(`[Movix] Reload triggered (status: ${res.statusCode})`);
      resolve(true);
    });
    req.on('error', (e) => { console.error('[Movix] Reload failed:', e.message); resolve(false); });
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
  });
}

async function checkMovixEndpoints(opts = {}) {
  const { manual = false } = opts;
  try {
    const detected = await detectMovixEndpoints();
    const current = readMovixConfig() || {};

    const now = new Date().toISOString();
    const changed = current.api !== detected.api || current.referer !== detected.referer;

    const next = {
      _comment: 'Endpoints Movix auto-mis à jour par telegram-bot.js depuis t.me/movix_site. Hot-reloadé par le scraper.',
      api: detected.api,
      referer: detected.referer,
      origin: detected.origin,
      lastCheckedAt: now,
      lastUpdatedAt: changed ? now : (current.lastUpdatedAt || null),
    };
    fs.writeFileSync(MOVIX_ENDPOINTS_PATH, JSON.stringify(next, null, 2));

    if (changed) {
      await triggerMovixReload();
      const prevApi = current.api || '(none)';
      await telegramRequest('sendMessage', {
        chat_id: CHAT_ID,
        text: `🔄 <b>Movix endpoints mis à jour</b>\n\n` +
          `API: <code>${prevApi}</code> → <code>${detected.api}</code>\n` +
          `Referer: <code>${detected.referer}</code>\n\n` +
          `Source: t.me/movix_site — appliqué via hot-reload.`,
        parse_mode: 'HTML'
      });
      console.log(`[Movix] Updated: ${prevApi} → ${detected.api}`);
    } else {
      console.log(`[Movix] No change (api=${detected.api})`);
      if (manual) {
        await telegramRequest('sendMessage', {
          chat_id: CHAT_ID,
          text: `✅ <b>Movix endpoints OK</b>\n\nAPI: <code>${detected.api}</code>\nReferer: <code>${detected.referer}</code>\n\nAucun changement.`,
          parse_mode: 'HTML'
        });
      }
    }
  } catch (e) {
    const detail = e && (e.message || e.code || String(e)) || 'unknown';
    console.error('[Movix] Check failed:', detail, e && e.stack ? '\n' + e.stack : '');
    if (manual) {
      await telegramRequest('sendMessage', {
        chat_id: CHAT_ID,
        text: `❌ <b>Movix check échec</b>\n\n<code>${detail}</code>`,
        parse_mode: 'HTML'
      }).catch(() => {});
    }
  }
}

// First check after 60s, then every 6h
setTimeout(checkMovixEndpoints, 60000);
setInterval(checkMovixEndpoints, MOVIX_CHECK_INTERVAL_MS);

// --- Flemmix endpoint watcher ---------------------------------------------
// Flemmix tourne souvent de domaine (flemmix.<tld>). On lit le dernier domaine
// annoncé sur le channel public, mais on NE LUI FAIT PAS confiance aveuglément :
// flemmix.website répond 200 sans films (relais), flemmix.cafe est mort... donc
// on valide chaque candidat par son contenu avant de basculer le config.
async function flemmixServesFilms(domain) {
  try {
    const html = await httpGetText(`https://${domain}/`);
    return /\/film-en-streaming\/\d+-/.test(html);
  } catch {
    return false;
  }
}

async function detectFlemmixEndpoints() {
  // 1. Scrape l'aperçu public du channel, découpé en blocs message (par id).
  const html = await httpGetText(`https://t.me/s/${FLEMMIX_CHANNEL}`);
  const blockRegex = /data-post="[^"/]+\/(\d+)"([\s\S]*?)(?=data-post="[^"/]+\/\d+"|$)/g;
  const blocks = [];
  let m;
  while ((m = blockRegex.exec(html)) !== null) {
    blocks.push({ id: parseInt(m[1], 10), html: m[2] });
  }
  blocks.sort((a, b) => b.id - a.id); // plus récent d'abord

  // 2. Collecter les domaines flemmix.<tld>, du message le plus récent au plus
  //    ancien. On lit d'abord les hrefs (propres), puis le texte avec une
  //    frontière en lookahead pour éviter de coller "flemmix.fastGardez...".
  const seen = new Set();
  const candidates = [];
  for (const b of blocks) {
    let mm;
    const hrefRe = /href="https?:\/\/(flemmix\.[a-z]{2,})/gi;
    while ((mm = hrefRe.exec(b.html)) !== null) {
      const d = mm[1].toLowerCase();
      if (!seen.has(d)) { seen.add(d); candidates.push(d); }
    }
    const txtRe = /https?:\/\/(flemmix\.[a-z]{2,})(?=["'<\s/])/gi;
    while ((mm = txtRe.exec(b.html)) !== null) {
      const d = mm[1].toLowerCase();
      if (!seen.has(d)) { seen.add(d); candidates.push(d); }
    }
  }
  if (!candidates.length) throw new Error('No flemmix domain found in channel');

  // 3. Prendre le premier candidat (le plus récent) qui sert réellement des films.
  for (const domain of candidates) {
    if (await flemmixServesFilms(domain)) {
      return { base: `https://${domain}`, origin: `https://${domain}`, referer: `https://${domain}/` };
    }
  }
  throw new Error(`No flemmix domain served film content (tried: ${candidates.join(', ')})`);
}

function readFlemmixConfig() {
  try {
    if (fs.existsSync(FLEMMIX_ENDPOINTS_PATH)) {
      return JSON.parse(fs.readFileSync(FLEMMIX_ENDPOINTS_PATH, 'utf-8'));
    }
  } catch {}
  return null;
}

async function triggerFlemmixReload() {
  return new Promise((resolve) => {
    const req = http.get(`http://${LOOSTREAM_CONTAINER}:7002/api/flemmix/endpoints?reload=true`, (res) => {
      console.log(`[Flemmix] Reload triggered (status: ${res.statusCode})`);
      resolve(true);
    });
    req.on('error', (e) => { console.error('[Flemmix] Reload failed:', e.message); resolve(false); });
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
  });
}

async function checkFlemmixEndpoints(opts = {}) {
  const { manual = false } = opts;
  try {
    const detected = await detectFlemmixEndpoints();
    const current = readFlemmixConfig() || {};

    const now = new Date().toISOString();
    const changed = current.base !== detected.base;

    const next = {
      _comment: 'Endpoints Flemmix auto-mis à jour par telegram-bot.js depuis t.me/' + FLEMMIX_CHANNEL + '. Hot-reloadé par le scraper.',
      base: detected.base,
      origin: detected.origin,
      referer: detected.referer,
      lastCheckedAt: now,
      lastUpdatedAt: changed ? now : (current.lastUpdatedAt || null),
    };
    fs.writeFileSync(FLEMMIX_ENDPOINTS_PATH, JSON.stringify(next, null, 2));

    if (changed) {
      await triggerFlemmixReload();
      const prevBase = current.base || '(none)';
      await telegramRequest('sendMessage', {
        chat_id: CHAT_ID,
        text: `🔄 <b>Flemmix endpoint mis à jour</b>\n\n` +
          `Domaine: <code>${prevBase}</code> → <code>${detected.base}</code>\n\n` +
          `Source: t.me/${FLEMMIX_CHANNEL} — validé (films présents) et appliqué via hot-reload.`,
        parse_mode: 'HTML'
      });
      console.log(`[Flemmix] Updated: ${prevBase} → ${detected.base}`);
    } else {
      console.log(`[Flemmix] No change (base=${detected.base})`);
      if (manual) {
        await telegramRequest('sendMessage', {
          chat_id: CHAT_ID,
          text: `✅ <b>Flemmix endpoint OK</b>\n\nDomaine: <code>${detected.base}</code>\n\nAucun changement.`,
          parse_mode: 'HTML'
        });
      }
    }
  } catch (e) {
    const detail = e && (e.message || e.code || String(e)) || 'unknown';
    console.error('[Flemmix] Check failed:', detail, e && e.stack ? '\n' + e.stack : '');
    if (manual) {
      await telegramRequest('sendMessage', {
        chat_id: CHAT_ID,
        text: `❌ <b>Flemmix check échec</b>\n\n<code>${detail}</code>`,
        parse_mode: 'HTML'
      }).catch(() => {});
    }
  }
}

// First check after 90s (décalé de Movix), then every 6h
setTimeout(checkFlemmixEndpoints, 90000);
setInterval(checkFlemmixEndpoints, FLEMMIX_CHECK_INTERVAL_MS);

// Start monitoring and polling
monitorLogs();
pollUpdates();

} // End of startBot function
