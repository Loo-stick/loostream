import { test } from 'node:test';
import assert from 'node:assert';
import { sanitizePseudo, pseudoLabel } from './pseudo';

test('sanitizePseudo: trim + longueur max 24', () => {
  assert.equal(sanitizePseudo('  Wallace  '), 'Wallace');
  assert.equal(sanitizePseudo('x'.repeat(40)).length, 24);
});
test('sanitizePseudo: retire les caractères non autorisés, garde lettres/chiffres/espace/_.-', () => {
  assert.equal(sanitizePseudo('Wa/ll<ace>'), 'Wallace');
  assert.equal(sanitizePseudo('Jean-Luc_92.x'), 'Jean-Luc_92.x');
  assert.equal(sanitizePseudo('Éléa 🎬'), 'Éléa');
});
test('pseudoLabel: vide -> (anonyme)', () => {
  assert.equal(pseudoLabel(''), '(anonyme)');
  assert.equal(pseudoLabel(undefined), '(anonyme)');
  assert.equal(pseudoLabel('   '), '(anonyme)');
  assert.equal(pseudoLabel('Wallace'), 'Wallace');
});
