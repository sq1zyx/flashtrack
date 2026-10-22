import mammoth from "mammoth";
import { parse, NodeType, type HTMLElement, type Node } from "node-html-parser";
import { AppError } from "../errors.js";
import type { ExtractionResult } from "./types.js";

/**
 * mammoth.extractRawText() drops Word's automatic list numbering ("1.1.", "2.3."),
 * and in contracts that numbering is how clauses reference each other. So we convert
 * to HTML (where numbered paragraphs become <ol><li>) and render the numbers ourselves.
 */
export async function extractDocx(buf: Buffer): Promise<ExtractionResult> {
  let html: string;
  try {
    ({ value: html } = await mammoth.convertToHtml({ buffer: buf }));
  } catch (err) {
    throw new AppError(422, "docx_corrupted", "DOCX повреждён или не является документом Word.", String((err as Error).message));
  }
  const lines: string[] = [];
  renderBlocks(parse(html), lines, []);
  return { sourceKind: "docx", pages: [lines.join("\n")], pageCount: 1, ocrPages: [], warnings: [] };
}

const inline = (el: Node) => el.text.replace(/\s+/g, " ").trim();
const isEl = (n: Node): n is HTMLElement => n.nodeType === NodeType.ELEMENT_NODE;

function renderBlocks(node: Node, out: string[], counters: number[]): void {
  for (const child of node.childNodes) {
    if (!isEl(child)) {
      const t = inline(child);
      if (t) out.push(t);
      continue;
    }
    const tag = child.tagName?.toLowerCase();
    switch (tag) {
      case "p": case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
        const t = inline(child);
        if (t) out.push(t);
        break;
      }
      case "ol": case "ul":
        renderList(child, out, counters, tag === "ol");
        break;
      case "table":
        for (const tr of child.querySelectorAll("tr")) {
          const cells = tr.querySelectorAll("td,th").map(inline).filter(Boolean);
          if (cells.length) out.push(cells.join(" | "));
        }
        break;
      default:
        renderBlocks(child, out, counters);
    }
  }
}

function renderList(list: HTMLElement, out: string[], parent: number[], ordered: boolean): void {
  let n = 0;
  for (const li of list.childNodes) {
    if (!isEl(li) || li.tagName.toLowerCase() !== "li") continue;
    n++;
    const path = [...parent, n];
    // Text of the <li> itself, without nested lists (they get their own lines).
    const own = li.childNodes
      .filter((c) => !(isEl(c) && ["ol", "ul"].includes(c.tagName.toLowerCase())))
      .map(inline)
      .filter(Boolean)
      .join(" ");
    const marker = ordered ? `${path.join(".")}.` : "•";
    if (own) out.push(`${marker} ${own}`);
    for (const nested of li.childNodes) {
      if (isEl(nested) && ["ol", "ul"].includes(nested.tagName.toLowerCase())) {
        renderList(nested, out, ordered ? path : parent, nested.tagName.toLowerCase() === "ol");
      }
    }
  }
}
