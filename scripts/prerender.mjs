/**
 * Pre-render all published pages to static HTML for AI-crawler accessibility (LPS-864).
 *
 * Run order (called from export.py step 2b):
 *   npm run build        → dist/ (client-side SPA shells)
 *   npm run build:ssr    → dist-ssr/entry-server.js (Node.js SSR bundle)
 *   node scripts/prerender.mjs  ← this script
 *
 * For each page in pages.manifest.json, injects ReactDOMServer.renderToString()
 * output into the corresponding dist/ HTML file, replacing <div id="root"></div>
 * with the pre-rendered React tree. AI crawlers can then read page content
 * without executing JavaScript. React hydration is unaffected.
 *
 * Fully non-fatal: any page-level failure is logged and skipped.
 * The script always exits 0 so a pre-render failure never blocks publish.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { pathToFileURL } from "url";
import path from "path";

const __dirname = new URL(".", import.meta.url).pathname;
const workspaceRoot = path.resolve(__dirname, "..");

// ── Stub browser globals ───────────────────────────────────────────────────────
// Agent-generated components may access window/document at module-evaluation
// time (outside useEffect). These stubs prevent import-time crashes so the
// bundle loads cleanly. Runtime failures during renderToString() are caught
// inside entry-server.tsx's try/catch.
if (typeof globalThis.window === "undefined") {
  globalThis.window = {
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { pathname: "/", href: "http://localhost/", search: "", hash: "" },
    history: { pushState: () => {}, replaceState: () => {} },
    scrollTo: () => {},
    requestAnimationFrame: (cb) => setTimeout(cb, 16),
    cancelAnimationFrame: clearTimeout,
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
  };
}
if (typeof globalThis.document === "undefined") {
  globalThis.document = {
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {}, classList: { add: () => {}, remove: () => {}, contains: () => false } }),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    body: { style: {}, classList: { add: () => {}, remove: () => {}, contains: () => false } },
    head: { appendChild: () => {}, querySelector: () => null },
    documentElement: { style: {}, classList: { add: () => {}, remove: () => {}, contains: () => false } },
    createTextNode: () => ({}),
    addEventListener: () => {},
    removeEventListener: () => {},
    createEvent: () => ({ initEvent: () => {} }),
    dispatchEvent: () => {},
  };
}
if (typeof globalThis.navigator === "undefined") {
  globalThis.navigator = { userAgent: "node", language: "en-US", languages: ["en-US"] };
}
if (typeof globalThis.localStorage === "undefined") {
  const _store = {};
  globalThis.localStorage = {
    getItem: (k) => _store[k] ?? null,
    setItem: (k, v) => { _store[k] = String(v); },
    removeItem: (k) => { delete _store[k]; },
    clear: () => { Object.keys(_store).forEach((k) => delete _store[k]); },
  };
}
if (typeof globalThis.sessionStorage === "undefined") {
  globalThis.sessionStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  };
}
// ──────────────────────────────────────────────────────────────────────────────

// ── Load manifest ─────────────────────────────────────────────────────────────
const manifestPath = path.join(workspaceRoot, "pages.manifest.json");
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (e) {
  console.log(`[prerender] Skipping — could not read pages.manifest.json: ${e.message}`);
  process.exit(0);
}

const pages = manifest.pages ?? [];
if (pages.length === 0) {
  console.log("[prerender] No pages in manifest — skipping");
  process.exit(0);
}
// ──────────────────────────────────────────────────────────────────────────────

// ── Load SSR bundle ───────────────────────────────────────────────────────────
const ssrBundlePath = path.join(workspaceRoot, "dist-ssr", "entry-server.js");
if (!existsSync(ssrBundlePath)) {
  console.log("[prerender] dist-ssr/entry-server.js not found — skipping");
  process.exit(0);
}

let renderPage;
try {
  const mod = await import(pathToFileURL(ssrBundlePath).href);
  renderPage = mod.renderPage;
  if (typeof renderPage !== "function") {
    throw new Error("renderPage export is not a function");
  }
} catch (e) {
  console.log(`[prerender] Skipping — failed to load SSR bundle: ${e.message}`);
  process.exit(0);
}
// ──────────────────────────────────────────────────────────────────────────────

// ── Pre-render each page ──────────────────────────────────────────────────────
const ROOT_PLACEHOLDER = '<div id="root"></div>';
let rendered = 0;
let skipped = 0;

for (const page of pages) {
  const slug = page.slug ?? "";
  const isHome = page.isHome === true || slug === "";
  const filePath = page.filePath; // e.g. "src/pages/About.tsx" (may be undefined)

  const htmlPath = isHome
    ? path.join(workspaceRoot, "dist", "index.html")
    : path.join(workspaceRoot, "dist", slug, "index.html");

  if (!existsSync(htmlPath)) {
    console.warn(`[prerender] ⚠  HTML missing for slug="${slug}": ${htmlPath}`);
    skipped++;
    continue;
  }

  // Render React component to string (non-fatal)
  let renderedHtml = "";
  try {
    renderedHtml = renderPage(slug, filePath);
  } catch (e) {
    console.warn(`[prerender] ⚠  renderPage threw for slug="${slug}": ${e.message}`);
    skipped++;
    continue;
  }

  if (!renderedHtml) {
    console.warn(`[prerender] ⚠  Empty render for slug="${slug}" (component not found or threw)`);
    skipped++;
    continue;
  }

  // Inject rendered HTML into the dist shell
  try {
    const shell = readFileSync(htmlPath, "utf8");
    if (!shell.includes(ROOT_PLACEHOLDER)) {
      console.warn(`[prerender] ⚠  Root placeholder not found in ${htmlPath}`);
      skipped++;
      continue;
    }
    const patched = shell.replace(ROOT_PLACEHOLDER, `<div id="root">${renderedHtml}</div>`);
    writeFileSync(htmlPath, patched, "utf8");
    rendered++;
    console.log(`[prerender] ✓ ${isHome ? "/" : `/${slug}`}`);
  } catch (e) {
    console.warn(`[prerender] ⚠  Write failed for ${htmlPath}: ${e.message}`);
    skipped++;
  }
}
// ──────────────────────────────────────────────────────────────────────────────

console.log(`[prerender] Done — ${rendered} rendered, ${skipped} skipped`);
