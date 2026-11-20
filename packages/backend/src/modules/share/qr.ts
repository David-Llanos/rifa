import jsQR from "jsqr";
import { PNG } from "pngjs";
import QRCode from "qrcode";

export type QrFormat = "png" | "svg";

/** Minimum PNG dimension in pixels (Requirement 16.3). */
export const QR_MIN_PIXELS = 1024;

const QUIET_ZONE = 4;

function modulesOf(url: string): { size: number; get: (x: number, y: number) => boolean } {
  const qr = QRCode.create(url, { errorCorrectionLevel: "M" });
  const { size, data } = qr.modules;
  return { size, get: (x, y) => data[y * size + x] === 1 };
}

/** Encode the URL as a PNG (at least 1024 by 1024) or an SVG. */
export function qrEncode(url: string, fmt: QrFormat): Buffer {
  const { size, get } = modulesOf(url);
  const total = size + QUIET_ZONE * 2;
  if (fmt === "svg") {
    let d = "";
    for (let y = 0; y < size; y++) {
      let x = 0;
      while (x < size) {
        if (!get(x, y)) {
          x++;
          continue;
        }
        const start = x;
        while (x < size && get(x, y)) x++;
        d += `M${start + QUIET_ZONE} ${y + QUIET_ZONE}h${x - start}v1h-${x - start}z`;
      }
    }
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${total * 32}" height="${total * 32}" shape-rendering="crispEdges">` +
      `<rect width="${total}" height="${total}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`;
    return Buffer.from(svg, "utf8");
  }
  const scale = Math.ceil(QR_MIN_PIXELS / total);
  const px = total * scale;
  const png = new PNG({ width: px, height: px });
  for (let y = 0; y < px; y++) {
    const my = Math.floor(y / scale) - QUIET_ZONE;
    for (let x = 0; x < px; x++) {
      const mx = Math.floor(x / scale) - QUIET_ZONE;
      const dark = mx >= 0 && my >= 0 && mx < size && my < size && get(mx, my);
      const v = dark ? 0 : 255;
      const i = (y * px + x) * 4;
      png.data[i] = v;
      png.data[i + 1] = v;
      png.data[i + 2] = v;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** Pixel size of a PNG buffer (from the IHDR chunk). */
export function pngDimensions(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function decodeBitmap(data: Uint8ClampedArray, width: number, height: number): string {
  const result = jsQR(data, width, height);
  if (!result) throw new Error("no QR code found");
  return result.data;
}

/** Decode a QR code produced by `qrEncode` (PNG or SVG) back to its text. */
export function qrDecode(buf: Buffer): string {
  const isPng = buf.length > 8 && buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG";
  if (isPng) {
    const png = PNG.sync.read(buf);
    return decodeBitmap(new Uint8ClampedArray(png.data), png.width, png.height);
  }
  const text = buf.toString("utf8");
  const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(text);
  const path = /<path[^>]* d="([^"]*)"/.exec(text);
  if (!vb || !path) throw new Error("unsupported SVG");
  const total = Number(vb[1]);
  const scale = Math.ceil(QR_MIN_PIXELS / total);
  const px = total * scale;
  const data = new Uint8ClampedArray(px * px * 4).fill(255);
  const re = /M(\d+) (\d+)h(\d+)v1h-\d+z/g;
  for (let m = re.exec(path[1] ?? ""); m; m = re.exec(path[1] ?? "")) {
    const [x0, y0, w] = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let y = y0 * scale; y < (y0 + 1) * scale; y++) {
      for (let x = x0 * scale; x < (x0 + w) * scale; x++) {
        const i = (y * px + x) * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
      }
    }
  }
  return decodeBitmap(data, px, px);
}
