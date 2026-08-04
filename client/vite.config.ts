import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Dev-only screenshot sink.
 *
 * A WebGPU canvas can only be captured by the browser's compositor when the
 * window is actually on screen, which makes verifying the render from a headless
 * or backgrounded context unreliable -- you get the last composited frame, not
 * the current one. This lets the page read its own pixels back and POST them, so
 * a frame can be captured and inspected regardless of window state.
 *
 * Dev server only; it is not part of the production build.
 */
function screenshotSink(): Plugin {
  const outDir = resolve(process.cwd(), '.shots');
  return {
    name: 'sydney-screenshot-sink',
    apply: 'serve',
    configureServer(server) {
      mkdirSync(outDir, { recursive: true });
      server.middlewares.use('/__shot', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c as Buffer));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              name?: string;
              data: string;
            };
            // Reject path traversal in the caller-supplied name.
            const safe = (body.name ?? 'shot').replace(/[^a-z0-9._-]/gi, '_');
            const ext = body.data.startsWith('data:image/png') ? 'png' : 'jpg';
            const base64 = body.data.slice(body.data.indexOf(',') + 1);
            const file = resolve(outDir, `${safe}.${ext}`);
            writeFileSync(file, Buffer.from(base64, 'base64'));
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, file }));
          } catch (err) {
            res.statusCode = 400;
            res.end(String(err));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [screenshotSink()],
  server: {
    port: 5173,
    // World tiles are large static files served from public/; no transform needed.
    fs: { strict: false },
  },
  build: {
    target: 'esnext', // top-level await, and WebGPU is only in modern engines anyway
    sourcemap: true,
  },
  // Tile payloads are fetched at runtime, never bundled.
  assetsInclude: ['**/*.glb', '**/*.bin'],
});
