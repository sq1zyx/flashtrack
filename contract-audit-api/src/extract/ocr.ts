import sharp from "sharp";
import { createWorker, type Worker } from "tesseract.js";
import { config } from "../config.js";
import { AppError } from "../errors.js";

let workerPromise: Promise<Worker> | undefined;

/**
 * One shared tesseract worker per process: creating a worker loads ~20 MB of language data,
 * so we do it once. tesseract.js queues recognize() calls on a worker, so concurrent requests are safe.
 */
function getWorker(): Promise<Worker> {
  workerPromise ??= createWorker(config.ocrLangs, 1, {
    langPath: config.ocrLangPath,
    cachePath: config.ocrCachePath,
  }).catch((err) => {
    workerPromise = undefined; // allow a retry on the next request
    throw new AppError(503, "ocr_unavailable", "OCR-движок не запустился. Повторите попытку позже.", String(err?.message ?? err));
  });
  return workerPromise;
}

export async function terminateOcr(): Promise<void> {
  if (!workerPromise) return;
  const w = await workerPromise.catch(() => undefined);
  workerPromise = undefined;
  await w?.terminate();
}

/**
 * Cleans up a photo/scan before OCR: EXIF rotation, grayscale, contrast stretch,
 * and upscaling small images (tesseract works best at ~300 DPI, i.e. ~2500px for A4 width).
 */
export async function preprocessForOcr(image: Buffer | Uint8Array): Promise<Buffer> {
  try {
    const img = sharp(image, { failOn: "error" }).rotate();
    const { width = 0 } = await img.metadata();
    const pipeline = img.grayscale().normalize();
    if (width > 0 && width < 1800) pipeline.resize({ width: 2400, kernel: "lanczos3" });
    if (width > 4000) pipeline.resize({ width: 3000 });
    return await pipeline.png().toBuffer();
  } catch (err) {
    throw new AppError(422, "image_corrupted", "Не удалось прочитать изображение: файл повреждён или формат не поддерживается.", String((err as Error).message));
  }
}

export interface OcrPage {
  text: string;
  confidence: number;
}

export async function ocrImage(image: Buffer | Uint8Array): Promise<OcrPage> {
  const prepared = await preprocessForOcr(image);
  const worker = await getWorker();
  try {
    const { data } = await worker.recognize(prepared);
    return { text: data.text, confidence: data.confidence };
  } catch (err) {
    throw new AppError(422, "ocr_failed", "Не удалось распознать текст на изображении.", String((err as Error).message));
  }
}
