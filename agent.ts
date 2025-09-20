import { convertToModelMessages, streamText, tool } from "ai";
import * as blink from "blink";
import { z } from "zod";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

export default blink.agent({
  async sendMessages({ messages }) {
    return streamText({
      model: "openai/gpt-oss-120b",
      system: `You can fetch Hacker News top stories via tools and write brief summaries.
- Keep each summary to 2–3 sentences.
- If a story has no URL (e.g., Ask HN), use the HN text field.
- Prefer readable article body extracted via Readability when available.
- Fetch and summarize the top 10 by default.`,
      messages: convertToModelMessages(messages),
      tools: {
        fetch_hn_top_articles: tool({
          description:
            "Fetch top N HN stories and extract best-effort readable article text.",
          inputSchema: z.object({
            limit: z.number().int().min(1).max(30).default(10),
          }),
          execute: async ({ limit }) => {
            const topIds: number[] = await fetch(
              "https://hacker-news.firebaseio.com/v0/topstories.json",
            ).then((r) => r.json());
            const ids = (topIds || []).slice(0, limit);

            const items = await Promise.all(
              ids.map(async (id) => {
                try {
                  const item = await fetch(
                    `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
                  ).then((r) => r.json());

                  const base = {
                    id: (item?.id as number | null) ?? null,
                    title: (item?.title as string | null) ?? null,
                    by: (item?.by as string | null) ?? null,
                    score: (item?.score as number | null) ?? null,
                    time: (item?.time as number | null) ?? null,
                    url: (item?.url as string | undefined) || null,
                    type: (item?.type as string | null) ?? null,
                    text: (item?.text as string | undefined) || null,
                  };

                  if (!item?.url) {
                    return {
                      ...base,
                      content: base.text,
                      source: "hn" as const,
                    };
                  }

                  try {
                    const res = await fetch(item.url, {
                      headers: {
                        "User-Agent":
                          "hn-summarizer/1.0 (+https://example.com)",
                      },
                    });
                    const html = await res.text();
                    const dom = new JSDOM(html, { url: item.url });
                    const reader = new Readability(dom.window.document);
                    const article = reader.parse();
                    const content = article?.textContent?.trim() || null;
                    return { ...base, content, source: "url" as const };
                  } catch {
                    return { ...base, content: null, source: "error" as const };
                  }
                } catch {
                  return {
                    id,
                    title: null,
                    by: null,
                    score: null,
                    time: null,
                    url: null,
                    type: null,
                    text: null,
                    content: null,
                    source: "error" as const,
                  };
                }
              }),
            );

            return { items };
          },
        }),
      },
    });
  },
});
