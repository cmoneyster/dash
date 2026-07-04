import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

// The Open Graph share image is intentionally sourced from
// `attached_assets/` rather than `artifacts/catering-web/public/`. JPEGs
// placed inside an artifact's `public/` get silently re-encoded by the
// surrounding asset pipeline, which causes a 1-byte drift on the file
// in every unrelated commit (see Task #155). Serving the canonical
// image from outside `public/` keeps the URL `/opengraph.jpg` stable
// while leaving nothing in `public/` for the encoder to mutate.
const ogImageSourcePath = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "attached_assets",
  "catering-web-opengraph.jpg",
);
const ogImageRelativePath = "opengraph.jpg";

type RoutePrerender = { path: string; title: string; description: string };

const PUBLIC_ROUTES: RoutePrerender[] = [
  {
    path: "menu",
    title: "Full Catering Menu — dash by Hollywood East Cafe",
    description:
      "Browse our complete catering menu of Chinese-American dishes — appetizers, entrées, rice, noodles, and more. Filter by category or build your event plan online.",
  },
  {
    path: "gallery",
    title: "Event Gallery — dash by Hollywood East Cafe",
    description:
      "See photos from real events catered by dash — corporate lunches, birthday parties, weddings, and more in the Maryland area.",
  },
  {
    path: "plan",
    title: "Plan Your Event — dash by Hollywood East Cafe",
    description:
      "Build your custom event menu, set your guest count, and request a catering quote from dash by Hollywood East Cafe — all online, no phone call required.",
  },
  {
    path: "plan/preview",
    title: "Event Plan Preview — dash by Hollywood East Cafe",
    description:
      "Preview and share your curated catering event plan from dash by Hollywood East Cafe.",
  },
];

function prerenderPlugin(outRoot: string): Plugin {
  return {
    name: "catering-web:prerender",
    apply: "build",
    closeBundle() {
      const indexPath = path.join(outRoot, "index.html");
      if (!fs.existsSync(indexPath)) return;
      const template = fs.readFileSync(indexPath, "utf-8");
      for (const route of PUBLIC_ROUTES) {
        const dir = path.join(outRoot, ...route.path.split("/"));
        fs.mkdirSync(dir, { recursive: true });
        const html = template
          .replace(/<title>[^<]*<\/title>/, `<title>${route.title}</title>`)
          .replace(
            /(<meta name="description" content=")[^"]*(")/,
            `$1${route.description}$2`,
          )
          .replace(
            /(<meta property="og:title" content=")[^"]*(")/,
            `$1${route.title}$2`,
          )
          .replace(
            /(<meta property="og:description" content=")[^"]*(")/,
            `$1${route.description}$2`,
          )
          .replace(
            /(<meta name="twitter:title" content=")[^"]*(")/,
            `$1${route.title}$2`,
          )
          .replace(
            /(<meta name="twitter:description" content=")[^"]*(")/,
            `$1${route.description}$2`,
          );
        fs.writeFileSync(path.join(dir, "index.html"), html);
      }
    },
  };
}

function ogImagePlugin(basePathPrefix: string): Plugin {
  // Accept both the bare URL and the BASE_PATH-prefixed URL so the
  // middleware works regardless of whether this artifact is mounted at
  // `/` or under a sub-path in dev.
  const normalizedBase = basePathPrefix.endsWith("/")
    ? basePathPrefix
    : `${basePathPrefix}/`;
  const servedPaths = new Set<string>([
    `/${ogImageRelativePath}`,
    `${normalizedBase}${ogImageRelativePath}`,
  ]);

  return {
    name: "catering-web:og-image",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url) {
          next();
          return;
        }
        const url = req.url.split("?")[0];
        if (!servedPaths.has(url)) {
          next();
          return;
        }
        try {
          const buf = fs.readFileSync(ogImageSourcePath);
          res.setHeader("Content-Type", "image/jpeg");
          res.setHeader("Content-Length", String(buf.length));
          res.setHeader("Cache-Control", "public, max-age=86400");
          res.end(buf);
        } catch (err) {
          next(err as Error);
        }
      });
    },
    closeBundle() {
      const outDir = path.resolve(import.meta.dirname, "dist", "public");
      fs.mkdirSync(outDir, { recursive: true });
      const destPath = path.join(outDir, ogImageRelativePath);
      fs.copyFileSync(ogImageSourcePath, destPath);
      if (!fs.existsSync(destPath)) {
        throw new Error(
          `og-image plugin failed to emit ${destPath} during build`,
        );
      }
    },
  };
}

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ogImagePlugin(basePath),
    prerenderPlugin(path.resolve(import.meta.dirname, "dist/public")),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
