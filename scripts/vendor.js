#!/usr/bin/env node
// Copies the player libraries from node_modules into web/vendor/ with their version in the file name, so the
// site can serve them itself (no third-party CDN) with a year-long cache. Run "make vendor" after upgrading them.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'web/vendor');
const version = (pkg) => JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', pkg, 'package.json'), 'utf8')).version;
const plyr = version('plyr');
const hls = version('hls.js');

const files = [
  ['plyr/dist/plyr.min.mjs', `plyr-${plyr}.min.js`],
  ['plyr/dist/plyr.css', `plyr-${plyr}.css`],
  ['plyr/dist/plyr.svg', `plyr-${plyr}.svg`],
  ['plyr/LICENSE.md', `plyr-${plyr}-LICENSE.txt`],
  ['hls.js/dist/hls.light.min.mjs', `hls.light-${hls}.min.js`],
  ['hls.js/dist/hls.worker.js', `hls.worker-${hls}.js`],
  ['hls.js/LICENSE', `hls.js-${hls}-LICENSE.txt`],
];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const [from, to] of files) {
  // Source maps are not shipped, so drop the comments that point at them.
  const text = fs.readFileSync(path.join(ROOT, 'node_modules', from), 'utf8').replace(/\n?\/[/*]# sourceMappingURL=\S+( \*\/)?\s*$/, '\n');
  fs.writeFileSync(path.join(OUT, to), text);
}
fs.writeFileSync(path.join(OUT, 'versions.json'), `${JSON.stringify({ plyr, hls: hls }, null, 2)}\n`);
console.log(`web/vendor: Plyr ${plyr}, hls.js ${hls}`);
