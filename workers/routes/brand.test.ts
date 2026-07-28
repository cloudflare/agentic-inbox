// Brand-registry tests. No framework (matches workers/quiz/grading.test.ts):
//   node --experimental-strip-types workers/routes/brand.test.ts
// Exits non-zero on the first failed assertion.

import assert from "node:assert/strict";
import {
	resolveBrand,
	brandLogo,
	brandCss,
	pageShell,
	pwaManifestFor,
} from "./brand.ts";

// ── resolveBrand: explicit brands resolve to their own identity ──
assert.equal(resolveBrand("wiser").id, "wiser", "wiser id");
assert.equal(resolveBrand("wiser").name, "Wiser", "wiser name");
assert.equal(resolveBrand("wiser").appName, "Wiser Mail", "wiser appName");
assert.equal(resolveBrand("wiser").mark, "/wiser-mark.svg", "wiser mark");
assert.equal(resolveBrand("wiser").pwaIcon192, "/wiser-icon-192.png", "wiser PWA 192 icon");
assert.equal(resolveBrand("wiser").pwaIcon512, "/wiser-icon-512.png", "wiser PWA 512 icon");
assert.equal(
	resolveBrand("wiser").appleTouchIcon,
	"/wiser-apple-touch-icon.png",
	"wiser Apple touch icon",
);
assert.equal(
	resolveBrand("wiser").notificationBadge,
	"/wiser-badge-96.png",
	"wiser notification badge",
);
assert.equal(
	resolveBrand("wiser").legacyFavicon,
	"/wiser-favicon-32.png",
	"wiser raster favicon",
);
assert.match(resolveBrand("wiser").fontFamily, /Inter/, "wiser font is Inter");

assert.equal(resolveBrand("whispyr").id, "whispyr", "whispyr id");
assert.equal(resolveBrand("whispyr").name, "Whispyr", "whispyr name");
assert.equal(resolveBrand("whispyr").appName, "Whispyr Mail", "whispyr appName");
assert.equal(resolveBrand("whispyr").mark, "/whispyr-mark.svg", "whispyr mark");
assert.equal(resolveBrand("whispyr").pwaIcon192, "/icon-192.png", "whispyr PWA 192 icon");
assert.equal(resolveBrand("whispyr").pwaIcon512, "/icon-512.png", "whispyr PWA 512 icon");
assert.equal(
	resolveBrand("whispyr").appleTouchIcon,
	"/apple-touch-icon.png",
	"whispyr Apple touch icon",
);
assert.equal(
	resolveBrand("whispyr").notificationBadge,
	"/favicon-32.png",
	"whispyr notification badge",
);
assert.equal(resolveBrand("whispyr").legacyFavicon, "/favicon.ico", "whispyr legacy favicon");
assert.match(resolveBrand("whispyr").fontFamily, /Kamerik 105/, "whispyr font is Kamerik");

// ── fail-safe default: unset/unknown → whispyr (a missing var never breaks the
//    live Whispyr portal — this is the load-bearing byte-identical guarantee) ──
assert.equal(resolveBrand(undefined).id, "whispyr", "unset → whispyr");
assert.equal(resolveBrand("").id, "whispyr", "empty → whispyr");
assert.equal(resolveBrand("bogus").id, "whispyr", "unknown → whispyr");
assert.equal(resolveBrand("constructor").id, "whispyr", "inherited property → whispyr");
assert.equal(resolveBrand("WISER").id, "wiser", "case-insensitive → wiser");

// ── brandLogo: per-brand mark asset + wordmark text ──
{
	const wiser = brandLogo(resolveBrand("wiser"));
	assert.match(wiser, /\/wiser-mark\.svg/, "wiser logo uses the wiser mark");
	assert.match(wiser, />\s*Wiser/, "wiser logo wordmark says Wiser");
	const whispyr = brandLogo(resolveBrand("whispyr"));
	assert.match(whispyr, /\/whispyr-mark\.svg/, "whispyr logo uses the whispyr mark");
	assert.match(whispyr, />\s*Whispyr/, "whispyr logo wordmark says Whispyr");
}

// ── pageShell: each brand owns the modern SVG favicon path ──
{
	const wiser = pageShell(resolveBrand("wiser"), "Wiser", "<main>Wiser</main>");
	const whispyr = pageShell(resolveBrand("whispyr"), "Whispyr", "<main>Whispyr</main>");
	assert.match(wiser, /href="\/wiser-mark\.svg" type="image\/svg\+xml"/, "wiser favicon");
	assert.match(
		wiser,
		/href="\/wiser-apple-touch-icon\.png"/,
		"wiser Apple touch icon",
	);
	assert.match(
		wiser,
		/href="\/wiser-favicon-32\.png" type="image\/png"/,
		"wiser raster favicon",
	);
	assert.match(whispyr, /href="\/favicon\.svg" type="image\/svg\+xml"/, "whispyr favicon");
	assert.match(whispyr, /href="\/apple-touch-icon\.png"/, "whispyr Apple touch icon");
	assert.match(
		whispyr,
		/href="\/favicon\.ico" type="image\/x-icon"/,
		"whispyr legacy favicon",
	);
	// Add to Home Screen reads install metadata off whatever page is open, and
	// a logged-out visitor only ever sees these Worker-rendered pages.
	for (const [name, shell] of [
		["wiser", wiser],
		["whispyr", whispyr],
	] as const) {
		assert.match(
			shell,
			/<link rel="manifest" href="\/manifest\.webmanifest">/,
			`${name} pageShell links the manifest`,
		);
		assert.match(
			shell,
			/<meta name="mobile-web-app-capable" content="yes">/,
			`${name} pageShell is installable`,
		);
		// The legacy apple-mobile-web-app-capable tag routes iOS installs down the
		// pre-manifest web-clip path whose push identity is empty, so webpushd
		// answers "denied" without ever prompting. The working Whispyr CRM ships
		// without it; the manifest's display:standalone covers iOS 16.4+.
		assert.doesNotMatch(
			shell,
			/apple-mobile-web-app-capable/,
			`${name} pageShell must not carry the legacy web-clip tag`,
		);
	}
	assert.match(
		wiser,
		/<meta name="apple-mobile-web-app-title" content="Wiser Mail">/,
		"wiser home-screen title",
	);
	assert.match(
		whispyr,
		/<meta name="apple-mobile-web-app-title" content="Whispyr Mail">/,
		"whispyr home-screen title",
	);
}

// ── PWA manifest: install metadata owns brand-specific raster assets ──
{
	const wiser = pwaManifestFor(resolveBrand("wiser"));
	assert.equal(wiser.name, "Wiser Mail");
	// With the legacy web-clip tag gone, display:standalone is the ONLY thing
	// keeping iOS installs standalone (and push-capable) — pin it per brand.
	assert.equal(wiser.display, "standalone", "wiser manifest display mode");
	assert.equal(
		pwaManifestFor(resolveBrand("whispyr")).display,
		"standalone",
		"whispyr manifest display mode",
	);
	assert.deepEqual(
		wiser.icons.map((icon) => icon.src),
		[
			"/wiser-icon-192.png",
			"/wiser-icon-192.png",
			"/wiser-icon-512.png",
			"/wiser-icon-512.png",
		],
	);
	const whispyr = pwaManifestFor(resolveBrand("whispyr"));
	assert.deepEqual(
		whispyr.icons.map((icon) => icon.src),
		["/icon-192.png", "/icon-192.png", "/icon-512.png", "/icon-512.png"],
	);
}

// ── brandCss: each brand emits ONLY its own palette + font, never the other's ──
{
	const wiser = brandCss(resolveBrand("wiser"));
	assert.match(wiser, /Inter/, "wiser css declares Inter");
	assert.match(wiser, /70 28% 38%/, "wiser css uses the olive accent");
	const whispyr = brandCss(resolveBrand("whispyr"));
	assert.match(whispyr, /Kamerik 105/, "whispyr css declares Kamerik");
	assert.match(whispyr, /#1a1a1a/, "whispyr css uses charcoal");
	assert.ok(!whispyr.includes("70 28% 38%"), "whispyr css contains no olive");
	assert.ok(!wiser.includes("Kamerik"), "wiser css contains no Kamerik");
}

console.log("brand.test.ts: all assertions passed");
