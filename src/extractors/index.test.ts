import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import {
  DEFAULT_EXTRACTOR_DOMAINS,
  EXTRACTOR_IDS,
  mergeExtractorDomains,
  detectExtractorIn,
  loadExtractorDomains,
  getExtractorDomains,
  detectExtractor,
} from './index';

test('EXTRACTOR_IDS contient les 12 extracteurs', () => {
  assert.equal(EXTRACTOR_IDS.length, 12);
});

test('mergeExtractorDomains: objet complet valide utilisé tel quel', () => {
  const input = { ...DEFAULT_EXTRACTOR_DOMAINS, voe: ['custom-voe.test'] };
  const merged = mergeExtractorDomains(input);
  assert.deepEqual(merged.voe, ['custom-voe.test']);
  assert.deepEqual(merged.uqload, DEFAULT_EXTRACTOR_DOMAINS.uqload);
});

test('mergeExtractorDomains: clé absente retombe sur le défaut', () => {
  const merged = mergeExtractorDomains({ voe: ['x.test'] });
  assert.deepEqual(merged.voe, ['x.test']);
  assert.deepEqual(merged.doodstream, DEFAULT_EXTRACTOR_DOMAINS.doodstream);
});

test('mergeExtractorDomains: entrée non-objet renvoie tous les défauts', () => {
  for (const bad of [null, undefined, 42, 'str', []]) {
    assert.deepEqual(mergeExtractorDomains(bad), DEFAULT_EXTRACTOR_DOMAINS);
  }
});

test('mergeExtractorDomains: valeur non-tableau retombe sur le défaut', () => {
  const merged = mergeExtractorDomains({ voe: 'not-an-array' });
  assert.deepEqual(merged.voe, DEFAULT_EXTRACTOR_DOMAINS.voe);
});

test('mergeExtractorDomains: tableau avec non-strings retombe sur le défaut', () => {
  const merged = mergeExtractorDomains({ voe: ['ok', 123] });
  assert.deepEqual(merged.voe, DEFAULT_EXTRACTOR_DOMAINS.voe);
});

test('mergeExtractorDomains: clés inconnues ignorées', () => {
  const merged = mergeExtractorDomains({ bogus: ['x'], voe: ['v.test'] });
  assert.equal('bogus' in merged, false);
  assert.deepEqual(merged.voe, ['v.test']);
});

test('detectExtractorIn: reconnaît un domaine voe connu', () => {
  assert.equal(
    detectExtractorIn('https://vidara.to/e/abc', DEFAULT_EXTRACTOR_DOMAINS),
    'voe',
  );
});

test('detectExtractorIn: hôte inconnu renvoie null', () => {
  assert.equal(
    detectExtractorIn('https://kathyinformationwhether.com/e/x', DEFAULT_EXTRACTOR_DOMAINS),
    null,
  );
});

test('detectExtractorIn: URL invalide renvoie null', () => {
  assert.equal(detectExtractorIn('pas une url', DEFAULT_EXTRACTOR_DOMAINS), null);
});

test('detectExtractorIn: respecte un domaine ajouté', () => {
  const domains = {
    ...DEFAULT_EXTRACTOR_DOMAINS,
    voe: [...DEFAULT_EXTRACTOR_DOMAINS.voe, 'kathyinformationwhether.com'],
  };
  assert.equal(
    detectExtractorIn('https://kathyinformationwhether.com/e/x', domains),
    'voe',
  );
});

function writeFixture(content: string): string {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'exd-'));
  const file = nodePath.join(dir, 'extractor-domains.json');
  fs.writeFileSync(file, content);
  return file;
}

test('loadExtractorDomains: lit un fichier valide', () => {
  const file = writeFixture(JSON.stringify({ voe: ['fixture-voe.test'] }));
  loadExtractorDomains(file);
  assert.deepEqual(getExtractorDomains().voe, ['fixture-voe.test']);
  assert.deepEqual(getExtractorDomains().uqload, DEFAULT_EXTRACTOR_DOMAINS.uqload);
});

test('loadExtractorDomains: JSON malformé retombe sur les défauts', () => {
  const file = writeFixture('{ ceci n est pas du json');
  loadExtractorDomains(file);
  assert.deepEqual(getExtractorDomains(), DEFAULT_EXTRACTOR_DOMAINS);
});

test('loadExtractorDomains: fichier absent retombe sur les défauts', () => {
  loadExtractorDomains('/chemin/inexistant/extractor-domains.json');
  assert.deepEqual(getExtractorDomains(), DEFAULT_EXTRACTOR_DOMAINS);
});

test('detectExtractor: utilise le jeu de domaines chargé', () => {
  const file = writeFixture(JSON.stringify({
    ...DEFAULT_EXTRACTOR_DOMAINS,
    voe: [...DEFAULT_EXTRACTOR_DOMAINS.voe, 'kathyinformationwhether.com'],
  }));
  loadExtractorDomains(file);
  assert.equal(detectExtractor('https://kathyinformationwhether.com/e/x'), 'voe');
});
