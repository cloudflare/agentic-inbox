import { Button, Input } from "@cloudflare/kumo";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { adminApi, type AdminUser } from "~/services/admin";
import { getCurrentUser } from "~/services/auth";

export function meta() { return [{ title: "Administration" }]; }

export default function AdminRoute() {
	const navigate = useNavigate();
	const [authorized, setAuthorized] = useState<boolean | null>(null);
	const [users, setUsers] = useState<AdminUser[]>([]);
	const [domains, setDomains] = useState<string[]>([]);
	const [newDomain, setNewDomain] = useState("");
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<string | null>(null);
	const [resetEmail, setResetEmail] = useState<string | null>(null);
	const [newPassword, setNewPassword] = useState("");
	const [legacyEmail, setLegacyEmail] = useState("");
	const [legacyName, setLegacyName] = useState("");
	const [legacyPassword, setLegacyPassword] = useState("");
	const [brandName, setBrandName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [backgroundBusy, setBackgroundBusy] = useState(false);
	const fileRef = useRef<HTMLInputElement>(null);

	useEffect(() => { getCurrentUser().then((user) => { if (user?.role === "admin") setAuthorized(true); else { setAuthorized(false); navigate("/", { replace: true }); } }).catch(() => { setAuthorized(false); navigate("/login", { replace: true }); }); }, [navigate]);

	const load = async () => {
		try { const [userData, branding, domainData] = await Promise.all([adminApi.listUsers(), adminApi.getBranding(), adminApi.getDomains()]); setUsers(userData.users); setBrandName(branding.appName); setDomains(domainData.domains); setError(null); }
		catch (err) { setError(err instanceof Error ? err.message : "Unable to load administration data"); }
		finally { setLoading(false); }
	};
	useEffect(() => { if (authorized) void load(); }, [authorized]);

	const approve = async (email: string) => { setBusy(email); try { await adminApi.approve(email); setNotice(`${email} approved.`); await load(); } catch (err) { setError(err instanceof Error ? err.message : "Approval failed"); } finally { setBusy(null); } };
	const toggle = async (user: AdminUser) => { setBusy(user.email); try { await adminApi.setStatus(user.email, user.status === "disabled" ? "active" : "disabled"); await load(); } catch (err) { setError(err instanceof Error ? err.message : "Status update failed"); } finally { setBusy(null); } };
	const resetPassword = async () => { if (!resetEmail || newPassword.length < 8) return; setBusy(resetEmail); try { await adminApi.resetPassword(resetEmail, newPassword); setResetEmail(null); setNewPassword(""); setNotice(`${resetEmail} password updated.`); await load(); } catch (err) { setError(err instanceof Error ? err.message : "Password reset failed"); } finally { setBusy(null); } };
	const initializeMailbox = async () => { const email = legacyEmail.trim().toLowerCase(); if (!email || legacyPassword.length < 8) return; setBusy("legacy"); setError(null); setNotice(null); try { await adminApi.resetPassword(email, legacyPassword, legacyName.trim() || email.split("@")[0]); setNotice(`${email} can now sign in with the password you just set.`); setLegacyEmail(""); setLegacyName(""); setLegacyPassword(""); await load(); } catch (err) { setError(err instanceof Error ? err.message : "Unable to initialize mailbox login"); } finally { setBusy(null); } };
	const saveBrand = async () => { const value = brandName.trim(); if (!value) return; setBusy("branding"); setError(null); try { const result = await adminApi.setBranding(value); setBrandName(result.appName); setNotice("Brand name saved. Refresh the login page to see it."); } catch (err) { setError(err instanceof Error ? err.message : "Unable to save brand name"); } finally { setBusy(null); } };
	const addDomain = async () => { const value = newDomain.trim().replace(/^@/, "").toLowerCase(); if (!value) return; setBusy("domain-add"); setError(null); try { const result = await adminApi.addDomain(value); setDomains(result.domains); setNewDomain(""); setNotice(`${value} added.`); } catch (err) { setError(err instanceof Error ? err.message : "Unable to add domain"); } finally { setBusy(null); } };
	const removeDomain = async (domain: string) => { setBusy(`domain:${domain}`); setError(null); try { const result = await adminApi.removeDomain(domain); setDomains(result.domains); setNotice(`${domain} removed.`); } catch (err) { setError(err instanceof Error ? err.message : "Unable to remove domain"); } finally { setBusy(null); } };
	const uploadBackground = async (file: File) => { setBackgroundBusy(true); setError(null); try { await adminApi.uploadLoginBackground(file); setNotice("Login background updated."); } catch (err) { setError(err instanceof Error ? err.message : "Unable to upload background"); } finally { setBackgroundBusy(false); if (fileRef.current) fileRef.current.value = ""; } };
	const removeBackground = async () => { setBackgroundBusy(true); setError(null); try { await adminApi.removeLoginBackground(); setNotice("Login background removed."); } catch (err) { setError(err instanceof Error ? err.message : "Unable to remove background"); } finally { setBackgroundBusy(false); } };

	if (authorized !== true) return <div className="flex items-center justify-center min-h-screen text-sm text-kumo-subtle">Checking administrator access…</div>;

	return (
		<div className="min-h-screen bg-kumo-recessed p-6 md:p-10">
			<div className="mx-auto max-w-5xl space-y-8">
				<div className="flex items-center justify-between gap-4"><div><h1 className="text-2xl font-bold">Administration</h1><p className="mt-1 text-sm text-kumo-subtle">Manage users, mailboxes, domains, branding and the login screen.</p></div><div className="flex gap-2"><Button variant="secondary" onClick={() => navigate("/")}>← Back to Mail</Button><Button variant="secondary" onClick={() => void load()}>Refresh</Button></div></div>
				{error && <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
				{notice && <div className="rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-700">{notice}</div>}

				<div className="rounded-xl border border-kumo-line bg-kumo-base p-6"><h2 className="text-lg font-semibold">Branding</h2><p className="mt-1 text-sm text-kumo-subtle">This overrides the APP_NAME deployment default and is stored in the mailbox system.</p><div className="mt-4 flex gap-3 items-end"><div className="flex-1"><Input label="Brand name" value={brandName} onChange={(e) => setBrandName(e.target.value)} placeholder="Company Mail" maxLength={80} /></div><Button variant="primary" loading={busy === "branding"} disabled={!brandName.trim()} onClick={() => void saveBrand()}>Save brand</Button></div></div>

				<div className="rounded-xl border border-kumo-line bg-kumo-base p-6"><h2 className="text-lg font-semibold">Email Domains</h2><p className="mt-1 text-sm text-kumo-subtle">These domains appear on the login screen and are accepted for employee registration.</p><div className="mt-4 flex flex-wrap gap-2">{domains.map((domain) => <div key={domain} className="flex items-center gap-2 rounded-lg border border-kumo-line px-3 py-2 text-sm"><span>@{domain}</span><button type="button" className="text-kumo-subtle hover:text-red-600" disabled={busy === `domain:${domain}`} onClick={() => void removeDomain(domain)} aria-label={`Remove ${domain}`}>×</button></div>)}</div><div className="mt-4 flex gap-3 items-end"><div className="flex-1 max-w-md"><Input label="Add domain" value={newDomain} onChange={(e) => setNewDomain(e.target.value)} placeholder="company.com" /></div><Button variant="primary" loading={busy === "domain-add"} disabled={!newDomain.trim()} onClick={() => void addDomain()}>Add domain</Button></div></div>

				<div className="rounded-xl border border-kumo-line bg-kumo-base p-6"><h2 className="text-lg font-semibold">Login background</h2><p className="mt-1 text-sm text-kumo-subtle">Upload a JPG, PNG, WebP or other image up to 5 MB. It will be shown behind the login screen.</p><div className="mt-5 flex flex-wrap gap-3"><input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) void uploadBackground(file); }} /><Button variant="primary" loading={backgroundBusy} onClick={() => fileRef.current?.click()}>Choose background image</Button><Button variant="secondary" loading={backgroundBusy} onClick={() => void removeBackground()}>Remove background</Button></div></div>

				<div className="rounded-xl border border-kumo-line bg-kumo-base p-6"><h2 className="text-lg font-semibold">Initialize an existing mailbox</h2><p className="mt-1 text-sm text-kumo-subtle">For mailboxes created before employee login accounts existed. Set a password here; the mailbox and its emails are not changed.</p><div className="mt-5 grid gap-4 md:grid-cols-3"><Input label="Mailbox email" type="email" value={legacyEmail} onChange={(e) => setLegacyEmail(e.target.value)} placeholder="user@company.com" /><Input label="Name (optional)" value={legacyName} onChange={(e) => setLegacyName(e.target.value)} placeholder="User" /><Input label="Login password" type="password" minLength={8} value={legacyPassword} onChange={(e) => setLegacyPassword(e.target.value)} placeholder="At least 8 characters" /></div><div className="mt-4"><Button variant="primary" loading={busy === "legacy"} disabled={!legacyEmail.trim() || legacyPassword.length < 8} onClick={() => void initializeMailbox()}>Set login password</Button></div></div>

				<div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base"><div className="p-5 border-b border-kumo-line"><h2 className="text-lg font-semibold">Users / Employees</h2><p className="mt-1 text-sm text-kumo-subtle">Pending registrations appear here for approval.</p></div>{loading ? <div className="p-8 text-center text-sm text-kumo-subtle">Loading…</div> : users.length === 0 ? <div className="p-8 text-center text-sm text-kumo-subtle">No employee accounts.</div> : users.map((user, index) => <div key={user.email} className={`flex flex-col gap-4 p-5 md:flex-row md:items-center ${index ? "border-t border-kumo-line" : ""}`}><div className="flex-1 min-w-0"><div className="font-medium truncate">{user.name}</div><div className="text-sm text-kumo-subtle truncate">{user.email}</div></div><div className="text-xs uppercase tracking-wide text-kumo-subtle">{user.role} · {user.status}</div><div className="flex gap-2">{user.role === "employee" && user.status === "pending" && <Button size="sm" variant="primary" loading={busy === user.email} onClick={() => void approve(user.email)}>Approve</Button>}{user.role === "employee" && user.status !== "pending" && <Button size="sm" variant="secondary" loading={busy === user.email} onClick={() => void toggle(user)}>{user.status === "disabled" ? "Enable" : "Disable"}</Button>}{user.role === "employee" && user.status !== "pending" && <Button size="sm" variant="ghost" onClick={() => setResetEmail(user.email)}>Reset password</Button>}</div></div>)}</div>
			</div>
			{resetEmail && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"><div className="w-full max-w-md rounded-xl bg-kumo-base p-6 shadow-2xl"><h2 className="text-lg font-semibold">Reset password</h2><p className="mt-1 text-sm text-kumo-subtle">{resetEmail}</p><div className="mt-5"><Input label="New password" type="password" minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /></div><div className="mt-5 flex justify-end gap-2"><Button variant="secondary" onClick={() => setResetEmail(null)}>Cancel</Button><Button variant="primary" loading={busy === resetEmail} disabled={newPassword.length < 8} onClick={() => void resetPassword()}>Save</Button></div></div></div>}
		</div>
	);
}
