"use strict";

const HN_API_BASE = "https://hacker-news.firebaseio.com/v0";

const now = () => Date.now();

class HN {
  constructor({
    ttlTopStoriesMs = 120_000,
    ttlItemMs = 600_000,
    concurrency = 12,
  } = {}) {
    this.ttlTopStories = ttlTopStoriesMs;
    this.ttlItem = ttlItemMs;
    this.concurrency = concurrency;
    this.cache = new Map();
    this.pending = new Map();
    this.timer = setInterval(() => this.cleanup(), 60_000);
    if (this.timer.unref) this.timer.unref();
  }
  cleanup() {
    const t = now();
    for (const [k, v] of this.cache) if (v.expires < t) this.cache.delete(k);
  }
  getCached(key) {
    const e = this.cache.get(key);
    if (!e) return null;
    if (e.expires < now()) {
      this.cache.delete(key);
      return null;
    }
    return e.value;
  }
  setCached(key, value, ttl) {
    this.cache.set(key, { value, expires: now() + ttl });
  }
  async dedupe(key, fn) {
    const p = this.pending.get(key);
    if (p) return p;
    const created = Promise.resolve().then(fn);
    this.pending.set(key, created);
    try {
      const v = await created;
      return v;
    } finally {
      this.pending.delete(key);
    }
  }
  async json(url) {
    const res = await fetch(url);
    return res.json();
  }
  async getTopStories() {
    const key = "topstories";
    const c = this.getCached(key);
    if (c) return c;
    const val = await this.dedupe(key, async () => {
      const data = await this.json(`${HN_API_BASE}/topstories.json`);
      this.setCached(key, data, this.ttlTopStories);
      return data;
    });
    return val;
  }
  async getItem(id) {
    const key = `item:${id}`;
    const c = this.getCached(key);
    if (c) return c;
    const val = await this.dedupe(key, async () => {
      const data = await this.json(`${HN_API_BASE}/item/${id}.json`);
      this.setCached(key, data, this.ttlItem);
      return data;
    });
    return val;
  }
  async pMap(items, mapper) {
    const ret = new Array(items.length);
    let i = 0;
    let active = 0;
    return new Promise((resolve, reject) => {
      const run = () => {
        if (i >= items.length && active === 0) return resolve(ret);
        while (active < this.concurrency && i < items.length) {
          const idx = i++;
          active++;
          Promise.resolve(mapper(items[idx], idx))
            .then((r) => {
              ret[idx] = r;
              active--;
              run();
            })
            .catch(reject);
        }
      };
      run();
    });
  }
  async getBatchItems(ids) {
    return this.pMap(ids, (id) => this.getItem(id));
  }
}

(async () => {
  const api = new HN({ concurrency: 2 });

  const t0 = now();
  const top1 = await api.getTopStories();
  const t1 = now();
  await api.getTopStories();
  const t2 = now();
  console.log(
    "topstories first:",
    t1 - t0,
    "ms",
    "second (cached):",
    t2 - t1,
    "ms",
  );

  const ids = top1.slice(0, 5);
  const b0 = now();
  await api.getBatchItems(ids);
  const b1 = now();
  console.log("batch 5 items:", b1 - b0, "ms");

  const same = ids[0];
  const d0 = now();
  await Promise.all([api.getItem(same), api.getItem(same), api.getItem(same)]);
  const d1 = now();
  console.log("dedup 3 concurrent same-item:", d1 - d0, "ms");
})();
