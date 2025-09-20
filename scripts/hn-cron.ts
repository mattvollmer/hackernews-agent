import cron from "node-cron";
import { generateText, tool } from "ai";
import { z } from "zod";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const fetch_hn_top_articles = tool({
  description:
    "Fetch top N HN stories and extract best-effort readable article text.",
  inputSchema: z.object({ limit: z.number().int().min(1).max(30).default(10) }),
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
            return { ...base, content: base.text, source: "hn" as const };
          }

          try {
            const res = await fetch(item.url, {
              headers: {
                "User-Agent": "hn-summarizer/1.0 (+https://example.com)",
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
});

async function runOnce() {
  const now = new Date().toISOString();
  const result = await generateText({
    model: "openai/gpt-oss-120b",
    system:
      "You are a batch job. Use fetch_hn_top_articles to get the top 10 items and write a concise 2–3 sentence summary for each. Output the summaries as plain text.",
    messages: [{ role: "user", content: "Run the HN summarization job now." }],
    tools: { fetch_hn_top_articles },
  });

  console.log(`[HN summaries @ ${now}]`);
  if (result.text) console.log(result.text);
}

cron.schedule("*/15 * * * *", () => {
  runOnce().catch((err) => {
    console.error("HN cron run error", err);
  });
});

console.log("HN cron scheduled: every 15 minutes");
