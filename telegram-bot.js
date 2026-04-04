const https = require('https');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

// Configuration paths
const TELEGRAM_CONFIG_PATH = process.env.TELEGRAM_CONFIG || './config/telegram.json';
const DOMAINS_CONFIG_PATH = process.env.DOMAINS_CONFIG || './config/allowed-domains.json';
const LOOSTREAM_CONTAINER = process.env.LOOSTREAM_CONTAINER || 'loostream';

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

if (!telegramConfig) {
  console.log('[Bot] No Telegram config found. Waiting for config...');
  console.log('[Bot] Configure via /configure page or set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');

  // Watch for config file creation
  const configDir = require('path').dirname(TELEGRAM_CONFIG_PATH);
  if (fs.existsSync(configDir)) {
    fs.watch(configDir, (eventType, filename) => {
      if (filename === 'telegram.json') {
        console.log('[Config] Config file changed, reloading...');
        telegramConfig = loadTelegramConfig();
        if (telegramConfig) {
          console.log('[Bot] Config loaded! Starting bot...');
          startBot();
        }
      }
    });
  }

  // Keep process alive waiting for config
  setInterval(() => {
    if (!telegramConfig) {
      telegramConfig = loadTelegramConfig();
      if (telegramConfig) {
        console.log('[Bot] Config found! Starting bot...');
        startBot();
      }
    }
  }, 10000);
} else {
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
    req.write(postData);
    req.end();
  });
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

  const message = `🚫 <b>Domaine bloqué</b>\n\n` +
    `<code>${domain}</code>\n\n` +
    `URL: <code>${fullUrl.substring(0, 100)}${fullUrl.length > 100 ? '...' : ''}</code>`;

  try {
    await telegramRequest('sendMessage', {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Ajouter à la whitelist', callback_data: `add:${domain}` },
          { text: '❌ Ignorer', callback_data: `ignore:${domain}` }
        ]]
      }
    });
    console.log(`[Telegram] Alert sent for: ${domain}`);
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
      }
    }
  } catch (e) {
    console.error('[Telegram] Poll error:', e.message);
  }

  // Continue polling
  setTimeout(pollUpdates, 1000);
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
  text: '🟢 <b>LooStream Alert Bot démarré</b>\n\nCommandes:\n/status - Voir le status\n/domains - Liste des domaines',
  parse_mode: 'HTML'
}).then(() => {
  console.log('[Bot] Startup message sent');
});

// Start monitoring and polling
monitorLogs();
pollUpdates();

} // End of startBot function
