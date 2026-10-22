// Checks that the configured neural network answers: `node dist/check-llm.js` (start.bat runs it).
import { config } from "./config.js";

async function main() {
  console.log(`Нейросеть: ${config.llmProvider}`);
  if (config.llmProvider === "gigachat") {
    const { gigachatSelfTest } = await import("./llm/gigachat.js");
    console.log(`Модель: ${config.gigachatModel}, scope: ${config.gigachatScope}`);
    const { models, reply } = await gigachatSelfTest();
    if (models.length) console.log(`Доступные модели: ${models.join(", ")}`);
    console.log(`Ответ нейросети: ${reply.trim()}`);
  } else {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const msg = await new Anthropic().messages.create({
      model: config.model, max_tokens: 50, messages: [{ role: "user", content: "Ответь одним словом: работает?" }],
    });
    console.log(`Модель: ${msg.model}`);
    console.log(`Ответ нейросети: ${msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim()}`);
  }
  console.log("OK: нейросеть подключена.");
}

main().catch((err) => {
  console.error(`\nОШИБКА: нейросеть не отвечает.\n${err?.details ?? err?.message ?? err}`);
  console.error("Проверьте ключ в файле .env (GIGACHAT_AUTH_KEY или ANTHROPIC_API_KEY) и подключение к интернету.");
  process.exit(1);
});
