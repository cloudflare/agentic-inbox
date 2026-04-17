export function renderAccessNotConfiguredPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>Setup Required — Agentic Inbox</title>
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body {
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
			background: #f4f4f5;
			color: #1e1e1e;
			min-height: 100vh;
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 2rem 1rem;
		}
		.container {
			max-width: 560px;
			width: 100%;
		}
		.card {
			background: #ffffff;
			border: 1px solid #e5e5e5;
			border-radius: 12px;
			padding: 2rem;
		}
		.icon-wrap {
			width: 48px;
			height: 48px;
			border-radius: 50%;
			background: #fef3c7;
			display: flex;
			align-items: center;
			justify-content: center;
			margin-bottom: 1.25rem;
		}
		.icon-wrap svg {
			width: 24px;
			height: 24px;
			color: #d97706;
		}
		h1 {
			font-size: 1.25rem;
			font-weight: 600;
			margin-bottom: 0.5rem;
		}
		.subtitle {
			font-size: 0.875rem;
			color: #737373;
			line-height: 1.5;
			margin-bottom: 1.5rem;
		}
		.steps li {
			padding: 0.875rem 0;
			border-top: 1px solid #f0f0f0;
			font-size: 0.875rem;
			line-height: 1.6;
			color: #404040;
		}
		.steps li:first-child {
			border-top: none;
			padding-top: 0;
		}
		.steps li::before {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 22px;
			height: 22px;
			border-radius: 50%;
			background: #f0f0f0;
			font-size: 0.75rem;
			font-weight: 600;
			color: #525252;
			margin-right: 0.625rem;
			vertical-align: middle;
		}
		code {
			background: #f4f4f5;
			border: 1px solid #e5e5e5;
			border-radius: 4px;
			padding: 0.125rem 0.375rem;
			font-family: "SF Mono", "Fira Code", "Fira Mono", "Roboto Mono", monospace;
			font-size: 0.8125rem;
			color: #1e1e1e;
		}
		.btn {
			display: inline-flex;
			align-items: center;
			gap: 0.375rem;
			padding: 0.5rem 1rem;
			border: none;
			border-radius: 6px;
			font-size: 0.875rem;
			font-weight: 500;
			cursor: pointer;
			text-decoration: none;
			transition: background 0.15s;
		}
		.btn-primary {
			background: #0052d4;
			color: #ffffff;
		}
		.btn-primary:hover { background: #0044b0; }
		.footer {
			margin-top: 1.5rem;
			display: flex;
			align-items: center;
			gap: 0.75rem;
			justify-content: center;
		}
		.brand {
			text-align: center;
			margin-top: 1.5rem;
			font-size: 0.8125rem;
			color: #a3a3a3;
		}
	</style>
</head>
<body>
	<div class="container">
		<div class="card">
		<div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem;">
			<div class="icon-wrap">
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="128" cy="128" r="96"/>
					<line x1="128" y1="136" x2="128" y2="88"/>
					<circle cx="128" cy="168" r="4" fill="currentColor"/>
				</svg>
				</div>
				<h1>Cloudflare Access is not configured</h1>
				</div>
			<p class="subtitle">
				This app requires Cloudflare Access for authentication in production.
				Follow the steps below to complete setup.
			</p>
			<ol class="steps">
				<li class="step">
					<strong>Enable Cloudflare Access</strong> — go to the <a href="https://dash.cloudflare.com/?to=/:account/workers-and-pages" style="color:#0052d4">Workers &amp; Pages</a> dashboard, select your Worker, then navigate to <strong>Settings &rarr; Domains &amp; Routes</strong> and click <strong>Enable Cloudflare Access</strong>.
				</li>
				<li>
					<strong>Configure the Access credentials</strong> — after enabling Access, a modal will appear with your <code>POLICY_AUD</code> (Application Audience Tag) and <code>TEAM_DOMAIN</code> values. Copy both values, then go to your Worker's <strong>Settings &rarr; Variables and Secrets</strong> and add them as encrypted secrets:
					<ul style="margin:0.5rem 0 0 1.875rem;list-style:disc;">
						<li><code>POLICY_AUD</code> &mdash; the Application Audience Tag shown in the modal</li>
						<li><code>TEAM_DOMAIN</code> &mdash; your Access team URL (e.g. <code>https://myteam.cloudflareaccess.com</code>) or the full certs URL</li>
					</ul>
				</li>
				<li>
					<strong>Reload this page</strong> after the secrets are saved.
				</li>
			</ol>
			<div class="footer">
				<a href="" class="btn btn-primary" onclick="event.preventDefault(); window.location.reload();">
					<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"><path d="M70 60a96 96 0 1 0 126.7-10.7"/><polyline points="160 16 200 48 168 80"/></svg>
					Reload
				</a>
			</div>
			<p style="font-size:0.8125rem;color:#737373;margin-top:1.25rem;text-align:center;">
				For more help, see the <a href="https://developers.cloudflare.com/workers/configuration/routing/workers-dev/#manage-access-to-workersdev" style="color:#0052d4;text-decoration:underline;">Cloudflare Access documentation</a>.
			</p>
		</div>
		<p class="brand">Agentic Inbox</p>
	</div>
</body>
</html>`;
}
