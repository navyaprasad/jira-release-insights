import OpenAI from "openai";

export function getOpenAI(): OpenAI | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const baseURL = process.env.OPENAI_BASE_URL?.replace(/\/$/, "");
  return new OpenAI(
    baseURL
      ? { apiKey, baseURL }
      : { apiKey },
  );
}

export async function chatComplete(
  system: string,
  user: string,
): Promise<string> {
  const client = getOpenAI();
  if (!client) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  const res = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL ?? "claude-sonnet-4-5",
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return res.choices[0]?.message?.content?.trim() ?? "";
}

export async function chatJson<T>(
  system: string,
  user: string,
  parse: (raw: string) => T,
): Promise<T> {
  const text = await chatComplete(system, user);
  return parse(text);
}
