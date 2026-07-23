// Recon: que contient net77.cc/verify2 ? (boutons, cookies, textes)
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await b.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'fr-FR', viewport: { width: 1280, height: 720 },
  });
  const pg = await ctx.newPage();
  await pg.goto(process.env.NETMIRROR_FACADE || 'https://net11.cc/home', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('goto', e.message));
  await pg.waitForTimeout(12000);
  console.log('URL   :', pg.url());
  console.log('TITRE :', await pg.title());
  const info = await pg.evaluate(() => ({
    text: document.body.innerText.slice(0, 700),
    buttons: [...document.querySelectorAll('button,a,input[type=submit],[role=button]')]
      .map(e => ({ tag: e.tagName, txt: (e.innerText || e.value || '').trim().slice(0, 50), href: e.getAttribute('href') || '', id: e.id || '', cls: (e.className || '').toString().slice(0, 40) }))
      .filter(x => x.txt || x.href).slice(0, 25),
    iframes: [...document.querySelectorAll('iframe')].map(f => f.src).slice(0, 8),
  }));
  console.log('TEXTE :', JSON.stringify(info.text));
  console.log('BOUTONS/LIENS:'); info.buttons.forEach(x => console.log('  ', JSON.stringify(x)));
  console.log('IFRAMES:', JSON.stringify(info.iframes));
  console.log('COOKIES:', (await ctx.cookies()).map(c => `${c.domain}${c.name}`).join(', ') || '(aucun)');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
