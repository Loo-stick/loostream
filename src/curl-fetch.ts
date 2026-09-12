import { execFile } from 'child_process';

// Transport HTTP délégué à curl.
//
// Pourquoi : depuis le 2026-09-12, Cloudflare rend un défi « Just a moment » (HTTP 403)
// à TOUTE requête Node vers naka.cx — claim, recherche, lecture, jusqu'à la page
// d'accueil. Mesuré sous tous les angles : curl passe, Node échoue, depuis l'hôte comme
// depuis le conteneur, avec les mêmes en-têtes et la même IP. C'est donc l'empreinte du
// client TLS qui est jugée, et ni l'ordre des chiffrements ni les courbes à la Chrome
// n'y changent quoi que ce soit (testé).
//
// FlareSolverr (déjà présent sur l'hôte) franchit aussi le mur, mais il IGNORE les
// en-têtes personnalisés : il sait faire le pairing (POST sans auth) mais jamais la
// recherche ni la lecture, qui exigent un `Authorization: Bearer`. curl fait les deux.
//
// ⚠️ C'est un contournement d'empreinte : si Cloudflare durcit encore, il tombera.
// Réservé aux sources qui n'ont pas d'autre voie (aujourd'hui : nkstrm seul).

export interface CurlResponse {
  status: number;      // 0 = échec réseau / curl indisponible
  body: string;
}

export interface CurlOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BUFFER = 8 * 1024 * 1024;   // les réponses de recherche peuvent être volumineuses

// ⚠️ Un User-Agent de NAVIGATEUR est obligatoire : sans lui curl s'annonce « curl/8.x »
// et Cloudflare le bloque exactement comme Node (vérifié — c'est ce qui m'a fait croire
// un instant que le transport ne servait à rien). L'appelant peut le remplacer.
const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
};

/**
 * Exécute curl et rend {status, body}. Les arguments passent par un TABLEAU (execFile,
 * pas de shell) : aucune interpolation, donc aucune injection possible via une URL ou
 * un en-tête. Le code HTTP est récupéré via `-w` et séparé du corps sur la dernière ligne.
 */
export function curlFetch(url: string, opts: CurlOptions = {}): Promise<CurlResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = [
    '-s',                                  // pas de barre de progression
    '--compressed',
    '--max-time', String(Math.ceil(timeoutMs / 1000)),
    '-w', '\n%{http_code}',                // code HTTP en dernière ligne
  ];
  const headers = { ...DEFAULT_HEADERS, ...(opts.headers || {}) };
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (opts.method === 'POST') {
    args.push('-X', 'POST');
    if (opts.body !== undefined) args.push('--data-binary', opts.body);
  }
  args.push(url);

  return new Promise<CurlResponse>(resolve => {
    execFile('curl', args, { timeout: timeoutMs + 2000, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
      (err, stdout) => {
        if (err && !stdout) {
          // curl absent de l'image, timeout, ou échec réseau : status 0, comme axios côté appelant.
          console.log(`[curl] échec (${(err as any).code || err.message}) sur ${url.slice(0, 80)}`);
          resolve({ status: 0, body: '' });
          return;
        }
        const out = String(stdout || '');
        const cut = out.lastIndexOf('\n');
        const status = Number(out.slice(cut + 1).trim()) || 0;
        resolve({ status, body: cut >= 0 ? out.slice(0, cut) : '' });
      });
  });
}

/** Idem, mais parse le JSON. `data` vaut null si le corps n'est pas du JSON (page HTML…). */
export async function curlJson<T = any>(url: string, opts: CurlOptions = {}): Promise<{ status: number; data: T | null; body: string }> {
  const r = await curlFetch(url, opts);
  let data: T | null = null;
  try {
    const parsed = JSON.parse(r.body);
    if (parsed && typeof parsed === 'object') data = parsed as T;
  } catch { /* corps non-JSON -> data null, l'appelant décide */ }
  return { status: r.status, data, body: r.body };
}

/**
 * Un interstitiel Cloudflare plutôt qu'une réponse applicative.
 *
 * ⚠️ Le statut est EXIGÉ : `challenge-platform` apparaît aussi dans les pages 200
 * légitimes (Cloudflare y injecte sa détection JS passive), donc le seul corps donne
 * des faux positifs. Un vrai blocage se présente en 403/503 avec « Just a moment ».
 */
export function isCloudflareChallenge(body: string, status: number): boolean {
  if (status < 400) return false;
  return /Just a moment|cf-browser-verification|challenge-platform/i.test(body);
}
