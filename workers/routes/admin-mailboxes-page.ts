import type { UserRow } from "../db/users-schema.ts";
import { escapeHtml } from "../lib/email-helpers.ts";
import type { MailboxManagementRow } from "../lib/mailbox-access.ts";
import {
	brandLogo,
	pageShell,
	type BrandConfig,
} from "./brand.ts";

type AdminMailboxUser = Pick<UserRow, "id" | "email" | "is_active">;

type PageFlash = {
	tone: "ok" | "err";
	message: string;
};

function inlineJson(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

function mailboxState(mailbox: MailboxManagementRow): string {
	return mailbox.is_active === 1
		? `<span class="badge mailbox-state">Active</span>`
		: `<span class="badge off mailbox-state">Inactive</span>`;
}

function personalMailboxRows(
	mailboxes: MailboxManagementRow[],
	users: AdminMailboxUser[],
): string {
	const ownerEmail = new Map(users.map((user) => [user.id, user.email]));
	if (mailboxes.length === 0) {
		return `<div class="empty-state">
			<strong>No Personal Mailboxes yet</strong>
			<span>Creating a user also creates their private Personal Mailbox.</span>
		</div>`;
	}

	return `<div class="mailbox-list">${mailboxes
		.map(
			(mailbox) => `<div class="mailbox-row">
				<div class="mailbox-identity">
					<strong>${escapeHtml(mailbox.address)}</strong>
					<span>${escapeHtml(ownerEmail.get(mailbox.owner_user_id ?? "") ?? "Private owner")}</span>
				</div>
				${mailboxState(mailbox)}
			</div>`,
		)
		.join("")}</div>`;
}

function sharedMailboxRows(mailboxes: MailboxManagementRow[]): string {
	if (mailboxes.length === 0) {
		return `<div class="empty-state">
			<strong>No Shared Mailboxes yet</strong>
			<span>Create one for an address that several teammates need to handle together.</span>
		</div>`;
	}

	return `<div class="shared-list">${mailboxes
		.map((mailbox) => {
			const memberLabel = `${mailbox.member_count} ${mailbox.member_count === 1 ? "member" : "members"}`;
			return `<details class="shared-mailbox" data-mailbox-id="${escapeHtml(mailbox.id)}">
				<summary>
					<span class="summary-chevron" aria-hidden="true">›</span>
					<span class="mailbox-identity">
						<strong>${escapeHtml(mailbox.address)}</strong>
						<span class="member-count">${memberLabel}</span>
					</span>
					${mailboxState(mailbox)}
				</summary>
				<div class="member-panel">
					<div class="member-list" role="list" aria-live="polite">
						<p class="muted">Open to load members.</p>
					</div>
					<form class="member-form">
						<label for="member-${encodeURIComponent(mailbox.id)}">Give a teammate access</label>
						<div class="member-add-row">
							<select id="member-${encodeURIComponent(mailbox.id)}" name="userId" required aria-label="Active teammate"></select>
							<button class="sm" type="submit">Add member</button>
						</div>
						<p class="form-note">Only active users can be added.</p>
					</form>
				</div>
			</details>`;
		})
		.join("")}</div>`;
}

export function renderAdminMailboxesPage(
	brand: BrandConfig,
	users: AdminMailboxUser[],
	mailboxes: MailboxManagementRow[],
	flash?: PageFlash,
): string {
	const activeUsers = users
		.filter((user) => user.is_active === 1)
		.sort((a, b) => a.email.localeCompare(b.email))
		.map(({ id, email }) => ({ id, email }));
	const personal = mailboxes
		.filter((mailbox) => mailbox.type === "PERSONAL")
		.sort((a, b) => a.address.localeCompare(b.address));
	const shared = mailboxes
		.filter((mailbox) => mailbox.type === "SHARED")
		.sort((a, b) => a.address.localeCompare(b.address));
	const flashHtml = flash
		? `<div class="flash ${flash.tone}" role="status">${escapeHtml(flash.message)}</div>`
		: "";

	return pageShell(
		brand,
		`Mailboxes · ${brand.appName}`,
		`<div class="wrap mailbox-admin">
		<style>
			.mailbox-admin{max-width:1040px}
			.admin-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
			.admin-actions .btn{padding:8px 12px;border-radius:10px;font-size:13px}
			.page-heading{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;align-items:end;margin:28px 0 26px}
			.page-heading .sub{max-width:620px;margin:6px 0 0}
			.create-panel{align-self:end;position:relative}
			.create-panel>summary{list-style:none;cursor:pointer;background:var(--accent);border:1px solid var(--accent);color:var(--accent-fg);font-weight:600;padding:10px 15px;border-radius:12px;white-space:nowrap}
			.create-panel>summary::-webkit-details-marker{display:none}
			.create-panel[open]>summary{background:var(--accent-hover)}
			.create-body{position:absolute;z-index:5;right:0;top:calc(100% + 8px);width:min(420px,calc(100vw - 32px));padding:20px;background:var(--surface);border:1px solid var(--line-strong);border-radius:16px;box-shadow:0 18px 50px rgba(26,26,26,.14)}
			.create-body h2{margin-bottom:2px}
			.create-body .sub{margin-bottom:10px}
			.create-body button{margin-top:16px;width:100%}
			.access-principles{display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--line);background:var(--surface);border-radius:16px;margin:0 0 30px;overflow:hidden}
			.principle{padding:20px 22px}
			.principle+.principle{border-left:1px solid var(--line)}
			.principle strong{display:block;font-size:14px;margin-bottom:5px}
			.principle span{display:block;color:var(--muted);font-size:13px;max-width:46ch}
			.section-heading{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;margin:30px 0 10px}
			.section-heading h2{font-size:18px;margin:0}
			.section-heading p{margin:2px 0 0;color:var(--muted);font-size:13px}
			.section-count{font-size:12px;color:var(--muted);white-space:nowrap}
			.mailbox-list,.shared-list{background:var(--surface);border:1px solid var(--line);border-radius:16px;overflow:hidden}
			.mailbox-row{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:16px 18px}
			.mailbox-row+.mailbox-row{border-top:1px solid var(--line)}
			.mailbox-identity{display:flex;flex-direction:column;min-width:0}
			.mailbox-identity strong{font-size:14px;overflow-wrap:anywhere}
			.mailbox-identity span{font-size:12px;color:var(--muted)}
			.mailbox-state{margin-left:auto}
			.shared-mailbox+ .shared-mailbox{border-top:1px solid var(--line)}
			.shared-mailbox>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:12px;padding:17px 18px;transition:background .14s ease-out}
			.shared-mailbox>summary::-webkit-details-marker{display:none}
			.shared-mailbox>summary:hover{background:var(--tint)}
			.shared-mailbox>summary:focus-visible{outline:3px solid var(--focus-shadow);outline-offset:-3px}
			.summary-chevron{font-size:23px;line-height:1;color:var(--muted);transform-origin:center;transition:transform .18s ease-out}
			.shared-mailbox[open] .summary-chevron{transform:rotate(90deg)}
			.member-panel{padding:4px 18px 20px 42px;border-top:1px solid var(--line);background:color-mix(in srgb,var(--tint) 48%,var(--surface))}
			.member-list{margin:8px 0 16px}
			.member-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid var(--line)}
			.member-email{font-size:13px;overflow-wrap:anywhere}
			.member-remove{background:transparent;color:var(--danger);border-color:transparent;padding:6px 8px}
			.member-remove:hover{background:#f7ded9;border-color:#e7b3ac}
			.member-add-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center}
			.member-form label{margin-top:0}
			.form-note{font-size:11px;color:var(--muted);margin:6px 0 0}
			.empty-state{padding:26px 20px;display:flex;flex-direction:column;gap:3px}
			.empty-state strong{font-size:14px}
			.empty-state span{font-size:13px;color:var(--muted)}
			#mailbox-status:empty{display:none}
			@media (max-width:700px){
				.page-heading{grid-template-columns:1fr;align-items:start}
				.create-panel{justify-self:start}
				.create-body{position:fixed;left:16px;right:16px;top:auto;width:auto}
				.access-principles{grid-template-columns:1fr}
				.principle+.principle{border-left:0;border-top:1px solid var(--line)}
				.member-panel{padding-left:18px}
				.member-add-row{grid-template-columns:1fr}
				.member-add-row button{width:100%}
			}
		</style>
		<div class="brandbar">${brandLogo(brand, { href: "/" })}
			<div class="admin-actions">
				<a class="btn secondary" href="/admin/ai-cost">AI costs</a>
				<a class="btn secondary" href="/admin/users">Users</a>
				<a class="btn secondary" href="/admin/quizzes">Quizzes</a>
				<form class="inline" method="post" action="/logout"><button class="sm secondary" type="submit">Sign out</button></form>
			</div>
		</div>
		<div class="page-heading">
			<div><h1>Mailboxes</h1><p class="sub">Control which addresses are private and which ones your team handles together.</p></div>
			<details class="create-panel">
				<summary>New Shared Mailbox</summary>
				<div class="create-body">
					<h2>Create a Shared Mailbox</h2>
					<p class="sub">Create the address first, then choose its members.</p>
					<form id="create-shared-mailbox">
						<label for="shared-name">Display name</label>
						<input id="shared-name" name="name" type="text" placeholder="Customer Support" autocomplete="off" required>
						<label for="shared-address">Mailbox address</label>
						<input id="shared-address" name="address" type="email" placeholder="support@${escapeHtml(brand.mailDomain)}" autocomplete="off" required>
						<button type="submit">Create Shared Mailbox</button>
					</form>
				</div>
			</details>
		</div>
		${flashHtml}<div id="mailbox-status" role="status" aria-live="polite"></div>
		<div class="access-principles">
			<div class="principle"><strong>Administrators see every mailbox</strong><span>An administrator has the same access as a member on every mailbox, Personal ones included: read, compose, and reply. Actions are attributed to the person who performed them.</span></div>
			<div class="principle"><strong>Shared means shared handling</strong><span>Members can read, compose, and reply. Read state is shared across the mailbox. Actions are attributed to the person who performed them.</span></div>
		</div>
		<section aria-labelledby="personal-heading">
			<div class="section-heading"><div><h2 id="personal-heading">Personal Mailboxes</h2><p>One mailbox per user. Administrators can open any of them.</p></div><span class="section-count">${personal.length} total</span></div>
			${personalMailboxRows(personal, users)}
		</section>
		<section aria-labelledby="shared-heading">
			<div class="section-heading"><div><h2 id="shared-heading">Shared Mailboxes</h2><p>Open a mailbox to manage its members.</p></div><span class="section-count">${shared.length} total</span></div>
			${sharedMailboxRows(shared)}
		</section>
		<script id="active-users" type="application/json">${inlineJson(activeUsers)}</script>
		<script>
		(function(){
			"use strict";
			var activeUsers=JSON.parse(document.getElementById("active-users").textContent||"[]");
			var status=document.getElementById("mailbox-status");

			function announce(message,tone){
				status.className="flash "+(tone==="err"?"err":"ok");
				status.textContent=message;
				status.scrollIntoView({behavior:"smooth",block:"nearest"});
			}

			async function requestJson(url,options){
				var response=await fetch(url,options);
				var payload={};
				if(response.status!==204){payload=await response.json().catch(function(){return {};});}
				if(!response.ok){throw new Error(payload.error||"The request could not be completed.");}
				return payload;
			}

			function setBusy(form,busy){
				Array.from(form.elements).forEach(function(element){element.disabled=busy;});
				form.setAttribute("aria-busy",String(busy));
			}

			async function loadMembers(panel,force){
				if(panel.dataset.loaded==="true"&&!force){return;}
				var mailboxId=panel.dataset.mailboxId;
				var list=panel.querySelector(".member-list");
				var form=panel.querySelector(".member-form");
				var select=form.querySelector("select");
				list.textContent="Loading members...";
				form.hidden=true;
				try{
					var payload=await requestJson("/api/v1/admin/shared-mailboxes/"+encodeURIComponent(mailboxId)+"/members");
					var members=payload.members||[];
					var memberIds=new Set(members.map(function(member){return member.id;}));
					list.replaceChildren();
					if(members.length===0){
						var empty=document.createElement("p");empty.className="muted";empty.textContent="No one has access yet.";list.appendChild(empty);
					}else{
						members.forEach(function(member){
							var row=document.createElement("div");row.className="member-row";row.setAttribute("role","listitem");
							var email=document.createElement("span");email.className="member-email";email.textContent=member.email;
							var remove=document.createElement("button");remove.type="button";remove.className="sm member-remove";remove.textContent="Remove";remove.setAttribute("aria-label","Remove "+member.email);
							remove.addEventListener("click",async function(){
								remove.disabled=true;
								try{
									await requestJson("/api/v1/admin/shared-mailboxes/"+encodeURIComponent(mailboxId)+"/members/"+encodeURIComponent(member.id),{method:"DELETE"});
									announce("Removed "+member.email+" from "+mailboxId+".","ok");
									await loadMembers(panel,true);
								}catch(error){announce(error.message,"err");remove.disabled=false;}
							});
							row.append(email,remove);list.appendChild(row);
						});
					}
					select.replaceChildren();
					activeUsers.filter(function(user){return !memberIds.has(user.id);}).forEach(function(user){select.add(new Option(user.email,user.id));});
					form.hidden=select.options.length===0;
					panel.querySelector(".member-count").textContent=members.length+" "+(members.length===1?"member":"members");
					panel.dataset.loaded="true";
				}catch(error){list.textContent=error.message;announce(error.message,"err");}
			}

			document.querySelectorAll(".shared-mailbox").forEach(function(panel){
				panel.addEventListener("toggle",function(){if(panel.open){loadMembers(panel,false);}});
				panel.querySelector(".member-form").addEventListener("submit",async function(event){
					event.preventDefault();var form=event.currentTarget;var userId=new FormData(form).get("userId");if(!userId){return;}
					setBusy(form,true);
					try{
						var member=await requestJson("/api/v1/admin/shared-mailboxes/"+encodeURIComponent(panel.dataset.mailboxId)+"/members",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({userId:userId})});
						announce("Added "+member.email+" to "+panel.dataset.mailboxId+".","ok");
						await loadMembers(panel,true);
					}catch(error){announce(error.message,"err");}finally{setBusy(form,false);}
				});
			});

			document.getElementById("create-shared-mailbox").addEventListener("submit",async function(event){
				event.preventDefault();var form=event.currentTarget;var values=new FormData(form);var address=String(values.get("address")||"").trim().toLowerCase();var name=String(values.get("name")||"").trim();
				setBusy(form,true);
				try{
					await requestJson("/api/v1/mailboxes",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:address,name:name})});
					window.location.assign("/admin/mailboxes?ok="+encodeURIComponent("Created "+address+". Add members when you are ready."));
				}catch(error){announce(error.message,"err");setBusy(form,false);}
			});
		})();
		</script>
	</div>`,
	);
}
