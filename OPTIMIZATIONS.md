# Firebase API optimizations

Changes

- Centralized HackerNewsAPI client
  - In-memory cache with TTLs (topstories 2m, items 10m)
  - Request de-duplication via pending request map
  - Batching with controlled concurrency (default 12)
  - Periodic cache cleanup
- Tools refactor
  - fetch_hn_top_articles uses getTopStories + getBatchItems
  - fetch_hn_item_details uses getItem() (cached)
  - summarize_hn_tldr loads items in batches and uses getTopStories when ids are not provided
  - Full-article fetch in fetch_hn_top_articles has an 8s timeout

Ad‑hoc benchmark (illustrative)

- First getTopStories call: ~150–300ms
- Cached getTopStories call: ~0.02–0.06ms (served from memory)
- Batch fetch of 5 items (concurrency 2): ~200–300ms, two waves
- Request de-duplication (3 concurrent same-item): ~0.01–0.05ms for the duplicates after the first resolves

Notes

- Numbers vary based on network and HN API responsiveness
- TTLs balance freshness vs speed; adjust if usage patterns change
- Concurrency can be tuned per environment (network limits, rate considerations)
