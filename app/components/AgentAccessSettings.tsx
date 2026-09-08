import { Badge, Button, Input, useKumoToastManager } from "@cloudflare/kumo";
import { CopyIcon, FloppyDiskIcon, KeyIcon, PlusIcon, ClockCounterClockwiseIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useMailboxes } from "~/queries/mailboxes";
import api from "~/services/api";
import { AgentConfigSchema, defaultAgentConfig, type AgentAccess, type AgentActivity, type AgentConfig, type AgentPermission } from "../../shared/agent-access";

const selectClass = "w-full min-w-0 rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default";
export default function AgentAccessSettings({ mailboxId }: { mailboxId: string }) {
	const qc = useQueryClient();
	const toast = useKumoToastManager();
	const { data: mailboxes = [] } = useMailboxes();
	const { data: entries = [], isPending, error: loadError } = useQuery({ queryKey: ["agent-access"], queryFn: api.listAgentAccess });
	const [selected, setSelected] = useState<AgentAccess | null>(null);
	const [editing, setEditing] = useState(false);
	const [config, setConfig] = useState<AgentConfig>(() => defaultAgentConfig(mailboxId));
	const [recipients, setRecipients] = useState("");
	const [token, setToken] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const [activity, setActivity] = useState<AgentActivity[] | null>(null);
	const [activityMailbox, setActivityMailbox] = useState(mailboxId);
	const [loadingActivity, setLoadingActivity] = useState(false);
	useEffect(() => { setSelected(null); setEditing(false); setToken(""); setActivity(null); setError(""); }, [mailboxId]);
	const baseUrl = typeof window === "undefined" ? "" : window.location.origin;
	function choose(entry: AgentAccess | null) {
		setSelected(entry); setEditing(true); setError(""); setToken(""); setActivity(null);
		if (entry) {
			const { id: _, revision: __, createdAt: ___, updatedAt: ____, ...value } = entry;
			setConfig(value); setRecipients(value.allowedRecipients.join("\n")); setActivityMailbox(value.mailboxIds[0]);
		} else { setConfig(defaultAgentConfig(mailboxId)); setRecipients(""); setActivityMailbox(mailboxId); }
	}
	function update<K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) { setConfig(previous => ({ ...previous, [key]: value })); }
	function togglePermission(permission: AgentPermission, checked: boolean) { update("permissions", checked ? [...config.permissions, permission] : config.permissions.filter(p => p !== permission)); }
	async function copy(value: string) {
		try { await navigator.clipboard.writeText(value); toast.add({ title: "Copied" }); }
		catch { setError("Clipboard unavailable"); }
	}
	async function save() {
		setError("");
		const parsed = AgentConfigSchema.safeParse({ ...config, allowedRecipients: recipients.split(/[\n,]+/).map(s => s.trim()).filter(Boolean) });
		if (!parsed.success) { setError("Enter a name, select at least one mailbox and permission, and check recipient addresses and limits."); return; }
		setSaving(true);
		try {
			if (selected) {
				const updated = await api.updateAgentAccess(selected.id, parsed.data, selected.revision);
				setSelected(updated);
			} else {
				const created = await api.createAgentAccess(parsed.data);
				setSelected(created.access); setToken(created.token);
			}
			setConfig(parsed.data);
			await qc.invalidateQueries({ queryKey: ["agent-access"] });
			toast.add({ title: "Agent access saved" });
		} catch (e) { setError(e instanceof Error ? e.message : "Could not save agent access"); }
		finally { setSaving(false); }
	}
	async function showActivity() {
		if (!selected) return;
		setLoadingActivity(true); setError("");
		try { setActivity(await api.getAgentActivity(selected.id, activityMailbox)); }
		catch (e) { setError(e instanceof Error ? e.message : "Could not load activity"); }
		finally { setLoadingActivity(false); }
	}
	return <section className="border-t border-kumo-line pt-6 space-y-4">
		<div className="flex flex-wrap items-center justify-between gap-2">
			<h2 className="flex items-center gap-2 text-base font-semibold"><KeyIcon size={18} />Agent Access</h2>
			<Button type="button" variant="secondary" size="sm" icon={<PlusIcon size={16} />} disabled={saving} onClick={() => choose(null)}>New agent</Button>
		</div>
		{loadError && <p role="alert" className="text-sm text-red-600">Could not load agent access.</p>}
		{isPending ? <p className="text-sm text-kumo-subtle">Loading...</p> : <div className="divide-y divide-kumo-line">
			{entries.map(entry => <button type="button" key={entry.id} onClick={() => choose(entry)} disabled={saving} className="w-full flex flex-wrap items-center justify-between gap-2 py-3 text-left">
				<span className="min-w-0"><span className="block text-sm font-medium break-words">{entry.name}</span><span className="block text-xs text-kumo-subtle break-all">{entry.mailboxIds.join(", ")}</span></span>
				<Badge variant={entry.enabled ? "primary" : "secondary"}>{!entry.enabled ? "Disabled" : entry.sendMode === "direct" ? "Direct send" : "Drafts only"}</Badge>
			</button>)}
			{entries.length === 0 && <p className="py-2 text-sm text-kumo-subtle">No agent access configured.</p>}
		</div>}
		{editing && <fieldset disabled={saving} className="space-y-4 min-w-0 border-t border-kumo-line pt-4">
			<legend className="text-sm font-medium">{selected ? "Edit agent access" : "New agent access"}</legend>
			<Input label="Agent name" value={config.name} onChange={e => update("name", e.target.value)} />
			<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.enabled} onChange={e => update("enabled", e.target.checked)} />Agent access enabled</label>
			<fieldset className="space-y-2"><legend className="text-sm font-medium mb-2">Allowed mailboxes</legend>
				{mailboxes.map(mailbox => <label key={mailbox.id} className="flex items-center gap-2 text-sm break-all"><input type="checkbox" checked={config.mailboxIds.includes(mailbox.id)} onChange={e => update("mailboxIds", e.target.checked ? [...config.mailboxIds, mailbox.id] : config.mailboxIds.filter(id => id !== mailbox.id))} />{mailbox.email}</label>)}
			</fieldset>
			<fieldset className="flex flex-wrap gap-4"><legend className="text-sm font-medium mb-2">Permissions</legend>
				{([['read', 'Read emails'], ['draft', 'Create drafts'], ['send', 'Submit send requests']] as const).map(([key, label]) => <label key={key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.permissions.includes(key)} onChange={e => togglePermission(key, e.target.checked)} />{label}</label>)}
			</fieldset>
			<label className="block text-sm font-medium space-y-1"><span>Send mode</span><select className={selectClass} value={config.sendMode} onChange={e => update("sendMode", e.target.value as AgentConfig["sendMode"])}><option value="draft_only">Save send requests as drafts</option><option value="direct">Send directly</option></select></label>
			<label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={config.testMode} onChange={e => update("testMode", e.target.checked)} /><span>Test mode</span></label>
			{config.testMode && <Input label="Test recipient" type="email" value={config.testRecipient || ""} onChange={e => update("testRecipient", e.target.value)} />}
			<label className="block text-sm font-medium space-y-1"><span>Allowed recipients (optional)</span><textarea aria-label="Allowed recipients" value={recipients} onChange={e => setRecipients(e.target.value)} rows={3} className={selectClass} /></label>
			<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
				<Input label="Sends / mailbox / UTC day" type="number" min={1} max={100} value={config.maxSendsPerDay} onChange={e => update("maxSendsPerDay", Number(e.target.value))} />
				<Input label="AI drafts / mailbox / UTC day" type="number" min={1} max={100} value={config.maxGenerationsPerDay} onChange={e => update("maxGenerationsPerDay", Number(e.target.value))} />
			</div>
			<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.verifyOutgoingWithAI} onChange={e => update("verifyOutgoingWithAI", e.target.checked)} />AI verification of supplied message content</label>
			<div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => { setEditing(false); setToken(""); }}>Close</Button><Button type="button" variant="primary" icon={<FloppyDiskIcon size={16} />} loading={saving} onClick={save}>{selected ? "Save agent access" : "Create agent key"}</Button></div>
			{token && <div className="space-y-2 border-t border-kumo-line pt-4"><label className="block text-sm font-medium">Agent key (shown once)</label><textarea aria-label="Agent key" readOnly value={token} rows={3} className={`${selectClass} font-mono break-all`} /><Button type="button" variant="secondary" size="sm" icon={<CopyIcon size={16} />} onClick={() => copy(token)}>Copy key</Button></div>}
			{selected && <div className="space-y-3 border-t border-kumo-line pt-4">
				<label className="block text-sm font-medium">MCP URL<input readOnly value={`${baseUrl}/agent/mcp`} className={`${selectClass} mt-1`} /></label>
				<label className="block text-sm font-medium">REST API URL<input readOnly value={`${baseUrl}/agent/api`} className={`${selectClass} mt-1`} /></label>
				<div className="text-xs font-mono break-all">Authorization: Bearer &lt;agent-key&gt;</div>
				<div className="flex flex-wrap items-end gap-2"><label className="min-w-0 flex-1 text-sm">Activity mailbox<select className={selectClass} value={activityMailbox} onChange={e => { setActivityMailbox(e.target.value); setActivity(null); }}>{selected.mailboxIds.map(id => <option key={id}>{id}</option>)}</select></label><Button type="button" variant="secondary" size="sm" loading={loadingActivity} icon={<ClockCounterClockwiseIcon size={16} />} onClick={showActivity}>Activity</Button></div>
				{activity && <div className="divide-y divide-kumo-line text-xs">{activity.length ? activity.map(item => <div key={item.requestId} className="py-2 space-y-1 break-all"><div>{item.action}: {item.status}</div><div className="text-kumo-subtle">{new Date(item.date).toLocaleString()} / {item.requestId}</div></div>) : <p>No activity recorded.</p>}</div>}
			</div>}
		</fieldset>}
		{error && <p role="alert" className="text-sm text-red-600">{error}</p>}
	</section>;
}
