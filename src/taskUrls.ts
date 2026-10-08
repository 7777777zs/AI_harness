// URLs in the task, for the "[Harness status]" line about task URLs not opened yet (N5). Without it,
// gpt-4.1-mini often listed the browser's pages or read the URL's path as a file, saw only the blank
// tab or a missing file, took that for the page itself, and gave up ("the page is not accessible").
import { STATUS_PREFIX } from "./context/coverage.js";

/** http(s) URLs in the task text, without trailing punctuation. */
export function taskUrls(task: string): URL[] {
  const urls: URL[] = [];
  for (const match of task.match(/https?:\/\/[^\s"'<>]+/g) ?? []) {
    try {
      urls.push(new URL(match.replace(/[.,;:!?)\]]+$/, "")));
    } catch {
      // not a valid URL
    }
  }
  return urls;
}

/** A URL without the differences a tool call may introduce (a trailing slash on the path). */
const urlKey = (url: URL) => url.origin + url.pathname.replace(/\/+$/, "") + url.search;

/** True if a tool call's arguments contain the URL itself (so the call could have opened it). */
export function mentionsUrl(args: Record<string, unknown> | null | undefined, url: URL): boolean {
  return taskUrls(JSON.stringify(args ?? {})).some((u) => urlKey(u) === urlKey(url));
}

/** Status line for task URLs that no MCP call has been given yet. */
export const unopenedUrlStatus = (urls: string[]) =>
  `Not opened by any tool call yet: ${urls.join(", ")} (from the task). The browser's open pages and the files ` +
  "in the working directory are not that page; open it with the MCP tool that loads URLs.";

/** The [Harness status] text with the unopened task URLs added (a status of its own if there was none). */
export function withUnopenedUrls(status: string | null, unopened: string[]): string | null {
  if (unopened.length === 0) return status;
  return `${status ?? STATUS_PREFIX}\n${unopenedUrlStatus(unopened)}`;
}
