import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Comptes admin SUPPLÉMENTAIRES (en plus du root env ADMIN_USER/ADMIN_PASS).
// Permet à l'exploitant d'une instance de créer des comptes perso pour des proches
// sans partager le mot de passe root. Stockés dans config/admins.json (bind-mount
// docker -> survit aux rebuilds). Mots de passe HASHÉS (scrypt + sel), jamais en clair.
//
// Le root (env) n'est PAS dans ce fichier : il reste toujours valide et non
// supprimable -> pas de verrouillage possible de l'instance.

export interface AdminAccount {
  user: string;
  salt: string;       // hex
  hash: string;       // hex (scrypt)
  createdAt: number;
  createdBy: string;  // user qui a créé ce compte
}

const filePath = process.env.ADMINS_CONFIG ||
  (fs.existsSync('/app/config/admins.json')
    ? '/app/config/admins.json'
    : path.join(process.cwd(), 'config', 'admins.json'));

const SCRYPT_KEYLEN = 64;
const USER_RE = /^[a-zA-Z0-9_.-]{2,32}$/;
const MIN_PASS_LEN = 8;

function load(): AdminAccount[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return Array.isArray(raw) ? raw.filter(a => a && a.user && a.salt && a.hash) : [];
  } catch {
    return [];
  }
}

function save(list: AdminAccount[]): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // 0600 : les hashes/sels ne doivent pas être lisibles par d'autres comptes du système.
  fs.writeFileSync(filePath, JSON.stringify(list, null, 2), { mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort (FS sans perms POSIX) */ }
}

// Sel+hash « leurre » stable (coût scrypt identique à un vrai hash) : on le vérifie
// quand le compte n'existe pas pour que le temps de réponse soit constant -> pas
// d'énumération des identifiants valides au chronomètre.
const DUMMY_SALT = '00000000000000000000000000000000';
const DUMMY_HASH = crypto.scryptSync('x', DUMMY_SALT, SCRYPT_KEYLEN).toString('hex');

function hashPassword(pass: string, salt?: string): { salt: string; hash: string } {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pass, s, SCRYPT_KEYLEN).toString('hex');
  return { salt: s, hash };
}

/** Compare en temps constant (jette jamais sur longueurs différentes). */
function hashMatches(pass: string, salt: string, expectedHex: string): boolean {
  const computed = crypto.scryptSync(pass, salt, SCRYPT_KEYLEN);
  let expected: Buffer;
  try { expected = Buffer.from(expectedHex, 'hex'); } catch { return false; }
  if (expected.length !== computed.length) return false;
  return crypto.timingSafeEqual(computed, expected);
}

/** Le nom est-il celui du root env ? (insensible à la casse pour éviter les collisions trompeuses) */
export function isRootUser(user: string): boolean {
  const root = process.env.ADMIN_USER;
  return !!root && user.toLowerCase() === root.toLowerCase();
}

/** Vérifie un couple (user, pass) contre les comptes du fichier (PAS le root env).
 * Temps constant : si le compte n'existe pas, on vérifie quand même contre un
 * hash leurre -> aucune fuite de timing révélant les identifiants valides. */
export function verifyFileAdmin(user: string, pass: string): boolean {
  const acc = load().find(a => a.user.toLowerCase() === (user || '').toLowerCase());
  if (!acc) {
    hashMatches(pass || '', DUMMY_SALT, DUMMY_HASH); // leurre : même coût CPU
    return false;
  }
  return hashMatches(pass || '', acc.salt, acc.hash);
}

/** Liste des comptes (sans secrets), pour l'admin. */
export function listAdmins(): { user: string; createdAt: number; createdBy: string }[] {
  return load()
    .map(a => ({ user: a.user, createdAt: a.createdAt, createdBy: a.createdBy }))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export interface AdminOpResult { ok: boolean; error?: string }

export function addAdmin(user: string, pass: string, createdBy: string): AdminOpResult {
  user = (user || '').trim();
  if (!USER_RE.test(user)) return { ok: false, error: 'Identifiant invalide (2-32 car. : lettres, chiffres, . _ -)' };
  if ((pass || '').length < MIN_PASS_LEN) return { ok: false, error: `Mot de passe trop court (min ${MIN_PASS_LEN} caractères)` };
  if (isRootUser(user)) return { ok: false, error: 'Ce nom est réservé au compte racine' };
  const list = load();
  if (list.some(a => a.user.toLowerCase() === user.toLowerCase())) return { ok: false, error: 'Ce compte existe déjà' };
  const { salt, hash } = hashPassword(pass);
  list.push({ user, salt, hash, createdAt: Date.now(), createdBy: createdBy || '?' });
  save(list);
  return { ok: true };
}

export function removeAdmin(user: string): AdminOpResult {
  user = (user || '').trim();
  if (isRootUser(user)) return { ok: false, error: 'Le compte racine ne peut pas être supprimé' };
  const list = load();
  const next = list.filter(a => a.user.toLowerCase() !== user.toLowerCase());
  if (next.length === list.length) return { ok: false, error: 'Compte introuvable' };
  save(next);
  return { ok: true };
}

export function setAdminPassword(user: string, pass: string): AdminOpResult {
  user = (user || '').trim();
  if ((pass || '').length < MIN_PASS_LEN) return { ok: false, error: `Mot de passe trop court (min ${MIN_PASS_LEN} caractères)` };
  if (isRootUser(user)) return { ok: false, error: 'Le mot de passe racine se change dans le .env' };
  const list = load();
  const acc = list.find(a => a.user.toLowerCase() === user.toLowerCase());
  if (!acc) return { ok: false, error: 'Compte introuvable' };
  const { salt, hash } = hashPassword(pass);
  acc.salt = salt; acc.hash = hash;
  save(list);
  return { ok: true };
}
