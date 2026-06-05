import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

const root = process.cwd();

function read(path: string): string {
	return readFileSync(join(root, path), "utf8");
}

function expectNoText(path: string, forbidden: string[]): void {
	const source = read(path);
	for (const text of forbidden) {
		expect(source, `${path} must not contain ${text}`).not.toContain(text);
	}
}

test("runtime has no AI, agent, or MCP mail access paths", () => {
	for (const path of [
		"workers/agent/index.ts",
		"workers/mcp/index.ts",
		"workers/lib/ai.ts",
		"app/components/AgentPanel.tsx",
		"app/components/AgentSidebar.tsx",
		"app/components/MCPPanel.tsx",
	]) {
		expect(existsSync(join(root, path)), `${path} should be removed`).toBe(false);
	}

	expectNoText("workers/app.ts", [
		"routeAgentRequest",
		"EmailAgent",
		"EmailMCP",
		'"/agents/*"',
		'"/mcp"',
	]);
	expectNoText("workers/index.ts", ["EMAIL_AGENT", "onNewEmail", "Auto-draft"]);
	expectNoText("wrangler.jsonc", [
		'"ai"',
		'"name": "EMAIL_AGENT"',
		'"class_name": "EmailAgent"',
		'"name": "EMAIL_MCP"',
		'"class_name": "EmailMCP"',
	]);
});

test("project metadata has no AI products, AI dependencies, or agentic branding", () => {
	const packageJson = JSON.parse(read("package.json")) as {
		name: string;
		cloudflare?: { label?: string; products?: string[] };
		dependencies?: Record<string, string>;
		scripts?: Record<string, string>;
	};
	expect(packageJson.name).not.toContain("agentic");
	expect(packageJson.cloudflare?.label ?? "").not.toContain("Agentic");
	expect(packageJson.cloudflare?.products ?? []).not.toContain("Workers AI");

	for (const dependency of [
		"@cloudflare/ai-chat",
		"agents",
		"ai",
		"workers-ai-provider",
		"react-markdown",
		"remark-gfm",
	]) {
		expect(packageJson.dependencies ?? {}, `${dependency} should not be a direct dependency`)
			.not.toHaveProperty(dependency);
	}

	expectNoText("README.md", [
		"Agentic Inbox",
		"AI-powered",
		"AI agent",
		"Auto-draft",
		"Workers AI",
		"/mcp",
		"/agents",
	]);
	expectNoText("wrangler.jsonc", ["agentic-inbox"]);
});
