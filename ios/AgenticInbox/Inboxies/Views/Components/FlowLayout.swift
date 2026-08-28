import SwiftUI

/// Wraps subviews onto additional lines instead of clipping them.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var origin = CGPoint.zero
        var rowHeight: CGFloat = 0
        var size = CGSize.zero

        for subview in subviews {
            let item = subview.sizeThatFits(.unspecified)
            if origin.x + item.width > maxWidth, origin.x > 0 {
                origin.x = 0
                origin.y += rowHeight + spacing
                rowHeight = 0
            }
            origin.x += item.width + spacing
            rowHeight = max(rowHeight, item.height)
            size.width = max(size.width, origin.x - spacing)
            size.height = origin.y + rowHeight
        }

        return size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var origin = CGPoint(x: bounds.minX, y: bounds.minY)
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let item = subview.sizeThatFits(.unspecified)
            if origin.x + item.width > bounds.maxX, origin.x > bounds.minX {
                origin.x = bounds.minX
                origin.y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: origin, proposal: ProposedViewSize(item))
            origin.x += item.width + spacing
            rowHeight = max(rowHeight, item.height)
        }
    }
}
