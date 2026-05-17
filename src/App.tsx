/**
 * Main Application Component
 * 
 * Handles routing for all pages defined in pages.manifest.json.
 * In development, uses React Router for SPA navigation.
 * In production, each page has its own HTML entry point.
 */

import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from "react-router-dom";
import { Suspense, lazy, useEffect, useState, useCallback, ComponentType } from "react";
import { initRouteNotifier } from "@/lib/routeNotifier";
import ErrorBoundary from "@/components/ErrorBoundary";
import SectionErrorBoundary from "@/components/SectionErrorBoundary";
import { useSeoMeta } from "@/hooks/useSeoMeta";

// Static page imports (always available)
import Index from "./pages/Index";
import NotFound from "./pages/NotFound";

// Loading component for lazy-loaded pages
const PageLoader = () => (
  <div className="min-h-screen flex items-center justify-center">
    <div className="animate-pulse text-muted-foreground">Loading...</div>
  </div>
);

const queryClient = new QueryClient();

/**
 * Cache for lazy-loaded page components.
 * This prevents creating new lazy() components on every render,
 * which would cause infinite remount loops.
 */
const lazyPageCache = new Map<string, ComponentType>();

/**
 * Get or create a lazy-loaded page component for a slug.
 * Uses a cache to ensure the same component instance is returned for the same slug.
 */
function getLazyPageComponent(slug: string, filePath?: string): ComponentType {
  const cacheKey = filePath || slug;
  if (lazyPageCache.has(cacheKey)) {
    return lazyPageCache.get(cacheKey)!;
  }

  const LazyPage = lazy(async () => {
    // When filePath is provided (upload projects), import directly from that path
    if (filePath) {
      try {
        const importPath = filePath.startsWith('src/') ? `./${filePath.slice(4)}` : `./${filePath}`;
        return await import(/* @vite-ignore */ importPath);
      } catch {
        console.warn(`[Router] Failed to import from filePath: ${filePath}, falling back to convention`);
      }
    }

    // Convention-based resolution: convert slug to PascalCase component name
    const componentName = slug
      .split(/[-/]/)
      .filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');

    try {
      return await import(`./pages/${componentName}.tsx`);
    } catch {
      try {
        return await import(`./pages/${slug.charAt(0).toUpperCase() + slug.slice(1)}.tsx`);
      } catch {
        if (!slug.includes('-') && slug.length <= 5) {
          try {
            return await import(`./pages/${slug.toUpperCase()}.tsx`);
          } catch {
            // fall through to NotFound
          }
        }
        console.warn(`[Router] Page component not found for slug: ${slug}`);
        return { default: NotFound };
      }
    }
  });

  lazyPageCache.set(cacheKey, LazyPage);
  return LazyPage;
}

/**
 * Wrapper component that renders a lazy-loaded page with Suspense.
 */
function LazyPageWrapper({ slug, filePath }: { slug: string; filePath?: string }) {
  const LazyPage = getLazyPageComponent(slug, filePath);
  return (
    <Suspense fallback={<PageLoader />}>
      <LazyPage />
    </Suspense>
  );
}

/**
 * Load page routes from manifest.
 * Returns array of route objects for React Router.
 */
interface PageRoute {
  path: string;
  slug: string;
  isHome: boolean;
  filePath?: string;
}

async function loadPageRoutes(): Promise<PageRoute[]> {
  try {
    const response = await fetch('/pages.manifest.json');
    if (response.ok) {
      const manifest = await response.json();
      return manifest.pages.map((page: { slug: string; isHome: boolean; filePath?: string }) => ({
        path: page.isHome ? '/' : `/${page.slug}`,
        slug: page.slug,
        isHome: page.isHome,
        filePath: page.filePath,
      }));
    }
  } catch (error) {
    console.warn('[Router] Failed to load manifest, using default routes:', error);
  }
  
  // Default to single home page
  return [{ path: '/', slug: '', isHome: true }];
}

/**
 * Inner app component that handles SEO and routing.
 * Must be inside BrowserRouter to use useLocation-based hooks.
 */
function AppRoutes({ routes }: { routes: PageRoute[] }) {
  // Update page title and meta tags on route change
  useSeoMeta();

  // Normalize path to lowercase (handles case-insensitive navigation)
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const lowercasePath = location.pathname.toLowerCase();
    if (location.pathname !== lowercasePath) {
      navigate(lowercasePath + location.search, { replace: true });
    }
  }, [location, navigate]);

  return (
    <Routes>
      {/* Home page - always uses Index component */}
      <Route path="/" element={<ErrorBoundary><Index /></ErrorBoundary>} />

      {/* Dynamic routes for other pages — each wrapped in its own ErrorBoundary */}
      {routes
        .filter(route => !route.isHome && route.slug && !route.filePath?.endsWith('.html'))
        .map(route => (
          <Route
            key={route.path}
            path={route.path}
            element={<ErrorBoundary><LazyPageWrapper slug={route.slug} filePath={route.filePath} /></ErrorBoundary>}
          />
        ))
      }

      {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

/**
 * Preload all non-home page chunks so Suspense fallback never shows during navigation.
 * No-op for landing pages (single home page only).
 */
function preloadPageChunks(routes: PageRoute[]) {
  routes
    .filter(r => !r.isHome && r.slug && !r.filePath?.endsWith('.html'))
    .forEach(route => {
      if (route.filePath) {
        const importPath = route.filePath.startsWith('src/') ? `./${route.filePath.slice(4)}` : `./${route.filePath}`;
        import(/* @vite-ignore */ importPath).catch(() => {});
        return;
      }
      const componentName = route.slug
        .split(/[-/]/)
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
      import(`./pages/${componentName}.tsx`).catch(() => {
        import(`./pages/${route.slug.charAt(0).toUpperCase() + route.slug.slice(1)}.tsx`).catch(() => {});
      });
    });
}

/**
 * Intercepts clicks on plain <a> tags for internal routes and converts them
 * to React Router SPA navigation. Prevents full page reloads when AI-generated
 * components use <a href="/path"> instead of <Link to="/path">.
 */
function LinkInterceptor({ routes }: { routes: PageRoute[] }) {
  const navigate = useNavigate();

  useEffect(() => {
    const htmlPaths = new Set(routes.filter(r => r.filePath?.endsWith('.html')).map(r => r.path));
    const knownPaths = new Set(routes.filter(r => !htmlPaths.has(r.path)).map(r => r.path));

    function handleClick(e: MouseEvent) {
      // Skip if already handled (e.g., React Router <Link> already called preventDefault)
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;

      const anchor = (e.target as HTMLElement).closest('a');
      if (!anchor) return;
      if (anchor.target === '_blank' || anchor.hasAttribute('download')) return;

      const href = anchor.getAttribute('href');
      if (!href) return;
      if (/^(mailto:|tel:|javascript:|blob:|data:)/.test(href)) return;
      if (href.startsWith('#')) return;

      try {
        const url = new URL(href, window.location.origin);
        if (url.origin !== window.location.origin) return;

        const pathname = url.pathname.toLowerCase().replace(/\/$/, '') || '/';
        if (knownPaths.has(pathname)) {
          e.preventDefault();
          navigate(pathname + url.search + url.hash);
        }
      } catch {
        return;
      }
    }

    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [routes, navigate]);

  return null;
}

/**
 * Resets scroll position to the top whenever the route changes.
 */
function ScrollToTop() {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return null;
}

/**
 * Listens for NAVIGATE_TO_PAGE postMessages from the parent frame
 * and performs SPA navigation via React Router (no full reload).
 */
function ParentNavigationListener() {
  const navigate = useNavigate();

  useEffect(() => {
    if (window === window.parent) return; // Not in iframe

    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type === 'NAVIGATE_TO_PAGE' && message.payload?.path) {
        navigate(message.payload.path);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [navigate]);

  return null;
}

/**
 * Wraps ErrorBoundary with a route-aware resetKey so that navigating to a
 * different page clears the error state instead of leaving the whole
 * app stuck on the "Something went wrong" screen.
 */
function RouteErrorBoundary({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  return <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>;
}

const App = () => {
  const [routes, setRoutes] = useState<PageRoute[]>([
    { path: '/', slug: '', isHome: true }
  ]);
  const [isLoading, setIsLoading] = useState(true);

  const refreshRoutes = useCallback(() => {
    loadPageRoutes().then((loadedRoutes) => {
      setRoutes(loadedRoutes);
      setIsLoading(false);
    });
  }, []);

  useEffect(() => {
    refreshRoutes();
  }, [refreshRoutes]);

  // Re-fetch routes when pages.manifest.json changes (dev mode HMR)
  useEffect(() => {
    if (import.meta.hot) {
      import.meta.hot.on('manifest-update', refreshRoutes);
    }
  }, [refreshRoutes]);

  // Preload non-home page chunks so navigation is instant (no Suspense flash)
  useEffect(() => {
    if (!isLoading) preloadPageChunks(routes);
  }, [isLoading, routes]);

  // Initialize route notifier to sync page changes with parent
  useEffect(() => {
    initRouteNotifier();
  }, []);

  // Signal to parent frame that the app has rendered
  useEffect(() => {
    window.parent.postMessage({ type: 'APP_RENDERED' }, '*');
  }, []);

  if (isLoading) {
    return <PageLoader />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter
          future={{
            v7_startTransition: true,
            v7_relativeSplatPath: true
          }}
        >
          <ScrollToTop />
          <ParentNavigationListener />
          <LinkInterceptor routes={routes} />
          <RouteErrorBoundary>
            <AppRoutes routes={routes} />
          </RouteErrorBoundary>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;
