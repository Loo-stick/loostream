import { test } from 'node:test';
import assert from 'node:assert';
import { pushLog, getLogs, maskSecrets } from './logbuffer';

test('maskSecrets masque une clé en query et un api_password', () => {
  process.env.ACCESS_KEY = 'topsecret123';
  assert.ok(!maskSecrets('proxy?k=topsecret123&x=1').includes('topsecret123'));
  assert.ok(!maskSecrets('url?api_password=abcdef').includes('abcdef'));
  delete process.env.ACCESS_KEY;
});

test('pushLog dérive la source depuis le tag [Xxx] et le niveau', () => {
  pushLog('info', '[Videasy] 2 flux trouvés');
  const { lines } = getLogs({ limit: 1 });
  assert.equal(lines[0].source, 'Videasy');
  assert.equal(lines[0].level, 'info');
});

test('getLogs filtre par source, niveau, texte et sinceSeq', () => {
  const before = getLogs({}).lastSeq;
  pushLog('error', '[Movix] échec extraction xyz');
  pushLog('info', '[Coflix] ok');
  const errs = getLogs({ level: 'error', sinceSeq: before });
  assert.ok(errs.lines.every(l => l.level === 'error'));
  const movix = getLogs({ source: 'Movix', sinceSeq: before });
  assert.ok(movix.lines.every(l => l.source === 'Movix'));
  const q = getLogs({ q: 'xyz', sinceSeq: before });
  assert.ok(q.lines.length >= 1 && q.lines.every(l => l.msg.includes('xyz')));
});
