import {
	Button,
	Empty,
	Loader,
} from "@cloudflare/kumo";
import {
	ArrowSquareOutIcon,
	CheckCircleIcon,
	GearIcon,
	InfoIcon,
	WarningCircleIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { Link as RouterLink } from "react-router";
import { useSetupStatus } from "~/queries/setup";
import { queryKeys } from "~/queries/keys";

export function meta() {
	return [{ title: "Setup — Agentic Inbox" }];
}

function StepIcon({ status }: { status: "complete" | "incomplete" | "error" | "info" }) {
	if (status === "complete") {
		return <CheckCircleIcon size={24} weight="fill" className="text-kumo-success shrink-0" />;
	}
	if (status === "error") {
		return <WarningCircleIcon size={24} weight="fill" className="text-kumo-danger shrink-0" />;
	}
	if (status === "info") {
		return <InfoIcon size={24} weight="fill" className="text-blue-500 shrink-0" />;
	}
	return <WarningCircleIcon size={24} weight="fill" className="text-kumo-warning shrink-0" />;
}

export default function SetupRoute() {
	const { data, isLoading, refetch, isRefetching } = useSetupStatus();
	const queryClient = useQueryClient();

	const handleRecheck = async () => {
		await refetch();
		queryClient.invalidateQueries({ queryKey: queryKeys.config });
		queryClient.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
	};

	if (isLoading) {
		return (
			<div className="flex items-center justify-center min-h-screen">
				<Loader size="lg" />
			</div>
		);
	}

	const steps = data?.steps ?? [];
	const isComplete = data?.isComplete ?? false;
	const requiredIncomplete = steps.filter((s) => s.required && s.status !== "complete" && s.status !== "info");
	const optionalIncomplete = steps.filter((s) => !s.required && s.status !== "complete");

	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
				<div className="mb-8">
					<div className="flex items-center gap-3 mb-2">
						<GearIcon size={28} className="text-kumo-default" />
						<h1 className="text-2xl font-bold text-kumo-default">Setup</h1>
					</div>
					<p className="text-sm text-kumo-subtle">
						Complete these steps to get your Agentic Inbox running.
					</p>
				</div>

				{isComplete && (
					<div className="rounded-xl border border-kumo-success/30 bg-kumo-success/5 p-4 mb-6 flex items-start gap-3">
						<CheckCircleIcon size={20} weight="fill" className="text-kumo-success mt-0.5 shrink-0" />
						<div>
							<p className="text-sm font-medium text-kumo-success">All set!</p>
							<p className="text-sm text-kumo-subtle">Your Agentic Inbox is fully configured and ready to use.</p>
						</div>
					</div>
				)}

				{requiredIncomplete.length > 0 && (
					<div className="rounded-xl border border-kumo-warning/30 bg-kumo-warning/5 p-4 mb-6 flex items-start gap-3">
						<WarningCircleIcon size={20} weight="fill" className="text-kumo-warning mt-0.5 shrink-0" />
						<div>
							<p className="text-sm font-medium text-kumo-warning">Setup incomplete</p>
							<p className="text-sm text-kumo-subtle">{requiredIncomplete.length} required step{requiredIncomplete.length > 1 ? "s" : ""} still need{requiredIncomplete.length === 1 ? "s" : ""} attention.</p>
						</div>
					</div>
				)}

				{steps.length > 0 && (
					<div className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden mb-6">
						{steps.map((step, idx) => (
							<div
								key={step.id}
								className={`px-5 py-4 ${idx > 0 ? "border-t border-kumo-line" : ""}`}
							>
								<div className="flex items-start gap-3">
									<StepIcon status={step.status} />
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className="text-sm font-medium text-kumo-default">
												{step.label}
											</span>
											{step.status === "info" ? (
												<span className="text-[10px] font-medium uppercase tracking-wider text-blue-600 bg-blue-500/10 px-1.5 py-0.5 rounded">
													Action needed
												</span>
											) : step.required ? (
												<span className="text-[10px] font-medium uppercase tracking-wider text-kumo-warning bg-kumo-warning/10 px-1.5 py-0.5 rounded">
													Required
												</span>
											) : (
												<span className="text-[10px] font-medium uppercase tracking-wider text-kumo-subtle bg-kumo-fill px-1.5 py-0.5 rounded">
													Optional
												</span>
											)}
										</div>
										{step.detail && (
											<p className="text-sm text-kumo-subtle mt-1 whitespace-pre-wrap">
												{step.detail}
											</p>
										)}
										{step.docsUrl && (
											<a
												href={step.docsUrl}
												target="_blank"
												rel="noopener noreferrer"
												className="text-xs text-blue-600 hover:text-blue-800 mt-1.5 inline-flex items-center gap-1"
											>
												View docs
												<ArrowSquareOutIcon size={12} />
											</a>
										)}
									</div>
								</div>
							</div>
						))}
					</div>
				)}

				{steps.length === 0 && (
					<Empty
						icon={<GearIcon size={48} className="text-kumo-inactive" />}
						title="Could not load setup status"
						description="Try refreshing the page."
					/>
				)}

				<div className="flex items-center gap-3">
					<Button
						variant="secondary"
						onClick={handleRecheck}
						loading={isRefetching}
					>
						Recheck
					</Button>
					<RouterLink to="/">
						<Button variant="primary">
							Continue to App
						</Button>
					</RouterLink>
				</div>

				{optionalIncomplete.length > 0 && isComplete && (
					<div className="mt-8 pt-6 border-t border-kumo-line">
						<h2 className="text-sm font-semibold text-kumo-subtle mb-3">Optional steps</h2>
						<p className="text-sm text-kumo-subtle">
							{optionalIncomplete.length} optional step{optionalIncomplete.length > 1 ? "s" : ""} {optionalIncomplete.length > 1 ? "remain" : "remains"}.
							These are not required but will enhance your experience.
						</p>
					</div>
				)}
			</div>
		</div>
	);
}
