// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	lazy,
	Suspense,
	useEffect,
	useRef,
	useState,
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
} from "react";
import LazyLoadBoundary from "~/components/LazyLoadBoundary";
import { useUIStore } from "~/hooks/useUIStore";
import {
	clampListPaneWidth,
	listPaneBounds,
	listPaneWidthFromKey,
	listPaneWidthFromPointer,
	supportsSplitView,
	type ListPaneResizeKey,
} from "~/lib/list-pane-resize";
import { LIST_PANE_WIDTH_PRESETS } from "~/lib/workspace-preferences";

const EmailPanel = lazy(() => import("~/components/EmailPanel"));

function EmailPanelLoadingFallback({ onBack }: { onBack: () => void }) {
	return (
		<div className="animate-pulse p-5 space-y-4" role="status" aria-label="Opening conversation">
			<button
				type="button"
				className="min-h-11 rounded-md px-3 text-sm font-medium text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring md:hidden"
				onClick={onBack}
			>
				Back to messages
			</button>
			<div className="h-5 w-2/3 rounded bg-kumo-fill" />
			<div className="flex items-center gap-3">
				<div className="size-10 rounded-full bg-kumo-fill" />
				<div className="flex-1 space-y-2">
					<div className="h-3 w-40 rounded bg-kumo-fill" />
					<div className="h-2.5 w-24 rounded bg-kumo-fill" />
				</div>
			</div>
			<span className="sr-only">Opening conversation…</span>
		</div>
	);
}

function EmailPanelLoadError({ onBack }: { onBack: () => void }) {
	return (
		<div className="grid h-full place-items-center p-5" role="alert">
			<div className="max-w-sm text-center">
				<h2 className="font-semibold text-kumo-default">Conversation could not open</h2>
				<p className="mt-2 text-sm text-kumo-subtle">
					The message list is safe. Reload to try loading this conversation again.
				</p>
				<div className="mt-4 flex flex-wrap justify-center gap-2">
					<button
						type="button"
						className="min-h-11 rounded-md border border-kumo-line px-3 text-sm font-medium text-kumo-default"
						onClick={onBack}
					>
						Back to messages
					</button>
					<button
						type="button"
						className="min-h-11 rounded-md bg-kumo-brand px-3 text-sm font-medium text-kumo-inverse"
						onClick={() => window.location.reload()}
					>
						Reload mail
					</button>
				</div>
			</div>
		</div>
	);
}

interface MailboxSplitViewProps {
	selectedEmailId: string | null;
	children: ReactNode;
}

interface ActivePointerResize {
	pointerId: number;
	startClientX: number;
	startWidth: number;
}

const RESIZE_KEYS = new Set<ListPaneResizeKey>([
	"ArrowLeft",
	"ArrowRight",
	"Home",
	"End",
	"Enter",
]);

export default function MailboxSplitView({
	selectedEmailId,
	children,
}: MailboxSplitViewProps) {
	// Compose now lives in a centered modal (ComposeEmail), so the split view is
	// purely: email list on the left, the open thread on the right.
	const isPanelOpen = selectedEmailId !== null;
	const { closePanel, listPaneWidth, setListPaneWidth } = useUIStore();
	const containerRef = useRef<HTMLDivElement>(null);
	const activePointerRef = useRef<ActivePointerResize | null>(null);
	const livePointerWidthRef = useRef<number | null>(null);
	const [containerWidth, setContainerWidth] = useState<number | null>(null);
	const [livePointerWidth, setLivePointerWidth] = useState<number | null>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const recordWidth = (width: number) => {
			const nextWidth = Math.max(0, Math.round(width));
			setContainerWidth((current) => current === nextWidth ? current : nextWidth);
		};
		const measure = () => recordWidth(container.getBoundingClientRect().width);
		measure();

		if (typeof ResizeObserver !== "undefined") {
			const observer = new ResizeObserver((entries) => {
				const entry = entries[0];
				if (entry) recordWidth(entry.contentRect.width);
			});
			observer.observe(container);
			return () => observer.disconnect();
		}

		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, []);

	const isSplitView = isPanelOpen && supportsSplitView(containerWidth);
	const bounds = containerWidth === null ? null : listPaneBounds(containerWidth);
	const renderedListPaneWidth = containerWidth === null
		? listPaneWidth
		: clampListPaneWidth(livePointerWidth ?? listPaneWidth, containerWidth);
	const currentPreset = LIST_PANE_WIDTH_PRESETS.find(
		(preset) => preset.value === renderedListPaneWidth,
	);
	const ariaValueText = currentPreset
		? `${renderedListPaneWidth} pixels, ${currentPreset.label}`
		: `${renderedListPaneWidth} pixels`;

	useEffect(() => {
		if (isSplitView) return;
		activePointerRef.current = null;
		livePointerWidthRef.current = null;
		setLivePointerWidth(null);
	}, [isSplitView]);

	const beginPointerResize = (event: PointerEvent<HTMLButtonElement>) => {
		if (
			event.button !== 0 ||
			containerWidth === null ||
			activePointerRef.current !== null
		) {
			return;
		}
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		activePointerRef.current = {
			pointerId: event.pointerId,
			startClientX: event.clientX,
			startWidth: renderedListPaneWidth,
		};
		livePointerWidthRef.current = renderedListPaneWidth;
		setLivePointerWidth(renderedListPaneWidth);
	};

	const movePointerResize = (event: PointerEvent<HTMLButtonElement>) => {
		const active = activePointerRef.current;
		if (
			!active ||
			active.pointerId !== event.pointerId ||
			containerWidth === null ||
			!event.currentTarget.hasPointerCapture(event.pointerId)
		) {
			return;
		}
		const nextWidth = listPaneWidthFromPointer({
			startWidth: active.startWidth,
			startClientX: active.startClientX,
			clientX: event.clientX,
			containerWidth,
		});
		livePointerWidthRef.current = nextWidth;
		setLivePointerWidth(nextWidth);
	};

	const finishPointerResize = (
		event: PointerEvent<HTMLButtonElement>,
		persist: boolean,
	) => {
		const active = activePointerRef.current;
		if (!active || active.pointerId !== event.pointerId) return;
		const finalWidth = persist && containerWidth !== null
			? listPaneWidthFromPointer({
					startWidth: active.startWidth,
					startClientX: active.startClientX,
					clientX: event.clientX,
					containerWidth,
				})
			: livePointerWidthRef.current;
		activePointerRef.current = null;
		livePointerWidthRef.current = null;
		setLivePointerWidth(null);
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		if (persist && finalWidth !== null) setListPaneWidth(finalWidth);
	};

	const handleSeparatorKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		if (!RESIZE_KEYS.has(event.key as ListPaneResizeKey) || containerWidth === null) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		setListPaneWidth(listPaneWidthFromKey({
			currentWidth: renderedListPaneWidth,
			key: event.key as ListPaneResizeKey,
			shiftKey: event.shiftKey,
			containerWidth,
		}));
	};

	return (
		<div
			ref={containerRef}
			className="flex h-full min-h-0 min-w-0 overflow-hidden"
		>
			<section
				aria-label="Message list"
				className={`min-w-0 shrink-0 flex-col ${
					isPanelOpen && !isSplitView ? "hidden" : "flex"
				} ${isPanelOpen && isSplitView ? "" : "w-full"}`}
				style={isSplitView ? { width: `${renderedListPaneWidth}px` } : undefined}
			>
				{children}
			</section>
			{isSplitView && bounds && (
				<div className="relative w-0 shrink-0">
					<button
						type="button"
						role="separator"
						aria-label="Resize message list"
						aria-orientation="vertical"
						aria-valuemin={bounds.min}
						aria-valuemax={bounds.max}
						aria-valuenow={renderedListPaneWidth}
						aria-valuetext={ariaValueText}
						onPointerDown={beginPointerResize}
						onPointerMove={movePointerResize}
						onPointerUp={(event) => finishPointerResize(event, true)}
						onPointerCancel={(event) => finishPointerResize(event, false)}
						onLostPointerCapture={(event) => finishPointerResize(event, false)}
						onKeyDown={handleSeparatorKeyDown}
						className="group absolute inset-y-0 left-1/2 z-20 w-11 -translate-x-1/2 cursor-col-resize touch-none border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-ring"
					>
						<span
							aria-hidden="true"
							className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-kumo-line group-hover:bg-kumo-brand"
						/>
					</button>
				</div>
			)}
			{isPanelOpen && selectedEmailId && (
				<section
					aria-label="Conversation"
					className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
				>
					{!isSplitView && (
						<div className="hidden min-h-11 shrink-0 items-center border-b border-kumo-line px-3 md:flex">
							<button
								type="button"
								onClick={closePanel}
								className="min-h-11 rounded-md px-3 text-sm font-medium text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
							>
								Back to messages
							</button>
						</div>
					)}
					<LazyLoadBoundary
						fallback={<EmailPanelLoadError onBack={closePanel} />}
						resetKey={selectedEmailId}
					>
						<Suspense fallback={<EmailPanelLoadingFallback onBack={closePanel} />}>
							<EmailPanel emailId={selectedEmailId} />
						</Suspense>
					</LazyLoadBoundary>
				</section>
			)}
		</div>
	);
}
