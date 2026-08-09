import { test, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DB = path.join(os.tmpdir(), `ua-test-${process.pid}.db`);
let ua: typeof import('./user-activity');

before(async () => {
  process.env.USERS_DB = DB;              // posé AVANT l'import (le module ouvre la base au load)
  ua = await import('./user-activity');
});
after(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + s); } catch { /* ignore */ } } });

test('record + overview: agrège par pseudo, compte vides/erreurs', () => {
  ua.recordUserActivity('Wallace', { title: 'A', streams: 0, outcome: 'empty', detail: '{}' });
  ua.recordUserActivity('Wallace', { title: 'B', streams: 4, outcome: 'ok', detail: '{}' });
  ua.recordUserActivity('Stick', { title: 'C', streams: 2, outcome: 'ok', detail: '{}' });
  const ov = ua.getUsersOverview();
  const w = ov.find((u: any) => u.pseudo === 'Wallace');
  assert.equal(w.requests, 2);
  assert.equal(w.empties, 1);
  assert.equal(w.errors, 0);
});

test('getUserRequests + getRequestLog: trace récupérable par id', () => {
  ua.recordUserActivity('Kevin', { title: 'D', streams: 0, outcome: 'error', detail: '{"movix":{"streams":0}}', log: '[Stream] No streams found' });
  const reqs = ua.getUserRequests('Kevin', 10);
  assert.equal(reqs[0].title, 'D');
  assert.equal(reqs[0].outcome, 'error');
  assert.match(reqs[0].detail, /movix/);
  const log = ua.getRequestLog(reqs[0].id);
  assert.match(log, /No streams found/);
});
