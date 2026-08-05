import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { getModeRaw, getOwnerKeyValue, autoWhitelistEnabled, updateSettings, settingsView } from './settings';

const p = path.join(process.cwd(), 'config', 'runtime-settings.json');
afterEach(() => { try { fs.writeFileSync(p, '{}'); } catch {} });

test('fallback env quand le fichier est vide', () => {
  fs.writeFileSync(p, '{}');
  process.env.MODE = 'DIRECT';
  process.env.AUTO_WHITELIST = 'true';
  assert.equal(getModeRaw(), 'DIRECT');
  assert.equal(autoWhitelistEnabled(), true);
});

test('le fichier surcharge l\'env', () => {
  process.env.MODE = 'DIRECT';
  updateSettings({ mode: 'DIRECT;LOCAL', autoWhitelist: false });
  assert.equal(getModeRaw(), 'DIRECT;LOCAL');
  assert.equal(autoWhitelistEnabled(), false);
});

test('null retire la surcharge (retour env)', () => {
  process.env.MODE = 'MFP';
  updateSettings({ mode: 'LOCAL' });
  assert.equal(getModeRaw(), 'LOCAL');
  updateSettings({ mode: null });
  assert.equal(getModeRaw(), 'MFP');
});

test('settingsView ne divulgue jamais la clé en clair', () => {
  updateSettings({ ownerKey: 'abcd1234efgh' });
  const v = settingsView();
  assert.equal(v.ownerKey.configured, true);
  assert.equal(v.ownerKey.length, 12);
  assert.ok(!JSON.stringify(v).includes('abcd1234efgh'));
  assert.equal(getOwnerKeyValue(), 'abcd1234efgh');
});
