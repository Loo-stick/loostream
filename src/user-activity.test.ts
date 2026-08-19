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

test('getUserStats: utilisateurs distincts (exclut (anonyme)), outcomes, média, top titres', () => {
  const before = ua.getUserStats();
  ua.recordUserActivity('Neo', { title: 'Matrix', mediaType: 'movie', contentId: 'tt1', streams: 3, outcome: 'ok' }, 'khash-neo');
  ua.recordUserActivity('Neo', { title: 'Matrix', mediaType: 'movie', contentId: 'tt1', streams: 2, outcome: 'ok' }, 'khash-neo');
  ua.recordUserActivity('Trinity', { title: 'Dune', mediaType: 'movie', contentId: 'tt2', streams: 0, outcome: 'empty' }, 'khash-trin');
  ua.recordUserActivity('Trinity', { title: 'BB S1', mediaType: 'series', contentId: 'tt3', streams: 1, outcome: 'error' }, 'khash-trin');
  ua.recordUserActivity('(anonyme)', { title: 'Solo', mediaType: 'movie', contentId: 'tt4', streams: 1, outcome: 'ok' });

  const s = ua.getUserStats();
  // 2 pseudos réels nouveaux (Neo, Trinity) ; (anonyme) exclu du décompte d'utilisateurs.
  assert.equal(s.distinctActive - before.distinctActive, 2);
  assert.equal(s.online - before.online, 2);        // tout est récent -> en ligne
  assert.equal(s.active24h - before.active24h, 2);
  assert.ok(s.totalClaimed - before.totalClaimed >= 2); // Neo + Trinity revendiqués via keyHash
  // Volume/outcomes : inclut (anonyme) dans le total de requêtes.
  assert.equal(s.outcomes.ok - before.outcomes.ok, 3);   // Neo x2 + anonyme
  assert.equal(s.outcomes.empty - before.outcomes.empty, 1);
  assert.equal(s.outcomes.error - before.outcomes.error, 1);
  assert.equal(s.media.movies - before.media.movies, 4); // Matrix x2 + Dune + Solo
  assert.equal(s.media.series - before.media.series, 1);
  // Top titres : Matrix (tt1) demandé 2 fois.
  const matrix = s.topTitles.find((t: any) => t.contentId === 'tt1');
  assert.equal(matrix.count, 2);
  assert.ok(s.onlineWindowMin > 0 && s.retentionDays > 0);
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
