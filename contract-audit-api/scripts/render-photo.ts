// Renders page 1 of a PDF to a JPEG that imitates a phone photo (for OCR tests).
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { PDFParse } from "pdf-parse";

const [src, dst] = process.argv.slice(2);
if (!src || !dst) throw new Error("usage: render-photo.ts <in.pdf> <out.jpg>");
const parser = new PDFParse({ data: new Uint8Array(readFileSync(src)) });
const shot = await parser.getScreenshot({ partial: [1], desiredWidth: 1700, imageBuffer: true, imageDataUrl: false });
await sharp(shot.pages[0]!.data).flatten({ background: "#ffffff" }).blur(0.6).jpeg({ quality: 70 }).toFile(dst);
await parser.destroy();
