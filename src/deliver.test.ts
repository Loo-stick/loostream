import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDirectable, canDirect, PROXY_FORCED_HOSTS } from './deliver';

test('isDirectable : hôte normal OK, hôte FAI-bloqué non, URL invalide non', () => {
  assert.equal(isDirectable('https://cuyyro04xrqrh.premilkyway.com/x.m3u8'), true);
  assert.equal(isDirectable('https://dej02es2pfpm.tnmr.org/x/master.m3u8'), true);
  assert.equal(isDirectable('https://strm2.uqload.is/hls2/x.m3u8'), false); // uqload
  assert.equal(isDirectable('https://voe.sx/e/abc'), false);                // voe.sx
  assert.equal(isDirectable('pas-une-url'), false);
});

test('canDirect : directable + pas forceLocal, INDÉPENDANT du mode proxy', () => {
  const ok = 'https://a.premilkyway.com/x.m3u8';
  assert.equal(canDirect(ok, false), true);  // directable -> direct, quel que soit le mode
  assert.equal(canDirect(ok, true),  false); // NetMirror (forceLocal) -> jamais direct
  assert.equal(canDirect('https://strm2.uqload.is/x', false), false); // hôte bloqué
});

test('PROXY_FORCED_HOSTS contient au moins uqload et voe', () => {
  assert.ok(PROXY_FORCED_HOSTS.includes('uqload'));
  assert.ok(PROXY_FORCED_HOSTS.some(h => h.includes('voe')));
});
