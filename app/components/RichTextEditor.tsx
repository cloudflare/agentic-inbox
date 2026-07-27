// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Tooltip } from "@cloudflare/kumo";
import {
	ArrowClockwiseIcon,
	ArrowCounterClockwiseIcon,
	LinkBreakIcon,
	LinkSimpleIcon,
	ListBulletsIcon,
	ListNumbersIcon,
	ImageIcon,
	MinusIcon,
	QuotesIcon,
	TextBIcon,
	TextItalicIcon,
	TextStrikethroughIcon,
	TextUnderlineIcon,
} from "@phosphor-icons/react";
import { Color } from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import LinkExtension from "@tiptap/extension-link";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useRef } from "react";
import { consumeComposeEditorFileTransfer } from "~/lib/compose-file-transfer";
import {
	MANAGED_INLINE_IMAGE_VERSION,
	type InlineImageInsertion,
} from "~/lib/compose-inline-images";
import { InlineImagePreviewRegistry } from "~/lib/inline-image-preview-registry";
import { ManagedInlineImage } from "./ManagedInlineImage";

interface RichTextEditorProps {
	value: string;
	onChange: (value: string) => void;
	onFiles?: (files: File[]) => void;
	onInlineImages?: (files: File[]) => InlineImageInsertion[];
	inlineImagePreviews?: Readonly<Record<string, string>>;
	fileTransfersDisabled?: boolean;
	/** Places the caret above any quoted or forwarded tail when the editor mounts. */
	autoFocus?: boolean;
}

export default function RichTextEditor({
	value,
	onChange,
	onFiles,
	onInlineImages,
	inlineImagePreviews = {},
	fileTransfersDisabled = false,
	autoFocus = false,
}: RichTextEditorProps) {
	const onFilesRef = useRef(onFiles);
	onFilesRef.current = onFiles;
	const onInlineImagesRef = useRef(onInlineImages);
	onInlineImagesRef.current = onInlineImages;
	const fileTransfersDisabledRef = useRef(fileTransfersDisabled);
	fileTransfersDisabledRef.current = fileTransfersDisabled;
	const editorRef = useRef<Editor | null>(null);
	const initialValueRef = useRef(value);
	const imageInputRef = useRef<HTMLInputElement>(null);
	const previewRegistryRef = useRef<InlineImagePreviewRegistry | null>(null);
	if (!previewRegistryRef.current) {
		previewRegistryRef.current = new InlineImagePreviewRegistry();
	}
	const previewRegistry = previewRegistryRef.current;

	const insertInlineImages = useCallback(
		(insertions: InlineImageInsertion[], position: number) => {
			if (insertions.length === 0 || !editorRef.current) return;
			editorRef.current
				.chain()
				.insertContentAt(position, insertions.map((insertion) => ({
					type: "image",
					attrs: {
						src: `cid:${insertion.contentId}`,
						alt: insertion.alt,
						managed: MANAGED_INLINE_IMAGE_VERSION,
					},
				})))
				.run();
		},
		[],
	);

	const consumeEditorFiles = useCallback((
		event: ClipboardEvent | DragEvent,
		position: number,
	) => {
		if (!onFilesRef.current && !onInlineImagesRef.current) return false;
		const result = consumeComposeEditorFileTransfer(event, {
			addInlineImages: (files) => {
				if (fileTransfersDisabledRef.current) return [];
				if (onInlineImagesRef.current) return onInlineImagesRef.current(files);
				onFilesRef.current?.(files);
				return [];
			},
		});
		if (result.consumed) insertInlineImages(result.inlineInsertions, position);
		return result.consumed;
	}, [insertInlineImages]);

	const editor = useEditor({
		autofocus: autoFocus ? "start" : false,
		extensions: [
			StarterKit,
			Underline,
			TextAlign.configure({ types: ["heading", "paragraph"] }),
			LinkExtension.configure({ openOnClick: false }),
				ManagedInlineImage.configure({
					inline: true,
					previewRegistry,
			}),
			TextStyle,
			Color,
			Highlight.configure({ multicolor: true }),
		],
		content: value,
		editorProps: {
			handlePaste: (view, event) => {
				return consumeEditorFiles(event, view.state.selection.from);
			},
			handleDrop: (view, event) => {
				const position = view.posAtCoords({
					left: event.clientX,
					top: event.clientY,
				})?.pos ?? view.state.selection.from;
				return consumeEditorFiles(event, position);
			},
			attributes: {
				"aria-label": "Message body",
				class:
					"prose prose-sm max-w-none focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-brand min-h-[180px] break-words p-3 text-sm [&_blockquote]:border-l-2 [&_blockquote]:border-kumo-line [&_blockquote]:pl-3 [&_blockquote]:text-kumo-subtle [&_blockquote]:bg-kumo-tint [&_blockquote]:py-1 [&_blockquote]:my-2 [&_blockquote]:text-xs [&_blockquote]:rounded-r-sm",
			},
		},
		onUpdate: ({ editor }) => {
			onChange(editor.getHTML());
		},
	});
	editorRef.current = editor;

	useEffect(() => {
		previewRegistry.replace(inlineImagePreviews);
	}, [inlineImagePreviews, previewRegistry]);

	useEffect(() => {
		if (!editor || editor.isDestroyed) return;
		const shouldRestoreEditorFocus = value !== initialValueRef.current;
		if (value !== editor.getHTML()) {
			editor.commands.setContent(value, { emitUpdate: false });
			if (!shouldRestoreEditorFocus) return;
			// External updates, such as AI drafting, should return focus above quoted text.
			const rafId = requestAnimationFrame(() => {
				if (!editor.isDestroyed) {
					editor.commands.focus('start');
				}
			});
			return () => cancelAnimationFrame(rafId);
		}
	}, [value, editor]);

	const setLink = useCallback(() => {
		if (!editor) return;
		const previousUrl = editor.getAttributes("link").href;
		const url = window.prompt("URL", previousUrl);
		if (url === null) return;
		if (url === "") {
			editor.chain().focus().extendMarkRange("link").unsetLink().run();
			return;
		}
		editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
	}, [editor]);

	if (!editor) return null;

	return (
		<div className="rounded-lg border border-kumo-line overflow-hidden flex flex-col h-full">
			{/* Toolbar */}
			<div className="flex flex-wrap items-center gap-0.5 bg-kumo-recessed px-2 py-1.5 border-b border-kumo-line shrink-0 [&_button]:min-h-11 [&_button]:min-w-11" role="toolbar" aria-label="Message formatting">
				{/* Text formatting */}
				<Tooltip content="Bold" side="bottom" asChild>
					<Button
						variant={editor.isActive("bold") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<TextBIcon size={16} />}
						onClick={() => editor.chain().focus().toggleBold().run()}
						aria-label="Bold"
					/>
				</Tooltip>
				<Tooltip content="Italic" side="bottom" asChild>
					<Button
						variant={editor.isActive("italic") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<TextItalicIcon size={16} />}
						onClick={() => editor.chain().focus().toggleItalic().run()}
						aria-label="Italic"
					/>
				</Tooltip>
				<Tooltip content="Underline" side="bottom" asChild>
					<Button
						variant={editor.isActive("underline") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<TextUnderlineIcon size={16} />}
						onClick={() => editor.chain().focus().toggleUnderline().run()}
						aria-label="Underline"
					/>
				</Tooltip>
				<Tooltip content="Strikethrough" side="bottom" asChild>
					<Button
						variant={editor.isActive("strike") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<TextStrikethroughIcon size={16} />}
						onClick={() => editor.chain().focus().toggleStrike().run()}
						aria-label="Strikethrough"
					/>
				</Tooltip>

				<div className="mx-1 h-5 w-px bg-kumo-fill" />

				{/* Lists */}
				<Tooltip content="Bullet list" side="bottom" asChild>
					<Button
						variant={editor.isActive("bulletList") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<ListBulletsIcon size={16} />}
						onClick={() => editor.chain().focus().toggleBulletList().run()}
						aria-label="Bullet list"
					/>
				</Tooltip>
				<Tooltip content="Numbered list" side="bottom" asChild>
					<Button
						variant={editor.isActive("orderedList") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<ListNumbersIcon size={16} />}
						onClick={() => editor.chain().focus().toggleOrderedList().run()}
						aria-label="Numbered list"
					/>
				</Tooltip>

				<div className="mx-1 h-5 w-px bg-kumo-fill" />

				{/* Block formatting */}
				<Tooltip content="Blockquote" side="bottom" asChild>
					<Button
						variant={editor.isActive("blockquote") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<QuotesIcon size={16} />}
						onClick={() => editor.chain().focus().toggleBlockquote().run()}
						aria-label="Blockquote"
					/>
				</Tooltip>
				<Tooltip content="Link" side="bottom" asChild>
					<Button
						variant={editor.isActive("link") ? "secondary" : "ghost"}
						shape="square"
						size="sm"
						icon={<LinkSimpleIcon size={16} />}
						onClick={setLink}
						aria-label="Link"
					/>
				</Tooltip>
				{editor.isActive("link") && (
					<Tooltip content="Remove link" side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<LinkBreakIcon size={16} />}
							onClick={() => editor.chain().focus().unsetLink().run()}
							aria-label="Remove link"
						/>
					</Tooltip>
				)}
				<Tooltip content="Horizontal rule" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<MinusIcon size={16} />}
						onClick={() => editor.chain().focus().setHorizontalRule().run()}
						aria-label="Horizontal rule"
					/>
				</Tooltip>
				<Tooltip content="Insert image" side="bottom" asChild>
					<Button
						type="button"
						variant="ghost"
						shape="square"
						size="sm"
						icon={<ImageIcon size={16} />}
						onClick={() => imageInputRef.current?.click()}
						aria-label="Insert image"
						disabled={fileTransfersDisabled}
					/>
				</Tooltip>
				<input
					ref={imageInputRef}
					type="file"
					accept="image/*"
					multiple
					disabled={fileTransfersDisabled}
					className="hidden"
					aria-label="Choose images to insert"
					onChange={(event) => {
						if (fileTransfersDisabledRef.current) {
							event.target.value = "";
							return;
						}
						const files = Array.from(event.target.files ?? []);
						const position = editor.state.selection.from;
						const insertions = onInlineImagesRef.current?.(files) ?? [];
						insertInlineImages(insertions, position);
						event.target.value = "";
					}}
				/>

				<div className="mx-1 h-5 w-px bg-kumo-fill" />

				{/* Undo/Redo */}
				<Tooltip content="Undo" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<ArrowCounterClockwiseIcon size={16} />}
						onClick={() => editor.chain().focus().undo().run()}
						disabled={!editor.can().undo()}
						aria-label="Undo"
					/>
				</Tooltip>
				<Tooltip content="Redo" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<ArrowClockwiseIcon size={16} />}
						onClick={() => editor.chain().focus().redo().run()}
						disabled={!editor.can().redo()}
						aria-label="Redo"
					/>
				</Tooltip>
			</div>

			{/* Editor content */}
			<div className="flex-1 overflow-y-auto">
				<EditorContent editor={editor} />
			</div>
		</div>
	);
}
