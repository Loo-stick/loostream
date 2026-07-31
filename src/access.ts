import { timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

// Clé d'accès OPTIONNELLE. `ACCESS_KEY` vide/absente => l'addon reste en libre
// accès (comportement historique). Renseignée => tout le périmètre streaming
// exige la clé (dans le config base64 pour les routes /:config/*, en query `?k=`
// pour les URLs auto-générées appelées directement par le player).

/** La clé configurée, ou undefined si la protection est désactivée. */
export function accessKey(): string | undefined {
  const k = process.env.ACCESS_KEY;
  return k && k.length > 0 ? k : undefined;
}

/** true si une clé d'accès est configurée (protection active). */
export function accessEnabled(): boolean {
  return accessKey() !== undefined;
}

/**
 * Compare un candidat à la clé configurée en temps constant. Renvoie false si
 * la protection est désactivée, si le candidat n'est pas une string, ou si les
 * longueurs diffèrent (timingSafeEqual jette sinon). Les appelants vérifient
 * toujours accessEnabled() d'abord — ce false défensif ferme la porte au cas où.
 */
export function keyMatches(candidate: unknown): boolean {
  const key = accessKey();
  if (!key || typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(key);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Ajoute `&k=<clé>` à une URL auto-générée (proxy, netmirror, moviebox…) quand
 * la protection est active. No-op sinon. Renvoie l'URL pour chaînage.
 */
export function signUrl(u: URL): URL {
  const key = accessKey();
  if (key) u.searchParams.set('k', key);
  return u;
}

/**
 * Middleware Express pour les routes auto-générées (proxy/netmirror/moviebox/
 * nabistream) : exige `?k=<clé>` valide quand la protection est active. 403 sinon.
 */
export function requireQueryKey(req: Request, res: Response, next: NextFunction): void {
  if (accessEnabled() && !keyMatches(req.query.k)) {
    res.status(403).send("Forbidden: clé d'accès requise ou invalide");
    return;
  }
  next();
}
