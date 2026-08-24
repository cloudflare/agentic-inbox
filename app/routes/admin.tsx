import { Button, Input } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import { adminApi, type AdminUser } from "~/services/admin";

export function meta() {
	return [{ title: "Agentic Inbox — Admin" }];
}

export default function AdminRoute() {
	const [users, setUsers] = useState<AdminUser[]>([]);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<string | null>(null);
	const [resetEmail, setResetEmail] = useState<string | null>(null);
	const [newPassword, setNewPassword] = useState("");
	const [error, setError] = useState<string | null>(null);

	const load = async () => {
		try {
			setUsers((await adminApi.listUsers()).users);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unable to load users");
		} finally { setLoading(false); }
	};
	useEffect(() => { void load(); }, []);

	const approve = async (email: string) => {
		setBusy(email);
		try { await adminApi.approve(email); await load(); } catch (err) { setError(err instanceof Error ? err.message : "Approval failed"); } finally { setBusy(null); }
	};

	const toggle = async (user: AdminUser) => {
		setBusy(user.email);
		try { await adminApi.setStatus(user.email, user.status === "disabled" ? "active" : "disabled"); await load(); } catch (err) { setError(err instanceof Error ? err.message : "Status update failed"); } finally { setBusy(null); }
	};

	const resetPassword = async () => {
		if (!resetEmail || newPassword.length < 8) return;
		setBusy(resetEmail);
		try { await adminApi.resetPassword(resetEmail, newPassword); setResetEmail(null); setNewPassword(""); } catch (err) { setError(err instanceof Error ? err.message : "Password reset failed"); } finally { setBusy(null); }
	};

	return (
		<div className="min-h-screen bg-kumo-recessed p-6 md:p-10">
			<div className="mx-auto max-w-5xl">
				<div className="mb-8 flex items-center justify-between">
					<div><h1 className="text-2xl font-bold">Employee Management</h1><p className="mt-1 text-sm text-kumo-subtle">Approve accounts and manage mailbox access.</p></div>
					<Button variant="secondary" onClick={() => void load()}>Refresh</Button>
				</div>
				{error && <div className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
				<div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
					{loading ? <div className="p-8 text-center text-sm text-kumo-subtle">Loading…</div> : users.map((user, index) => (
						<div key={user.email} className={`flex flex-col gap-4 p-5 md:flex-row md:items-center ${index ? "border-t border-kumo-line" : ""}`}>
							<div className="flex-1 min-w-0"><div className="font-medium truncate">{user.name}</div><div className="text-sm text-kumo-subtle truncate">{user.email}</div></div>
							<div className="text-xs uppercase tracking-wide text-kumo-subtle">{user.role} · {user.status}</div>
							<div className="flex gap-2">
								{user.role === "employee" && user.status === "pending" && <Button size="sm" variant="primary" loading={busy === user.email} onClick={() => void approve(user.email)}>Approve</Button>}
								{user.role === "employee" && user.status !== "pending" && <Button size="sm" variant="secondary" loading={busy === user.email} onClick={() => void toggle(user)}>{user.status === "disabled" ? "Enable" : "Disable"}</Button>}
								{user.role === "employee" && user.status !== "pending" && <Button size="sm" variant="ghost" onClick={() => setResetEmail(user.email)}>Reset password</Button>}
							</div>
						</div>
					))}
				</div>
			</div>

			{resetEmail && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
				<div className="w-full max-w-md rounded-xl bg-kumo-base p-6 shadow-2xl">
					<h2 className="text-lg font-semibold">Reset password</h2>
					<p className="mt-1 text-sm text-kumo-subtle">{resetEmail}</p>
					<div className="mt-5"><Input label="New password" type="password" minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /></div>
					<div className="mt-5 flex justify-end gap-2"><Button variant="secondary" onClick={() => setResetEmail(null)}>Cancel</Button><Button variant="primary" loading={busy === resetEmail} disabled={newPassword.length < 8} onClick={() => void resetPassword()}>Save</Button></div>
				</div>
			</div>}
		</div>
	);
}
