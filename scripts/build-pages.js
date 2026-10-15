#!/usr/bin/env node
// Builds a static site (web/ + src/) for GitHub Pages. With no backend, the app boots an in-browser node.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'web'), out, { recursive: true });
fs.cpSync(path.join(root, 'src'), path.join(out, 'src'), {
  recursive: true,
  filter: (p) => !p.endsWith('server.js'), // Node-only entry point
});
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`built static site → ${path.relative(root, out)}/`);
