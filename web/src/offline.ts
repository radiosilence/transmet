import { pageUrl, type Issue } from "./catalogue";
import { useDownloads, useShelf } from "./store";

/** Must match `PAGES` in public/sw.js, which serves from it. */
const CACHE = "transmet-pages-v1";
const PARALLEL = 4;

const urls = (issue: Issue) => issue.pages.flatMap((p) => [pageUrl(p.src), pageUrl(p.thumb)]);

let queue = Promise.resolve();

/**
 * Saves every page of an issue into the Cache API, where the service worker
 * serves them from without a network. Runs one issue at a time so an arc
 * download does not starve the page being read.
 */
export function save(issue: Issue) {
  if (useShelf.getState().saved[issue.id] || issue.id in useDownloads.getState()) return queue;
  useDownloads.setState({ [issue.id]: 0 });
  queue = queue.then(() => fetchAll(issue)).catch(() => {});
  return queue;
}

async function fetchAll(issue: Issue) {
  void navigator.storage?.persist?.();
  const cache = await caches.open(CACHE);
  const todo = urls(issue);
  let done = 0;
  const worker = async () => {
    for (let url = todo.pop(); url; url = todo.pop()) {
      if (!(await cache.match(url))) {
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) throw new Error(`${url}: ${res.status}`);
        await cache.put(url, res);
      }
      done++;
      useDownloads.setState({ [issue.id]: done / (issue.pages.length * 2) });
    }
  };
  try {
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    useShelf.getState().markSaved(issue.id, true);
  } finally {
    useDownloads.setState((s) => {
      const { [issue.id]: _, ...rest } = s;
      return rest;
    }, true);
  }
}

export async function forget(issue: Issue) {
  const cache = await caches.open(CACHE);
  await Promise.all(urls(issue).map((u) => cache.delete(u)));
  useShelf.getState().markSaved(issue.id, false);
}

export async function forgetAll() {
  await caches.delete(CACHE);
  for (const id of Object.keys(useShelf.getState().saved)) useShelf.getState().markSaved(id, false);
}

/** Keeps the open issue and the next few on the device, like an album queued in a music player. */
export function keepAhead(issues: Issue[], from: Issue) {
  const start = issues.indexOf(from);
  for (const issue of issues.slice(start, start + 1 + useShelf.getState().ahead)) void save(issue);
}

export async function usage() {
  const est = await navigator.storage?.estimate?.();
  return est?.usage ?? 0;
}
