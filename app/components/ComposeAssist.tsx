import { Button, Select } from "@cloudflare/kumo";
import { SparkleIcon, TextTIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import type { ResponseTemplate } from "~/types";

interface ComposeAssistProps {
	templates: ResponseTemplate[];
	canUseTemplates: boolean;
	canUseAiDraft: boolean;
	isGeneratingAiDraft: boolean;
	onInsertTemplate: (template: ResponseTemplate) => void;
	onGenerateAiDraft: (templateId?: string) => void;
}

export default function ComposeAssist({
	templates,
	canUseTemplates,
	canUseAiDraft,
	isGeneratingAiDraft,
	onInsertTemplate,
	onGenerateAiDraft,
}: ComposeAssistProps) {
	const [selectedTemplateId, setSelectedTemplateId] = useState("");
	const selectedTemplate = useMemo(
		() => templates.find((template) => template.id === selectedTemplateId),
		[selectedTemplateId, templates],
	);

	if (!canUseTemplates && !canUseAiDraft) return null;

	return (
		<div className="flex flex-wrap items-center gap-2 rounded-md border border-kumo-line bg-kumo-fill/20 p-2">
			{canUseTemplates && (
				<div className="min-w-48 flex-1">
					<Select
						aria-label="Response template"
						value={selectedTemplateId}
						onValueChange={(value) => setSelectedTemplateId(value || "")}
					>
						{templates.map((template) => (
							<Select.Option key={template.id} value={template.id}>
								{template.name}
							</Select.Option>
						))}
					</Select>
				</div>
			)}
			{canUseTemplates && (
				<Button
					type="button"
					variant="secondary"
					size="sm"
					icon={<TextTIcon size={14} />}
					disabled={!selectedTemplate}
					onClick={() => {
						if (selectedTemplate) onInsertTemplate(selectedTemplate);
					}}
				>
					Insert
				</Button>
			)}
			{canUseAiDraft && (
				<Button
					type="button"
					variant="secondary"
					size="sm"
					icon={<SparkleIcon size={14} />}
					loading={isGeneratingAiDraft}
					onClick={() => onGenerateAiDraft(selectedTemplate?.id)}
				>
					AI Draft
				</Button>
			)}
		</div>
	);
}
