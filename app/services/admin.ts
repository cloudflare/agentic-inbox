export interface AdminUser {
	email: string;
	name: string;
	role: "admin" | "employee";
	status: "pending" | "active" | "disabled";
	createdAt: string;
}

async function call<T>(url: string, method = "GET", body?: unknown): Promise<T> {
	const response = await fetch(url, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error((data as { error?: string }).error || `Request failed: ${response.status}`);
	return data as T;
}

export const adminApi = {
	listUsers: () => call<{ users: AdminUser[] }>("/api/v1/admin/users"),
	approve: (email: string) => call("/api/v1/admin/approve", "POST", { email }),
	setStatus: (email: string, status: AdminUser["status"]) => call("/api/v1/admin/status", "POST", { email, status }),
	resetPassword: (email: string, password: string, name?: string) => call("/api/v1/admin/reset-password", "POST", { email, password, name }),
	getBranding: () => call<{ appName: string }>("/branding"),
	setBranding: (appName: string) => call<{ appName: string }>("/branding", "POST", { appName }),
	uploadLoginBackground: async (file: File) => {
		const form = new FormData(); form.set("file", file);
		const response = await fetch("/api/v1/admin/login-background", { method: "POST", credentials: "same-origin", body: form });
		const data = await response.json().catch(() => ({})) as { error?: string };
		if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
	},
	removeLoginBackground: async () => {
		const response = await fetch("/api/v1/admin/login-background", { method: "DELETE", credentials: "same-origin" });
		if (!response.ok) throw new Error("Unable to remove login background");
	},
};
