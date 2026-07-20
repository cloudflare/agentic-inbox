// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Dialog, Input, Loader, Table, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import { CloudArrowUpIcon, PlusIcon, TrashIcon, UsersIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { useParams } from "react-router";
import { type ParsedStudent, parseRosterCsv } from "~/lib/csv";
import { useCreateRoster, useDeleteRoster, useRosterList, useStudentList } from "~/queries/rosters";
import type { Roster } from "~/types";

export default function RosterRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();
	const { data: rosters = [], isLoading } = useRosterList(mailboxId);
	const createRosterMutation = useCreateRoster();
	const deleteRosterMutation = useDeleteRoster();

	const [isAddOpen, setIsAddOpen] = useState(false);
	const [isDragging, setIsDragging] = useState(false);
	const [courseName, setCourseName] = useState("");
	const [parsedStudents, setParsedStudents] = useState<ParsedStudent[]>([]);
	const [parseErrors, setParseErrors] = useState<string[]>([]);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const [viewingRosterId, setViewingRosterId] = useState<string | null>(null);
	const { data: students = [] } = useStudentList(mailboxId, viewingRosterId ?? undefined);

	const resetAddForm = () => {
		setCourseName("");
		setParsedStudents([]);
		setParseErrors([]);
	};

	const handleFile = async (file: File) => {
		const text = await file.text();
		const { students: parsed, errors } = parseRosterCsv(text);
		setParsedStudents(parsed);
		setParseErrors(errors);
		if (!courseName.trim()) {
			setCourseName(file.name.replace(/\.csv$/i, ""));
		}
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!mailboxId || !courseName.trim() || parsedStudents.length === 0) return;
		try {
			await createRosterMutation.mutateAsync({
				mailboxId,
				name: courseName.trim(),
				students: parsedStudents,
			});
			resetAddForm();
			setIsAddOpen(false);
			toastManager.add({ title: `Roster added with ${parsedStudents.length} student(s)` });
		} catch {
			toastManager.add({ title: "Failed to add roster", variant: "error" });
		}
	};

	const handleDelete = async (id: string) => {
		if (!mailboxId) return;
		try {
			await deleteRosterMutation.mutateAsync({ mailboxId, id });
			if (viewingRosterId === id) setViewingRosterId(null);
			toastManager.add({ title: "Roster deleted" });
		} catch {
			toastManager.add({ title: "Failed to delete roster", variant: "error" });
		}
	};

	const viewingRoster = rosters.find((r) => r.id === viewingRosterId);

	return (
		<div className="max-w-2xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<div className="flex items-center justify-between mb-6">
				<div className="flex items-center gap-2">
					<UsersIcon size={20} weight="duotone" className="text-kumo-subtle" />
					<h1 className="text-lg font-semibold text-kumo-default">Rosters</h1>
				</div>
				<Button variant="primary" icon={<PlusIcon size={16} />} onClick={() => setIsAddOpen(true)}>
					Add Roster
				</Button>
			</div>

			<p className="text-xs text-kumo-subtle mb-4">
				Upload a course roster (CSV with name/email columns) to match senders and send announcements.
			</p>

			{isLoading ? (
				<div className="flex justify-center py-20">
					<Loader size="lg" />
				</div>
			) : (
				<div className="border border-kumo-line rounded-lg divide-y divide-kumo-line">
					{rosters.length === 0 ? (
						<div className="px-4 py-6 text-sm text-kumo-subtle text-center">
							No rosters yet.
						</div>
					) : (
						rosters.map((roster: Roster) => (
							<div key={roster.id} className="flex items-center gap-2.5 px-4 py-3">
								<button
									type="button"
									onClick={() => setViewingRosterId(roster.id)}
									className="flex items-center gap-2.5 flex-1 min-w-0 text-left bg-transparent border-0 p-0 cursor-pointer"
								>
									<div className="min-w-0 flex-1">
										<span className="text-sm font-medium text-kumo-default block truncate">
											{roster.name}
										</span>
										<span className="text-xs text-kumo-subtle">
											{roster.studentCount} student{roster.studentCount !== 1 ? "s" : ""}
										</span>
									</div>
								</button>
								<Tooltip content="Delete" asChild>
									<Button
										variant="ghost"
										shape="square"
										size="sm"
										icon={<TrashIcon size={16} />}
										onClick={() => handleDelete(roster.id)}
										aria-label="Delete roster"
									/>
								</Tooltip>
							</div>
						))
					)}
				</div>
			)}

			{/* Add Roster dialog */}
			<Dialog.Root
				open={isAddOpen}
				onOpenChange={(open) => {
					setIsAddOpen(open);
					if (!open) resetAddForm();
				}}
			>
				<Dialog size="lg" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-4">
						Add roster
					</Dialog.Title>
					<form onSubmit={handleSubmit} className="space-y-4">
						<div
							onDragOver={(e) => {
								e.preventDefault();
								setIsDragging(true);
							}}
							onDragLeave={() => setIsDragging(false)}
							onDrop={(e) => {
								e.preventDefault();
								setIsDragging(false);
								const file = e.dataTransfer.files[0];
								if (file) handleFile(file);
							}}
							className={`rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
								isDragging ? "border-kumo-brand bg-kumo-brand/5" : "border-kumo-line"
							}`}
						>
							<CloudArrowUpIcon size={24} className="mx-auto mb-2 text-kumo-subtle" />
							<input
								type="file"
								hidden
								ref={fileInputRef}
								accept=".csv"
								onChange={(e) => {
									const file = e.target.files?.[0];
									if (file) handleFile(file);
									e.target.value = "";
								}}
							/>
							<Button
								type="button"
								variant="secondary"
								size="sm"
								onClick={() => fileInputRef.current?.click()}
							>
								Choose CSV file
							</Button>
							<p className="text-xs text-kumo-subtle mt-2">
								or drag and drop a CSV file here. Must include an "email" column.
							</p>
						</div>

						{parseErrors.length > 0 && (
							<div className="rounded-lg bg-kumo-danger/10 p-3 text-xs text-kumo-danger space-y-1">
								{parseErrors.map((err, i) => (
									<p key={i}>{err}</p>
								))}
							</div>
						)}

						{parsedStudents.length > 0 && (
							<>
								<Input
									label="Course name"
									placeholder="e.g. CS101 Fall 2026"
									value={courseName}
									onChange={(e) => setCourseName(e.target.value)}
									required
								/>
								<div className="max-h-64 overflow-y-auto rounded-lg border border-kumo-line">
									<Table>
										<Table.Header>
											<Table.Row>
												<Table.Head>Name</Table.Head>
												<Table.Head>Email</Table.Head>
											</Table.Row>
										</Table.Header>
										<Table.Body>
											{parsedStudents.map((s, i) => (
												<Table.Row key={i}>
													<Table.Cell>{s.name || "—"}</Table.Cell>
													<Table.Cell>{s.email}</Table.Cell>
												</Table.Row>
											))}
										</Table.Body>
									</Table>
								</div>
								<p className="text-xs text-kumo-subtle">
									{parsedStudents.length} student{parsedStudents.length !== 1 ? "s" : ""} ready to import.
								</p>
							</>
						)}

						<div className="flex justify-end gap-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary">
										Cancel
									</Button>
								)}
							/>
							<Button
								type="submit"
								variant="primary"
								disabled={!courseName.trim() || parsedStudents.length === 0}
								loading={createRosterMutation.isPending}
							>
								Add roster
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>

			{/* View students dialog */}
			<Dialog.Root open={!!viewingRosterId} onOpenChange={(open) => !open && setViewingRosterId(null)}>
				<Dialog size="lg" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-1">
						{viewingRoster?.name}
					</Dialog.Title>
					<div className="mb-4">
						<Badge variant="secondary">
							{students.length} student{students.length !== 1 ? "s" : ""}
						</Badge>
					</div>
					<div className="max-h-96 overflow-y-auto rounded-lg border border-kumo-line">
						<Table>
							<Table.Header>
								<Table.Row>
									<Table.Head>Name</Table.Head>
									<Table.Head>Email</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{students.map((s) => (
									<Table.Row key={s.id}>
										<Table.Cell>{s.name || "—"}</Table.Cell>
										<Table.Cell>{s.email}</Table.Cell>
									</Table.Row>
								))}
							</Table.Body>
						</Table>
					</div>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
