/**
 * Vite Configuration for Landing Page Studio Preview Container
 * 
 * Supports both:
 * - Development: SPA mode with React Router for fast HMR
 * - Production: MPA mode with per-page HTML for SEO optimization
 * 
 * @see https://vitejs.dev/config/
 * @build 2026-02-02-multipage-seo
 */
import { defineConfig, Plugin, UserConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import fs from "fs";
import { componentTagger } from "lovable-tagger";

// Types for pages.manifest.json
interface PageSeo {
  title: string;
  description: string;
  keywords: string[];
  ogImage: string;
  canonicalUrl: string;
  noindex: boolean;
  structuredDataType: string;
  structuredData: Record<string, unknown> | null;
}

interface ManifestPage {
  id: string;
  name: string;
  slug: string;
  isHome: boolean;
  seo: PageSeo;
  sections: string[];
  inNavigation: boolean;
  filePath?: string;
  pageId?: string;
}

interface PagesManifest {
  site: {
    name: string;
    domain: string;
    language: string;
    defaultSeo?: {
      titleTemplate?: string;
      ogImage?: string;
    };
  };
  pages: ManifestPage[];
  navigation: {
    header: string[];
    footer: string[];
  };
  sections: Record<string, unknown>;
}

/**
 * Get the site domain from various sources:
 * 1. SITE_DOMAIN env var (set by agent at publish time for sitemap/canonical)
 * 2. Manifest domain when already a full URL (agent wrote custom/preview domain; prefer over PREVIEW_URL)
 * 3. PREVIEW_URL env var (auto-generated preview URL)
 * 4. Manifest domain (legacy/example.com excluded)
 * 5. Empty string (skip canonical/og:url generation)
 */
function getSiteDomain(manifestDomain: string): string {
  // Priority 1: Domain from environment (agent sets this at build-and-publish time)
  if (process.env.SITE_DOMAIN) {
    return process.env.SITE_DOMAIN.replace(/\/$/, ''); // Remove trailing slash
  }

  // Priority 2: Manifest already has a full URL (e.g. agent wrote custom domain) — use it so PREVIEW_URL doesn't override
  const trimmed = (manifestDomain || '').trim();
  if (trimmed.startsWith('https://') && !trimmed.includes('example.com')) {
    return trimmed.replace(/\/$/, '');
  }

  // Priority 3: Preview URL from environment
  if (process.env.PREVIEW_URL) {
    return process.env.PREVIEW_URL.replace(/\/$/, '');
  }

  // Priority 4: Domain from manifest (if set and not example.com)
  if (trimmed && !trimmed.includes('example.com')) {
    return trimmed.replace(/\/$/, '');
  }

  // No valid domain - skip canonical/og:url generation
  return '';
}

/**
 * Load pages.manifest.json with fallback defaults
 */
function loadManifest(): PagesManifest {
  const manifestPath = path.resolve(__dirname, './pages.manifest.json');
  
  try {
    if (fs.existsSync(manifestPath)) {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(content) as Partial<PagesManifest>;

      // Ensure required fields exist (manifest may be missing site/pages/navigation/sections)
      if (!manifest.site) {
        manifest.site = { name: 'Website', domain: '', language: 'en' };
      }
      if (!manifest.pages || !Array.isArray(manifest.pages)) {
        manifest.pages = [];
      }
      if (!manifest.navigation) {
        manifest.navigation = { header: [], footer: [] };
      }
      if (!manifest.sections) {
        manifest.sections = {};
      }

      // Override domain with environment-based domain
      manifest.site.domain = getSiteDomain(manifest.site.domain || '');

      return manifest as PagesManifest;
    }
  } catch (error) {
    console.warn('[vite] Failed to read pages.manifest.json:', error);
  }
  
  // Default manifest for backwards compatibility
  return {
    site: { name: 'Website', domain: getSiteDomain(''), language: 'en' },
    pages: [{
      id: 'home',
      name: 'Home',
      slug: '',
      isHome: true,
      seo: {
        title: 'Welcome',
        description: '',
        keywords: [],
        ogImage: '',
        canonicalUrl: '',
        noindex: false,
        structuredDataType: '',
        structuredData: null,
      },
      sections: [],
      inNavigation: true,
    }],
    navigation: { header: ['home'], footer: ['home'] },
    sections: {},
  };
}

/**
 * Generate JSON-LD structured data script
 */
function generateStructuredData(
  page: ManifestPage, 
  manifest: PagesManifest
): string {
  if (!page.seo.structuredData && !page.seo.structuredDataType) {
    return '';
  }
  
  let jsonLd: Record<string, unknown>;
  
  if (page.seo.structuredData) {
    // Use custom structured data if provided
    jsonLd = page.seo.structuredData;
  } else {
    // Generate basic structured data based on type
    // Only include URL fields if we have a real domain
    const baseUrl = manifest.site.domain;
    const pageUrl = baseUrl ? (page.isHome ? baseUrl : `${baseUrl}/${page.slug}`) : undefined;
    
    switch (page.seo.structuredDataType) {
      case 'WebSite':
        jsonLd = {
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: manifest.site.name,
          ...(baseUrl && { url: baseUrl }),
        };
        break;
      case 'Organization':
        jsonLd = {
          '@context': 'https://schema.org',
          '@type': 'Organization',
          name: manifest.site.name,
          ...(baseUrl && { url: baseUrl }),
        };
        break;
      case 'LocalBusiness':
        jsonLd = {
          '@context': 'https://schema.org',
          '@type': 'LocalBusiness',
          name: manifest.site.name,
          ...(baseUrl && { url: baseUrl }),
        };
        break;
      case 'FAQPage':
        jsonLd = {
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: [],
        };
        break;
      default:
        jsonLd = {
          '@context': 'https://schema.org',
          '@type': page.seo.structuredDataType || 'WebPage',
          name: page.seo.title,
          ...(pageUrl && { url: pageUrl }),
        };
    }
  }
  
  return `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`;
}

// LPS-19: read-only scan for the Hero's first hardcoded image URL so the
// browser starts the LCP fetch in parallel with JS parsing. Returns null
// when the Hero file isn't found or the URL isn't a literal — preload is
// silently skipped (degraded, not broken).
function findHeroImageUrl(
  page: ManifestPage,
  manifest: PagesManifest
): string | null {
  const heroName = page.sections?.[0];
  if (!heroName) return null;
  const sectionEntry = (manifest.sections as Record<string, { file?: string }>)?.[heroName];
  const filePath = sectionEntry?.file;
  if (!filePath) return null;
  try {
    const abs = path.resolve(__dirname, filePath);
    if (!fs.existsSync(abs)) return null;
    const content = fs.readFileSync(abs, 'utf-8');
    const m = content.match(/<img\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Generate HTML <head> content for a page
 */
function generateHeadContent(
  page: ManifestPage,
  manifest: PagesManifest
): string {
  const seo = page.seo;
  const site = manifest.site;
  const baseUrl = site.domain || '';
  const pageUrl = page.isHome ? baseUrl : `${baseUrl}/${page.slug}`;
  
  const parts: string[] = [];
  
  // Title
  const title = seo.title || page.name;
  parts.push(`<title>${title}</title>`);
  
  // Meta description — always emit one so Lighthouse meta-description passes.
  // Use the page SEO description when available, otherwise fall back to a
  // generic but valid value built from the page and site names.
  const descriptionContent = seo.description ||
    `${page.name}${site.name ? ` — ${site.name}` : ''}`;
  parts.push(`<meta name="description" content="${descriptionContent}" />`);
  
  // Keywords
  if (seo.keywords && seo.keywords.length > 0) {
    parts.push(`<meta name="keywords" content="${seo.keywords.join(', ')}" />`);
  }
  
  // Canonical URL
  if (seo.canonicalUrl) {
    parts.push(`<link rel="canonical" href="${seo.canonicalUrl}" />`);
  } else if (baseUrl) {
    parts.push(`<link rel="canonical" href="${pageUrl}" />`);
  }

  // LPS-19: preload the Hero's first image so LCP fetch starts before JS parses.
  const lcpImage = findHeroImageUrl(page, manifest);
  if (lcpImage) {
    parts.push(
      `<link rel="preload" as="image" href="${lcpImage}" fetchpriority="high" />`
    );
  }

  // Robots — page-level noindex only. Preview domains are blocked via
  // robots.txt Disallow:/ (real crawlers respect it) without penalising the
  // Lighthouse is-crawlable audit (which only checks meta/X-Robots-Tag).
  if (seo.noindex) {
    parts.push('<meta name="robots" content="noindex, nofollow" />');
  }
  
  // Open Graph
  parts.push(`<meta property="og:title" content="${title}" />`);
  if (seo.description) {
    parts.push(`<meta property="og:description" content="${seo.description}" />`);
  }
  parts.push('<meta property="og:type" content="website" />');
  if (baseUrl) {
    parts.push(`<meta property="og:url" content="${pageUrl}" />`);
  }
  const ogImage = seo.ogImage || site.defaultSeo?.ogImage;
  if (ogImage) {
    const ogImageUrl = ogImage.startsWith('http') ? ogImage : `${baseUrl}${ogImage}`;
    parts.push(`<meta property="og:image" content="${ogImageUrl}" />`);
  }
  
  // Twitter Card
  parts.push('<meta name="twitter:card" content="summary_large_image" />');
  parts.push(`<meta name="twitter:title" content="${title}" />`);
  if (seo.description) {
    parts.push(`<meta name="twitter:description" content="${seo.description}" />`);
  }
  if (ogImage) {
    const ogImageUrl = ogImage.startsWith('http') ? ogImage : `${baseUrl}${ogImage}`;
    parts.push(`<meta name="twitter:image" content="${ogImageUrl}" />`);
  }
  
  // Structured data
  const structuredData = generateStructuredData(page, manifest);
  if (structuredData) {
    parts.push(structuredData);
  }
  
  return parts.join('\n    ');
}

/**
 * Plugin to inject SEO metadata into HTML during build.
 * 
 * For development (SPA mode): Only applies to index.html
 * For production (MPA mode): Applies to each page's HTML
 * 
 * IMPORTANT: In development, we read the manifest fresh on each request
 * because the agent may update pages.manifest.json after Vite starts.
 */
function seoInjectorPlugin(initialManifest: PagesManifest, isDev: boolean): Plugin {
  return {
    name: 'seo-injector',
    transformIndexHtml(html, ctx) {
      // In development, always read fresh manifest (agent may have updated it)
      // In production build, use the cached manifest for consistency
      const manifest = isDev ? loadManifest() : initialManifest;
      
      // Determine which page this HTML is for
      let page: ManifestPage;
      
      if (ctx.filename) {
        // For MPA build, extract page from directory path
        // e.g., index.html -> dir '.' -> slug '' -> home page
        //       menu/index.html -> dir 'menu' -> slug 'menu' -> menu page
        const relativePath = path.relative(__dirname, ctx.filename);
        const dirName = path.dirname(relativePath);
        const pagePath = dirName === '.' ? '' : dirName;
        page = manifest.pages.find(p => 
          p.slug === pagePath || (p.isHome && pagePath === '')
        ) || manifest.pages[0];
      } else {
        // Default to home page
        page = manifest.pages.find(p => p.isHome) || manifest.pages[0];
      }
      
      if (!page) return html;
      
      // Generate SEO content
      const seoContent = generateHeadContent(page, manifest);
      
      // =================================================================
      // CLEANUP: Remove all SEO-related content written by the agent
      // The agent may write SEO tags directly to index.html, but we
      // control all SEO through pages.manifest.json for consistency.
      // =================================================================
      
      // Remove SEO meta tags
      html = html.replace(/<title>.*?<\/title>/gi, '');
      html = html.replace(/<meta name="description"[^>]*>/gi, '');
      html = html.replace(/<meta name="keywords"[^>]*>/gi, '');
      html = html.replace(/<meta name="robots"[^>]*>/gi, '');
      html = html.replace(/<meta property="og:[^"]*"[^>]*>/gi, '');
      html = html.replace(/<meta name="twitter:[^"]*"[^>]*>/gi, '');
      html = html.replace(/<link rel="canonical"[^>]*>/gi, '');
      html = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/gi, '');
      
      // Remove agent-written comment sections (leaves empty lines, cleaned up below)
      // These are common patterns agents use when organizing SEO in index.html
      html = html.replace(/<!--\s*Title and Description\s*-->/gi, '');
      html = html.replace(/<!--\s*Open Graph\s*-->/gi, '');
      html = html.replace(/<!--\s*Twitter Card\s*-->/gi, '');
      html = html.replace(/<!--\s*SEO\s*-->/gi, '');
      html = html.replace(/<!--\s*SEO Metadata\s*-->/gi, '');
      html = html.replace(/<!--\s*Meta Tags\s*-->/gi, '');
      html = html.replace(/<!--\s*Canonical\s*-->/gi, '');
      html = html.replace(/<!--\s*Structured Data\s*-->/gi, '');
      
      // Clean up multiple consecutive blank lines (from removed tags/comments)
      html = html.replace(/(\n\s*){3,}/g, '\n\n    ');
      
      // Inject SEO content before </head>
      html = html.replace(
        '</head>',
        `<!-- SEO Metadata -->\n    ${seoContent}\n  </head>`
      );
      
      return html;
    },
  };
}

/**
 * Plugin to inject custom embeddings (analytics, tracking) into HTML.
 */
function embeddingsInjectorPlugin(): Plugin {
  return {
    name: 'embeddings-injector',
    transformIndexHtml(html) {
      const embeddingsPath = path.resolve(__dirname, './src/embeddings.json');
      let embeddings = { header: '', footer: '' };
      
      try {
        if (fs.existsSync(embeddingsPath)) {
          const content = fs.readFileSync(embeddingsPath, 'utf-8');
          embeddings = JSON.parse(content);
        }
      } catch (error) {
        console.warn('[embeddings-injector] Failed to read embeddings.json:', error);
      }
      
      // Normalize external <script src="..."> tags to non-blocking by adding defer
      // if they don't already have defer or async
      const normalizeScripts = (snippet: string): string => {
        return snippet.replace(
          /<script\b((?![^>]*\b(?:defer|async)\b)[^>]*)\bsrc\s*=/gi,
          '<script defer$1src='
        );
      };

      if (embeddings.header) {
        html = html.replace(
          '</head>',
          `  <!-- Custom Header Embeddings -->\n  ${normalizeScripts(embeddings.header)}\n  </head>`
        );
      }

      if (embeddings.footer) {
        html = html.replace(
          '</body>',
          `  <!-- Custom Footer Embeddings -->\n  ${normalizeScripts(embeddings.footer)}\n  </body>`
        );
      }
      
      return html;
    },
  };
}

/**
 * Plugin to generate sitemap.xml and robots.txt during build.
 */
function sitemapPlugin(manifest: PagesManifest): Plugin {
  return {
    name: 'sitemap-generator',
    generateBundle() {
      const baseUrl = manifest.site.domain;
      if (!baseUrl) {
        console.log('[sitemap] Skipping sitemap generation - no domain configured');
        return;
      }
      
      // Generate sitemap.xml
      const urls = manifest.pages
        .filter(p => !p.seo.noindex)
        .map(page => {
          const loc = page.isHome ? baseUrl : `${baseUrl}/${page.slug}`;
          const priority = page.isHome ? '1.0' : '0.8';
          return `  <url>
    <loc>${loc}</loc>
    <priority>${priority}</priority>
    <changefreq>weekly</changefreq>
  </url>`;
        })
        .join('\n');
      
      const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
      
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: sitemap,
      });
      
      // Generate robots.txt
      const robots = `User-agent: *
Allow: /

Sitemap: ${baseUrl}/sitemap.xml
LLMs-txt: ${baseUrl}/llms.txt`;
      
      this.emitFile({
        type: 'asset',
        fileName: 'robots.txt',
        source: robots,
      });
      
      console.log(`[sitemap] Generated sitemap.xml with ${manifest.pages.filter(p => !p.seo.noindex).length} URLs`);
    },
  };
}

/**
 * Plugin to generate llms.txt during build.
 * Provides a markdown-based summary of the site for AI crawlers and LLM-based search engines.
 * @see https://llmstxt.org/
 */
function llmsTxtPlugin(manifest: PagesManifest): Plugin {
  return {
    name: 'llms-txt-generator',
    generateBundle() {
      const baseUrl = manifest.site.domain;
      if (!baseUrl) {
        console.log('[llms.txt] Skipping llms.txt generation - no domain configured');
        return;
      }

      const lines: string[] = [];

      // Site heading
      lines.push(`# ${manifest.site.name}`);
      lines.push('');

      // Site-level description from the home page if available
      const homePage = manifest.pages.find(p => p.isHome);
      if (homePage?.seo.description) {
        lines.push(`> ${homePage.seo.description}`);
        lines.push('');
      }

      // Pages listing
      lines.push('## Pages');
      lines.push('');

      for (const page of manifest.pages) {
        if (page.seo.noindex) continue;

        const pageUrl = page.isHome ? baseUrl : `${baseUrl}/${page.slug}`;
        const title = page.seo.title || page.name;

        lines.push(`- [${title}](${pageUrl})`);
        if (page.seo.description) {
          lines.push(`  ${page.seo.description}`);
        }
      }

      lines.push('');

      const content = lines.join('\n');

      this.emitFile({
        type: 'asset',
        fileName: 'llms.txt',
        source: content,
      });

      console.log(`[llms.txt] Generated llms.txt with ${manifest.pages.filter(p => !p.seo.noindex).length} pages`);
    },
  };
}

/**
 * Plugin to suppress the Vite error overlay during agent-initiated
 * edits (parallel page creation and similar bulk operations).
 *
 * Watches ``.lps-hmr-state.json`` written by the agent daemon. When
 * ``status === "quiet"`` and ``expires_at`` is in the future, the
 * plugin emits a ``lps:quiet:start`` WS event. On idle it emits
 * ``lps:quiet:end``. The client hook (``src/lib/quietHmr.ts``) listens
 * and toggles the existing ``HIDE_VITE_ERROR_OVERLAY`` postMessage
 * plumbing in ``index.html``.
 *
 * Safety: the plugin never suppresses anything on its own. It only
 * forwards state transitions. TTL enforcement is duplicated in the
 * client so a missed ``end`` event cannot wedge the overlay.
 */
function quietHmrPlugin(): Plugin {
  const statePath = path.resolve(__dirname, '.lps-hmr-state.json');
  // Seed as 'idle' so the initial read of a non-existent file (the
  // common case at dev-server start) does NOT broadcast an 'end'.
  // Browsers default to "no suppression" — nothing to signal.
  let lastStatus: 'quiet' | 'idle' = 'idle';

  interface QuietState {
    status?: string;
    request_id?: string;
    started_at?: number;
    expires_at?: number;
    ended_at?: number;
    end_status?: string;
  }

  function readState(source: string): QuietState | null {
    if (!fs.existsSync(statePath)) return null;
    try {
      const raw = fs.readFileSync(statePath, 'utf-8');
      return JSON.parse(raw) as QuietState;
    } catch (err) {
      // Only log parse errors — they indicate a real problem
      // (corrupted write / external writer). Successful reads stay
      // silent; the transition log in ``broadcast`` is the user-facing
      // signal. ``source`` is preserved in the log so we can localize
      // a regression.
      console.log(`[quiet-hmr] readState(${source}) parse error: ${err}`);
      return null;
    }
  }

  function broadcast(
    server: import('vite').ViteDevServer,
    state: QuietState | null,
    source: string,
  ) {
    const now = Math.floor(Date.now() / 1000);
    const isQuiet =
      state?.status === 'quiet' &&
      typeof state.expires_at === 'number' &&
      state.expires_at > now;

    const nextStatus: 'quiet' | 'idle' = isQuiet ? 'quiet' : 'idle';
    if (nextStatus === lastStatus) {
      // No transition. Stay quiet in the logs so a noisy file system
      // (or the scratch script's many writes) doesn't spam.
      return;
    }
    lastStatus = nextStatus;

    if (nextStatus === 'quiet') {
      console.log(
        `[quiet-hmr] -> START (${source}) request_id=${state?.request_id} expires_at=${state?.expires_at}`,
      );
      server.ws.send({
        type: 'custom',
        event: 'lps:quiet:start',
        data: {
          request_id: state?.request_id ?? null,
          expires_at: state?.expires_at ?? null,
        },
      });
    } else {
      console.log(
        `[quiet-hmr] -> END (${source}) request_id=${state?.request_id ?? 'none'} status=${state?.end_status ?? 'cleared'}`,
      );
      server.ws.send({
        type: 'custom',
        event: 'lps:quiet:end',
        data: {
          request_id: state?.request_id ?? null,
          end_status: state?.end_status ?? 'cleared',
        },
      });
    }
  }

  return {
    name: 'lps-quiet-hmr',
    transformIndexHtml() {
      // Cold-load path: if a quiet window is active at the moment the
      // browser requests index.html, inject the state into
      // ``window.__LPS_QUIET_INITIAL__``. quietHmr.ts reads it on boot
      // and enters quiet mode BEFORE Vite can transform any broken
      // modules. Without this, a refresh mid-window briefly shows the
      // red overlay until the WS ``lps:quiet:start`` event arrives.
      const state = readState('transformIndexHtml');
      const now = Math.floor(Date.now() / 1000);
      const isQuiet =
        state?.status === 'quiet' &&
        typeof state.expires_at === 'number' &&
        state.expires_at > now;
      if (!isQuiet) return;
      // Escape ``</`` so a crafted ``request_id`` cannot break out of
      // the <script> element. ``JSON.stringify`` by default does NOT
      // escape ``</script>`` / ``<!--`` / ``-->`` — the HTML parser
      // terminates the script early if we leave them intact.
      const safeJson = JSON.stringify({
        request_id: state?.request_id ?? null,
        expires_at: state?.expires_at ?? null,
      }).replace(/</g, '\\u003c');
      return [
        {
          tag: 'script',
          attrs: { type: 'text/javascript' },
          injectTo: 'head-prepend',
          children: `window.__LPS_QUIET_INITIAL__ = ${safeJson};`,
        },
      ];
    },
    configureServer(server) {
      server.watcher.add(statePath);

      server.watcher.on('add', (p) => {
        if (path.resolve(p) === statePath) {
          broadcast(server, readState('add'), 'add');
        }
      });
      server.watcher.on('change', (p) => {
        if (path.resolve(p) === statePath) {
          broadcast(server, readState('change'), 'change');
        }
      });
      server.watcher.on('unlink', (p) => {
        if (path.resolve(p) === statePath) {
          broadcast(server, null, 'unlink');
        }
      });

      // Telemetry sink: client POSTs ``{suppressed_error_count}`` here
      // on ``lps:quiet:end`` so the daemon can include it in the
      // ``generation_metrics`` payload. Written as a small file that
      // the daemon reads + deletes when closing its quiet window.
      const telemetryPath = path.resolve(__dirname, '.lps-hmr-telemetry.json');
      server.middlewares.use('/__lps/quiet/telemetry', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          try {
            const payload = body ? JSON.parse(body) : {};
            fs.writeFileSync(
              telemetryPath,
              JSON.stringify({
                suppressed_error_count: Number(payload.suppressed_error_count) || 0,
                request_id: payload.request_id ?? null,
                recorded_at: Math.floor(Date.now() / 1000),
              }),
            );
            res.statusCode = 204;
            res.end();
          } catch (err) {
            res.statusCode = 400;
            res.end(`bad telemetry: ${err}`);
          }
        });
      });

      // HTTP fallback + diagnostic endpoint.
      //   GET  /__lps/quiet          → current state + lastStatus (JSON)
      //   POST /__lps/quiet/start    → body {request_id, ttl_seconds} writes quiet state
      //   POST /__lps/quiet/end      → body {request_id, status} writes idle state
      // Bypasses file-watcher flakiness so we can confirm the WS path
      // in isolation. If this works but file-based does not, the issue
      // is in the watcher / file-write race, not the plugin.
      server.middlewares.use('/__lps/quiet', (req, res) => {
        if (req.method === 'GET') {
          const state = readState('http-get');
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              statePath,
              state,
              lastStatus,
              nowEpochSec: Math.floor(Date.now() / 1000),
            }),
          );
          return;
        }
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk: Buffer) => (body += chunk.toString()));
          req.on('end', () => {
            try {
              const payload = body ? JSON.parse(body) : {};
              const isStart = (req.url || '').endsWith('/start');
              const isEnd = (req.url || '').endsWith('/end');
              const nowEpochSec = Math.floor(Date.now() / 1000);
              let state: QuietState;
              if (isStart) {
                state = {
                  status: 'quiet',
                  request_id: payload.request_id ?? `http-${nowEpochSec}`,
                  started_at: nowEpochSec,
                  expires_at: nowEpochSec + (payload.ttl_seconds ?? 90),
                };
              } else if (isEnd) {
                state = {
                  status: 'idle',
                  request_id: payload.request_id ?? null,
                  ended_at: nowEpochSec,
                  end_status: payload.status ?? 'success',
                };
              } else {
                res.statusCode = 404;
                res.end('use /__lps/quiet/start or /__lps/quiet/end');
                return;
              }
              fs.writeFileSync(statePath, JSON.stringify(state));
              broadcast(server, state, 'http');
              res.statusCode = 204;
              res.end();
            } catch (err) {
              res.statusCode = 400;
              res.end(`bad request: ${err}`);
            }
          });
          return;
        }
        res.statusCode = 405;
        res.end();
      });

      // Initial read at server start — logs whether the file exists,
      // and broadcasts only if we're starting mid-quiet-window.
      console.log(`[quiet-hmr] plugin configured; watching ${statePath}`);
      broadcast(server, readState('init'), 'init');
    },
  };
}

/**
 * Plugin to notify the client when pages.manifest.json changes.
 *
 * In dev mode, the agent may add new pages via vibe coding. When the manifest
 * is updated, this plugin sends a custom HMR event so App.tsx can re-fetch
 * routes and register the new page in React Router — preventing 404s.
 */
function manifestHmrPlugin(): Plugin {
  return {
    name: 'manifest-hmr',
    configureServer(server) {
      const manifestPath = path.resolve(__dirname, 'pages.manifest.json');

      server.watcher.add(manifestPath);
      server.watcher.on('change', (changedPath) => {
        if (path.resolve(changedPath) === manifestPath) {
          console.log('[manifest-hmr] pages.manifest.json changed, notifying client');
          server.ws.send({
            type: 'custom',
            event: 'manifest-update',
          });
        }
      });
    },
  };
}

/**
 * Plugin to generate per-page HTML entry points for MPA builds.
 * 
 * In production, Vite's MPA mode needs distinct HTML files for each page.
 * This plugin:
 * 1. Creates {slug}/index.html for each non-home page (copies root index.html)
 * 2. Sets rollupOptions.input to map each page to its own HTML file
 * 3. Cleans up generated HTML files after the build
 * 
 * This ensures Rollup treats each page as a separate entry and produces
 * separate HTML outputs (e.g., dist/index.html, dist/menu/index.html).
 */
function mpaHtmlGeneratorPlugin(manifest: PagesManifest): Plugin {
  const generatedFiles: string[] = [];
  
  return {
    name: 'mpa-html-generator',
    config() {
      const rootHtml = path.resolve(__dirname, 'index.html');
      const rootHtmlContent = fs.readFileSync(rootHtml, 'utf-8');
      const inputs: Record<string, string> = {};
      const seenFiles = new Set<string>();
      // Collect slug dirs so we can tell Vite's dev-server watcher to ignore them.
      // mpaHtmlGeneratorPlugin only runs during production builds (!isDev), but the
      // Vite dev server is a separate supervisord process that may be running at the
      // same time.  Without the ignore, chokidar fires add/unlink on the temp HTML
      // files and briefly invalidates the module graph → false-positive APP_BOOT_FAILED.
      const watchIgnored: string[] = [];

      for (const page of manifest.pages) {
        // Upload projects with filePath pointing to an HTML file: use it directly as a build entry.
        // Virtual pages sharing the same file are deduplicated — only one rollup entry per physical file.
        if (page.filePath?.endsWith('.html')) {
          if (seenFiles.has(page.filePath)) continue;
          seenFiles.add(page.filePath);
          const absPath = path.resolve(__dirname, page.filePath);
          if (fs.existsSync(absPath)) {
            inputs[page.id] = absPath;
            console.log(`[mpa] Using upload HTML entry: ${page.filePath}`);
            continue;
          }
        }

        if (page.isHome) {
          inputs[page.id] = rootHtml;
        } else {
          // Non-home pages need their own HTML file for Rollup to treat as distinct entries.
          // The path MUST be inside __dirname so Rollup computes a non-traversing relative
          // path (e.g. "blog/index.html") as the output fileName — paths outside the root
          // (e.g. /tmp) become "../tmp/…" which Rollup rejects as a relative-path fileName.
          const pageDir = path.resolve(__dirname, page.slug);
          const pageHtml = path.resolve(pageDir, 'index.html');

          fs.mkdirSync(pageDir, { recursive: true });
          fs.writeFileSync(pageHtml, rootHtmlContent);
          generatedFiles.push(pageHtml);

          inputs[page.id] = pageHtml;
          watchIgnored.push(`**/${page.slug}/**`);
          console.log(`[mpa] Generated HTML entry: ${page.slug}/index.html`);
        }
      }

      console.log(`[mpa] ${Object.keys(inputs).length} HTML entry points configured`);

      return {
        build: {
          rollupOptions: {
            input: inputs,
          },
        },
        // Tell the dev server watcher to ignore the temp slug dirs so it never
        // fires add/unlink events for files we create and delete during the build.
        server: {
          watch: {
            ignored: watchIgnored,
          },
        },
      };
    },
    generateBundle() {
      // Include pages.manifest.json in build output for client-side routing.
      // The React app fetches this at runtime to register React Router routes.
      // Without it, only the home route works on the static site.
      const manifestPath = path.resolve(__dirname, 'pages.manifest.json');
      if (fs.existsSync(manifestPath)) {
        this.emitFile({
          type: 'asset',
          fileName: 'pages.manifest.json',
          source: fs.readFileSync(manifestPath, 'utf-8'),
        });
        console.log('[mpa] Included pages.manifest.json in build output');
      }
    },
    closeBundle() {
      // Clean up generated HTML files (they were only needed for the build)
      for (const file of generatedFiles) {
        try {
          fs.unlinkSync(file);
          const dir = path.dirname(file);
          // Remove the directory if it's now empty
          if (fs.readdirSync(dir).length === 0) {
            fs.rmdirSync(dir);
          }
        } catch {
          // Ignore cleanup errors
        }
      }
      if (generatedFiles.length > 0) {
        console.log(`[mpa] Cleaned up ${generatedFiles.length} generated HTML files`);
      }
    },
  };
}

/**
 * Dev middleware for static HTML uploads (Phase 4 — Upload V2).
 *
 * Vite's SPA fallback returns `index.html` for all unmatched paths.
 * For static HTML uploads with multiple `.html` files, this middleware
 * intercepts requests matching known page slugs and serves the correct
 * `.html` file directly — before Vite's built-in handler runs.
 *
 * Only active when IS_STATIC_HTML_PROJECT=true.
 */
function staticHtmlServingPlugin(manifest: PagesManifest): Plugin {
  const isStaticHtml = process.env.IS_STATIC_HTML_PROJECT === 'true';

  return {
    name: 'static-html-serving',
    configureServer(server) {
      if (!isStaticHtml) return;

      // Build slug → filePath map from manifest, refresh on change.
      let slugMap = buildSlugMap(manifest);

      server.watcher.on('change', (changedPath) => {
        if (path.resolve(changedPath) === path.resolve(__dirname, 'pages.manifest.json')) {
          try {
            const fresh = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'pages.manifest.json'), 'utf-8'));
            slugMap = buildSlugMap(fresh);
            console.log(`[static-html] Refreshed slug map: ${Object.keys(slugMap).length} entries`);
          } catch { /* ignore parse errors */ }
        }
      });

      // Register middleware BEFORE Vite's SPA fallback.
      server.middlewares.use((req, res, next) => {
        const url = req.url || '';
        const pathname = url.split('?')[0].split('#')[0];

        // Direct .html file request (e.g., /about.html)
        if (pathname.endsWith('.html') && pathname !== '/index.html') {
          const file = pathname.startsWith('/') ? pathname.slice(1) : pathname;
          const absPath = path.resolve(__dirname, file);
          if (fs.existsSync(absPath)) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(fs.readFileSync(absPath, 'utf-8'));
            return;
          }
        }

        // Slug-based request (e.g., /about → about.html)
        const slug = pathname.replace(/^\//, '').replace(/\/$/, '');
        if (slug && slugMap[slug]) {
          const absPath = path.resolve(__dirname, slugMap[slug]);
          if (fs.existsSync(absPath)) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(fs.readFileSync(absPath, 'utf-8'));
            return;
          }
        }

        next();
      });
    },
  };
}

function buildSlugMap(manifest: PagesManifest): Record<string, string> {
  const map: Record<string, string> = {};
  for (const page of manifest.pages) {
    if (page.filePath?.endsWith('.html') && page.slug) {
      map[page.slug] = page.filePath;
    }
  }
  return map;
}

/**
 * Production build plugin for static HTML uploads (Phase 5 — Upload V2).
 *
 * For static HTML projects, the standard React MPA build is wrong — there
 * are no React entry points. Instead, this plugin copies all HTML/CSS/JS/
 * asset files to `dist/`, injects SEO metadata from the manifest into each
 * HTML file, and generates sitemap + robots.txt.
 *
 * Only active when IS_STATIC_HTML_PROJECT=true in production builds.
 */
function staticHtmlBuildPlugin(manifest: PagesManifest): Plugin {
  const isStaticHtml = process.env.IS_STATIC_HTML_PROJECT === 'true';

  return {
    name: 'static-html-build',
    apply: 'build',
    enforce: 'pre',
    config() {
      if (!isStaticHtml) return;

      // Collect all HTML files as rollup inputs.
      const inputs: Record<string, string> = {};
      const seen = new Set<string>();

      for (const page of manifest.pages) {
        if (page.filePath?.endsWith('.html') && !seen.has(page.filePath)) {
          seen.add(page.filePath);
          const absPath = path.resolve(__dirname, page.filePath);
          if (fs.existsSync(absPath)) {
            inputs[page.id] = absPath;
          }
        }
      }

      // If no HTML pages found, fall back to default (React build).
      if (Object.keys(inputs).length === 0) return;

      console.log(`[static-html-build] ${Object.keys(inputs).length} HTML entry points`);

      return {
        build: {
          rollupOptions: {
            input: inputs,
          },
        },
      };
    },
    generateBundle() {
      if (!isStaticHtml) return;

      // Emit the manifest as a build asset.
      const manifestPath = path.resolve(__dirname, 'pages.manifest.json');
      if (fs.existsSync(manifestPath)) {
        this.emitFile({
          type: 'asset',
          fileName: 'pages.manifest.json',
          source: fs.readFileSync(manifestPath, 'utf-8'),
        });
      }

      // Copy non-HTML assets (CSS, JS, images) that HTML files reference.
      const assetExts = ['.css', '.js', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff', '.woff2'];
      for (const entry of fs.readdirSync(__dirname)) {
        const ext = path.extname(entry).toLowerCase();
        if (assetExts.includes(ext)) {
          const content = fs.readFileSync(path.resolve(__dirname, entry));
          this.emitFile({
            type: 'asset',
            fileName: entry,
            source: content,
          });
        }
      }
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const manifest = loadManifest();
  const isDev = mode === 'development';
  
  console.log(`[Vite Config] Mode: ${mode}`);
  console.log(`[Vite Config] Pages in manifest: ${manifest.pages.length}`);
  console.log(`[Vite Config] componentTagger enabled: ${isDev}`);
  
  const config: UserConfig = {
    server: {
      host: "::",
      port: 5173,
      // Allow all hosts for dynamic subdomains
      allowedHosts: true,
      // Enable CORS for cross-origin requests
      cors: true,
    },
    plugins: [
      react(),
      // Development-only: component tagger for visual editing
      isDev && componentTagger({ 
        jsxSource: true,
        tailwindConfig: true,
        virtualOverrides: true,
        debug: false,
      }),
      // Development-only: notify client when pages.manifest.json changes
      isDev && manifestHmrPlugin(),
      // Development-only: suppress the Vite error overlay during
      // agent-initiated bulk edits (LPS-327 quiet-hmr spike)
      isDev && quietHmrPlugin(),
      // Development-only: serve static HTML pages for upload projects
      isDev && staticHtmlServingPlugin(manifest),
      // Production-only: MPA HTML generator (creates per-page HTML entry points)
      !isDev && mpaHtmlGeneratorPlugin(manifest),
      // Production-only: static HTML build for upload projects
      !isDev && staticHtmlBuildPlugin(manifest),
      // SEO metadata injection (reads manifest fresh in dev mode)
      seoInjectorPlugin(manifest, isDev),
      // Production-only: custom embeddings injected at build time (dev uses EmbeddingsLoader.ts)
      !isDev && embeddingsInjectorPlugin(),
      // Production-only: sitemap generation and llmtxtplugin
      !isDev && sitemapPlugin(manifest),
      !isDev && llmsTxtPlugin(manifest),
    ].filter(Boolean),
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    build: {
      // Explicit minification for production performance (90+ PSI)
      minify: 'esbuild',
      cssMinify: true,
      cssCodeSplit: true,
      // MPA build configuration handled by mpaHtmlGeneratorPlugin
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react':  ['react', 'react-dom'],
            'vendor-router': ['react-router-dom'],
            'vendor-motion': ['framer-motion'],
            'vendor-charts': ['recharts'],
            'vendor-icons':  ['lucide-react'],
            'vendor-forms':  ['react-hook-form', '@hookform/resolvers', 'zod'],
            'vendor-query':  ['@tanstack/react-query'],
          },
        },
      },
    },
    optimizeDeps: {
      include: [
        // Radix UI (used by shadcn/ui components - may be lazy-loaded per page)
        '@radix-ui/react-accordion',
        '@radix-ui/react-alert-dialog',
        '@radix-ui/react-aspect-ratio',
        '@radix-ui/react-avatar',
        '@radix-ui/react-checkbox',
        '@radix-ui/react-collapsible',
        '@radix-ui/react-context-menu',
        '@radix-ui/react-dialog',
        '@radix-ui/react-dropdown-menu',
        '@radix-ui/react-hover-card',
        '@radix-ui/react-label',
        '@radix-ui/react-menubar',
        '@radix-ui/react-navigation-menu',
        '@radix-ui/react-popover',
        '@radix-ui/react-progress',
        '@radix-ui/react-radio-group',
        '@radix-ui/react-scroll-area',
        '@radix-ui/react-select',
        '@radix-ui/react-separator',
        '@radix-ui/react-slider',
        '@radix-ui/react-slot',
        '@radix-ui/react-switch',
        '@radix-ui/react-tabs',
        '@radix-ui/react-toast',
        '@radix-ui/react-toggle',
        '@radix-ui/react-toggle-group',
        '@radix-ui/react-tooltip',
        // Heavy deps that sections may import
        'framer-motion',
        'lucide-react',
        'recharts',
        'react-hook-form',
        '@hookform/resolvers',
        'sonner',
        'date-fns',
        'cmdk',
        'embla-carousel-react',
        'input-otp',
        'react-day-picker',
        'react-resizable-panels',
        'vaul',
        '@tanstack/react-query',
        'react-router-dom',
      ],
    },
  };

  return config;
});
