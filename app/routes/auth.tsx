import { Button, Input, Select } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import { Link as RouterLink, useLocation } from "react-router";
import { login, register } from "~/services/auth";

export function meta() { return [{ title: "Sign in" }]; }

export default function AuthRoute() {
	const location = useLocation();
	const isRegister = location.pathname === "/register";
	const [appName, setAppName] = useState("Agentic Inbox");
	const [domains, setDomains] = useState<string[]>(["astratradehk.com"]);
	const [name, setName] = useState("");
	const [username, setUsername] = useState("");
	const [selectedDomain, setSelectedDomain] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		Promise.all([
			fetch("/branding").then((r) => r.ok ? r.json() as Promise<{ appName?: string }> : null),
			fetch("/api/v1/auth/config").then((r) => r.ok ? r.json() as Promise<{ domains?: string[]; teamDomain?: string }> : null),
		]).then(([branding, config]) => {
			if (cancelled) return;
			if (branding?.appName?.trim()) setAppName(branding.appName.trim());
			const configured = (config?.domains || []).map((d) => d.trim().replace(/^@/, "")).filter(Boolean);
			const nextDomains = configured.length ? configured : (config?.teamDomain?.trim() ? [config.teamDomain.trim().replace(/^@/, "")] : ["astratradehk.com"]);
			setDomains(nextDomains);
			setSelectedDomain((current) => current && nextDomains.includes(current) ? current : nextDomains[0] || "");
		}).catch(() => undefined);
		return () => { cancelled = true; };
	}, []);

	useEffect(() => { document.title = `${appName} — ${isRegister ? "Register" : "Sign in"}`; }, [appName, isRegister]);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault(); setError(null); setMessage(null);
		const local = username.trim();
		if (!local || !selectedDomain) { setError("Please enter your username and choose a domain"); return; }
		const email = `${local}@${selectedDomain}`;
		if (isRegister && password !== confirm) { setError("Passwords do not match"); return; }
		setBusy(true);
		try {
			if (isRegister) {
				await register(name, email, password); setMessage("Registration submitted. An administrator must approve your account before you can sign in."); setName(""); setUsername(""); setPassword(""); setConfirm("");
			} else {
				const user = await login(email, password); window.location.href = user.role === "admin" ? "/" : `/mailbox/${encodeURIComponent(user.email)}`;
			}
		} catch (err) { setError(err instanceof Error ? err.message : "Something went wrong"); } finally { setBusy(false); }
	};

	return (
		<div className="min-h-screen flex items-center justify-center p-6 relative overflow-hidden bg-kumo-recessed">
			<div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: "url('/api/v1/auth/login-background')" }} />
			<div className="absolute inset-0 bg-black/35" />
			<div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(59,130,246,0.18),transparent_35%),radial-gradient(circle_at_80%_80%,rgba(14,165,233,0.16),transparent_35%)]" />
			<div className="relative w-full max-w-md rounded-2xl border border-white/20 bg-white/90 shadow-2xl p-8 backdrop-blur-xl">
				<div className="text-center mb-8"><div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-black/10 text-xl font-bold">✉</div><h1 className="text-2xl font-bold text-gray-900">{appName}</h1><p className="mt-1 text-sm text-gray-600">{isRegister ? "Create your company mailbox account" : "Sign in to your company mailbox"}</p></div>
				<form onSubmit={submit} className="space-y-4">
					{error && <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
					{message && <div className="rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-700">{message}</div>}
					{isRegister && <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" required />}
					<div><label className="mb-1.5 block text-sm font-medium text-gray-900">Username</label><div className="flex items-center gap-2"><div className="flex-1"><Input aria-label="Username" value={username} onChange={(e) => setUsername(e.target.value.replace(/\s/g, ""))} placeholder="gavin" required /></div><span className="text-sm text-gray-500">@</span><div className="flex-1">{domains.length > 1 ? <Select aria-label="Email domain" value={selectedDomain} onValueChange={(value) => value && setSelectedDomain(value)}>{domains.map((d) => <Select.Option key={d} value={d}>{d}</Select.Option>)}</Select> : <div className="h-9 flex items-center text-sm text-gray-600">{selectedDomain}</div>}</div></div></div>
					<Input label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" minLength={8} required />
					{isRegister && <Input label="Confirm password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />}
					<Button type="submit" variant="primary" className="w-full" loading={busy}>{isRegister ? "Register" : "Sign in"}</Button>
				</form>
				<div className="mt-6 text-center text-sm text-gray-600">{isRegister ? <>Already have an account? <RouterLink to="/login" className="font-medium text-gray-900 underline">Sign in</RouterLink></> : <>Need an account? <RouterLink to="/register" className="font-medium text-gray-900 underline">Employee registration</RouterLink></>}</div>
			</div>
		</div>
	);
}
