// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { GraphIcon } from "@phosphor-icons/react";

// POC stub. Real hub needs feed sync endpoints + indicator stream — out of
// scope for the preview branch.
export default function HubRoute() {
	return (
		<div className="px-6 md:px-10 py-8 max-w-[1280px] space-y-6">
			<div>
				<div className="text-[11px] uppercase tracking-[0.08em] text-ink-3 mb-1">
					Community defense
				</div>
				<h1 className="pp-serif text-[40px] leading-none text-ink mb-2">
					Threat-intel hub
				</h1>
				<p className="text-[13px] text-ink-3 max-w-2xl">
					Pull corroborated indicators from MISP-compatible feeds. Push your
					own confirmed phishing back. Trust-weighted so one org can't
					single-handedly promote its own finding.
				</p>
			</div>

			<div className="pp-card p-10 flex flex-col items-center text-center gap-3">
				<span className="flex h-12 w-12 items-center justify-center rounded-full bg-paper-2 text-ink-3">
					<GraphIcon size={22} />
				</span>
				<div className="pp-serif text-[20px] text-ink">Hub coming soon</div>
				<p className="text-[12.5px] text-ink-3 max-w-md leading-relaxed">
					This screen will show subscribed feeds, indicator stream, sharing
					groups, and contribution stats once the hub backend lands.
				</p>
			</div>
		</div>
	);
}
