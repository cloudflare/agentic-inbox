import { Button, Loader } from "@cloudflare/kumo";
import { CalendarDotsIcon, CheckCircleIcon, EnvelopeSimpleIcon, LightningIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import api from "~/services/api";
import { queryKeys } from "~/queries/keys";

const icons = {
	email: <EnvelopeSimpleIcon size={18} />,
	event: <CalendarDotsIcon size={18} />,
	task: <CheckCircleIcon size={18} />,
	"follow-up": <LightningIcon size={18} />,
};

export default function BriefingRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const queryClient = useQueryClient();
	const briefing = useQuery({
		queryKey: queryKeys.productivity.briefing(mailboxId || ""),
		queryFn: () => api.getBriefing(mailboxId!),
		enabled: Boolean(mailboxId),
	});
	const sync = useMutation({
		mutationFn: () => api.queueSync(mailboxId!),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.productivity.briefing(mailboxId || "") }),
	});

	if (briefing.isLoading) return <div className="flex h-full items-center justify-center"><Loader size="lg" /></div>;
	const items = briefing.data?.items ?? [];

	return (
		<div className="h-full overflow-y-auto bg-kumo-recessed p-5 md:p-8">
			<div className="mx-auto max-w-4xl">
				<div className="mb-8 flex items-start justify-between gap-4">
					<div>
						<p className="text-sm font-medium text-kumo-subtle">AI-first inbox</p>
						<h1 className="mt-1 text-3xl font-semibold text-kumo-default">Today’s briefing</h1>
						<p className="mt-2 text-sm text-kumo-subtle">A ranked action list across mail and follow-ups.</p>
					</div>
					<Button variant="secondary" onClick={() => sync.mutate()} disabled={sync.isPending}>
						{sync.isPending ? "Syncing…" : "Sync Outlook"}
					</Button>
				</div>
				{items.length === 0 ? (
					<div className="rounded-xl border border-kumo-line bg-kumo-base p-10 text-center text-sm text-kumo-subtle">Your action list is clear.</div>
				) : (
					<div className="space-y-3">
						{items.map((item) => (
							<Link key={item.id} to={item.sourceUrl} className="flex items-start gap-4 rounded-xl border border-kumo-line bg-kumo-base p-4 no-underline transition hover:border-kumo-strong">
								<div className={`mt-0.5 rounded-lg p-2 ${item.priority === "high" ? "bg-red-100 text-red-700" : "bg-kumo-fill text-kumo-strong"}`}>{icons[item.type]}</div>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2"><h2 className="truncate text-sm font-semibold text-kumo-default">{item.title}</h2><span className="text-xs uppercase tracking-wide text-kumo-subtle">{item.type}</span></div>
									<p className="mt-1 text-sm text-kumo-subtle">{item.reason}</p>
								</div>
							</Link>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
