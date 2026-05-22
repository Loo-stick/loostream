const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  deduceExtractor,
  parseUnrecognizedHostLine,
  addDomainToExtractorConfig,
} = require('./telegram-bot-domains');

test('deduceExtractor: mappe les labels connus', () => {
  assert.equal(deduceExtractor('Voe'), 'voe');
  assert.equal(deduceExtractor('Vidara'), 'voe');
  assert.equal(deduceExtractor('LuLuTV'), 'lulustream');
  assert.equal(deduceExtractor('DdStream'), 'doodstream');
  assert.equal(deduceExtractor('Swish'), 'streamwish');
  assert.equal(deduceExtractor('uqload'), 'uqload');
  assert.equal(deduceExtractor('Vmoly'), 'vidmoly');
});

test('deduceExtractor: label inconnu ou générique renvoie null', () => {
  assert.equal(deduceExtractor('vostfr 1'), null);
  assert.equal(deduceExtractor('Hxfile'), null);
  assert.equal(deduceExtractor('Vidsonic'), null);
  assert.equal(deduceExtractor(''), null);
  assert.equal(deduceExtractor(undefined), null);
});

test('parseUnrecognizedHostLine: parse une ligne flemmix', () => {
  const line = '[Flemmix] Unrecognized host: kathyinformationwhether.com (server="Voe", title="Projet Dernière Chance")';
  assert.deepEqual(parseUnrecognizedHostLine(line), {
    scraper: 'Flemmix',
    host: 'kathyinformationwhether.com',
    server: 'Voe',
    title: 'Projet Dernière Chance',
  });
});

test('parseUnrecognizedHostLine: parse une ligne movix au titre vide', () => {
  const line = '[Movix] Unrecognized host: playmogo.com (server="DdStream", title="")';
  assert.deepEqual(parseUnrecognizedHostLine(line), {
    scraper: 'Movix', host: 'playmogo.com', server: 'DdStream', title: '',
  });
});

test('parseUnrecognizedHostLine: ligne non concernée renvoie null', () => {
  assert.equal(parseUnrecognizedHostLine('[Flemmix] 15 embeds, 6 supported: Voe'), null);
});

test('addDomainToExtractorConfig: ajoute un nouveau domaine', () => {
  const { config, added } = addDomainToExtractorConfig({ voe: ['a.test'] }, 'voe', 'b.test');
  assert.equal(added, true);
  assert.deepEqual(config.voe, ['a.test', 'b.test']);
});

test('addDomainToExtractorConfig: domaine en double non ajouté', () => {
  const { config, added } = addDomainToExtractorConfig({ voe: ['a.test'] }, 'voe', 'a.test');
  assert.equal(added, false);
  assert.deepEqual(config.voe, ['a.test']);
});

test('addDomainToExtractorConfig: crée le tableau de l\'extracteur si absent', () => {
  const { config, added } = addDomainToExtractorConfig({}, 'voe', 'a.test');
  assert.equal(added, true);
  assert.deepEqual(config.voe, ['a.test']);
});
