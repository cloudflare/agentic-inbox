// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, Loader } from "@cloudflare/kumo";
import { SparkleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import api from "~/services/api";

interface ComposeAIBarProps {
	mailboxId: string;
	body: string;
	onRewrite: (newBody: string) => void;
}

const QUICK_ACTIONS = [
	{ action: "polish", label: "Polish" },
	{ action: "formalize", label: "Formalize" },
	{ action: "friendly", label: "Friendly" },
	{ action: "shorten", label: "Shorten" },
] as const;

/** AI compose bar with custom instruction input and quick-action buttons. */
export function ComposeAIBar({ mailboxId, body, onRewrite }: ComposeAIBarProps) {
	const [instruction, setInstruction] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [activeAction, setActiveAction] = useState<string | null>(null);

	const handleRewrite = async (action: string, customInstruction?: string) => {
		if (!body.trim() || isLoading) return;
		setIsLoading(true);
		setActiveAction(action);
		try {
			const result = await api.rewriteEmailBody(
				mailboxId,
				body,
				action,
				customInstruction,
			);
			onRewrite(result.body);
			if (action === "custom") setInstruction("");
		} finally {
			setIsLoading(false);
			setActiveAction(null);
		}
	};

	const handleCustomSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!instruction.trim()) return;
		handleRewrite("custom", instruction.trim());
	};

	return (
		<div className="flex items-center gap-2 px-3 py-2 border-t border-kumo-line bg-kumo-fill/30">
			<SparkleIcon size={14} className="text-kumo-subtle shrink-0" />
			<form onSubmit={handleCustomSubmit} className="flex items-center gap-2 flex-1 min-w-0">
				<div className="flex-1 min-w-0">
					<Input
						size="sm"
						placeholder="Describe your change..."
						value={instruction}
						onChange={(e) => setInstruction(e.target.value)}
						disabled={isLoading}
					/>
				</div>
				{QUICK_ACTIONS.map(({ action, label }) => (
					<Button
						key={action}
						type="button"
						variant="ghost"
						size="sm"
						disabled={isLoading || !body.trim()}
						onClick={() => handleRewrite(action)}
					>
						{isLoading && activeAction === action ? <Loader size="sm" /> : label}
					</Button>
				))}
			</form>
		</div>
	);
}
