import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeTokens, titlesMatch, yearVerdict, accepts, pickBest } from './matching';

test('normalizeTokens : accents, articles, tags de version et année retirés', () => {
  assert.deepEqual(normalizeTokens('Le Fabuleux Destin (2001)'), ['fabuleux', 'destin']);
  assert.deepEqual(normalizeTokens('Happy End VOSTFR'), ['happy', 'end']);
});

test('titlesMatch : égalité de token-set, pas de sous-chaîne', () => {
  assert.equal(titlesMatch(['Happy End'], 'Happy End'), true);
  assert.equal(titlesMatch(['Happy End'], 'My Happy Ending'), false); // le bug d'origine
  assert.equal(titlesMatch(['Happy End'], 'Happy End 2'), false);      // sequel distinct
  assert.equal(titlesMatch(['Projet Dernière Chance', 'Project Hail Mary'], 'Project Hail Mary'), true);
});

test('yearVerdict : exact / close(±1) / unknown / mismatch', () => {
  assert.equal(yearVerdict(1999, 1999), 'exact');
  assert.equal(yearVerdict(1999, 2000), 'close');
  assert.equal(yearVerdict(1999, undefined), 'unknown');
  assert.equal(yearVerdict(1999, 2023), 'mismatch');
});

test('accepts : rejette mauvais titre ET mauvaise année, garde titre exact sans année', () => {
  const w = { titles: ['Happy End'], year: 1999 };
  assert.equal(accepts(w, { title: 'My Happy Ending', year: 2023, item: 1 }), false);
  assert.equal(accepts(w, { title: 'Happy End', year: 2017, item: 2 }), false); // même titre, autre année
  assert.equal(accepts(w, { title: 'Happy End', year: 1999, item: 3 }), true);
  assert.equal(accepts(w, { title: 'Happy End', year: undefined, item: 4 }), true); // année inconnue OK
});

test('pickBest : année exacte préférée', () => {
  const w = { titles: ['Happy End'], year: 1999 };
  const best = pickBest(w, [
    { title: 'Happy End', year: undefined, item: 'unknown' },
    { title: 'Happy End', year: 2000, item: 'close' },
    { title: 'Happy End', year: 1999, item: 'exact' },
  ]);
  assert.equal(best?.item, 'exact');
});
