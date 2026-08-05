import { test } from 'node:test';
import assert from 'node:assert';
import { parseOpenSubtitles } from './subtitles';

test('parseOpenSubtitles : filtre srt, trie par téléchargements, top 5', () => {
  const srt = (dl: number, extra: any = {}) => ({ SubFormat: 'srt', SubDownloadLink: 'https://dl.opensubtitles.org/' + dl, SubDownloadsCnt: String(dl), ...extra });
  const raw = [
    srt(100),
    { SubFormat: 'sub', SubDownloadLink: 'https://dl.opensubtitles.org/x', SubDownloadsCnt: '999999' }, // non-srt -> exclu
    srt(5000, { SubFileName: 'B.srt' }),
    srt(300), srt(10), srt(800), srt(2000),
  ];
  const out = parseOpenSubtitles(raw);
  assert.equal(out.length, 5); // 6 srt -> cap 5
  assert.deepEqual(out.map(s => s.downloads), [5000, 2000, 800, 300, 100]); // trié desc, top 5
  assert.equal(out[0].name, 'B.srt');
});

test('parseOpenSubtitles : entrée non-tableau -> []', () => {
  assert.deepEqual(parseOpenSubtitles(null as any), []);
});
