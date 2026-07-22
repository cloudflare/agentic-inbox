import { Button, Loader } from "@cloudflare/kumo";
import { CalendarDotsIcon, CheckCircleIcon, UsersIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router";
import api from "~/services/api";
import { queryKeys } from "~/queries/keys";

export default function ProductivityRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const queryClient = useQueryClient();
	const query = useQuery({ queryKey: queryKeys.productivity.snapshot(mailboxId || ""), queryFn: () => api.getProductivity(mailboxId!), enabled: Boolean(mailboxId) });
	const topics = useQuery({ queryKey: queryKeys.productivity.topics(mailboxId || ""), queryFn: () => api.listTopics(mailboxId!), enabled: Boolean(mailboxId) });
	const sync = useMutation({ mutationFn: () => api.getProductivity(mailboxId!), onSuccess: (data) => queryClient.setQueryData(queryKeys.productivity.snapshot(mailboxId || ""), data) });
	if (query.isLoading) return <div className="flex h-full items-center justify-center"><Loader size="lg" /></div>;
	const data = query.data;
	return <div className="h-full overflow-y-auto bg-kumo-recessed p-5 md:p-8"><div className="mx-auto max-w-5xl">
		<div className="mb-8 flex items-start justify-between"><div><p className="text-sm text-kumo-subtle">One workflow, three views</p><h1 className="mt-1 text-3xl font-semibold text-kumo-default">Productivity</h1></div><Button variant="secondary" onClick={() => sync.mutate()} disabled={sync.isPending}>{sync.isPending ? "Refreshing…" : "Refresh Outlook"}</Button></div>
		<div className="grid gap-4 md:grid-cols-3">
			<section className="rounded-xl border border-kumo-line bg-kumo-base p-5"><div className="mb-4 flex items-center gap-2 font-semibold"><CalendarDotsIcon size={20} /> Calendar <span className="ml-auto text-sm text-kumo-subtle">{data?.events.length ?? 0}</span></div>{data?.events.slice(0, 8).map((event) => <div key={event.id} className="border-t border-kumo-line py-3 text-sm"><div className="font-medium">{event.subject || "Untitled event"}</div><div className="text-xs text-kumo-subtle">{event.start?.dateTime ? new Date(event.start.dateTime).toLocaleString() : "No time"}</div></div>)}</section>
			<section className="rounded-xl border border-kumo-line bg-kumo-base p-5"><div className="mb-4 flex items-center gap-2 font-semibold"><CheckCircleIcon size={20} /> Tasks <span className="ml-auto text-sm text-kumo-subtle">{data?.tasks.length ?? 0}</span></div>{data?.tasks.slice(0, 8).map((task) => <div key={task.id} className="border-t border-kumo-line py-3 text-sm"><div className="font-medium">{task.title || "Untitled task"}</div><div className="text-xs text-kumo-subtle">{task.dueDateTime?.dateTime ? `Due ${new Date(task.dueDateTime.dateTime).toLocaleDateString()}` : task.status}</div></div>)}</section>
			<section className="rounded-xl border border-kumo-line bg-kumo-base p-5"><div className="mb-4 flex items-center gap-2 font-semibold"><UsersIcon size={20} /> Contacts <span className="ml-auto text-sm text-kumo-subtle">{data?.contacts.length ?? 0}</span></div>{data?.contacts.slice(0, 8).map((contact) => <div key={contact.id} className="border-t border-kumo-line py-3 text-sm"><div className="font-medium">{contact.displayName || contact.emailAddresses?.[0]?.address || "Contact"}</div><div className="text-xs text-kumo-subtle">{contact.companyName || ""}</div></div>)}</section>
		</div>
		<div className="mt-6 rounded-xl border border-kumo-line bg-kumo-base p-5"><div className="mb-3 flex items-center justify-between"><h2 className="font-semibold text-kumo-default">Agent Topics</h2><span className="text-xs text-kumo-subtle">{topics.data?.topics.length ?? 0} saved</span></div>{topics.data?.topics.length ? <div className="space-y-2">{topics.data.topics.map((topic) => <div key={topic.id} className="flex items-center justify-between rounded-lg bg-kumo-recessed px-3 py-2 text-sm"><span className="font-medium">{topic.title}</span><span className="text-xs text-kumo-subtle">{topic.status}</span></div>)}</div> : <p className="text-sm text-kumo-subtle">Create a Topic from the agent panel to retain a work context.</p>}</div>
	</div></div>;
}
