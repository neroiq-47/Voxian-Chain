#!/usr/bin/env node
// Builds the static GitHub Pages site:
//   /       landing page (site/)
//   /app/   the web app (web/ + src/); with no backend it boots an in-browser node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
const app = path.join(out, 'app');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'site'), out, { recursive: true });
fs.cpSync(path.join(root, 'web'), app, { recursive: true });
fs.cpSync(path.join(root, 'src'), path.join(app, 'src'), {
  recursive: true,
  filter: (p) => !p.endsWith('server.js'), // Node-only entry point
});
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`built static site → ${path.relative(root, out)}/ (landing page) + ${path.relative(root, app)}/ (demo app)`);
