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
  evalObfuscatedUrl,
  isDecoyUrl,
} from './index';

test('isDecoyUrl : rejette les mires/pubs (fsvid /troll/, vast, ads), garde le vrai flux', () => {
  assert.equal(isDecoyUrl('https://s1.fsvid.lol/troll/master.m3u8'), true);
  assert.equal(isDecoyUrl('https://x/vast.xml'), true);
  assert.equal(isDecoyUrl('https://googleads.g.doubleclick.net/x'), true);
  assert.equal(isDecoyUrl('https://cdn.example/ads/preroll.m3u8'), true);
  assert.equal(isDecoyUrl('https://s1.fsvid.lol/real/master.m3u8'), false);
  assert.equal(isDecoyUrl('https://dej02.tnmr.org/hls2/master.m3u8'), false);
});

test('EXTRACTOR_IDS et DEFAULT_EXTRACTOR_DOMAINS restent alignés', () => {
  // Pas de nombre en dur (rotait à chaque ajout d'extracteur) : les deux
  // structures doivent lister exactement les mêmes clés.
  assert.deepEqual(
    [...EXTRACTOR_IDS].sort(),
    Object.keys(DEFAULT_EXTRACTOR_DOMAINS).sort(),
  );
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

test('detectExtractorIn: route les hôtes des extracteurs locaux (v1.9)', () => {
  const cases: Array<[string, string]> = [
    ['https://luluvdo.com/e/abc', 'lulustream'],
    ['https://minochinos.com/v/x', 'filelions'],
    ['https://vidmoly.to/embed-x.html', 'vidmoly'],
    ['https://vidzy.cc/e/y', 'vidzy'],
    ['https://streamwish.to/e/z', 'streamwish'],
    ['https://dood.re/e/q', 'doodstream'],
  ];
  for (const [url, id] of cases) {
    assert.equal(detectExtractorIn(url, DEFAULT_EXTRACTOR_DOMAINS), id, url);
  }
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

test('evalObfuscatedUrl: exécute la fonction JS obfusquée (vidzy) et renvoie l’URL', () => {
  // Reproduit la forme `src:(function(s){…})("base64")` de vidzy : la fonction
  // est exécutée en sandbox avec atob, et seule une sortie http(s) est acceptée.
  const b64 = Buffer.from('https://ex.com/a.m3u8').toString('base64');
  assert.equal(
    evalObfuscatedUrl(`src:(function(s){return atob(s)})("${b64}")`),
    'https://ex.com/a.m3u8',
  );
});

test('evalObfuscatedUrl: gère une IIFE à accolades imbriquées (boucle for, type fsvid)', () => {
  // XOR clé calculée + reverse, exactement le schéma fsvid, avec un for -> accolades
  // imbriquées qui cassaient l'ancien regex non-greedy.
  const b64 = Buffer.from('https://r1.example/a.m3u8'.split('').reverse().join(''), 'binary').toString('base64');
  const js = `var _d="https://troll/master.m3u8";src:(function(s){var b=atob(s),r="";for(var i=0;i<b.length;i++){r+=b.charAt(i)}return r.split("").reverse().join("")})("${b64}")`;
  assert.equal(evalObfuscatedUrl(js), 'https://r1.example/a.m3u8');
});

test('evalObfuscatedUrl: null sans motif fonction ou si la sortie n’est pas une URL', () => {
  assert.equal(evalObfuscatedUrl('src:"https://plain.m3u8"'), null); // pas une fonction
  assert.equal(evalObfuscatedUrl('src:(function(){return "coucou"})()'), null); // non-http
});
