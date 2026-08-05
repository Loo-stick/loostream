import { test } from 'node:test';
import assert from 'node:assert';
import { passesPreferences, normalizeQuality, normalizeLanguage } from './prefs';

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

test('NetMirror reste exempté (multi-langue)', () => {
  assert.equal(passesPreferences({ quality: 'HD', language: 'VO', source: 'netmirror' }, LANGS), true);
});

test('normalisation : HD → 1080p (repli), 480p → 480p, VF reconnu', () => {
  assert.equal(normalizeQuality('HD'), '1080p');
  assert.equal(normalizeQuality('480p'), '480p');
  assert.equal(normalizeLanguage('VF'), 'VF');
});
