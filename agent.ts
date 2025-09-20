import { convertToModelMessages, streamText, tool, generateText } from "ai";
import * as blink from "blink";
import { z } from "zod";
import { parse } from "node-html-parser";
import * as slackbot from "@blink-sdk/slackbot";

const timeAgo = (unixSeconds: number | null) => {
  if (!unixSeconds || typeof unixSeconds !== "number") return null;
  const now = Math.floor(Date.now() / 1000);
  let s = Math.max(0, now - unixSeconds);
  const units: [number, string][] = [
    [365 * 24 * 3600, "y"],
    [30 * 24 * 3600, "mo"],
    [7 * 24 * 3600, "w"],
    [24 * 3600, "d"],
    [3600, "h"],
    [60, "m"],
    [1, "s"],
  ];
  for (const [sec, label] of units) {
    if (s >= sec) return `${Math.floor(s / sec)}${label} ago`;
  }
  return "just now";
};

const stripHtml = (html: string | null | undefined) => {
  if (!html) return null;
  try {
    const root = parse(html);
    return root.textContent?.replace(/\s+/g, " ").trim() || null;
  } catch {
    return html
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
};

// Simple readability-like text extraction
const extractArticleText = (html: string): string | null => {
  if (!html) return null;

  try {
    const root = parse(html);

    // Remove unwanted elements
    const unwantedSelectors = [
      "script",
      "style",
      "nav",
      "header",
      "footer",
      ".ad",
      ".advertisement",
      ".sidebar",
      ".menu",
      ".social",
      ".share",
      ".comments",
      ".related",
    ];

    unwantedSelectors.forEach((selector) => {
      root.querySelectorAll(selector).forEach((el) => el.remove());
    });

    // Look for main content containers
    const contentSelectors = [
      "article",
      '[role="main"]',
      "main",
      ".content",
      ".post",
      ".entry",
      ".article",
      "#content",
      ".post-content",
      ".entry-content",
    ];

    for (const selector of contentSelectors) {
      const content = root.querySelector(selector);
      if (content) {
        const text = content.textContent?.trim();
        if (text && text.length > 100) {
          return text.replace(/\s+/g, " ");
        }
      }
    }

    // Fallback: find paragraphs and combine them
    const paragraphs = root.querySelectorAll("p");
    const textParts: string[] = [];

    paragraphs.forEach((p) => {
      const text = p.textContent?.trim();
      if (text && text.length > 20) {
        textParts.push(text);
      }
    });

    if (textParts.length > 0) {
      return textParts.join(" ").replace(/\s+/g, " ");
    }

    // Final fallback: get all text
    const allText = root.textContent?.trim();
    return allText && allText.length > 50 ? allText.replace(/\s+/g, " ") : null;
  } catch {
    return null;
  }
};

export default blink.agent({
  async sendMessages({ messages }) {
    return streamText({
      model: "anthropic/claude-sonnet-4",
      system: `You can fetch Hacker News top stories via tools and write brief summaries.
- Always include links to stories or comments.
- Keep each summary to 2–3 sentences.
- If a story has no URL (e.g., Ask HN), use the HN text field.
- Only fetch full article content when explicitly asked.
- To fetch a full story with comments, use fetch_hn_item_details.
- NEVER include emojies in your messages.
- For TLDR bullets and sentiment across stories, use summarize_hn_tldr and include links, upvotes, and comment counts.`,
      messages: convertToModelMessages(messages),
      tools: {
        ...slackbot.tools({
          messages,
        }),
        fetch_hn_top_articles: tool({
          description:
            "Fetch top N HN stories and (optionally) extract readable article text. Includes points, comment count, and time ago.",
          inputSchema: z.object({
            limit: z.number().int().min(1).max(30).default(10),
            include_article: z.boolean().default(false),
            max_content_chars: z
              .number()
              .int()
              .min(200)
              .max(20000)
              .default(1200),
          }),
          execute: async ({ limit, include_article, max_content_chars }) => {
            const topIds: number[] = await fetch(
              "https://hacker-news.firebaseio.com/v0/topstories.json"
            ).then((r) => r.json());
            const ids = (topIds || []).slice(0, limit);

            const items = await Promise.all(
              ids.map(async (id) => {
                try {
                  const item = await fetch(
                    `https://hacker-news.firebaseio.com/v0/item/${id}.json`
                  ).then((r) => r.json());

                  const base = {
                    id: (item?.id as number | null) ?? null,
                    title: (item?.title as string | null) ?? null,
                    by: (item?.by as string | null) ?? null,
                    score: (item?.score as number | null) ?? null,
                    time: (item?.time as number | null) ?? null,
                    time_ago: timeAgo(item?.time ?? null),
                    url: (item?.url as string | undefined) || null,
                    type: (item?.type as string | null) ?? null,
                    text: stripHtml(item?.text as string | undefined) || null,
                    comments_count:
                      (item?.descendants as number | null) ?? null,
                    comments_url: item?.id
                      ? `https://news.ycombinator.com/item?id=${item.id}`
                      : null,
                  } as const;

                  if (!item?.url) {
                    return {
                      ...base,
                      content: base.text
                        ? base.text.slice(0, max_content_chars)
                        : null,
                      source: "hn" as const,
                    };
                  }

                  if (!include_article) {
                    return { ...base, content: null, source: "url" as const };
                  }

                  try {
                    const res = await fetch(item.url, {
                      headers: {
                        "User-Agent":
                          "hn-summarizer/1.0 (+https://example.com)",
                      },
                    });
                    const html = await res.text();
                    const content = extractArticleText(html);
                    return {
                      ...base,
                      content: content
                        ? content.slice(0, max_content_chars)
                        : null,
                      source: "url" as const,
                    };
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
                    time_ago: null,
                    url: null,
                    type: null,
                    text: null,
                    comments_count: null,
                    comments_url: null,
                    content: null,
                    source: "error" as const,
                  };
                }
              })
            );

            return { items };
          },
        }),

        fetch_hn_item_details: tool({
          description:
            "Fetch a single HN item by id, with optional article body and comment tree (configurable depth and limits).",
          inputSchema: z.object({
            id: z.number().int(),
            include_article: z.boolean().default(false),
            include_comments: z.boolean().default(false),
            max_depth: z.number().int().min(0).max(5).default(1),
            max_comments: z.number().int().min(1).max(500).default(50),
            strip_html: z.boolean().default(true),
          }),
          execute: async ({
            id,
            include_article,
            include_comments,
            max_depth,
            max_comments,
            strip_html,
          }) => {
            const loadItem = async (itemId: number) =>
              fetch(
                `https://hacker-news.firebaseio.com/v0/item/${itemId}.json`
              ).then((r) => r.json());

            const item = await loadItem(id);
            if (!item) return { error: "not_found", id } as const;

            const base = {
              id: (item?.id as number | null) ?? null,
              title: (item?.title as string | null) ?? null,
              by: (item?.by as string | null) ?? null,
              score: (item?.score as number | null) ?? null,
              time: (item?.time as number | null) ?? null,
              time_ago: timeAgo(item?.time ?? null),
              url: (item?.url as string | undefined) || null,
              type: (item?.type as string | null) ?? null,
              text: strip_html
                ? stripHtml(item?.text as string | undefined)
                : (item?.text as string | undefined) || null,
              comments_count: (item?.descendants as number | null) ?? null,
              comments_url: item?.id
                ? `https://news.ycombinator.com/item?id=${item.id}`
                : null,
            };

            let article_content: string | null = null;
            if (include_article && item?.url) {
              try {
                const res = await fetch(item.url, {
                  headers: {
                    "User-Agent": "hn-summarizer/1.0 (+https://example.com)",
                  },
                });
                const html = await res.text();
                article_content = extractArticleText(html);
              } catch {
                article_content = null;
              }
            }

            let comments: any[] | null = null;
            if (
              include_comments &&
              Array.isArray(item?.kids) &&
              item.kids.length
            ) {
              let remaining = max_comments;
              const loadComment = async (
                cid: number,
                depth: number
              ): Promise<any | null> => {
                if (remaining <= 0) return null;
                try {
                  const c = await loadItem(cid);
                  if (!c || c?.type !== "comment") return null;
                  remaining -= 1;
                  const node: any = {
                    id: c.id ?? null,
                    by: c.by ?? null,
                    time: c.time ?? null,
                    time_ago: timeAgo(c.time ?? null),
                    text: strip_html ? stripHtml(c.text) : c.text ?? null,
                    parent: c.parent ?? null,
                    dead: !!c.dead,
                    deleted: !!c.deleted,
                    kids_count: Array.isArray(c.kids) ? c.kids.length : 0,
                    children: [] as any[],
                  };
                  if (
                    depth < max_depth &&
                    Array.isArray(c.kids) &&
                    c.kids.length &&
                    remaining > 0
                  ) {
                    const children: any[] = [];
                    for (const kid of c.kids) {
                      if (remaining <= 0) break;
                      const child = await loadComment(kid, depth + 1);
                      if (child) children.push(child);
                    }
                    node.children = children;
                  }
                  return node;
                } catch {
                  return null;
                }
              };

              const topLevel: any[] = [];
              for (const kid of item.kids as number[]) {
                if (remaining <= 0) break;
                const node = await loadComment(kid, 0);
                if (node) topLevel.push(node);
              }
              comments = topLevel;
            }

            return {
              item: base,
              article_content,
              comments,
            };
          },
        }),

        summarize_hn_tldr: tool({
          description:
            "Create TLDR bullet points for stories and summarize overall sentiment/feedback based on comments.",
          inputSchema: z.object({
            story_ids: z.array(z.number().int()).optional(),
            limit: z.number().int().min(1).max(30).default(3),
            include_article: z.boolean().default(true),
            include_comments: z.boolean().default(false),
            max_depth: z.number().int().min(0).max(3).default(1),
            max_comments: z.number().int().min(1).max(100).default(10),
            max_article_chars: z
              .number()
              .int()
              .min(200)
              .max(2000)
              .default(2000),
            max_comment_chars: z.number().int().min(50).max(2000).default(500),
            format: z.enum(["markdown", "json"]).default("markdown"),
          }),
          execute: async (args) => {
            const {
              story_ids,
              limit,
              include_article,
              include_comments,
              max_depth,
              max_comments,
              max_article_chars,
              max_comment_chars,
              format,
            } = args;

            const loadItem = async (itemId: number) =>
              fetch(
                `https://hacker-news.firebaseio.com/v0/item/${itemId}.json`
              ).then((r) => r.json());

            let ids: number[] = story_ids ?? [];
            if (!ids.length) {
              const topIds: number[] = await fetch(
                "https://hacker-news.firebaseio.com/v0/topstories.json"
              ).then((r) => r.json());
              ids = (topIds || []).slice(0, limit);
            }

            const stories = await Promise.all(
              ids.map(async (id) => {
                try {
                  const item = await loadItem(id);
                  if (!item) return null;
                  const base = {
                    id: (item?.id as number | null) ?? null,
                    title: (item?.title as string | null) ?? null,
                    by: (item?.by as string | null) ?? null,
                    score: (item?.score as number | null) ?? null,
                    time: (item?.time as number | null) ?? null,
                    time_ago: timeAgo(item?.time ?? null),
                    url: (item?.url as string | undefined) || null,
                    type: (item?.type as string | null) ?? null,
                    text: stripHtml(item?.text as string | undefined),
                    comments_count:
                      (item?.descendants as number | null) ?? null,
                    comments_url: item?.id
                      ? `https://news.ycombinator.com/item?id=${item.id}`
                      : null,
                  };

                  let article_excerpt: string | null = null;
                  if (include_article && item?.url) {
                    try {
                      const res = await fetch(item.url, {
                        headers: {
                          "User-Agent":
                            "hn-summarizer/1.0 (+https://example.com)",
                        },
                      });
                      const html = await res.text();
                      const text = extractArticleText(html);
                      if (text)
                        article_excerpt = text.slice(0, max_article_chars);
                    } catch {
                      article_excerpt = null;
                    }
                  }

                  const flatComments: string[] = [];
                  if (
                    include_comments &&
                    Array.isArray(item?.kids) &&
                    item.kids.length
                  ) {
                    let remaining = max_comments;
                    const loadComment = async (
                      cid: number,
                      depth: number
                    ): Promise<void> => {
                      if (remaining <= 0) return;
                      try {
                        const c = await loadItem(cid);
                        if (!c || c?.type !== "comment") return;
                        remaining -= 1;
                        const txt = stripHtml(c.text) || "";
                        if (txt)
                          flatComments.push(txt.slice(0, max_comment_chars));
                        if (
                          depth < max_depth &&
                          Array.isArray(c.kids) &&
                          c.kids.length &&
                          remaining > 0
                        ) {
                          for (const kid of c.kids) {
                            if (remaining <= 0) break;
                            await loadComment(kid, depth + 1);
                          }
                        }
                      } catch {
                        /* ignore */
                      }
                    };

                    for (const kid of item.kids as number[]) {
                      if (remaining <= 0) break;
                      await loadComment(kid, 0);
                    }
                  }

                  return {
                    ...base,
                    article_excerpt,
                    comments_sample: flatComments,
                  };
                } catch {
                  return null;
                }
              })
            );

            const compact = stories.filter(Boolean);

            const prompt = `You are generating concise TLDRs for Hacker News items. For each story:
- Include links, points, comment count, and time ago.
            - Provide 2–3 bullet points summarizing what the story is about (based on title, article excerpt, or Ask HN text).
- Provide overall sentiment and 2–3 bullets of feedback/themes observed in the comments sample.
- Be neutral and factual; avoid speculation.
Return ${format} format.`;

            const { text } = await generateText({
              model: "anthropic/claude-sonnet-4",
              system: prompt,
              prompt: JSON.stringify(compact, null, 2),
            });

            if (format === "json") {
              try {
                const parsed = JSON.parse(text);
                return {
                  format,
                  stories_count: compact.length,
                  output: parsed,
                };
              } catch {
                return {
                  format,
                  stories_count: compact.length,
                  output_raw: text,
                };
              }
            }
            return { format, stories_count: compact.length, output: text };
          },
        }),
      },
    });
  },
  async webhook(request) {
    if (slackbot.isOAuthRequest(request)) {
      return slackbot.handleOAuthRequest(request);
    }
    if (slackbot.isWebhook(request)) {
      // Parse the request body to handle message events
      const body = await request.json();
      
      // Automatically react to new messages with an emoji
      if (body.event?.type === 'message' && 
          !body.event.bot_id && 
          !body.event.subtype && 
          body.event.text) {
        try {
          await slackbot.slackbot_react_to_message({
            channel: body.event.channel,
            timestamp: body.event.ts,
            name: 'eyes' // React with eyes emoji
          });
        } catch (error) {
          console.error('Failed to add emoji reaction:', error);
        }
      }
      
      return slackbot.handleWebhook(request);
    }
  },
});
