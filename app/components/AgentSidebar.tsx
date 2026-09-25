// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Loader } from "@cloudflare/kumo";
import { PlugsIcon, RobotIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import MCPPanel from "./MCPPanel";
import { useConfig } from "~/queries/config";

function LazyAgentPanel() {
	const [AgentChat, setAgentChat] = useState<React.ComponentType | null>(
		null,
	);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		import("~/components/AgentPanel").then((mod) => {
			setAgentChat(() => mod.default);
		}).catch((err) => {
			console.error("Failed to load AgentPanel:", err);
			setLoadError("Failed to load agent panel");
		});
	}, []);

	if (loadError) {
		return (
			<div className="flex items-center justify-center h-full">
				<span className="text-xs text-kumo-error">{loadError}</span>
			</div>
		);
	}
	if (!AgentChat) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-2">
				<Loader size="base" />
				<span className="text-xs text-kumo-subtle">Loading agent...</span>
			</div>
		);
	}
	return <AgentChat />;
}

export default function AgentSidebar() {
	const { data: config } = useConfig();
	const aiAgentEnabled = config?.features ? config.features.aiAgent : true;
	const mcpEnabled = config?.features ? config.features.mcp : true;

	const [activeTab, setActiveTab] = useState<"agent" | "mcp">("agent");

	useEffect(() => {
		if (!aiAgentEnabled && mcpEnabled) {
			setActiveTab("mcp");
		} else if (aiAgentEnabled && !mcpEnabled) {
			setActiveTab("agent");
		}
	}, [aiAgentEnabled, mcpEnabled]);

	if (!aiAgentEnabled && !mcpEnabled) {
		return (
			<div className="flex flex-col items-center justify-center h-full p-6 text-center text-kumo-subtle text-sm">
				AI Agent and MCP features are currently disabled.
			</div>
		);
	}

	const showBothTabs = aiAgentEnabled && mcpEnabled;

	return (
		<div className="flex flex-col h-full">
			{/* Tab bar (only when both features are enabled) */}
			{showBothTabs ? (
				<div className="flex items-center border-b border-kumo-line shrink-0">
					<button
						type="button"
						onClick={() => setActiveTab("agent")}
						className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 bg-transparent cursor-pointer ${
							activeTab === "agent"
								? "border-kumo-brand text-kumo-default"
								: "border-transparent text-kumo-subtle hover:text-kumo-default"
						}`}
					>
						<RobotIcon size={14} weight={activeTab === "agent" ? "fill" : "regular"} />
						Agent
					</button>
					<button
						type="button"
						onClick={() => setActiveTab("mcp")}
						className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 bg-transparent cursor-pointer ${
							activeTab === "mcp"
								? "border-kumo-brand text-kumo-default"
								: "border-transparent text-kumo-subtle hover:text-kumo-default"
						}`}
					>
						<PlugsIcon size={14} weight={activeTab === "mcp" ? "fill" : "regular"} />
						MCP
					</button>
				</div>
			) : (
				<div className="flex items-center gap-2 px-4 py-3 border-b border-kumo-line shrink-0 font-medium text-sm text-kumo-default">
					{aiAgentEnabled ? (
						<>
							<RobotIcon size={16} weight="duotone" className="text-kumo-brand" />
							<span>AI Agent</span>
						</>
					) : (
						<>
							<PlugsIcon size={16} weight="duotone" className="text-kumo-brand" />
							<span>MCP Server</span>
						</>
					)}
				</div>
			)}

			{/* Tab content — keep agent mounted so chat isn't lost if both are enabled */}
			<div className="flex-1 min-h-0 overflow-hidden">
				{aiAgentEnabled && (
					<div className={activeTab === "agent" ? "h-full" : "hidden"}>
						<LazyAgentPanel />
					</div>
				)}
				{mcpEnabled && activeTab === "mcp" && <MCPPanel />}
			</div>
		</div>
	);
}
