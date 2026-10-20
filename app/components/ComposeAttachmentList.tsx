import type { ComposeAttachment } from "~/lib/compose-attachments";

export function ComposeAttachmentList({ attachments, onRemove, disabled = false }: { attachments: ComposeAttachment[]; onRemove: (index: number) => void; disabled?: boolean }) {
	if (!attachments.length) return null;
	return <div className="rounded-md border border-kumo-line bg-kumo-fill/20 px-3 py-2 text-xs text-kumo-subtle">
		<p className="font-medium">Attachments and images</p>
		{attachments.map((item, index) => <div key={item.contentId || `${index}-${item.filename}`} className="flex items-center gap-2 py-1">
			<span className="truncate">{item.filename}{item.disposition === "inline" ? " (inline image)" : ""}</span>
			<button type="button" disabled={disabled} aria-label={`Remove ${item.filename}`} onClick={() => onRemove(index)} className="text-kumo-link">Remove</button>
		</div>)}
	</div>;
}
