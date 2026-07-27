// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Brand registry for the Worker-rendered pages (login, admin, bulk, landing,
// OAuth consent, quiz). One shared codebase serves multiple brands; the active
// brand is selected at runtime by the `BRAND` env var and resolved via
// `resolveBrand(env.BRAND)` (unset/unknown → whispyr, so a missing var can never
// break the live portal). Each brand fully declares its own palette, font, mark,
// and wordmark. Brand assets are served statically from public/ (fonts/, *.svg).
//
// Two brand seams are kept in sync by hand: this module (server HTML pages) and
// app/index.css (the React SPA, via `:root[data-brand="..."]`).

export type Brand = "whispyr" | "wiser";

export type BrandConfig = {
	/** Stable brand id — also the `data-brand` value on the SPA `<html>`. */
	id: Brand;
	/** Wordmark text. */
	name: string;
	/** Page-title brand, e.g. "Whispyr Mail". */
	appName: string;
	/** Logo mark asset path (served from public/). */
	mark: string;
	/** Modern SVG favicon asset path. */
	favicon: string;
	/** Install and connector PNGs. */
	pwaIcon192: string;
	pwaIcon512: string;
	/** Home-screen icon used by Apple devices. */
	appleTouchIcon: string;
	/** Monochrome-capable notification badge. */
	notificationBadge: string;
	/** Raster fallback for browsers that do not use the SVG favicon. */
	legacyFavicon: string;
	legacyFaviconType: "image/png" | "image/x-icon";
	legacyFaviconSizes: string;
	markWidth: number;
	markHeight: number;
	/** Marketing site (MCP/OAuth metadata). */
	websiteUrl: string;
	/** Absolute origin of the mail app (MCP/OAuth absolute asset URLs). */
	mailOrigin: string;
	/** `<meta name="theme-color">`. */
	themeColor: string;
	/** CSS font stack. */
	fontFamily: string;
	/** `@font-face` declarations for the brand font. */
	fontFaceCss: string;
	/** The woff2 to `<link rel="preload">`. */
	preloadFont: string;
	/** The brand's `:root` custom-property palette (no font / color-scheme). */
	rootVars: string;
	/** Email-address domain, used in address placeholders. */
	mailDomain: string;
	/** Login-page tagline (shown when not bootstrapping). */
	loginTagline: string;
	/** Login-page footer note. */
	loginNote: string;
	/** Landing-page description (inline HTML allowed). */
	landingBlurb: string;
};

const KAMERIK_FACES = `
@font-face { font-family:"Kamerik 105"; src:url("/fonts/Kamerik105-Light.woff2") format("woff2"); font-weight:300; font-display:swap; }
@font-face { font-family:"Kamerik 105"; src:url("/fonts/Kamerik105-Book.woff2") format("woff2"); font-weight:400; font-display:swap; }
@font-face { font-family:"Kamerik 105"; src:url("/fonts/Kamerik105-Bold.woff2") format("woff2"); font-weight:700; font-display:swap; }`;

const INTER_FACES = `
@font-face { font-family:"Inter"; src:url("/fonts/Inter-Regular.woff2") format("woff2"); font-weight:400; font-display:swap; }
@font-face { font-family:"Inter"; src:url("/fonts/Inter-Medium.woff2") format("woff2"); font-weight:500; font-display:swap; }
@font-face { font-family:"Inter"; src:url("/fonts/Inter-SemiBold.woff2") format("woff2"); font-weight:600; font-display:swap; }
@font-face { font-family:"Inter"; src:url("/fonts/Inter-Bold.woff2") format("woff2"); font-weight:700; font-display:swap; }`;

const BRANDS: Record<Brand, BrandConfig> = {
	// Whispyr — the live production portal. Values reproduce today's look exactly
	// (charcoal ink + charcoal primary actions, warm off-white canvas, Kamerik).
	whispyr: {
		id: "whispyr",
		name: "Whispyr",
		appName: "Whispyr Mail",
		mark: "/whispyr-mark.svg",
		favicon: "/favicon.svg",
		pwaIcon192: "/icon-192.png",
		pwaIcon512: "/icon-512.png",
		appleTouchIcon: "/apple-touch-icon.png",
		notificationBadge: "/favicon-32.png",
		legacyFavicon: "/favicon.ico",
		legacyFaviconType: "image/x-icon",
		legacyFaviconSizes: "48x48 32x32 16x16",
		markWidth: 22,
		markHeight: 36,
		websiteUrl: "https://whispyrai.com",
		mailOrigin: "https://mail.whispyrcrm.com",
		themeColor: "#faf8f5",
		fontFamily: `"Kamerik 105", ui-sans-serif, system-ui, -apple-system, sans-serif`,
		fontFaceCss: KAMERIK_FACES,
		preloadFont: "/fonts/Kamerik105-Book.woff2",
		rootVars: `
  --bg:#fbfaf8; --surface:#ffffff; --charcoal:#1a1a1a; --slate:#3a352f; --muted:#6b6b6b;
  --tint:#f7f3ec; --fill:#f1ebe1;
  --line:rgba(26,26,26,.12); --line-strong:rgba(26,26,26,.20); --ring:rgba(26,26,26,.30);
  --success:#1e6b43; --danger:#b42318;
  --accent:#1a1a1a; --accent-hover:#000000; --accent-fg:#ffffff; --focus-shadow:rgba(26,26,26,.12);`,
		mailDomain: "whispyrcrm.com",
		loginTagline: "Whispyr sales mail portal",
		loginNote: "Whispyr sales team only.",
		landingBlurb: `This is the outreach mail domain for the <strong>Whispyr</strong> sales team. Whispyr is an
    AI-powered sales platform that helps real estate teams close more deals with WhatsApp,
    AI lead scoring, and automated outreach.`,
	},
	// Wiser — the team portal. Reuses the Wiser product's light tokens: olive
	// primary action, warm-cream canvas, near-charcoal ink, Inter. Forced light.
	wiser: {
		id: "wiser",
		name: "Wiser",
		appName: "Wiser Mail",
		mark: "/wiser-mark.svg",
		favicon: "/wiser-mark.svg",
		pwaIcon192: "/wiser-icon-192.png",
		pwaIcon512: "/wiser-icon-512.png",
		appleTouchIcon: "/wiser-apple-touch-icon.png",
		notificationBadge: "/wiser-badge-96.png",
		legacyFavicon: "/wiser-favicon-32.png",
		legacyFaviconType: "image/png",
		legacyFaviconSizes: "32x32",
		markWidth: 30,
		markHeight: 30,
		websiteUrl: "https://wiserchat.ai",
		mailOrigin: "https://mail.wiserchat.ai",
		themeColor: "#f9f7f3",
		fontFamily: `"Inter", ui-sans-serif, system-ui, -apple-system, sans-serif`,
		fontFaceCss: INTER_FACES,
		preloadFont: "/fonts/Inter-Regular.woff2",
		rootVars: `
  --bg:hsl(38 35% 96.5%); --surface:#ffffff; --charcoal:hsl(30 18% 12%); --slate:hsl(30 12% 25%); --muted:hsl(30 10% 42%);
  --tint:hsl(38 28% 93%); --fill:hsl(38 22% 89%);
  --line:hsl(35 18% 87%); --line-strong:hsl(35 16% 80%); --ring:hsl(70 28% 38% / .5);
  --success:#1e6b43; --danger:hsl(8 60% 48%);
  --accent:hsl(70 28% 38%); --accent-hover:hsl(70 28% 31%); --accent-fg:hsl(38 35% 97%); --focus-shadow:hsl(70 28% 38% / .16);`,
		mailDomain: "wiserchat.ai",
		loginTagline: "Wiser team mail",
		loginNote: "Wiser team only.",
		landingBlurb: `This is the internal team mail portal for <strong>Wiser</strong>.`,
	},
};

/**
 * Resolve the active brand from the `BRAND` env var. Case-insensitive; an
 * unset, empty, or unknown value falls back to Whispyr so a missing/typo'd var
 * can never break the live production portal.
 */
export function resolveBrand(value: string | undefined | null): BrandConfig {
	const key = (value ?? "").trim().toLowerCase();
	if (key === "wiser") return BRANDS.wiser;
	return BRANDS.whispyr;
}

/** Install metadata for the active brand's public web-manifest endpoint. */
export function pwaManifestFor(b: BrandConfig) {
	return {
		id: "/",
		name: b.appName,
		short_name: b.name,
		description: `${b.name} team mail`,
		start_url: "/",
		scope: "/",
		display: "standalone",
		theme_color: b.themeColor,
		background_color: b.themeColor,
		icons: [
			{ src: b.pwaIcon192, sizes: "192x192", type: "image/png", purpose: "any" },
			{
				src: b.pwaIcon192,
				sizes: "192x192",
				type: "image/png",
				purpose: "maskable",
			},
			{ src: b.pwaIcon512, sizes: "512x512", type: "image/png", purpose: "any" },
			{
				src: b.pwaIcon512,
				sizes: "512x512",
				type: "image/png",
				purpose: "maskable",
			},
		],
	};
}

// Component styles shared across brands — they reference the per-brand `:root`
// custom properties above, so the same markup re-skins per brand. `--charcoal`
// is the ink (primary text); `--accent` is the primary action color (split out
// so Wiser's buttons are olive while its text stays dark).
const COMPONENT_CSS = `
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--charcoal);font-family:var(--font);font-weight:400;line-height:1.5;letter-spacing:-.005em;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;}
a{color:var(--charcoal);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:960px;margin:0 auto;padding:26px 24px 64px}
.wrap--center{min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px}
.brandbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px;flex-wrap:wrap}
.brand{display:inline-flex;align-items:center;gap:10px;color:var(--charcoal)}
.brand:hover{text-decoration:none}
.brand img{display:block;height:30px;width:auto}
.brand b{font-weight:700;font-size:19px;letter-spacing:-.01em}
.brand b span{color:var(--muted);font-weight:400}
h1{font-size:24px;font-weight:700;letter-spacing:-.02em;margin:0 0 4px}
h2{font-size:16px;font-weight:700;margin:0 0 14px}
.sub{color:var(--muted);font-size:14px;margin:0 0 22px}
.note{color:var(--muted);font-size:12px;margin-top:18px;text-align:center}
.muted{color:var(--muted);font-size:13px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:26px;margin:16px 0;box-shadow:0 1px 2px rgba(26,26,26,.04)}
.card--auth{width:100%;max-width:412px;margin:0;overflow-wrap:anywhere}
.auth-heading{margin-top:18px}
label{display:block;font-size:13px;font-weight:500;color:var(--slate);margin:14px 0 6px}
input:not([type=checkbox]):not([type=radio]),select,textarea{width:100%;padding:10px 12px;border-radius:12px;border:1px solid var(--line-strong);background:var(--surface);color:var(--charcoal);font-size:15px;font-family:inherit;transition:border-color .12s,box-shadow .12s}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--focus-shadow)}
textarea{min-height:170px;resize:vertical;line-height:1.5}
input[type=file]{padding:9px 0;border:0;background:transparent;font-size:13px;color:var(--slate)}
.checkbox-label{display:flex;align-items:flex-start;gap:10px;line-height:1.4;cursor:pointer}
.checkbox-label input{flex:0 0 auto;width:16px;height:16px;margin:1px 0 0;accent-color:var(--accent)}
button,.btn{appearance:none;cursor:pointer;font-family:inherit;font-weight:600;font-size:15px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);padding:11px 18px;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;gap:8px;text-decoration:none;transition:background .12s,border-color .12s}
button:hover,.btn:hover{background:var(--accent-hover);border-color:var(--accent-hover);text-decoration:none}
a.btn{color:var(--accent-fg)}
a.btn.secondary{color:var(--charcoal)}
button.block{width:100%;margin-top:22px}
.btn.secondary,button.secondary{background:transparent;color:var(--charcoal);border-color:var(--line-strong)}
.btn.secondary:hover,button.secondary:hover{background:var(--tint);border-color:var(--ring)}
button.sm{padding:7px 11px;font-size:12px;border-radius:10px}
button.danger{background:var(--danger);border-color:var(--danger);color:#fff}
button.danger:hover{background:#9a1d14;border-color:#9a1d14}
button:disabled{opacity:.45;cursor:not-allowed}
.err{background:#f7ded9;border:1px solid #e7b3ac;color:#8a2018;padding:10px 12px;border-radius:10px;font-size:13px;margin-bottom:10px}
.flash{padding:11px 14px;border-radius:10px;margin-bottom:12px;font-size:13px}
.flash.ok{background:#d9ece0;border:1px solid #aacdb8;color:#1e6b43}
.flash.warn{background:#fff4d6;border:1px solid #e3c56d;color:#604700}
.flash.err{background:#f7ded9;border:1px solid #e7b3ac;color:#8a2018}
.pill{color:#1e6b43;font-weight:700}
.tablewrap{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.badge{font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid var(--line-strong);color:var(--slate);white-space:nowrap}
.badge.admin{color:var(--charcoal);border-color:var(--line);background:var(--fill)}
.badge.off{color:#8a2018;border-color:#e7b3ac;background:#f7ded9}
code{background:var(--tint);border:1px solid var(--line);padding:3px 7px;border-radius:7px;font-size:13px;word-break:break-all;font-family:ui-monospace,Menlo,monospace}
.credential-token{display:block;margin:0 0 16px;padding:10px 12px;line-height:1.5;user-select:all}
.row{display:flex;gap:14px;flex-wrap:wrap;align-items:center}
.row>div{flex:1;min-width:200px}
form.inline{display:inline;margin:0}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:8px;flex-wrap:wrap}
.preview{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px;white-space:pre-wrap;font-size:13px}
.bar{height:8px;background:var(--tint);border-radius:999px;overflow:hidden;border:1px solid var(--line)}
.bar>span{display:block;height:100%;background:var(--accent);width:0%;transition:width .3s}
.hide{display:none}
@media (max-width:640px){
  .wrap{padding:18px 16px 48px}
  .card{padding:18px;border-radius:14px}
  h1{font-size:21px}
  h2{font-size:15px}
  .row{gap:10px}
  .row>div{min-width:100%}
  button,.btn{font-size:14px;padding:11px 16px}
  button.sm{width:auto}
}`;

/** The full stylesheet for a brand: its font faces, its `:root` palette, and the shared component rules. */
export function brandCss(b: BrandConfig): string {
	return `${b.fontFaceCss}
:root{${b.rootVars}
  --font:${b.fontFamily};
  color-scheme:light;
}
${COMPONENT_CSS}`;
}

/** The brand mark + wordmark. `href` defaults to the inbox; `sub` is the suffix word. */
export function brandLogo(
	b: BrandConfig,
	opts: { href?: string; sub?: string } = {},
): string {
	const href = opts.href ?? "/";
	const sub = opts.sub ?? "Mail";
	return `<a class="brand" href="${href}" aria-label="${b.name} ${sub}">
  <img src="${b.mark}" alt="" width="${b.markWidth}" height="${b.markHeight}">
  <b>${b.name}${sub ? ` <span>${sub}</span>` : ""}</b>
</a>`;
}

/**
 * Full HTML document with the brand's styles applied.
 *
 * Carries the same install metadata as the SPA shell in app/root.tsx. iOS
 * snapshots web-app metadata from whichever page is open at Add to Home Screen
 * time, and a logged-out visitor is redirected to /login — so without this the
 * saved icon opens in a browser chrome instead of standalone.
 */
export function pageShell(b: BrandConfig, title: string, body: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="${b.themeColor}">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${b.appName}">
<link rel="icon" href="${b.favicon}" type="image/svg+xml">
<link rel="icon" href="${b.legacyFavicon}" type="${b.legacyFaviconType}" sizes="${b.legacyFaviconSizes}">
<link rel="apple-touch-icon" href="${b.appleTouchIcon}">
<link rel="preload" href="${b.preloadFont}" as="font" type="font/woff2" crossorigin>
<title>${title}</title><style>${brandCss(b)}</style></head><body>${body}</body></html>`;
}
