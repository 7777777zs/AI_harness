// Converting between MCP and the harness: tool input schemas become function parameters the
// OpenAI API accepts, and tool results become plain text tool messages.

/** Keys the OpenAI API rejects (or that carry no meaning for the model) in function parameters. */
const STRIPPED_KEYS = new Set(["$schema", "$id", "$comment"]);

export interface CleanedSchema {
  schema: Record<string, unknown>;
  /** What was changed, e.g. `removed $schema`, `hid parameter filePath`. Empty if unchanged. */
  changes: string[];
}

/**
 * Make an MCP inputSchema usable as function parameters: strip rejected keys at every level
 * (property names themselves are left alone), remove hidden parameters, and make sure the top
 * level is an object schema with `properties`.
 */
export function cleanSchema(input: unknown, hidden: string[] = []): CleanedSchema {
  const changes = new Set<string>();
  const walk = (node: unknown, isPropertyMap: boolean): unknown => {
    if (Array.isArray(node)) return node.map((x) => walk(x, false));
    if (typeof node !== "object" || node === null) return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (!isPropertyMap && STRIPPED_KEYS.has(key)) {
        changes.add(`removed ${key}`);
        continue;
      }
      // Under "properties" the keys are parameter names; their values are schemas again.
      out[key] = walk(value, !isPropertyMap && (key === "properties" || key === "patternProperties"));
    }
    return out;
  };
  const schema = (typeof input === "object" && input !== null && !Array.isArray(input) ? walk(input, false) : {}) as Record<string, unknown>;
  if (schema.type !== "object") {
    if (schema.type !== undefined) changes.add(`replaced type ${JSON.stringify(schema.type)} with "object"`);
    else changes.add('added type "object"');
    schema.type = "object";
  }
  if (typeof schema.properties !== "object" || schema.properties === null) {
    schema.properties = {};
    changes.add("added empty properties");
  }
  const properties = schema.properties as Record<string, unknown>;
  for (const param of hidden) {
    if (!(param in properties)) continue;
    delete properties[param];
    changes.add(`hid parameter ${param}`);
    if (Array.isArray(schema.required)) schema.required = schema.required.filter((r) => r !== param);
  }
  return { schema, changes: [...changes] };
}

interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
}

/**
 * An MCP tool result as text: text blocks are joined; images and other binary content become a
 * short note (tool messages cannot carry images); text resources are inlined; `isError` results
 * start with "Error:" like every other failed tool call.
 */
export function convertResult(result: unknown, toolName: string): string {
  const r = (typeof result === "object" && result !== null ? result : {}) as {
    content?: ContentBlock[];
    isError?: boolean;
    structuredContent?: unknown;
    toolResult?: unknown;
  };
  const parts: string[] = [];
  for (const block of Array.isArray(r.content) ? r.content : []) parts.push(convertBlock(block, toolName));
  if (parts.length === 0 && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent, null, 2));
  if (parts.length === 0 && r.toolResult !== undefined) parts.push(JSON.stringify(r.toolResult, null, 2));
  const text = parts.join("\n");
  if (r.isError) return `Error: ${text || `${toolName} reported an error`}`;
  return text || "(no content)";
}

function convertBlock(block: ContentBlock, toolName: string): string {
  switch (block.type) {
    case "text":
      return block.text ?? "";
    case "image": {
      const size = typeof block.data === "string" ? imageSize(block.data) : null;
      return `[image omitted: ${block.mimeType ?? "image"}${size ? `, ${size.width}x${size.height}` : ""}, from ${toolName}]`;
    }
    case "audio":
      return `[audio omitted: ${block.mimeType ?? "audio"}, from ${toolName}]`;
    case "resource": {
      const res = block.resource ?? {};
      if (typeof res.text === "string") return `[resource ${res.uri ?? ""}]\n${res.text}`;
      return `[binary resource omitted: ${res.uri ?? "unknown"}${res.mimeType ? ` (${res.mimeType})` : ""}]`;
    }
    case "resource_link":
      return `[resource link: ${block.uri ?? ""}${block.name ? ` (${block.name})` : ""}]`;
    default:
      return `[unsupported content omitted: ${block.type}]`;
  }
}

/** Width and height of a base64 PNG or JPEG, from its header; null if not recognized. */
export function imageSize(base64: string): { width: number; height: number } | null {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64.slice(0, 90_000), "base64");
  } catch {
    return null;
  }
  // PNG: signature, then the IHDR chunk with width and height (big-endian).
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  // JPEG: walk the segments to the first start-of-frame marker.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1]!;
      const length = bytes.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
      }
      i += 2 + length;
    }
  }
  return null;
}
