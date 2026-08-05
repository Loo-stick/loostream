import { test } from 'node:test';
import assert from 'node:assert';
import { parseOpenSubtitles } from './subtitles';

test('parseOpenSubtitles : filtre srt, trie par téléchargements, top 3', () => {
  const raw = [
    { SubFormat: 'srt', SubDownloadLink: 'https://dl.opensubtitles.org/a', SubDownloadsCnt: '100', MovieReleaseName: 'A' },
    { SubFormat: 'sub', SubDownloadLink: 'https://dl.opensubtitles.org/x', SubDownloadsCnt: '999', MovieReleaseName: 'X' }, // non-srt -> exclu
    { SubFormat: 'srt', SubDownloadLink: 'https://dl.opensubtitles.org/b', SubDownloadsCnt: '5000', SubFileName: 'B.srt' },
    { SubFormat: 'srt', SubDownloadLink: 'https://dl.opensubtitles.org/c', SubDownloadsCnt: '300', MovieReleaseName: 'C' },
    { SubFormat: 'srt', SubDownloadLink: 'https://dl.opensubtitles.org/d', SubDownloadsCnt: '10', MovieReleaseName: 'D' },
  ];
  const out = parseOpenSubtitles(raw);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(s => s.downloads), [5000, 300, 100]); // trié desc, top 3
  assert.equal(out[0].name, 'B.srt');
});

test('parseOpenSubtitles : entrée non-tableau -> []', () => {
  assert.deepEqual(parseOpenSubtitles(null as any), []);
});
