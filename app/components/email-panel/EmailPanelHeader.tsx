// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

interface EmailPanelHeaderProps {
	subject: string;
	messageCount: number;
	showThreadCount: boolean;
}

export default function EmailPanelHeader({
	subject,
	messageCount,
	showThreadCount,
}: EmailPanelHeaderProps) {
	return (
		<div className="px-4 py-3 border-b border-line shrink-0 md:px-6">
			<h2 className="text-base font-semibold text-ink">{subject}</h2>
			{showThreadCount && (
				<span className="text-xs text-ink-3 mt-0.5 block">
					{messageCount} messages in this thread
				</span>
			)}
		</div>
	);
}
