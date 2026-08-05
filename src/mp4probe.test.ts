import { test } from 'node:test';
import assert from 'node:assert';
import { mp4HeightFromBuffer } from './mp4probe';

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
