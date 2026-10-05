// Prints the link that unlocks the admin page on a device, so the admin key doesn't have to be
// typed on a phone:
//
//   node tools/admin-link.mjs https://tick.<subdomain>.workers.dev
//
// The key (INVITE_SECRET, read from .dev.vars) sits after the "#", which browsers never send to
// a server, and the app removes it from the address as soon as it has read it. Even so, this
// link is the key to the whole server: open it yourself, and don't send it to anyone.

import fs from 'node:fs';

const [site] = process.argv.slice(2);
if (!site) { console.error('Usage: node tools/admin-link.mjs <app address>'); process.exit(1); }
const vars = fs.readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
const secret = /^INVITE_SECRET\s*=\s*"?([^"\n]+)"?/m.exec(vars)?.[1];
if (!secret) { console.error('INVITE_SECRET is missing from .dev.vars'); process.exit(1); }
console.log(`${site.replace(/\/$/, '')}/#admin=${encodeURIComponent(secret)}`);
console.log('Open it on your own device only. Anyone with this link can make invites.');
