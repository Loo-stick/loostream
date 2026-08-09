import { test } from 'node:test';
import assert from 'node:assert';
import { runWithLogCapture, capturedLines, currentPseudo, captureLine } from './request-log';

test('capture les lignes DANS le contexte de requête, pas dehors', async () => {
  captureLine('hors-contexte'); // aucun contexte -> ignoré
  const cap = await runWithLogCapture('Wallace', async () => {
    captureLine('[Movix] Purstream=0');
    captureLine('[Stream] No streams found');
    assert.equal(currentPseudo(), 'Wallace');
    return capturedLines();
  });
  assert.match(cap, /\[Movix\] Purstream=0/);
  assert.match(cap, /No streams found/);
  assert.doesNotMatch(cap, /hors-contexte/);
  assert.equal(capturedLines(), ''); // hors contexte après
});
