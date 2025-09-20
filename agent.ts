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
    console.log("🚀 [AGENT] sendMessages called with:", {
      messageCount: messages.length,
      lastMessage: messages[messages.length - 1]?.content,
      lastMessageRole: messages[messages.length - 1]?.role
    });
    
    console.log("📵 [AGENT] Full messages array:", JSON.stringify(messages, null, 2));
    
    const convertedMessages = convertToModelMessages(messages);
    console.log("🔄 [AGENT] Converted messages:", JSON.stringify(convertedMessages, null, 2));
    
    console.log("🎤 [AGENT] About to call streamText with model: anthropic/claude-sonnet-4");
    
    try {
      const streamResult = streamText({
        model: "anthropic/claude-sonnet-4",
        system: `You can fetch Hacker News top stories via tools and write brief summaries.
- Keep each summary to 2–3 sentences.
- If a story has no URL (e.g., Ask HN), use the HN text field.
- Prefer readable article body extracted via lightweight text extraction when available.
- Fetch and summarize the top 10 by default.
- To fetch a full story with comments, use fetch_hn_item_details.
- For TLDR bullets and sentiment across stories, use summarize_hn_tldr.`,
        messages: convertedMessages,
        tools: {
          ...slackbot.tools({
            messages,
          }),
          fetch_hn_top_articles: tool({
            description:
              "Fetch top N HN stories and extract best-effort readable article text. Includes points, comment count, and time ago.",
            inputSchema: z.object({
              limit: z.number().int().min(1).max(30).default(10),
            }),
            execute: async ({ limit }) => {
              console.log("📰 [TOOL] fetch_hn_top_articles executing with limit:", limit);
              try {
                const topIds: number[] = await fetch(
                  "https://hacker-news.firebaseio.com/v0/topstories.json",
                ).then((r) => r.json());
                const ids = (topIds || []).slice(0, limit);
                console.log("📰 [TOOL] Got story IDs:", ids);

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
                        time_ago: timeAgo(item?.time ?? null),
                        url: (item?.url as string | undefined) || null,
                        type: (item?.type as string | null) ?? null,
                        text: (item?.text as string | undefined) || null,
                        comments_count:
                          (item?.descendants as number | null) ?? null,
                        comments_url: item?.id
                          ? `https://news.ycombinator.com/item?id=${item.id}`
                          : null,
                      };

                      if (!item?.url) {
                        return {
                          ...base,
                          content: stripHtml(base.text),
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
                        const content = extractArticleText(html);
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
                  }),
                );

                console.log("📰 [TOOL] fetch_hn_top_articles returning:", { itemCount: items.length });
                const result = { items };
                console.log("📰 [TOOL] fetch_hn_top_articles result structure:", Object.keys(result));
                return result;
              } catch (error) {
                console.error("❌ [TOOL] fetch_hn_top_articles error:", error);
                throw error;
              }
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
              console.log("🔍 [TOOL] fetch_hn_item_details executing with:", {
                id, include_article, include_comments, max_depth, max_comments
              });
              
              try {
                const loadItem = async (itemId: number) =>
                  fetch(
                    `https://hacker-news.firebaseio.com/v0/item/${itemId}.json`,
                  ).then((r) => r.json());

                const item = await loadItem(id);
                if (!item) {
                  console.log("🔍 [TOOL] Item not found:", id);
                  return { error: "not_found", id } as const;
                }

                console.log("🔍 [TOOL] fetch_hn_item_details loaded item:", item.title);

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
                    depth: number,
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
                        text: strip_html ? stripHtml(c.text) : (c.text ?? null),
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

                const result = {
                  item: base,
                  article_content,
                  comments,
                };
                
                console.log("🔍 [TOOL] fetch_hn_item_details returning:", {
                  hasItem: !!result.item,
                  hasArticle: !!result.article_content,
                  hasComments: !!result.comments,
                  commentCount: result.comments?.length
                });
                
                return result;
              } catch (error) {
                console.error("❌ [TOOL] fetch_hn_item_details error:", error);
                throw error;
              }
            },
          }),

          summarize_hn_tldr: tool({
            description:
              "Create TLDR bullet points for stories and summarize overall sentiment/feedback based on comments.",
            inputSchema: z.object({
              story_ids: z.array(z.number().int()).optional(),
              limit: z.number().int().min(1).max(30).default(10),
              include_article: z.boolean().default(true),
              include_comments: z.boolean().default(true),
              max_depth: z.number().int().min(0).max(3).default(1),
              max_comments: z.number().int().min(1).max(100).default(25),
              max_article_chars: z
                .number()
                .int()
                .min(200)
                .max(20000)
                .default(4000),
              max_comment_chars: z.number().int().min(50).max(2000).default(500),
              format: z.enum(["markdown", "json"]).default("markdown"),
            }),
            execute: async (args) => {
              console.log("📋 [TOOL] summarize_hn_tldr executing with:", args);
              
              try {
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
                    `https://hacker-news.firebaseio.com/v0/item/${itemId}.json`,
                  ).then((r) => r.json());

                let ids: number[] = story_ids ?? [];
                if (!ids.length) {
                  console.log("📋 [TOOL] Fetching top stories from HN API");
                  const topIds: number[] = await fetch(
                    "https://hacker-news.firebaseio.com/v0/topstories.json",
                  ).then((r) => r.json());
                  ids = (topIds || []).slice(0, limit);
                  console.log("📋 [TOOL] Got story IDs for TLDR:", ids.length, "stories");
                }

                console.log("📋 [TOOL] Starting to process stories...");
                const stories = await Promise.all(
                  ids.map(async (id, index) => {
                    console.log(`📋 [TOOL] Processing story ${index + 1}/${ids.length} (ID: ${id})`);
                    try {
                      const item = await loadItem(id);
                      if (!item) return null;
                      console.log(`📋 [TOOL] Story ${index + 1} loaded: ${item.title?.slice(0, 50)}...`);
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
                        console.log(`📋 [TOOL] Fetching article for story ${index + 1}`);
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
                          console.log(`📋 [TOOL] Article fetched for story ${index + 1}: ${article_excerpt ? 'success' : 'no content'}`);
                        } catch {
                          article_excerpt = null;
                          console.log(`📋 [TOOL] Article fetch failed for story ${index + 1}`);
                        }
                      }

                      const flatComments: string[] = [];
                      if (
                        include_comments &&
                        Array.isArray(item?.kids) &&
                        item.kids.length
                      ) {
                        console.log(`📋 [TOOL] Fetching comments for story ${index + 1}`);
                        let remaining = max_comments;
                        const loadComment = async (
                          cid: number,
                          depth: number,
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
                        console.log(`📋 [TOOL] Comments fetched for story ${index + 1}: ${flatComments.length} comments`);
                      }

                      console.log(`📋 [TOOL] Story ${index + 1} processed successfully`);
                      return {
                        ...base,
                        article_excerpt,
                        comments_sample: flatComments,
                      };
                    } catch (error) {
                      console.error(`❌ [TOOL] Error processing story ${index + 1} (ID: ${id}):`, error);
                      return null;
                    }
                  }),
                );

                const compact = stories.filter(Boolean);
                console.log(`📋 [TOOL] Processed ${compact.length} stories successfully`);

                const prompt = `You are generating concise TLDRs for Hacker News items. For each story:
- Provide 2–3 bullet points summarizing what the story is about (based on title, article excerpt, or Ask HN text).
- Provide overall sentiment and 2–3 bullets of feedback/themes observed in the comments sample.
- Be neutral and factual; avoid speculation.
Return ${format} format.`;

                console.log(`📋 [TOOL] About to call generateText with ${compact.length} stories`);
                console.log(`📋 [TOOL] Data payload size:`, JSON.stringify(compact, null, 2).length, "characters");
                
                const { text } = await generateText({
                  model: "anthropic/claude-sonnet-4",
                  system: prompt,
                  prompt: JSON.stringify(compact, null, 2),
                });
                
                console.log(`📋 [TOOL] generateText completed, response length:`, text.length);
                console.log(`📋 [TOOL] generateText response preview:`, text.slice(0, 200) + "...");

                if (format === "json") {
                  try {
                    const parsed = JSON.parse(text);
                    console.log(`📋 [TOOL] JSON parsing successful`);
                    const result = {
                      format,
                      stories_count: compact.length,
                      output: parsed,
                    };
                    console.log(`📋 [TOOL] summarize_hn_tldr returning JSON result:`, Object.keys(result));
                    return result;
                  } catch (parseError) {
                    console.error(`❌ [TOOL] JSON parsing failed:`, parseError);
                    const result = {
                      format,
                      stories_count: compact.length,
                      output_raw: text,
                    };
                    console.log(`📋 [TOOL] summarize_hn_tldr returning raw result due to parse error`);
                    return result;
                  }
                }
                const result = { format, stories_count: compact.length, output: text };
                console.log(`📋 [TOOL] summarize_hn_tldr returning markdown result:`, Object.keys(result));
                return result;
              } catch (error) {
                console.error("❌ [TOOL] summarize_hn_tldr error:", error);
                throw error;
              }
            },
          }),
        },
        onToolCall: (args) => {
          console.log("🔧 [STREAM] Tool call initiated:", args.toolName, "with args:", args.args);
        },
        onToolResult: (args) => {
          console.log("✅ [STREAM] Tool call completed:", args.toolName, "result type:", typeof args.result);
          console.log("✅ [STREAM] Tool result keys:", args.result ? Object.keys(args.result) : "null result");
        },
      });
      
      console.log("🎤 [AGENT] streamText call successful, returning stream");
      return streamResult;
    } catch (error) {
      console.error("❌ [AGENT] streamText call failed:", error);
      throw error;
    }
  },
  async webhook(request) {
    if (slackbot.isOAuthRequest(request)) {
      return slackbot.handleOAuthRequest(request);
    }
    if (slackbot.isWebhook(request)) {
      return slackbot.handleWebhook(request);
    }
  },
});
