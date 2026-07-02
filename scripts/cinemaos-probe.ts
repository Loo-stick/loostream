import { signSecret } from '../src/scrapers/cinemaos';

const got = signSecret({ tmdbId: '299534', imdbId: 'tt4154796' });
const want = 'ba7f3b4e283ecfcfd04b23d5aee1c54ff7b5b470d2be3a93dd611800f862fba4';
console.log('secret:', got);
if (got !== want) { console.error('MISMATCH — expected', want); process.exit(1); }
console.log('OK: signSecret reproduces the browser secret');
