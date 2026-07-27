// Rendu d'affichage des streams pour Stremio EN DIRECT (name + description).
// N'affecte PAS behaviorHints.filename : AIOStreams parse le filename, pas ces
// champs. On garde donc ici toute la fantaisie (emojis, multi-lignes) sans
// risque de régression sur le parsing PTT côté meta-addons.

import { providerLabel } from './filename';

export interface DisplayMeta {
  quality: string;
  language: string;
  source: string;
  codec?: string;
  server?: string;
  platform?: string;
  sizeBytes?: number;
  subCount?: number;
}

// Tag qualité brut -> "emoji résolution". Beaucoup de sources FR ne renvoient
// que "HD" : on lui donne son propre badge plutôt qu'un faux 720p.
export function resolutionBadge(quality: string): string {
  const q = (quality || '').toLowerCase();
  if (q.includes('2160') || q.includes('4k')) return '💎 4K';
  if (q.includes('1440')) return '🔷 1440p';
  if (q.includes('1080')) return '🎬 1080p';
  if (q.includes('720')) return '📺 720p';
  if (q.includes('576')) return '📱 576p';
  if (q.includes('480')) return '📱 480p';
  if (q === 'hd') return '📺 HD';
  if (q === 'sd') return '📼 SD';
  return `🎞️ ${quality || '?'}`;
}

// Drapeau de la langue d'origine (cas "VO"), depuis TMDB originalLanguage.
const ORIGIN_FLAG: Record<string, string> = {
  en: '🇬🇧', ja: '🇯🇵', ko: '🇰🇷', zh: '🇨🇳', es: '🇪🇸', de: '🇩🇪', it: '🇮🇹',
  pt: '🇵🇹', ru: '🇷🇺', hi: '🇮🇳', th: '🇹🇭', tr: '🇹🇷', ar: '🇸🇦', fr: '🇫🇷',
};

export function languageChip(language: string, originalLanguage?: string): string {
  const l = (language || '').toUpperCase();
  if (l.includes('MULTI')) return '🌍 MULTI';
  if (l.includes('VOSTFR')) return '💬 VOSTFR';
  if (l === 'VF' || l === 'VFF' || l === 'VFQ' || l.includes('FRENCH')) return `🇫🇷 ${language}`;
  if (l === 'VO' || l.includes('ORIGINAL')) {
    const flag = ORIGIN_FLAG[(originalLanguage || '').toLowerCase()] || '🌐';
    return `${flag} VO`;
  }
  return `🗣️ ${language}`;
}

// Octets -> taille humaine décimale ("2.10 GB", "640 MB").
export function humanSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(0)} KB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

function codecChip(codec?: string): string {
  const c = (codec || '').toLowerCase();
  if (c.includes('hevc') || c.includes('265')) return 'x265';
  if (c.includes('avc') || c.includes('264')) return 'x264';
  return '';
}

// name : 2 lignes -> "{badge résolution}\n{Provider[ Platform]}"
export function buildStreamName(m: DisplayMeta): string {
  const provider = providerLabel(m.source) + (m.platform ? ` ${m.platform}` : '');
  return `${resolutionBadge(m.quality)}\n${provider}`;
}

// title : chips " · " sur plusieurs lignes. Ligne 1 = langue [· codec] [· taille].
// Ligne 2 = [serveur] [· n sous-titres]. Ligne 3 = 💾 nom de fichier (scène) si
// fourni. On saute toute ligne vide.
export function buildStreamTitle(m: DisplayMeta, originalLanguage?: string, filename?: string): string {
  const line1 = [languageChip(m.language, originalLanguage)];
  const codec = codecChip(m.codec);
  if (codec) line1.push(`🧬 ${codec}`);
  const size = m.sizeBytes ? humanSize(m.sizeBytes) : '';
  if (size) line1.push(`📊 ${size}`);

  const line2: string[] = [];
  if (m.server) line2.push(`▶️ ${m.server}`);
  if (m.subCount && m.subCount > 0) line2.push(`📝 ${m.subCount} sous-titres`);

  const lines = [line1.join(' · '), line2.join(' · ')];
  if (filename) lines.push(`💾 ${filename}`);
  return lines.filter(Boolean).join('\n');
}
