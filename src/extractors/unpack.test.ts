import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unpack, unpackFromHtml, findPackedBlock, findStreamUrl } from './unpack';

// Échantillon P.A.C.K.E.R. minimal (base 10, corps vide) : le dictionnaire
// https|ex|com|a se substitue aux tokens 0|1|2|3 du payload.
const PACKED =
  `eval(function(p,a,c,k,e,d){}('src:"0://1.2/3.m3u8"',10,4,'https|ex|com|a'.split('|'),0,{}))`;

test('unpack : substitue les tokens du dictionnaire', () => {
  assert.equal(unpack(PACKED), 'src:"https://ex.com/a.m3u8"');
});

test('unpack : null si le bloc n’a pas la forme attendue', () => {
  assert.equal(unpack('console.log("pas packé")'), null);
});

test('findPackedBlock + unpackFromHtml : isole et dépacke depuis une page', () => {
  const html = `<html><body><script>${PACKED}</script></body></html>`;
  assert.ok(findPackedBlock(html)?.startsWith('eval(function(p,a,c,k,e,d)'));
  assert.equal(unpackFromHtml(html), 'src:"https://ex.com/a.m3u8"');
});

test('findStreamUrl : priorité src > file > sources > 1re m3u8', () => {
  assert.equal(findStreamUrl('src:"https://a/x.m3u8"'), 'https://a/x.m3u8');
  assert.equal(findStreamUrl('file: "https://b/y.m3u8"'), 'https://b/y.m3u8');
  assert.equal(findStreamUrl('sources:["https://c/z.m3u8"]'), 'https://c/z.m3u8');
  assert.equal(findStreamUrl('var v="https://d/w.m3u8?t=1"'), 'https://d/w.m3u8?t=1');
});

test('findStreamUrl : ignore les valeurs non-URL, null si rien', () => {
  assert.equal(findStreamUrl('src:"relative/path.m3u8"'), null);
  assert.equal(findStreamUrl('rien à voir ici'), null);
});
