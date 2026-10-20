// Draws Tiny Killer's icons in code, so every size comes from the same shapes:
//   assets/icon.png            1024×1024 app icon (tinyjs turns it into AppIcon.icns)
//   src/frontend/app-icon.png  the squircle alone (no margin or shadow), 88×88 px, for the
//                              settings window, which adds its own shadow
//   resources/tray.png         menu bar template image: the bolt alone, black on clear,
//                              36×36 px (18 pt @2x)
// The picture: a lightning bolt cutting through the Node.js hexagon, on a dark squircle.
//
// Run from the project root: swift scripts/make-icons.swift
import AppKit

// The bolt, in a 100×100 box with y pointing down
let bolt: [CGPoint] = [
  CGPoint(x: 64, y: 0), CGPoint(x: 16, y: 56), CGPoint(x: 44, y: 56),
  CGPoint(x: 34, y: 100), CGPoint(x: 84, y: 40), CGPoint(x: 56, y: 40),
]

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
  CGColor(srgbRed: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255,
          blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
}

// A closed polygon whose corners are rounded with the given radius
func roundedPolygon(_ points: [CGPoint], radius: CGFloat) -> CGPath {
  let path = CGMutablePath()
  let n = points.count
  let start = CGPoint(x: (points[n - 1].x + points[0].x) / 2, y: (points[n - 1].y + points[0].y) / 2)
  path.move(to: start)
  for i in 0..<n {
    path.addArc(tangent1End: points[i], tangent2End: points[(i + 1) % n], radius: radius)
  }
  path.closeSubpath()
  return path
}

func place(_ points: [CGPoint], center: CGPoint, scale: CGFloat) -> [CGPoint] {
  points.map { CGPoint(x: center.x + ($0.x - 50) * scale, y: center.y + ($0.y - 50) * scale) }
}

func boltPath(center: CGPoint, scale: CGFloat, radius: CGFloat) -> CGPath {
  roundedPolygon(place(bolt, center: center, scale: scale), radius: radius)
}

func hexagonPath(center: CGPoint, radius: CGFloat, corner: CGFloat) -> CGPath {
  let points = (0..<6).map { i -> CGPoint in
    let angle = CGFloat.pi / 2 + CGFloat(i) * CGFloat.pi / 3 // pointy top
    return CGPoint(x: center.x + radius * cos(angle), y: center.y - radius * sin(angle))
  }
  return roundedPolygon(points, radius: corner)
}

func linear(_ ctx: CGContext, _ colors: [CGColor], from: CGPoint, to: CGPoint) {
  let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors as CFArray, locations: nil)!
  ctx.drawLinearGradient(gradient, start: from, end: to, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
}

// The app icon in a 1024 box (y down), on the macOS icon grid: an 824 squircle inset 100
let iconGrid = CGRect(x: 100, y: 100, width: 824, height: 824)

func drawIcon(_ ctx: CGContext, shadow: Bool) {
  let squircle = CGPath(roundedRect: iconGrid, cornerWidth: 185, cornerHeight: 185, transform: nil)

  // Drop shadow, as macOS icons carry
  if shadow {
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: color(0x000000, 0.35))
    ctx.addPath(squircle)
    ctx.setFillColor(color(0x15181c))
    ctx.fillPath()
    ctx.restoreGState()
  }

  // Charcoal body with a green glow where the hexagon sits
  ctx.saveGState()
  ctx.addPath(squircle)
  ctx.clip()
  linear(ctx, [color(0x2c3238), color(0x111417)], from: CGPoint(x: 512, y: 100), to: CGPoint(x: 512, y: 924))
  let glow = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
                        colors: [color(0x6cc24a, 0.28), color(0x6cc24a, 0)] as CFArray, locations: nil)!
  ctx.drawRadialGradient(glow, startCenter: CGPoint(x: 512, y: 512), startRadius: 0,
                         endCenter: CGPoint(x: 512, y: 512), endRadius: 400, options: [])

  // The hexagon, cut where the bolt goes through it
  let center = CGPoint(x: 512, y: 512)
  let hexagon = hexagonPath(center: center, radius: 272, corner: 44)
  let strike = boltPath(center: CGPoint(x: 520, y: 512), scale: 5.8, radius: 14)
  ctx.beginTransparencyLayer(auxiliaryInfo: nil)
  ctx.saveGState()
  ctx.addPath(hexagon)
  ctx.clip()
  linear(ctx, [color(0x9bd35a), color(0x3e863d)], from: CGPoint(x: 330, y: 250), to: CGPoint(x: 700, y: 790))
  ctx.restoreGState()
  ctx.setBlendMode(.clear)
  ctx.setLineWidth(36)
  ctx.setLineJoin(.round)
  ctx.addPath(strike)
  ctx.strokePath()
  ctx.endTransparencyLayer()

  // The bolt, glowing
  ctx.saveGState()
  ctx.setShadow(offset: .zero, blur: 70, color: color(0xffc83d, 0.55))
  ctx.addPath(strike)
  ctx.setFillColor(color(0xffd23f))
  ctx.fillPath()
  ctx.restoreGState()
  ctx.saveGState()
  ctx.addPath(strike)
  ctx.clip()
  linear(ctx, [color(0xfff27a), color(0xffa51f)], from: CGPoint(x: 600, y: 200), to: CGPoint(x: 420, y: 830))
  ctx.restoreGState()

  // A hairline of light along the top edge
  ctx.addPath(squircle)
  ctx.setLineWidth(4)
  ctx.setStrokeColor(color(0xffffff, 0.10))
  ctx.strokePath()
  ctx.restoreGState()
}

// The menu bar bolt, in a 1024 box (y down)
func drawTray(_ ctx: CGContext) {
  ctx.addPath(boltPath(center: CGPoint(x: 520, y: 512), scale: 9.4, radius: 30))
  ctx.setFillColor(color(0x000000))
  ctx.fillPath()
}

// Draws the part of the 1024 box in `area` (all of it by default) at size × size px
func render(size: Int, area: CGRect = CGRect(x: 0, y: 0, width: 1024, height: 1024),
            _ draw: (CGContext) -> Void) -> NSBitmapImageRep {
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
    bytesPerRow: size * 4, bitsPerPixel: 32)!
  NSGraphicsContext.saveGraphicsState()
  let context = NSGraphicsContext(bitmapImageRep: rep)!
  NSGraphicsContext.current = context
  let ctx = context.cgContext
  ctx.setAllowsAntialiasing(true)
  ctx.interpolationQuality = .high
  // Draw in a 1024 box with y pointing down, whatever the output size
  let scale = CGFloat(size) / area.width
  ctx.translateBy(x: 0, y: CGFloat(size))
  ctx.scaleBy(x: scale, y: -scale)
  ctx.translateBy(x: -area.minX, y: -area.minY)
  draw(ctx)
  NSGraphicsContext.restoreGraphicsState()
  return rep
}

func write(_ rep: NSBitmapImageRep, to path: String) {
  let url = URL(fileURLWithPath: path)
  try! FileManager.default.createDirectory(
    at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  try! rep.representation(using: .png, properties: [:])!.write(to: url)
  print("wrote \(path)")
}

write(render(size: 1024) { drawIcon($0, shadow: true) }, to: "assets/icon.png")
write(render(size: 88, area: iconGrid) { drawIcon($0, shadow: false) }, to: "src/frontend/app-icon.png")
write(render(size: 36, drawTray), to: "resources/tray.png")
