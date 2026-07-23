/**
 * Dépackeur P.A.C.K.E.R. (Dean Edwards) — `eval(function(p,a,c,k,e,d){…})`.
 *
 * Beaucoup d'hébergeurs (fsvid, vidzy, filemoon…) cachent l'URL du flux dans du
 * JS packé. On reproduit l'algorithme d'origine :
 *   - `p` = payload, `a` = base, `c` = compteur, `k` = dictionnaire (séparé par |)
 *   - chaque token `\b<base-a>\b` du payload est remplacé par `k[n]`
 * L'encodage des indices suit la fonction `e()` du packer : base36 pour les
 * chiffres, et au-delà de 35 un caractère via `String.fromCharCode(c + 29)`.
 */

/** Encode un entier comme le fait la fonction `e()` du packer. */
function encodeIndex(n: number, base: number): string {
  const low = n % base;
  const high = Math.floor(n / base);
  const ch = low > 35 ? String.fromCharCode(low + 29) : low.toString(36);
  return high === 0 ? ch : encodeIndex(high, base) + ch;
}

/** Isole le bloc packé d'une page HTML (du `eval(function(p,a,c,k,e,d)` au `</script>`). */
export function findPackedBlock(html: string): string | null {
  const start = html.indexOf('eval(function(p,a,c,k,e,d)');
  if (start === -1) return null;
  const end = html.indexOf('</script>', start);
  return html.slice(start, end === -1 ? undefined : end);
}

/**
 * Dépacke un bloc `eval(function(p,a,c,k,e,d){…}('payload',base,count,'k1|k2'.split('|'),0,{}))`.
 * Renvoie le JS déobfusqué, ou null si le bloc n'a pas la forme attendue.
 */
export function unpack(packed: string): string | null {
  // Les quotes du payload peuvent être ' ou " ; le payload contient des \' échappés.
  const m = packed.match(
    /\}\s*\(\s*(['"])([\s\S]*?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])([\s\S]*?)\5\s*\.\s*split\(\s*(['"])\|\7\s*\)/
  );
  if (!m) return null;

  let payload = m[2];
  const base = parseInt(m[3], 10);
  const count = parseInt(m[4], 10);
  const keywords = m[6].split('|');
  if (!base || !Number.isFinite(count)) return null;

  // Le payload est une chaîne JS : on rétablit les échappements courants.
  payload = payload.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');

  let out = payload;
  for (let i = count - 1; i >= 0; i--) {
    const word = keywords[i];
    if (!word) continue; // token non substitué = laissé tel quel (comportement du packer)
    const token = encodeIndex(i, base);
    out = out.replace(new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), word);
  }
  return out;
}

/** Raccourci : HTML -> JS dépacké (null si pas de bloc packé ou échec). */
export function unpackFromHtml(html: string): string | null {
  const block = findPackedBlock(html);
  return block ? unpack(block) : null;
}

/**
 * Cherche l'URL du flux dans du JS dépacké. Ordre repris de l'app Onyx
 * (FsvidExtractor) : src -> file -> sources[0] -> première URL .m3u8.
 */
export function findStreamUrl(js: string): string | null {
  const patterns = [
    /src\s*:\s*["']([^"']+)["']/,
    /file\s*:\s*["']([^"']+)["']/,
    /sources\s*:\s*\[\s*["']([^"']+)["']/,
    /(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/,
  ];
  for (const re of patterns) {
    const m = js.match(re);
    if (m && /^https?:\/\//i.test(m[1])) return m[1];
  }
  return null;
}
