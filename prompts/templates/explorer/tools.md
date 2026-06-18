## `read_file`

`read_file(path, start_line?, end_line?)`

Read text files (max 50 MB). Returns up to **2000 lines / 80,000 chars** per call; lines longer than 2000 chars are truncated (use bash `head -n N file | tail -n 1 | cut -c FROM-TO` to read past the cap — all three are pre-approved). `offset` is an alias for `start_line`; `limit` is the **number of lines** to read starting at `start_line`/`offset` (not an alias for `end_line`).

If you know there are several files to read, **issue multiple `read_file` calls in parallel** rather than serialising them. Avoid tiny repeated slices (e.g. 30-line chunks); pick a window that covers what you need in one call.

Also reads image files (PNG, JPG, GIF, WebP, BMP, SVG, ICO, TIFF; max 20 MB) when the model supports multimodal input. The image is returned as a visual content block for direct inspection.

Returns `mtime_ms` metadata for optional optimistic concurrency checks.

## `list_dir`

`list_dir(path?, max_depth?, max_entries?, include_hidden?)`

List files and directories as a tree. Defaults: depth 2, up to 200 entries. File entries include a size suffix (`[12 KB]`). Common build / cache directories (`node_modules`, `.git`, `dist`, `target`, `.venv`, …) are skipped unless you pass them explicitly as `path`.

If you are looking for a specific filename, prefer `glob`; for content matches, prefer `grep`.

## `glob`

`glob(pattern, path?, limit?)`

Find files by name pattern. Returns matching absolute paths sorted by modification time (newest first). Default limit 200 (cap 1000).

Patterns without a slash are auto-prefixed with `**/`, so `*.ts` matches every `.ts` file in the tree. Supports `**`, `*`, `?`, `[abc]`, and brace expansion (`*.{ts,tsx}`).

## `grep`

`grep(pattern, path?, output_mode?, glob?, type?, -A?, -B?, -C?, -i?, head_limit?, limit_per_file?)`

Search file contents by regex. `pattern` accepts a single string **or an array of strings** — multiple patterns are combined with OR logic, useful for snake_case / PascalCase / camelCase variants in one call.

Smart case: an all-lowercase pattern is matched case-insensitively automatically. Pass `-i: true` (or `-i: false`) to override.

Defaults: returns up to 100 entries overall, 15 matching lines per file, with each line capped at 2000 chars. Tune with `head_limit` and `limit_per_file`. Skips common build / cache directories unless you pass them explicitly as `path`.

Key parameters:
- `output_mode`: `"files_with_matches"` (default, paths only), `"content"` (matching lines), `"count"` (match counts).
- `glob`: Filter files by name pattern (e.g. `"*.ts"`, `"*.{ts,tsx}"`).
- `type`: Filter by file extension (e.g. `"js"`, `"py"`).
- `-A`, `-B`, `-C`: Context lines after/before/around each match (content mode only).
- `-i`: Force case-insensitive (overrides smart case).
- `head_limit`, `limit_per_file`: result caps.

Recommended workflow for large files and logs:

- Start with `grep` to find the relevant area.
- Then use `read_file(start_line, end_line)` to inspect the matching region.
- When output says "truncated", search the full log file with a more specific pattern rather than re-requesting full content.

# Tool: time

Use `time` when a task depends on the current date/time or timezone.

- Call with `{}`.
- Prefer reporting absolute timestamps (not only relative words like "today"/"now").

## `web_search`

`web_search(query)`

Search the web for current information. Returns numbered results with titles, URLs, highlights, and available metadata.

## `web_fetch`

`web_fetch(url, prompt?)`

Fetch content from a URL and return it as readable text. Uses Jina Reader first, then falls back to local extraction; successful fetches return page content in readable markdown-like form.

- Only http/https URLs. Localhost, private IPs, embedded credentials, and local hostnames are rejected.
- Use `web_search` to discover URLs; use `web_fetch` to read specific pages.
- Results may be truncated for very large pages (~100K char limit).

## `await_event`

`await_event(seconds)`

Pause until a new runtime event arrives or the timeout expires.

- `seconds` (required, minimum 15): Wall-clock timeout in seconds.
- Returns early when a new message arrives.
- After sending a request to a persistent sub-agent, call `await_event` — do not loop `send`.
