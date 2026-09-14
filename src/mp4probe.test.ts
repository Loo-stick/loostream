import { test } from 'node:test';
import assert from 'node:assert';
import { mp4HeightFromBuffer, mp4DimensionsFromBuffer } from './mp4probe';
import { resLabel } from './multiaudio';

// Construit un box MP4 : [size:uint32BE][type:4][payload].
function box(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

// tkhd v0 : width/height (fixed 16.16) sur les 8 DERNIERS octets du payload.
function tkhd(widthPx: number, heightPx: number): Buffer {
  const p = Buffer.alloc(84);
  p.writeUInt32BE(widthPx << 16, 76);
  p.writeUInt32BE(heightPx << 16, 80);
  return box('tkhd', p);
}

test('lit la hauteur vidéo dans moov→trak→tkhd', () => {
  const moov = box('moov', box('trak', tkhd(1280, 720)));
  assert.equal(mp4HeightFromBuffer(moov), 720);
});

test('ignore les pistes non-vidéo (audio height=0), prend le max', () => {
  const audioTrak = box('trak', tkhd(0, 0));      // piste audio
  const videoTrak = box('trak', tkhd(1920, 1080)); // piste vidéo
  const moov = box('moov', Buffer.concat([audioTrak, videoTrak]));
  assert.equal(mp4HeightFromBuffer(moov), 1080);
});

test('saute les boîtes de tête (ftyp) avant le moov', () => {
  const ftyp = box('ftyp', Buffer.from('isommp42'));
  const moov = box('moov', box('trak', tkhd(854, 480)));
  assert.equal(mp4HeightFromBuffer(Buffer.concat([ftyp, moov])), 480);
});

test('renvoie null si aucun tkhd (pas de moov dans le buffer)', () => {
  const ftyp = box('ftyp', Buffer.from('isommp42'));
  assert.equal(mp4HeightFromBuffer(ftyp), null);
});

test('lit aussi la LARGEUR : un MP4 cinémascope 1920x800 est un 1080p', () => {
  const moov = box('moov', box('trak', tkhd(1920, 800)));
  assert.deepEqual(mp4DimensionsFromBuffer(moov), { width: 1920, height: 800 });
  const d = mp4DimensionsFromBuffer(moov)!;
  assert.equal(resLabel(d.height, d.width), '1080p'); // était « 720p » sur la hauteur seule
});

test('entre deux pistes vidéo, garde la meilleure hauteur EFFECTIVE (largeur comprise)', () => {
  const small = box('trak', tkhd(1280, 720));   // hauteur réelle plus grande…
  const scope = box('trak', tkhd(1920, 800));   // …mais le cinémascope est la meilleure piste
  const moov = box('moov', Buffer.concat([small, scope]));
  assert.deepEqual(mp4DimensionsFromBuffer(moov), { width: 1920, height: 800 });
  assert.equal(mp4HeightFromBuffer(moov), 800);
});

test('dimensions null si aucune piste vidéo', () => {
  const moov = box('moov', box('trak', tkhd(0, 0)));
  assert.equal(mp4DimensionsFromBuffer(moov), null);
});
