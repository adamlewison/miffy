export const OPENAI_BASE = "https://api.openai.com/v1";

export function openaiHeaders() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}
