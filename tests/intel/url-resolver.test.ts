import { describe, expect, it } from "vitest";
import { extractTitle, resolveUrl } from "../../workers/intel/url-resolver";

/** Minimal fetch stub that plays back a scripted chain of responses by URL. */
function stubFetch(chain: Record<string, Response>): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
		const res = chain[url];
		if (!res) throw new Error(`unexpected URL: ${url}`);
		return res;
	}) as typeof fetch;
}

describe("extractTitle", () => {
	it("pulls the first <title> from an HTML doc", () => {
		expect(extractTitle("<html><title> Login </title></html>")).toBe("Login");
	});
	it("collapses whitespace and trims", () => {
		expect(extractTitle("<html><title>\n  Sign\n  in\n</title></html>")).toBe("Sign in");
	});
	it("returns null when no title tag is present", () => {
		expect(extractTitle("<html><body>no title</body></html>")).toBeNull();
	});
	it("caps at 200 chars", () => {
		const long = "x".repeat(500);
		expect(extractTitle(`<title>${long}</title>`)?.length).toBe(200);
	});
});

describe("resolveUrl", () => {
	it("follows a single 302 redirect to a new host and flags host_changed", async () => {
		const fetchImpl = stubFetch({
			"https://short.example/abc": new Response("", {
				status: 302,
				headers: { location: "https://target.example/phish" },
			}),
			"https://target.example/phish": new Response("<html><title>Sign in</title></html>", {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
		});
		const r = await resolveUrl("https://short.example/abc", fetchImpl);
		expect(r?.resolved).toBe("https://target.example/phish");
		expect(r?.host_changed).toBe(true);
		expect(r?.title).toBe("Sign in");
		expect(r?.hops).toBe(2);
	});

	it("truncates at the max redirect depth without following indefinitely", async () => {
		// Build a 10-deep chain; MAX_REDIRECT_HOPS is 5.
		const chain: Record<string, Response> = {};
		for (let i = 0; i < 10; i++) {
			chain[`https://hop${i}.example/`] = new Response("", {
				status: 302,
				headers: { location: `https://hop${i + 1}.example/` },
			});
		}
		chain["https://hop10.example/"] = new Response("done", { status: 200 });
		const r = await resolveUrl("https://hop0.example/", stubFetch(chain));
		expect(r?.truncated).toBe(true);
		expect(r?.hops).toBeLessThanOrEqual(5);
	});

	it("returns a result with final_status=0 when the fetch throws", async () => {
		const fetchImpl = (async () => { throw new Error("offline"); }) as typeof fetch;
		const r = await resolveUrl("https://offline.example", fetchImpl);
		expect(r?.final_status).toBe(0);
		expect(r?.resolved).toBe("https://offline.example");
	});

	it("does not change host when the redirect stays on the same domain", async () => {
		const fetchImpl = stubFetch({
			"https://same.example/a": new Response("", {
				status: 302,
				headers: { location: "https://same.example/b" },
			}),
			"https://same.example/b": new Response("ok", { status: 200 }),
		});
		const r = await resolveUrl("https://same.example/a", fetchImpl);
		expect(r?.host_changed).toBe(false);
	});

	it("returns null for a URL that cannot be parsed", async () => {
		const r = await resolveUrl("not a url");
		expect(r).toBeNull();
	});
});
