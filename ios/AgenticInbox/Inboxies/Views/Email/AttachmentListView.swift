import QuickLook
import SwiftUI
import UniformTypeIdentifiers

struct AttachmentListView: View {
    @Environment(AppModel.self) private var app
    let email: Email

    @State private var isDownloadingId: String?
    @State private var previewURL: URL?
    @State private var errorMessage: String?

    private var attachments: [Attachment] { email.nonInlineAttachments }

    private static let chipSpacing: CGFloat = 8
    private static let chipMaxWidth: CGFloat = 180

    var body: some View {
        if !attachments.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                if attachments.count > 1 {
                    Text("\(attachments.count) attachments")
                        .font(.system(size: 12, weight: .regular))
                        .foregroundStyle(AppTheme.muted)
                }

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Self.chipSpacing) {
                        ForEach(attachments) { attachment in
                            attachmentChip(attachment)
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)

                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            .quickLookPreview($previewURL)
        }
    }

    private func attachmentChip(_ attachment: Attachment) -> some View {
        Button {
            Task { await download(attachment) }
        } label: {
            HStack(spacing: 8) {
                fileTypeIcon(for: attachment)

                VStack(alignment: .leading, spacing: 4) {
                    Text(attachment.filename)
                        .font(.system(size: 11, weight: .regular))
                        .foregroundStyle(AppTheme.ink)
                        .lineLimit(1)
                    Text(byteString(attachment.size))
                        .font(.system(size: 9))
                        .foregroundStyle(AppTheme.muted)
                        .lineLimit(1)
                }

                if isDownloadingId == attachment.id {
                    ProgressView().controlSize(.small)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: Self.chipMaxWidth, alignment: .leading)
            .background(AppTheme.pillFill)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(isDownloadingId != nil)
        .accessibilityLabel(attachment.filename)
        .accessibilityValue(byteString(attachment.size))
        .accessibilityHint("Downloads and previews the attachment")
    }

    private func fileTypeIcon(for attachment: Attachment) -> some View {
        let kind = AttachmentFileKind(attachment)
        return Image(systemName: kind.systemImage)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(kind.tint)
            .frame(width: 28, height: 28)
            .background(kind.tint.opacity(0.14))
            .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
            .accessibilityHidden(true)
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

private struct AttachmentFileKind {
    let systemImage: String
    let tint: Color

    init(_ attachment: Attachment) {
        let ext = URL(fileURLWithPath: attachment.filename).pathExtension.lowercased()
        let mime = attachment.mimetype.lowercased()
        let type = UTType(mimeType: attachment.mimetype) ?? UTType(filenameExtension: ext)

        if Self.matches(type, .image) || mime.hasPrefix("image/") || Self.imageExtensions.contains(ext) {
            systemImage = "photo"
            tint = Color(red: 0.20, green: 0.48, blue: 0.86)
        } else if Self.matches(type, .movie) || Self.matches(type, .video) || mime.hasPrefix("video/") || Self.videoExtensions.contains(ext) {
            systemImage = "video"
            tint = Color(red: 0.56, green: 0.27, blue: 0.82)
        } else if Self.matches(type, .audio) || mime.hasPrefix("audio/") || Self.audioExtensions.contains(ext) {
            systemImage = "music.note"
            tint = Color(red: 0.78, green: 0.22, blue: 0.48)
        } else if Self.matches(type, .pdf) || mime == "application/pdf" || ext == "pdf" {
            systemImage = "doc.richtext"
            tint = Color(red: 0.82, green: 0.22, blue: 0.22)
        } else if Self.matches(type, .spreadsheet) || Self.spreadsheetMimes.contains(where: mime.contains) || Self.spreadsheetExtensions.contains(ext) {
            systemImage = "tablecells"
            tint = Color(red: 0.18, green: 0.58, blue: 0.36)
        } else if Self.matches(type, .presentation) || Self.presentationMimes.contains(where: mime.contains) || Self.presentationExtensions.contains(ext) {
            systemImage = "rectangle.on.rectangle"
            tint = Color(red: 0.86, green: 0.42, blue: 0.16)
        } else if Self.wordMimes.contains(where: mime.contains) || Self.wordExtensions.contains(ext) {
            systemImage = "doc.text"
            tint = Color(red: 0.22, green: 0.40, blue: 0.78)
        } else if Self.matches(type, .archive) || mime.contains("zip") || mime.contains("compressed") || Self.archiveExtensions.contains(ext) {
            systemImage = "doc.zipper"
            tint = Color(red: 0.55, green: 0.42, blue: 0.28)
        } else if mime.contains("calendar") || ext == "ics" {
            systemImage = "calendar"
            tint = Color(red: 0.82, green: 0.28, blue: 0.28)
        } else if mime.contains("vcard") || ext == "vcf" {
            systemImage = "person.crop.rectangle"
            tint = Color(red: 0.28, green: 0.52, blue: 0.72)
        } else if Self.matches(type, .sourceCode) || Self.codeExtensions.contains(ext) {
            systemImage = "chevron.left.forwardslash.chevron.right"
            tint = AppTheme.muted
        } else if Self.matches(type, .plainText) || mime.hasPrefix("text/") || Self.textExtensions.contains(ext) {
            systemImage = "doc.plaintext"
            tint = AppTheme.muted
        } else {
            systemImage = "doc"
            tint = AppTheme.muted
        }
    }

    private static func matches(_ type: UTType?, _ other: UTType) -> Bool {
        type?.conforms(to: other) == true
    }

    private static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tiff", "tif", "svg"]
    private static let videoExtensions: Set<String> = ["mp4", "mov", "m4v", "avi", "mkv", "webm"]
    private static let audioExtensions: Set<String> = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "aiff"]
    private static let spreadsheetExtensions: Set<String> = ["xls", "xlsx", "csv", "numbers", "ods"]
    private static let presentationExtensions: Set<String> = ["ppt", "pptx", "key", "odp"]
    private static let wordExtensions: Set<String> = ["doc", "docx", "rtf", "pages", "odt"]
    private static let archiveExtensions: Set<String> = ["zip", "rar", "7z", "tar", "gz", "tgz"]
    private static let codeExtensions: Set<String> = ["js", "ts", "tsx", "jsx", "swift", "py", "rb", "go", "java", "kt", "json", "xml", "html", "css", "sh"]
    private static let textExtensions: Set<String> = ["txt", "md", "log"]
    private static let spreadsheetMimes = ["spreadsheet", "excel"]
    private static let presentationMimes = ["presentation", "powerpoint"]
    private static let wordMimes = ["msword", "wordprocessing"]
}
