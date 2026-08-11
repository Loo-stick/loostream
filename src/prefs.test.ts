import { test } from 'node:test';
import assert from 'node:assert';
import { passesPreferences, normalizeQuality, normalizeLanguage, compareStreams, QUALITY_SCORES, isUnknownQuality } from './prefs';

const LANGS = ['MULTI', 'VF', 'VOSTFR']; // VO décoché

test('régression v1.12.0 : un VF basse-déf n’est PLUS filtré par la qualité', () => {
  // Avant le fix : 480p (score 1) < seuil 720p (2) → jeté à tort.
  assert.equal(passesPreferences({ quality: '480p', language: 'VF', source: 'coflix' }, LANGS), true);
  assert.equal(passesPreferences({ quality: '360p', language: 'VF', source: 'movix' }, LANGS), true);
  assert.equal(passesPreferences({ quality: '1080p', language: 'VF', source: 'movix' }, LANGS), true);
});

test('le filtre de LANGUE reste actif : VO décoché → rejeté', () => {
  assert.equal(passesPreferences({ quality: '1080p', language: 'VO', source: 'videasy' }, LANGS), false);
  assert.equal(passesPreferences({ quality: 'VOSTFR', language: 'VOSTFR', source: 'nabistream' }, LANGS), true);
});

test('NetMirror reste exempté du filtre de LANGUE (multi-audio VF+VO)', () => {
  // Une seule langue cochée (VF) : NetMirror MULTI/VO passe quand même (il contient la VF).
  assert.equal(passesPreferences({ quality: 'HD', language: 'VO', source: 'netmirror' }, ['VF']), true);
  assert.equal(passesPreferences({ quality: '720p', language: 'MULTI', source: 'netmirror' }, ['VF']), true);
});

test('exclusion qualité : 4K/360p exclus → rejetés (par qualité normalisée) ; autres OK', () => {
  const ex = ['4K', '360p'];
  assert.equal(passesPreferences({ quality: '4K', language: 'VF', source: 'movix' }, LANGS, ex), false);
  assert.equal(passesPreferences({ quality: '2160p', language: 'VF', source: 'movix' }, LANGS, ex), false); // normalise -> 4K
  assert.equal(passesPreferences({ quality: '360p', language: 'VF', source: 'movix' }, LANGS, ex), false);
  assert.equal(passesPreferences({ quality: '1080p', language: 'VF', source: 'movix' }, LANGS, ex), true);
});

test('exclusion qualité : NetMirror y est SOUMIS (une entrée par qualité désormais)', () => {
  // Depuis qu'on émet une entrée NetMirror par résolution, l'exclusion s'applique à chacune :
  // exclure 1080p retire l'entrée 1080p mais garde 720p/480p.
  assert.equal(passesPreferences({ quality: '1080p', language: 'MULTI', source: 'netmirror' }, LANGS, ['1080p']), false);
  assert.equal(passesPreferences({ quality: '720p', language: 'MULTI', source: 'netmirror' }, LANGS, ['1080p']), true);
  assert.equal(passesPreferences({ quality: '480p', language: 'MULTI', source: 'netmirror' }, LANGS, ['1080p']), true);
});

test('exclusion qualité : « HD »/inconnu N’EST PAS exclu par une résolution mesurée', () => {
  // Exclure 1080p ne doit PAS amputer les sources en repli « HD » (résolution non mesurée).
  assert.equal(passesPreferences({ quality: 'HD', language: 'VF', source: 'movix' }, LANGS, ['1080p']), true);
  assert.equal(passesPreferences({ quality: '', language: 'VF', source: 'coflix' }, LANGS, ['1080p', '720p']), true);
});

test('exclusion qualité : token « unknown » → les sources « HD »/inconnu sont exclues', () => {
  assert.equal(passesPreferences({ quality: 'HD', language: 'VF', source: 'movix' }, LANGS, ['unknown']), false);
  assert.equal(passesPreferences({ quality: '', language: 'VF', source: 'coflix' }, LANGS, ['unknown']), false);
  // « unknown » ne touche PAS les résolutions mesurées.
  assert.equal(passesPreferences({ quality: '1080p', language: 'VF', source: 'movix' }, LANGS, ['unknown']), true);
  // Combiné : exclure 1080p + unknown retire les deux.
  assert.equal(passesPreferences({ quality: 'HD', language: 'VF', source: 'movix' }, LANGS, ['1080p', 'unknown']), false);
  assert.equal(passesPreferences({ quality: '720p', language: 'VF', source: 'movix' }, LANGS, ['1080p', 'unknown']), true);
});

test('isUnknownQuality : « HD »/vide oui ; résolutions mesurées non', () => {
  assert.equal(isUnknownQuality('HD'), true);
  assert.equal(isUnknownQuality(''), true);
  assert.equal(isUnknownQuality('FHD'), true);
  assert.equal(isUnknownQuality('1080p'), false);
  assert.equal(isUnknownQuality('720p'), false);
  assert.equal(isUnknownQuality('4K'), false);
});

test('exclusion qualité : sans liste → aucun effet (rétro-compat)', () => {
  assert.equal(passesPreferences({ quality: '4K', language: 'VF', source: 'movix' }, LANGS), true);
});

test('normalisation : HD → 1080p (repli), 480p → 480p, VF reconnu', () => {
  assert.equal(normalizeQuality('HD'), '1080p');
  assert.equal(normalizeQuality('480p'), '480p');
  assert.equal(normalizeLanguage('VF'), 'VF');
});

// Tri : langue-d'abord vs qualité-d'abord. langOrder [MULTI,VOSTFR,VF,VO], pref 4K.
const ORDER = ['MULTI', 'VOSTFR', 'VF', 'VO'];
const PREF4K = QUALITY_SCORES['4K']; // 4
const vf4k = { quality: '4K', language: 'VF' };
const multi1080 = { quality: '1080p', language: 'MULTI' };

test('sortBy language : la MULTI passe devant la VF 4K (langue prime)', () => {
  const c = compareStreams(vf4k, multi1080, { langOrder: ORDER, prefQualityScore: PREF4K, sortBy: 'language' });
  assert.ok(c > 0, 'VF 4K doit être APRÈS MULTI 1080p'); // >0 => vf4k après multi1080
});

test('sortBy quality : la VF 4K remonte devant la MULTI 1080p (qualité prime)', () => {
  const c = compareStreams(vf4k, multi1080, { langOrder: ORDER, prefQualityScore: PREF4K, sortBy: 'quality' });
  assert.ok(c < 0, 'VF 4K doit être AVANT MULTI 1080p'); // <0 => vf4k avant multi1080
});

test('sortBy quality : à qualité égale, la langue départage', () => {
  const vf1080 = { quality: '1080p', language: 'VF' };
  const c = compareStreams(multi1080, vf1080, { langOrder: ORDER, prefQualityScore: PREF4K, sortBy: 'quality' });
  assert.ok(c < 0, 'à 1080p égal, MULTI (rang 0) avant VF (rang 2)');
});
