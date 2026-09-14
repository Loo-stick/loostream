import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeTarget, resLabel, effectiveHeight } from './multiaudio';

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

test('resLabel: format cinémascope classé par sa LARGEUR (bandes noires retirées)', () => {
  assert.equal(resLabel(960, 1920), '1080p');   // Mutiny seekstreaming : était « 720p »
  assert.equal(resLabel(640, 1280), '720p');    // Mutiny VF : était « 576p »
  assert.equal(resLabel(1600, 3840), '4K');
  assert.equal(resLabel(800, 1920), '1080p');   // 2.40:1
});

test('resLabel: 16:9 standard et hauteur seule inchangés', () => {
  assert.equal(resLabel(720, 1280), '720p');
  assert.equal(resLabel(1080, 1920), '1080p');
  assert.equal(resLabel(406, 720), '480p');     // petit WEBRIP
  assert.equal(resLabel(960), '720p');          // sans largeur : comportement d'avant
  assert.equal(resLabel(150, 0), null);
});

test('effectiveHeight: jamais en dessous de la hauteur réelle', () => {
  assert.equal(effectiveHeight(1080, 1440), 1080); // 4:3 : la hauteur l'emporte
  assert.equal(effectiveHeight(960, 1920), 1080);
  assert.equal(effectiveHeight(700, null), 700);
});
