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
		<div className="shrink-0 px-4 pt-5 pb-3 md:px-6">
			<h2 className="text-lg font-medium leading-snug text-kumo-default break-words">{subject}</h2>
			{showThreadCount && (
				<span className="mt-1 block text-xs text-kumo-subtle tabular-nums">
					{messageCount} messages in this thread
				</span>
			)}
		</div>
	);
}
