import { signSecret, getCinemaosStreams } from '../src/scrapers/cinemaos';

const got = signSecret({ tmdbId: '299534', imdbId: 'tt4154796' });
const want = 'ba7f3b4e283ecfcfd04b23d5aee1c54ff7b5b470d2be3a93dd611800f862fba4';
console.log('secret:', got);
if (got !== want) { console.error('MISMATCH — expected', want); process.exit(1); }
console.log('OK: signSecret reproduces the browser secret');

(async () => {
  const r = await getCinemaosStreams('299534', 'tt4154796', 'movie', 'Avengers: Endgame', '2019');
  console.log('Endgame streams:', r.length);
  console.log('first:', JSON.stringify(r[0], null, 2).slice(0, 400));
  const sheep = await getCinemaosStreams('1301421', 'tt32565993', 'movie', 'The Sheep Detectives', '2026');
  console.log('Sheep Detectives streams:', sheep.length, '| subs on first:', sheep[0]?.subtitles?.length ?? 0);
  if (r.length === 0 || sheep.length === 0) process.exit(1);
  process.exit(0);
})();
