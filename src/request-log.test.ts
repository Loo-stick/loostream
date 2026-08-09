import { test } from 'node:test';
import assert from 'node:assert';
import { runWithLogCapture, capturedLines, currentPseudo, installLogCapture } from './request-log';

installLogCapture();

test('capture les console.log DANS le contexte, pas dehors', async () => {
  console.log('hors-contexte'); // ne doit pas apparaître
  const cap = await runWithLogCapture('Wallace', async () => {
    console.log('[Movix] Purstream=0');
    console.log('[Stream] No streams found');
    assert.equal(currentPseudo(), 'Wallace');
    return capturedLines();
  });
  assert.match(cap, /\[Movix\] Purstream=0/);
  assert.match(cap, /No streams found/);
  assert.doesNotMatch(cap, /hors-contexte/);
  assert.equal(capturedLines(), ''); // hors contexte après
});
