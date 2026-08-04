import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDirectable, directDecision, PROXY_FORCED_HOSTS } from './deliver';

test('isDirectable : hôte normal OK, hôte FAI-bloqué non, URL invalide non', () => {
  assert.equal(isDirectable('https://cuyyro04xrqrh.premilkyway.com/x.m3u8'), true);
  assert.equal(isDirectable('https://dej02es2pfpm.tnmr.org/x/master.m3u8'), true);
  assert.equal(isDirectable('https://strm2.uqload.is/hls2/x.m3u8'), false); // uqload
  assert.equal(isDirectable('https://voe.sx/e/abc'), false);                // voe.sx
  assert.equal(isDirectable('pas-une-url'), false);
});

test('directDecision : direct seulement si mode direct + directable + pas forceLocal', () => {
  const ok = 'https://a.premilkyway.com/x.m3u8';
  assert.equal(directDecision(ok, false, 'direct'), true);
  assert.equal(directDecision(ok, true,  'direct'), false); // NetMirror (forceLocal)
  assert.equal(directDecision('https://strm2.uqload.is/x', false, 'direct'), false); // bloqué
  assert.equal(directDecision(ok, false, 'local'), false);   // pas le mode direct
  assert.equal(directDecision(ok, false, 'mediaflow'), false);
  assert.equal(directDecision(ok, false, undefined), false);
});

test('PROXY_FORCED_HOSTS contient au moins uqload et voe', () => {
  assert.ok(PROXY_FORCED_HOSTS.includes('uqload'));
  assert.ok(PROXY_FORCED_HOSTS.some(h => h.includes('voe')));
});
