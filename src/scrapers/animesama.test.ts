import { test } from 'node:test';
import assert from 'node:assert';
import { parseEpisodesJs } from './animesama';

test('parseEpisodesJs : une URL par tableau-lecteur pour l\'épisode demandé (index)', () => {
  const js = `var eps1 = [\n'https://a.net/e/1a',\n'https://a.net/e/2a',\n];\nvar eps2 = [\n'https://video.sibnet.ru/1b',\n'https://video.sibnet.ru/2b',\n];`;
  assert.deepEqual(parseEpisodesJs(js, 1), ['https://a.net/e/2a', 'https://video.sibnet.ru/2b']); // épisode 2 -> index 1
  assert.deepEqual(parseEpisodesJs(js, 0), ['https://a.net/e/1a', 'https://video.sibnet.ru/1b']);
});

test('parseEpisodesJs : préfixe protocol-relative // -> https, index hors borne ignoré', () => {
  const js = `var epsA = [\n'//cdn.host/x',\n];`;
  assert.deepEqual(parseEpisodesJs(js, 0), ['https://cdn.host/x']);
  assert.deepEqual(parseEpisodesJs(js, 5), []); // épisode inexistant
});
