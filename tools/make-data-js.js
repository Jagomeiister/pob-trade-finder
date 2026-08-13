// Converts data/*.json into window-global .js files so index.html works from file://
// Also re-fetches fresh data when run with --fetch (league changes, new mods).
const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA = path.join(__dirname, '..', 'data');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PoB-Trade-Helper/1.0';

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA } }, res => {
      if (res.statusCode !== 200) return reject(new Error(url + ' -> HTTP ' + res.statusCode));
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

async function main() {
  if (process.argv.includes('--fetch')) {
    console.log('Fetching fresh trade data from pathofexile.com…');
    fs.writeFileSync(path.join(DATA, 'stats.json'),
      await fetch('https://www.pathofexile.com/api/trade/data/stats'));
    fs.writeFileSync(path.join(DATA, 'leagues.json'),
      await fetch('https://www.pathofexile.com/api/trade/data/leagues'));
  }
  const stats = fs.readFileSync(path.join(DATA, 'stats.json'), 'utf8');
  const leagues = fs.readFileSync(path.join(DATA, 'leagues.json'), 'utf8');
  JSON.parse(stats); JSON.parse(leagues); // validate
  fs.writeFileSync(path.join(DATA, 'stats.js'), 'window.POE_STATS = ' + stats + ';\n');
  fs.writeFileSync(path.join(DATA, 'leagues.js'), 'window.POE_LEAGUES = ' + leagues + ';\n');
  console.log('Wrote data/stats.js and data/leagues.js');
}

main().catch(e => { console.error(e.message); process.exit(1); });
