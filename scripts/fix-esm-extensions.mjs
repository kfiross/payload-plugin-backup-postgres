// Rewrites extensionless relative imports in emitted ESM (`./core/backup` → `./core/backup.js`,
// `./endpoints` → `./endpoints/index.js`) so the package also loads under plain Node ESM
// (Payload CLI, scripts), not only through bundlers. Also maps `next/server` and
// `next/navigation` to their `.js` entry files.
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.argv[2] ?? 'dist')
const SPEC =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+|next\/(?:server|navigation))\2/g

function resolveSpec(fileDir, spec) {
  // Next.js has no `exports` map; the `.js` entry files resolve in both Node ESM and bundlers.
  if (spec === 'next/server' || spec === 'next/navigation') {
    return `${spec}.js`
  }
  if (/\.(m?js|cjs|json|css)$/.test(spec)) {
    return spec
  }
  const abs = path.resolve(fileDir, spec)
  if (fs.existsSync(`${abs}.js`)) {
    return `${spec}.js`
  }
  if (fs.existsSync(path.join(abs, 'index.js'))) {
    return `${spec.replace(/\/$/, '')}/index.js`
  }
  return spec
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(p)
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) {
      const src = fs.readFileSync(p, 'utf8')
      const out = src.replace(
        SPEC,
        (_m, pre, q, spec) => `${pre}${q}${resolveSpec(path.dirname(p), spec)}${q}`,
      )
      if (out !== src) {
        fs.writeFileSync(p, out)
      }
    }
  }
}

walk(root)
