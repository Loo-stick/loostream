#!/usr/bin/env node
/**
 * Déblocage NetMirror (pub quotidienne) — porté de la logique de loobox (dexter).
 *
 * NetMirror gate le contenu derrière un déblocage PUB QUOTIDIEN (~20s -> "valid user").
 * Sans lui: player.php renvoie {"status":"otp","usertoken":"none"} et les masters pointent
 * sur le placeholder invité /files/220884/ avec in=unknown (vidéo blanche, 10 min).
 *
 * Ce script lance Chromium (qui passe le Cloudflare de la façade), tente de déclencher la
 * lecture pour que la pub se déroule, collecte les cookies de session, VÉRIFIE qu'ils donnent
 * du contenu RÉEL (titre-sonde) et n'écrit le cookie QUE si c'est confirmé.
 *
 * Usage:  node netmirror-unlock.js [--headful] [--timeout 90]
 * Sortie: config/netmirror-cookie.json  {cookie, at, verifiedWith}
 * Exit:   0 = cookie vérifié et écrit | 1 = échec (l'ancien cookie est conservé)
 */
const fs = require('fs');
const path = require('path');

const OUT = process.env.NETMIRROR_COOKIE_FILE
  || path.join(__dirname, '..', '..', 'config', 'netmirror-cookie.json');

// Façade (redirige vers net77.cc/verify2 derrière Cloudflare). Env-overridable (rotation).
const FACADE = process.env.NETMIRROR_FACADE || 'https://net11.cc/home';
// Titre-sonde: Batman Begins (id netfree). Sert à confirmer un accès RÉEL.
const PROBE_ID = process.env.NETMIRROR_PROBE_ID || '70021642';
const API_BASE = 'https://tv.imgcdn.kim';
const APP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0 /OS.GatuNewTV v1.0';
const APP_XRW = 'NetmirrorNewTV v1.0';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const COOKIE_NAMES = new Set(['t_hash', 't_hash_t', 'hd', 'ott', 'uid', 'recentplay', 'addhash', 'df', 'l']);

const argv = process.argv.slice(2);
const HEADFUL = argv.includes('--headful');
const TIMEOUT_S = Number((argv[argv.indexOf('--timeout') + 1] || '').replace(/\D/g, '')) || 90;

const log = (...a) => console.log('[nm-unlock]', ...a);

function appHeaders(ott = 'nf', cookie = '') {
  const h = {
    'User-Agent': APP_UA,
    'X-Requested-With': APP_XRW,
    'Ott': ott,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Accept': 'application/json, text/plain, */*',
  };
  if (cookie) h['Cookie'] = cookie.includes('ott=') ? cookie : `${cookie}; ott=${ott}`;
  return h;
}

const isPlaceholder = (m) => (m || '').includes('/files/220884/') || (m || '').includes('in=unknown');
const isDegraded = (m) => {
  const s = m || '';
  if (s.includes(':///')) return true;
  return !s.includes('#EXT-X-STREAM-INF') && !s.includes('#EXTINF') && !s.includes('.ts');
};

/** Le cookie donne-t-il du contenu RÉEL ? (player.php -> master sans placeholder) */
async function hasRealAccess(cookie) {
  try {
    const p = await fetch(`${API_BASE}/newtv/player.php?id=${PROBE_ID}&t=${Math.floor(Date.now() / 1000)}`,
      { headers: appHeaders('nf', cookie) });
    const j = await p.json().catch(() => null);
    if (!j || !j.video_link) return { ok: false, why: 'pas de video_link' };
    if (j.status && j.status !== 'ok') {
      // status "otp" = déblocage pub non fait
      const m0 = await (await fetch(j.video_link, { headers: appHeaders('nf', cookie) })).text().catch(() => '');
      if (isPlaceholder(m0)) return { ok: false, why: `status=${j.status} + placeholder` };
    }
    const master = await (await fetch(j.video_link, { headers: appHeaders('nf', cookie) })).text();
    if (isPlaceholder(master)) return { ok: false, why: 'master placeholder (220884/in=unknown)' };
    if (isDegraded(master)) return { ok: false, why: 'master dégradé' };
    return { ok: true, why: 'contenu réel' };
  } catch (e) {
    return { ok: false, why: `erreur: ${e.message}` };
  }
}

function collectCookie(cookies) {
  const parts = [];
  for (const c of cookies) {
    const dom = (c.domain || '').replace(/^\./, '');
    if (dom.startsWith('net') || dom.includes('imgcdn') || COOKIE_NAMES.has(c.name)) {
      parts.push(`${c.name}=${c.value}`);
    }
  }
  return [...new Map(parts.map(p => [p.split('=')[0], p])).values()].join('; ');
}

async function main() {
  // Court-circuit: si le cookie actuel marche encore, ne rien faire (évite de lancer Chromium).
  try {
    const cur = JSON.parse(fs.readFileSync(OUT, 'utf-8'));
    if (cur.cookie) {
      const r = await hasRealAccess(cur.cookie);
      if (r.ok) { log('cookie existant toujours valide — rien à faire'); return 0; }
      log(`cookie existant invalide (${r.why}) — nouveau déblocage`);
    }
  } catch { /* pas de cookie -> on débloque */ }

  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: !HEADFUL,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  let cookie = '';
  try {
    const ctx = await browser.newContext({ userAgent: BROWSER_UA, locale: 'fr-FR', viewport: { width: 1280, height: 720 } });
    const pg = await ctx.newPage();
    log(`ouverture ${FACADE} …`);
    await pg.goto(FACADE, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_S * 1000 }).catch(e => log('goto:', e.message));
    await pg.waitForTimeout(9000); // Cloudflare + chargement app
    log('URL après CF:', pg.url());

    // Déclenche au mieux une lecture (et donc la pub). Best-effort, tolérant.
    for (const sel of ["a[href*='watch']", "a[href*='post']", '[data-id]', '.poster', '.card a', '.play', 'video']) {
      try {
        const el = await pg.$(sel);
        if (el) { log('clic sur', sel); await el.click({ timeout: 3000 }); await pg.waitForTimeout(6000); break; }
      } catch { /* suivant */ }
    }
    log('attente du déroulé de la pub (~22s) …');
    await pg.waitForTimeout(22000);
    cookie = collectCookie(await ctx.cookies());
    log('cookies collectés:', cookie ? cookie.split(';').map(s => s.trim().split('=')[0]).join(',') : '(aucun)');
  } finally {
    await browser.close();
  }

  if (!cookie) { log('ÉCHEC: aucun cookie collecté'); return 1; }
  const verdict = await hasRealAccess(cookie);
  if (!verdict.ok) { log(`ÉCHEC: cookie non validé (${verdict.why}) — rien écrit`); return 1; }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ cookie, at: new Date().toISOString(), verifiedWith: PROBE_ID }, null, 2));
  log(`✅ cookie VÉRIFIÉ et écrit -> ${OUT}`);
  return 0;
}

main().then(c => process.exit(c)).catch(e => { console.error('[nm-unlock] erreur:', e); process.exit(1); });
