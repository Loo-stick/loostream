import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { accessEnabled, keyMatches, signUrl } from './access';

const ORIG = process.env.ACCESS_KEY;
afterEach(() => {
  if (ORIG === undefined) delete process.env.ACCESS_KEY;
  else process.env.ACCESS_KEY = ORIG;
});

test('accessEnabled: false si ACCESS_KEY absente ou vide', () => {
  delete process.env.ACCESS_KEY;
  assert.equal(accessEnabled(), false);
  process.env.ACCESS_KEY = '';
  assert.equal(accessEnabled(), false);
});

test('accessEnabled: true si ACCESS_KEY renseignée', () => {
  process.env.ACCESS_KEY = 'secret';
  assert.equal(accessEnabled(), true);
});

test('keyMatches: exact', () => {
  process.env.ACCESS_KEY = 's3cr3t-key';
  assert.equal(keyMatches('s3cr3t-key'), true);
});

test('keyMatches: mauvaise clé / longueur différente / vide', () => {
  process.env.ACCESS_KEY = 's3cr3t-key';
  assert.equal(keyMatches('wrong-key!!'), false); // même longueur, contenu ≠
  assert.equal(keyMatches('court'), false);        // longueur ≠ (ne jette pas)
  assert.equal(keyMatches(''), false);
});

test('keyMatches: candidat non-string ou undefined', () => {
  process.env.ACCESS_KEY = 'secret';
  assert.equal(keyMatches(undefined), false);
  assert.equal(keyMatches(null), false);
  assert.equal(keyMatches(42), false);
  assert.equal(keyMatches(['secret']), false);
});

test('keyMatches: false quand la protection est désactivée', () => {
  delete process.env.ACCESS_KEY;
  assert.equal(keyMatches('anything'), false);
  assert.equal(keyMatches(''), false);
});

test('signUrl: ajoute &k= si activée, no-op sinon', () => {
  process.env.ACCESS_KEY = 'abc';
  assert.equal(signUrl(new URL('https://h/proxy/segment?url=x')).searchParams.get('k'), 'abc');
  delete process.env.ACCESS_KEY;
  assert.equal(signUrl(new URL('https://h/proxy/segment?url=x')).searchParams.get('k'), null);
});
