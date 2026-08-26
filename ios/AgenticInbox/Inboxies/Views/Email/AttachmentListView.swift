import QuickLook
import SwiftUI

struct AttachmentListView: View {
    @Environment(AppModel.self) private var app
    let email: Email

    @State private var isDownloadingId: String?
    @State private var previewURL: URL?
    @State private var errorMessage: String?

    private var attachments: [Attachment] { email.nonInlineAttachments }

    var body: some View {
        if !attachments.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Attachments")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(AppTheme.muted)

                ForEach(attachments) { attachment in
                    Button {
                        Task { await download(attachment) }
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "paperclip")
                                .foregroundStyle(AppTheme.muted)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(attachment.filename)
                                    .font(.system(size: 15, weight: .medium))
                                    .foregroundStyle(AppTheme.ink)
                                    .lineLimit(1)
                                Text(byteString(attachment.size))
                                    .font(.system(size: 12))
                                    .foregroundStyle(AppTheme.muted)
                            }
                            Spacer()
                            if isDownloadingId == attachment.id {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: "arrow.down.circle")
                                    .foregroundStyle(AppTheme.accent)
                            }
                        }
                        .padding(12)
                        .background(AppTheme.pillFill)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(isDownloadingId != nil)
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            .quickLookPreview($previewURL)
        }
    }

    private func download(_ attachment: Attachment) async {
        guard let mailboxId = app.selectedMailboxId else { return }
        isDownloadingId = attachment.id
        errorMessage = nil
        defer { isDownloadingId = nil }
        do {
            let data = try await APIClient.shared.getAttachment(
                mailboxId: mailboxId,
                emailId: email.id,
                attachmentId: attachment.id
            )
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent(attachment.filename)
            try data.write(to: url, options: .atomic)
            previewURL = url
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func byteString(_ size: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)
    }
}
