/** The closed page and asset route tables (WP14, D46).
 *
 * Extracted from server.ts so a check can build the tables both ways and
 * assert the ungated one contains no bridge route — server.ts itself listens
 * on import, so a check can never import it (the convention documented in
 * session-admin.check.ts). server.ts holds the only caller.
 *
 * WHY A CLOSED MAP AT ALL: `join(HERE, "public", url.pathname)` is a
 * directory-traversal read of this user's whole filesystem waiting for one
 * missing normalisation. There are two pages and there is no reason for the
 * set to be open.
 *
 * `/` is the application shell (WP4). `/bridge` is the raw event view WP0–WP3
 * were proven on. The shell drives turns and answers permission requests
 * itself since WP5/WP6; the bridge survives as a development surface only,
 * and D46 rules it must never ship in a public release — so it is in these
 * tables only when STUDIO_DEV=1. Without the flag, /bridge, /bridge.css and
 * /bridge.js 404 like any unknown path: not a redirect, not a stub page, and
 * no served assets either — a gated page with served assets would still be a
 * surface.
 */

/** Every HTML document the server will serve, and the only ones. */
export function buildPageMap(dev: boolean): Map<string, string> {
  const pages = new Map<string, string>([
    ["/", "index.html"],
    ["/index.html", "index.html"],
  ]);
  if (dev) pages.set("/bridge", "bridge.html");
  return pages;
}

/** The stylesheet and the script for each page, and the only other files the
    server will read out of `public/`. Same closed-map reasoning as the pages. */
export function buildAssetMap(dev: boolean): Map<string, { file: string; type: string }> {
  const assets = new Map<string, { file: string; type: string }>([
    ["/app.css", { file: "app.css", type: "text/css; charset=utf-8" }],
    ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ]);
  if (dev) {
    assets.set("/bridge.css", { file: "bridge.css", type: "text/css; charset=utf-8" });
    assets.set("/bridge.js", { file: "bridge.js", type: "text/javascript; charset=utf-8" });
  }
  return assets;
}
