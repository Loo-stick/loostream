import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeTarget } from './multiaudio';

test('probeTarget: URL MediaFlow -> sonde le CDN brut (?d=) avec son Referer', () => {
  const raw = 'https://cdn.example/master.m3u8?token=abc';
  const ref = 'https://src.example/';
  const mf = 'https://mf.example/proxy/hls/manifest.m3u8'
    + `?d=${encodeURIComponent(raw)}&h_referer=${encodeURIComponent(ref)}&api_password=x`;
  const t = probeTarget(mf);
  assert.equal(t.viaMediaFlow, true);
  assert.equal(t.url, raw);                 // searchParams décode le ?d=
  assert.deepEqual(t.headers, { Referer: ref });
});

test('probeTarget: URL brute (mode local) sondée telle quelle', () => {
  const raw = 'https://cdn.example/master.m3u8';
  const headers = { Referer: 'https://origin/' };
  const t = probeTarget(raw, headers);
  assert.equal(t.viaMediaFlow, false);
  assert.equal(t.url, raw);
  assert.deepEqual(t.headers, headers);     // headers d'origine conservés
});

test('probeTarget: ?d= non-http ignoré (pas un flux MediaFlow)', () => {
  const url = 'https://cdn.example/x.m3u8?d=42';
  const t = probeTarget(url);
  assert.equal(t.viaMediaFlow, false);
  assert.equal(t.url, url);
});
