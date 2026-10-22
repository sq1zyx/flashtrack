import Anthropic from "@anthropic-ai/sdk";

/** An error that is safe to show to the API client. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Maps Anthropic SDK errors to client-facing errors. The SDK has already retried 408/409/429/5xx by then. */
export function fromAnthropicError(err: unknown): AppError | undefined {
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new AppError(504, "llm_timeout", "Сервис анализа не ответил вовремя. Повторите попытку позже.");
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AppError(503, "llm_unavailable", "Сервис анализа временно недоступен. Повторите попытку позже.");
  }
  if (err instanceof Anthropic.RateLimitError) {
    const retryAfter = err.headers?.get("retry-after") ?? undefined;
    return new AppError(503, "llm_rate_limited", "Сервис анализа перегружен. Повторите попытку через минуту.", { retryAfter });
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    // Misconfiguration on our side: log the real reason, don't leak it.
    console.error("[anthropic] auth error:", err.message);
    return new AppError(500, "llm_misconfigured", "Сервис анализа не настроен. Обратитесь в поддержку.");
  }
  if (err instanceof Anthropic.BadRequestError) {
    console.error("[anthropic] bad request:", err.message);
    return new AppError(500, "llm_bad_request", "Не удалось сформировать запрос к сервису анализа.");
  }
  if (err instanceof Anthropic.InternalServerError) {
    // 500 / 529 overloaded
    return new AppError(503, "llm_unavailable", "Сервис анализа временно недоступен. Повторите попытку позже.");
  }
  if (err instanceof Anthropic.APIError) {
    console.error("[anthropic] api error:", err.status, err.message);
    return new AppError(502, "llm_error", "Ошибка сервиса анализа.");
  }
  return undefined;
}
