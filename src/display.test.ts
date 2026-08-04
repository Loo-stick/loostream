import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryChip, buildStreamTitle } from './display';

test('deliveryChip : une icône par mode de livraison', () => {
  assert.equal(deliveryChip('direct'), '🚀 Direct');
  assert.equal(deliveryChip('local'), '🏠 Proxy');
  assert.equal(deliveryChip('mediaflow'), '☁️ MFP');
  assert.equal(deliveryChip(undefined), '');
  assert.equal(deliveryChip('bogus'), '');
});

test('buildStreamTitle : préfixe le badge de livraison en tête de ligne 1', () => {
  const t = buildStreamTitle({ quality: 'HD', language: 'MULTI', source: 'movix', delivery: 'direct' });
  assert.ok(t.startsWith('🚀 Direct · 🌍 MULTI'), t);
});

test('buildStreamTitle : pas de badge si delivery absent (rétro-compat)', () => {
  const t = buildStreamTitle({ quality: 'HD', language: 'VF', source: 'movix' });
  assert.ok(!t.includes('🚀') && !t.includes('☁️') && !t.includes('🏠'), t);
});
