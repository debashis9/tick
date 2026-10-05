// Makes an invite link for cloud backup. Anyone can use Tick on their own device; an invite is
// only needed to create a backup vault on the server.
//
//   node tools/invite.mjs https://tick.<subdomain>.workers.dev [days=14]
//
// Reads INVITE_SECRET from .dev.vars (the same value you set with `npx wrangler secret put
// INVITE_SECRET`). The link works for anyone until it expires; nothing is stored anywhere.

import fs from 'node:fs';
import { signInvite } from '../worker/vault.js';

const [site, days = '14'] = process.argv.slice(2);
if (!site) { console.error('Usage: node tools/invite.mjs <app address> [days]'); process.exit(1); }
const vars = fs.readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
const secret = /^INVITE_SECRET\s*=\s*"?([^"\n]+)"?/m.exec(vars)?.[1];
if (!secret) { console.error('INVITE_SECRET is missing from .dev.vars'); process.exit(1); }
const exp = Date.now() + Number(days) * 864e5;
const token = await signInvite(secret, { exp });
console.log(`${site.replace(/\/$/, '')}/?invite=${token}`);
console.log(`Valid until ${new Date(exp).toDateString()}.`);
