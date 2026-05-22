// Helpers purs pour l'ajout assisté de domaines d'extracteurs. Aucun effet de bord.

// Tokens de label (minuscules) -> extracteur. Premier match gagne.
const LABEL_TO_EXTRACTOR = [
  { tokens: ['vidara', 'voe'], extractor: 'voe' },
  { tokens: ['uqload'], extractor: 'uqload' },
  { tokens: ['vmoly', 'vidmoly', 'molystream', 'vidhide'], extractor: 'vidmoly' },
  { tokens: ['filelions', 'lions'], extractor: 'filelions' },
  { tokens: ['swish', 'streamwish', 'wish'], extractor: 'streamwish' },
  { tokens: ['lulu'], extractor: 'lulustream' },
  { tokens: ['dood', 'ddstream'], extractor: 'doodstream' },
  { tokens: ['vidoza'], extractor: 'vidoza' },
  { tokens: ['filemoon', 'moon'], extractor: 'filemoon' },
  { tokens: ['streamtape', 'tape'], extractor: 'streamtape' },
  { tokens: ['mixdrop', 'mdrop'], extractor: 'mixdrop' },
  { tokens: ['sharecloudy', 'cloudy'], extractor: 'sharecloudy' },
];

/** Déduit l'extracteur depuis un label serveur. null si inconnu/générique. */
function deduceExtractor(label) {
  if (!label || typeof label !== 'string') return null;
  const norm = label.toLowerCase();
  for (const entry of LABEL_TO_EXTRACTOR) {
    if (entry.tokens.some(t => norm.includes(t))) return entry.extractor;
  }
  return null;
}

const LOG_RE = /\[(Flemmix|Movix)\] Unrecognized host: (\S+) \(server="([^"]*)", title="([^"]*)"\)/;

/** Parse une ligne de log "Unrecognized host". null si non concernée. */
function parseUnrecognizedHostLine(line) {
  const m = line.match(LOG_RE);
  if (!m) return null;
  return { scraper: m[1], host: m[2], server: m[3], title: m[4] };
}

/**
 * Ajoute un domaine au tableau d'un extracteur dans un objet de config.
 * Renvoie { config: <nouvel objet>, added: boolean }. Ne mute pas l'entrée.
 */
function addDomainToExtractorConfig(config, extractor, domain) {
  const next = (config && typeof config === 'object') ? { ...config } : {};
  const list = Array.isArray(next[extractor]) ? next[extractor].slice() : [];
  if (list.includes(domain)) {
    return { config: next, added: false };
  }
  list.push(domain);
  next[extractor] = list;
  next.lastUpdatedAt = new Date().toISOString();
  return { config: next, added: true };
}

module.exports = { deduceExtractor, parseUnrecognizedHostLine, addDomainToExtractorConfig };
