import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import type { EvalTask } from "../types.js";
import { fail, pass, write } from "../helpers.js";

/**
 * Regression for a real-world failure: reading and summarizing ~6 files under a tight
 * context limit. Old tool results get compacted away, so the agent must keep notes; a naive
 * recursive listing drowns in .git / virtualenv junk and gets truncated.
 */

interface SourceFile {
  path: string;
  /** Unique function name defined only in this file. */
  id: string;
  /** Matches a one-sentence description of this file's purpose. */
  purpose: RegExp;
  doc: string;
  body: string;
}

// File names are deliberately generic so the purpose can't be guessed from the name alone.
const FILES: SourceFile[] = [
  {
    path: "src/billing/calc.py",
    id: "compute_invoice_totals_v7",
    purpose: /invoice/i,
    doc: "Invoice total calculation: sums line items, applies per-region tax tables and discounts, and rounds to cents.",
    body: `def compute_invoice_totals_v7(lines, region, discount_pct=0):
    """Return subtotal, tax and grand total for an invoice."""
    subtotal = sum(line["qty"] * line["unit_price"] for line in lines)
    tax = round(subtotal * TAX_TABLE.get(region, 0.0), 2)
    discount = round(subtotal * discount_pct / 100, 2)
    return {"subtotal": subtotal, "tax": tax, "total": round(subtotal + tax - discount, 2)}

TAX_TABLE = {"eu": 0.21, "uk": 0.20, "us-ca": 0.0725, "us-ny": 0.08875}`,
  },
  {
    path: "src/auth/keys.py",
    id: "rotate_signing_keys_hourly",
    purpose: /rotat/i,
    doc: "Signing key rotation: generates a new key every hour, keeps the previous key valid for a grace period, and retires old keys.",
    body: `def rotate_signing_keys_hourly(keystore, now):
    """Create a fresh signing key and retire keys past their grace period."""
    new_key = keystore.generate(algorithm="ed25519", created_at=now)
    for key in keystore.active():
        if now - key.created_at > GRACE_PERIOD_SECONDS:
            keystore.retire(key.kid)
    keystore.set_primary(new_key.kid)
    return new_key.kid

GRACE_PERIOD_SECONDS = 2 * 3600`,
  },
  {
    path: "src/storage/gc.py",
    id: "sweep_orphaned_blobs",
    purpose: /orphan|blob|garbage/i,
    doc: "Storage garbage collector: finds blobs no longer referenced by any manifest and deletes them after a safety delay.",
    body: `def sweep_orphaned_blobs(bucket, manifests, min_age_days=7):
    """Delete blobs that no manifest references and that are older than min_age_days."""
    referenced = {digest for m in manifests for digest in m.blob_digests}
    removed = 0
    for blob in bucket.list_blobs():
        if blob.digest not in referenced and blob.age_days >= min_age_days:
            bucket.delete(blob.digest)
            removed += 1
    return removed`,
  },
  {
    path: "src/api/throttle.py",
    id: "sliding_window_admit",
    purpose: /rate.?limit|sliding.?window/i,
    doc: "API rate limiting with a sliding window: admits a request only if the client made fewer than N requests in the last window.",
    body: `def sliding_window_admit(store, client_id, now, max_requests=100, window_seconds=60):
    """Return True if the request is admitted under the sliding-window limit."""
    key = f"rl:{client_id}"
    store.zremrangebyscore(key, 0, now - window_seconds)
    if store.zcard(key) >= max_requests:
        return False
    store.zadd(key, {str(now): now})
    return True`,
  },
  {
    path: "src/reports/export.py",
    id: "render_monthly_pdf_report",
    purpose: /pdf/i,
    doc: "Monthly report export: renders the month's metrics into a paginated PDF document with a cover page and charts.",
    body: `def render_monthly_pdf_report(metrics, month, out_path):
    """Write a PDF with one page per metric group plus a cover page."""
    doc = PdfDocument(title=f"Monthly report {month}")
    doc.add_cover(month=month, generated_by="reports-service")
    for group, values in sorted(metrics.items()):
        doc.add_page(heading=group, chart=values)
    doc.save(out_path)
    return out_path`,
  },
  {
    path: "src/notify/gateway.py",
    id: "dispatch_sms_batch",
    purpose: /sms|text messag/i,
    doc: "SMS gateway client: sends batches of text messages through the carrier API with retries and delivery receipts.",
    body: `def dispatch_sms_batch(client, messages, sender_id="ACME"):
    """Send up to 100 SMS messages in one carrier API call; return delivery ids."""
    payload = [{"to": m.phone, "body": m.text[:160], "from": sender_id} for m in messages[:100]]
    response = client.post("/v2/sms/batch", json=payload)
    response.raise_for_status()
    return [item["delivery_id"] for item in response.json()["items"]]`,
  },
];

// Neutral helpers used as padding. They must not contain any file's purpose keywords.
const HELPERS = [
  ["_coerce_int", "value, default=0", "Convert value to int, falling back to default.", "try:\n        return int(value)\n    except (TypeError, ValueError):\n        return default"],
  ["_chunked", "items, size", "Yield successive chunks of the given size.", "for start in range(0, len(items), size):\n        yield items[start:start + size]"],
  ["_merge_dicts", "base, override", "Return a new dict with override applied on top of base.", "merged = dict(base)\n    merged.update(override or {})\n    return merged"],
  ["_clamp", "value, low, high", "Clamp value into the closed interval [low, high].", "return max(low, min(high, value))"],
  ["_dedupe", "items", "Remove duplicates while keeping the first occurrence order.", "seen = set()\n    out = []\n    for item in items:\n        if item not in seen:\n            seen.add(item)\n            out.append(item)\n    return out"],
  ["_safe_get", "mapping, path, default=None", "Walk a dotted path through nested dicts.", "node = mapping\n    for part in path.split('.'):\n        if not isinstance(node, dict) or part not in node:\n            return default\n        node = node[part]\n    return node"],
  ["_format_ts", "seconds", "Format a duration in seconds as H:MM:SS.", "h, rem = divmod(int(seconds), 3600)\n    m, s = divmod(rem, 60)\n    return f\"{h}:{m:02d}:{s:02d}\""],
  ["_retry", "fn, attempts=3", "Call fn, retrying on exceptions up to the given number of attempts.", "last = None\n    for _ in range(attempts):\n        try:\n            return fn()\n        except Exception as exc:  # noqa: BLE001\n            last = exc\n    raise last"],
] as const;

function renderFile(f: SourceFile, index: number): string {
  let text = `"""${f.doc}"""\n\nimport json\nimport logging\n\nlog = logging.getLogger(__name__)\n\n\n${f.body}\n`;
  // Pad with neutral helpers (renamed per file) until the file is 5-7k chars.
  const target = 5_200 + index * 300;
  for (let round = 0; text.length < target; round++) {
    for (const [name, args, doc, body] of HELPERS) {
      text += `\n\ndef ${name}_${round}(${args}):\n    """${doc}"""\n    ${body}\n`;
      if (text.length >= target) break;
    }
  }
  return text;
}

function hex(n: number, seed: string): string {
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, n);
}

export const task: EvalTask = {
  id: "multi-file-summary",
  description: "Summarize 6 source files under a tight context limit, in a repo full of .git/.venv junk",
  prompt: "List each source file in this project and describe its purpose in one sentence.",
  contextLimit: 8_000,
  compactThreshold: 0.7,
  setup(dir) {
    FILES.forEach((f, i) => write(dir, f.path, renderFile(f, i)));
    write(dir, ".gitignore", ".venv/\n");
    // Junk a naive recursive listing will include: big enough to exceed the 10k truncation limit.
    for (let i = 0; i < 400; i++) {
      const h = hex(64, `obj${i}`);
      write(dir, `.git/lfs/objects/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}`, "x");
    }
    for (let i = 0; i < 300; i++) {
      write(dir, `.venv/Lib/site-packages/pkg${i % 30}/module_${i}.py`, "# vendored\n");
    }
    // A real repository makes `git ls-files` work; skip silently if git is unavailable.
    const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (git("init", "-q").status === 0) {
      git("add", "-A");
      git("-c", "user.name=eval", "-c", "user.email=eval@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture");
    }
  },
  check(_dir, result) {
    if (result.stopReason !== "done") return fail(`run ended with ${result.stopReason}`);
    const text = result.finalText ?? "";
    const missingNames = FILES.map((f) => f.path.split("/").pop()!).filter((name) => !text.includes(name));
    const missingPurpose = FILES.filter((f) => !text.includes(f.id) && !f.purpose.test(text)).map((f) => f.path.split("/").pop());
    const problems = [
      ...(missingNames.length ? [`files not named: ${missingNames.join(", ")}`] : []),
      ...(missingPurpose.length ? [`purpose missing for: ${missingPurpose.join(", ")}`] : []),
    ];
    return problems.length ? fail(problems.join("; ")) : pass();
  },
};
