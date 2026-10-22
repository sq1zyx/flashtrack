// Access codes from the command line: `npm run code -- new 10 "Иванов, риелтор"` (dev)
// or `node dist/cli.js new 10 "Иванов, риелтор"` (built / Docker).
//   new <credits> [note]     create a code with N audits
//   add <CODE> <credits>     top up an existing code
//   list                     all codes with remaining audits
import { addCredits, createCode, listCodes } from "./store.js";

const [cmd, a, b] = process.argv.slice(2);
const fmt = (c: { code: string; credits_total: number; credits_used: number; note: string }) =>
  `${c.code}  осталось ${c.credits_total - c.credits_used} из ${c.credits_total}  ${c.note}`;

if (cmd === "new" && Number(a) > 0) {
  console.log(fmt(createCode(Number(a), b ?? "")));
} else if (cmd === "add" && a && Number(b) > 0) {
  const c = addCredits(a, Number(b));
  console.log(c ? fmt(c) : `Код ${a} не найден`);
} else if (cmd === "list") {
  for (const c of listCodes()) console.log(fmt(c));
} else {
  console.log('usage: npm run code -- new <credits> [note] | add <CODE> <credits> | list');
  process.exit(1);
}
