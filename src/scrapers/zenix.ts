import axios from 'axios';
import { cached } from '../cache';
import { Wanted, accepts } from '../matching';
import { makeEndpointConfig } from '../endpoint-config';
import { probeMp4Quality } from '../mp4probe';

// zenix.best — catalogue FR (films + séries), **VF uniquement**.
//
// Intérêt : il relaie le catalogue de StreamFlix (chemins `series/VF/<Titre>/S01/…mp4`,
// même convention), dont NOS flux rendent 403 depuis leur passage par falzey. Zenix,
// lui, les sert. C'est donc du contenu qu'on liste aujourd'hui comme injouable — et
// c'est de la SÉRIE VF, notre point faible (dulourd étant seule).
//
// Flux (reversé le 2026-09-09) :
//   1. /ajax/search/suggest?q=<titre>  -> JSON {title, url, type: tv|movie, year}
//      L'URL porte le slug, qui n'est PAS dérivable du titre (« weeds-2 », « voyage-au-
//      centre-de-la-terre-4ature ») -> la recherche est obligatoire.
//   2. Page du contenu : /episode/<slug>/<saison>-<episode> (série) ou /movie/<slug>.
//      Elle embarque une liste JSON de ~26 serveurs, **HTML-ÉCHAPPÉE** dans un attribut
//      Alpine : {"label","type","link","provider"}. On ne garde que `provider:"fastflux"`
//      (source PROPRE à zenix, type mp4). Les ~24 autres sont des agrégateurs tiers
//      anglophones (vidsrc & co), dont deux qu'on exploite déjà (Videasy, WaveWatch).
//   3. Page du lecteur /embed/<idInterne> -> <input id="encrypted-source" value="<b64>">
//      -> atob() = /api/fastflux-mp4.php?path=…&t=<horodatage>&h=<signature>
//
// ⚠️ DEUX contraintes vérifiées, qui commandent l'architecture :
//   • Le jeton `t=`/`h=` n'est émis QUE si la requête porte les cookies de session :
//     sans cookie, l'URL sort sans jeton.
//   • Et le cookie est exigé AUSSI au téléchargement (referer seul -> 403). On ne peut
//     donc PAS rediriger le client vers le fichier : il faut relayer, cf. /zenix/stream.
//   • Le jeton périme -> la chaîne est rejouée AU MOMENT DE LA LECTURE, jamais au listing.

const siteEndpoints = makeEndpointConfig('zenix-endpoints.json', 'ZENIX_ENDPOINTS_CONFIG', {
  base: 'https://zenix.best',
});
export const reloadZenixEndpoints = siteEndpoints.reload;
export const getZenixEndpoints = siteEndpoints.get;

const BASE = () => siteEndpoints.get().base.replace(/\/+$/, '');

const STREAMS_TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const REQ_TIMEOUT_MS = 15000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'fr-FR,fr;q=0.9',
};

/** Ce qu'on annonce à Stremio : de quoi REJOUER la chaîne au play-time, pas une URL. */
export interface ZenixStream {
  slug: string;
  mediaType: 'movie' | 'series';
  se: number;
  ep: number;
  quality: string;
  language: string;   // VF (leur catalogue propre n'a pas d'autre dossier de langue)
  server: string;
}

// --- Session : les cookies portent le droit d'obtenir ET de lire ---------------

interface Session { cookie: string; }

function mergeCookies(current: string, setCookie: string[] | undefined): string {
  if (!setCookie || !setCookie.length) return current;
  const jar = new Map<string, string>();
  for (const part of current.split('; ').filter(Boolean)) {
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i), part.slice(i + 1));
  }
  for (const raw of setCookie) {
    const first = raw.split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) jar.set(first.slice(0, i).trim(), first.slice(i + 1));
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function fetchPage(url: string, sess: Session, referer?: string): Promise<string | null> {
  try {
    const { data, status, headers } = await axios.get<string>(url, {
      headers: {
        ...HEADERS,
        ...(referer ? { Referer: referer } : {}),
        ...(sess.cookie ? { Cookie: sess.cookie } : {}),
      },
      timeout: REQ_TIMEOUT_MS,
      responseType: 'text', transformResponse: v => v,
      validateStatus: () => true, maxRedirects: 4,
    });
    sess.cookie = mergeCookies(sess.cookie, headers['set-cookie'] as string[] | undefined);
    if (status < 200 || status >= 400 || typeof data !== 'string') return null;
    return data;
  } catch { return null; }
}

// --- 1. Recherche -------------------------------------------------------------

interface SuggestItem { title: string; url: string; type: string; year?: number; quality?: string; }

async function search(title: string, sess: Session): Promise<SuggestItem[]> {
  try {
    const { data, headers } = await axios.get(`${BASE()}/ajax/search/suggest?q=${encodeURIComponent(title)}`, {
      headers: {
        ...HEADERS, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest',
        Referer: `${BASE()}/`, ...(sess.cookie ? { Cookie: sess.cookie } : {}),
      },
      timeout: REQ_TIMEOUT_MS, validateStatus: () => true,
    });
    sess.cookie = mergeCookies(sess.cookie, headers['set-cookie'] as string[] | undefined);
    const posts = (data && Array.isArray(data.posts)) ? data.posts : [];
    return posts.map((p: any) => ({
      title: String(p.title || ''),
      url: String(p.url || ''),
      type: String(p.type || ''),
      year: Number(String(p.year || '').match(/\d{4}/)?.[0]) || undefined,
      quality: String(p.quality || '') || undefined,
    })).filter((p: SuggestItem) => p.title && p.url);
  } catch { return []; }
}

const slugOf = (url: string) => url.split('/').filter(Boolean).pop() || '';

/**
 * Slug déduit du titre — repli quand leur recherche ne trouve rien alors que la fiche
 * existe (vérifié sur « The Gentlemen » : /ajax/search/suggest rend 0 résultat, la page
 * /tv-show/the-gentlemen répond). On ne devine PAS les suffixes numériques de leurs
 * doublons (« weeds-2 ») : ce repli récupère les cas simples, pas tous.
 */
function guessSlug(title: string): string {
  return (title || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// --- 2. Page du contenu : la liste des serveurs (JSON HTML-échappé) -----------

/** Décode les entités HTML sans dépendance : la liste vit dans un attribut Alpine. */
function unescapeHtml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * Le lien du lecteur PROPRE à zenix. Les deux voies diffèrent selon le type :
 *  • SÉRIES : provider `fastflux` (type mp4) -> fichier MP4 direct.
 *  • FILMS  : pas d'entrée fastflux du tout ; c'est `zenix_embed` (le lecteur 4K) qui
 *    porte la source, sous forme d'un blob /embed-stream/ -> hls-proxy.php (HLS).
 * Les ~24 autres entrées sont des agrégateurs tiers : on les ignore.
 */
function ownPlayerLink(html: string): string | null {
  const h = unescapeHtml(html);
  for (const provider of ['fastflux', 'zenix_embed']) {
    const rx = new RegExp(`\\{"label":"[^"]*","type":"[^"]*","link":"([^"]+)","provider":"${provider}"\\}`);
    const m = h.match(rx);
    if (m) return m[1].replace(/\\\//g, '/');
  }
  return null;
}

// --- 3. Page du lecteur : la source encodée ----------------------------------

function b64Url(raw: string): string | null {
  try {
    const s = raw.replace(/-/g, '+').replace(/_/g, '/');
    const url = Buffer.from(s + '='.repeat((4 - s.length % 4) % 4), 'base64').toString('utf-8');
    return /^https?:\/\//.test(url) ? url : null;
  } catch { return null; }
}

/** La source du lecteur : MP4 encodé (séries) ou blob /embed-stream/ -> HLS (films). */
function decodeSource(html: string): { url: string; isHls: boolean } | null {
  const h = unescapeHtml(html);
  const mp4 = h.match(/id="encrypted-source"[^>]*value="([A-Za-z0-9+/=]+)"/)
    || h.match(/value="([A-Za-z0-9+/=]{40,})"[^>]*id="encrypted-source"/);
  if (mp4) {
    const url = b64Url(mp4[1]);
    if (url) return { url, isHls: false };
  }
  for (const m of h.matchAll(/\/embed-stream\/([A-Za-z0-9+/=_-]+)/g)) {
    const url = b64Url(m[1]);
    if (url && /hls-proxy|\.m3u8/i.test(url)) return { url, isHls: true };
  }
  return null;
}

/** URL de la page du contenu (série : page de l'épisode ; film : fiche). */
function contentUrl(slug: string, mediaType: 'movie' | 'series', se: number, ep: number): string {
  return mediaType === 'series'
    ? `${BASE()}/episode/${slug}/${se}-${ep}`
    : `${BASE()}/movie/${slug}`;
}

// --- Listing ------------------------------------------------------------------

export async function getZenixStreams(
  mediaType: 'movie' | 'series',
  title: string,
  originalTitle?: string,
  year?: number,
  season?: number,
  episode?: number,
): Promise<ZenixStream[]> {
  if (!title) return [];
  if (mediaType === 'series' && (!season || !episode)) return [];
  const key = `zenix:${mediaType}:${title.toLowerCase()}:${season || ''}:${episode || ''}`;
  return cached(
    key, STREAMS_TTL_MS,
    () => fetchZenixStreams(mediaType, title, originalTitle, year, season || 0, episode || 0),
    { scope: 'zenix', shouldCache: r => r.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );
}

async function fetchZenixStreams(
  mediaType: 'movie' | 'series',
  title: string,
  originalTitle: string | undefined,
  year: number | undefined,
  se: number,
  ep: number,
): Promise<ZenixStream[]> {
  const sess: Session = { cookie: '' };
  const titles = [...new Set([title, originalTitle].filter(Boolean) as string[])];

  // Recherche (titre FR d'abord) puis matching STRICT titre+année, filtré sur le type.
  const wantType = mediaType === 'series' ? 'tv' : 'movie';
  let items: SuggestItem[] = [];
  for (const t of titles) {
    items = (await search(t, sess)).filter(i => i.type === wantType);
    if (items.length) break;
  }
  const wanted: Wanted = { titles, year };
  const hit = items.find(i => accepts(wanted, { title: i.title, year: i.year, item: i }));
  // Repli : leur index de recherche a des trous -> slug déduit du titre. La page
  // elle-même valide (elle n'existe pas, ou n'expose pas de source propre -> 0 flux).
  const slug = hit ? slugOf(hit.url) : guessSlug(titles[0]);
  if (!hit) console.log(`[Zenix] recherche vide pour "${titles[0]}" -> essai du slug "${slug}"`);
  // On résout dès le listing — mêmes requêtes qu'avant — pour MESURER la vraie
  // résolution : leur champ `quality` ne vaut qu'un « HD » générique, inutilisable
  // pour trier. Le jeton obtenu ici n'est PAS réutilisé (il meurt en ~3 min) : la
  // lecture rejoue la chaîne. La sonde écarte au passage les flux morts.
  const resolved = await resolveZenixStream(slug, mediaType, se, ep);
  if (!resolved) {
    console.log(`[Zenix] pas de source propre pour "${titles[0]}" (${slug}${mediaType === 'series' ? ` S${se}E${ep}` : ''})`);
    return [];
  }

  const probeHeaders = {
    ...HEADERS,
    Referer: resolved.referer,
    ...(resolved.cookie ? { Cookie: resolved.cookie } : {}),
  };
  // On ne sonde QUE les séries (MP4) : leur boîte `moov` donne la vraie résolution en
  // quelques kilo-octets. Les films passent par un manifeste HLS SANS `RESOLUTION` ->
  // la sonde ne rapportait rien et coûtait ~5 s au listing, alors que zenix est en
  // dernière position du fan-out (l'early-exit boucle vers 1,5 s). Ils gardent donc le
  // libellé du site. Corollaire assumé : plus de détection de flux mort côté films.
  let quality = hit?.quality || 'HD';
  if (!resolved.isHls) {
    quality = (await probeMp4Quality(resolved.url, probeHeaders)) || quality;
  }

  console.log(`[Zenix] 1 flux ${quality} pour "${titles[0]}"${mediaType === 'series' ? ` S${se}E${ep}` : ''}`);
  return [{
    slug, mediaType, se, ep,
    quality,
    language: 'VF',   // leur catalogue propre n'expose que des chemins `.../VF/...`
    server: 'zenix',
  }];
}

// --- Résolution AU PLAY-TIME ---------------------------------------------------

/**
 * Rejoue la chaîne complète et rend {url, cookie} frais. À appeler à la lecture :
 * le jeton `t=` périme, et le cookie qui l'accompagne est exigé au téléchargement.
 */
export async function resolveZenixStream(
  slug: string, mediaType: 'movie' | 'series', se: number, ep: number,
): Promise<{ url: string; cookie: string; referer: string; isHls: boolean } | null> {
  const sess: Session = { cookie: '' };
  const pageUrl = contentUrl(slug, mediaType, se, ep);

  const page = await fetchPage(pageUrl, sess, `${BASE()}/`);
  if (!page) return null;
  const player = ownPlayerLink(page);
  if (!player) return null;

  const playerHtml = await fetchPage(player, sess, pageUrl);
  if (!playerHtml) return null;
  const src = decodeSource(playerHtml);
  if (!src) return null;

  return { url: src.url, cookie: sess.cookie, referer: player, isHls: src.isHls };
}

/** Sonde de santé : la recherche répond-elle ? */
export async function zenixProbe(): Promise<boolean> {
  return (await search('reacher', { cookie: '' })).length > 0;
}
