import axios from 'axios';
import { unpackFromHtml, findStreamUrl } from '../src/extractors/unpack';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
(async () => {
  for (const u of ['https://fsvid.lol/embed-mtotlijp92i5.html','https://vidzy.org/embed-ldfm9dessufv.html']) {
    const origin = new URL(u).origin;
    try {
      const { data } = await axios.get<string>(u, { headers: { 'User-Agent': UA, Referer: origin + '/' }, timeout: 15000, responseType: 'text', transformResponse: r => r });
      const js = unpackFromHtml(String(data));
      console.log(`\n${u}`);
      console.log('  dépack:', js ? `OK (${js.length} c)` : 'ÉCHEC');
      if (js) console.log('  stream:', findStreamUrl(js) || 'non trouvé');
    } catch (e: any) { console.log(u, 'erreur', e.message); }
  }
  process.exit(0);
})();
