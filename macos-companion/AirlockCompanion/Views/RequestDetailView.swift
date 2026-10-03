import AppKit
import SwiftUI

struct RequestDetailView: View {
    let request: ApprovalRequest
    let onApprove: () -> Void
    let onDeny: () -> Void
    let onDismiss: () -> Void
    var onNext: (() -> Void)? = nil
    var onPrev: (() -> Void)? = nil
    @Binding var argsScrollView: NSScrollView?
    var loadPreview: ((String) async throws -> ApprovalPreview)? = nil
    @State private var preview: ApprovalPreview?
    @State private var previewLoading = false
    @State private var previewError: String?

    private var sortedArgKeys: [String] { request.args.keys.sorted() }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                Button(action: onDismiss) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .focusable(false)
                .focusEffectDisabled()

                VStack(alignment: .leading, spacing: 4) {
                    Text(request.displayTitle)
                        .font(.system(size: 18, weight: .semibold))
                    Text(request.displaySubtitle)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }

                Spacer()

                HStack(spacing: 8) {
                    if onPrev != nil || onNext != nil {
                        Text("⇧K / ⇧J  navigate")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(.tertiary)
                    }
                    Text("H  back")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.tertiary)
                    Text(request.displayIdentifier)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ScrollViewProbe(captured: $argsScrollView).frame(height: 0)

                    if previewLoading {
                        ProgressView("Loading fetched preview…")
                    } else if let preview, preview.status == "ready" {
                        VStack(alignment: .leading, spacing: 8) {
                            if let fields = preview.fields, !fields.isEmpty {
                                ApprovalPreviewFieldsView(fields: fields)
                            } else {
                              Text(verbatim: preview.text ?? "")
                                .font(.system(size: 13))
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            Text(verbatim: "Fetched via \(preview.tool ?? "")\(preview.truncated == true ? " · Truncated" : "")")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.quaternary.opacity(0.45))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    } else if let message = previewError ?? (preview?.status == "error" ? preview?.message : nil) {
                        contextBox(title: "Fetched preview", value: message)
                    }

                    if let fields = preview?.requestedFields, preview?.status == "ready", !fields.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Requested action").font(.caption).foregroundStyle(.secondary)
                            ApprovalPreviewFieldsView(fields: fields)
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.quaternary.opacity(0.45))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }

                    HStack(spacing: 12) {
                        detailPill(
                            title: "Timeout",
                            value: request.timeoutMs > 0 ? "\(request.timeoutMs / 1000)s" : "None"
                        )
                        detailPill(title: "Args", value: "\(request.args.count)")
                        if request.isUserQuestion {
                            detailPill(title: "Kind", value: "Question")
                        }
                    }

                    if request.isUserQuestion, let context = request.questionContext {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Context")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(.secondary)
                            Text(context)
                                .font(.system(size: 12))
                                .textSelection(.enabled)
                        }
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.quaternary.opacity(0.45))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }

                    if let reason = request.requestReason {
                        contextBox(title: "Request reason", value: reason)
                    }

                    if let note = request.requestNote {
                        contextBox(title: "Request note", value: note)
                    }

                    if request.args.isEmpty {
                        Text("No arguments").font(.system(size: 12)).foregroundStyle(.secondary)
                    }

                    ForEach(sortedArgKeys, id: \.self) { key in
                        if let value = request.args[key] {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(key)
                                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                                    .foregroundStyle(.secondary)

                                CodeBlockView(attributedText: CodeHighlighter.highlightedString(for: value))
                                    .frame(minHeight: 80, idealHeight: 120, maxHeight: 220)
                                    .background(.quaternary.opacity(0.45))
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                            }
                        }
                    }
                }
                .padding(.trailing, 2)
            }

            ApproveRejectButtons(
                onApprove: { onApprove(); onDismiss() },
                onDeny:    { onDeny();    onDismiss() },
                fontSize: 14,
                verticalPadding: 9,
                cornerRadius: 8,
                approveLabel: request.approveLabel
            )
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: request.id) {
            preview = nil
            previewError = nil
            guard !request.isUserQuestion, let loadPreview else { return }
            previewLoading = true
            defer { previewLoading = false }
            do {
                let fetched = try await loadPreview(request.id)
                try Task.checkCancellation()
                preview = fetched
            } catch {
                if !Task.isCancelled { previewError = "Preview unavailable. You can still approve or deny this request." }
            }
        }
    }

    private func detailPill(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 12, weight: .semibold))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(.quaternary.opacity(0.45))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func contextBox(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 12))
                .textSelection(.enabled)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.45))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - ScrollViewProbe

struct ScrollViewProbe: NSViewRepresentable {
    @Binding var captured: NSScrollView?

    func makeNSView(context: Context) -> NSView { NSView() }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async {
            var v: NSView? = nsView.superview
            while let node = v {
                if let sv = node as? NSScrollView { captured = sv; return }
                v = node.superview
            }
        }
    }
}

private struct ApprovalPreviewFieldsView: View {
    let fields: [ApprovalPreviewField]
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 10) {
                ForEach(Array(fields.enumerated()).filter { $0.element.primary != true }, id: \.offset) { item in
                    GridRow(alignment: .top) {
                        Text(verbatim: item.element.label).foregroundStyle(.secondary)
                        Text(verbatim: item.element.value).textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            if fields.contains(where: { $0.primary == true }) && fields.contains(where: { $0.primary != true }) { Divider() }
            ForEach(Array(fields.enumerated()).filter { $0.element.primary == true }, id: \.offset) { item in
                VStack(alignment: .leading, spacing: 6) {
                    Text(verbatim: item.element.label).font(.caption).foregroundStyle(.secondary)
                    Text(verbatim: item.element.value).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
