## `read_file`

`read_file(path, start_line?, end_line?)`

Read text files (max 50 MB). Returns up to **2000 lines / 80,000 chars** per call; lines longer than 2000 chars are truncated (use bash `head -n N file | tail -n 1 | cut -c FROM-TO` to read past the cap — all three are pre-approved). `offset` is an alias for `start_line`; `limit` is the **number of lines** to read starting at `start_line`/`offset` (not an alias for `end_line`).

If you know there are several files to read, **issue multiple `read_file` calls in parallel** rather than serialising them.

Also reads image files (PNG, JPG, GIF, WebP, BMP, SVG, ICO, TIFF; max 20 MB) when the model supports multimodal input.

Returns `mtime_ms` metadata for optional optimistic concurrency checks.

## `list_dir`

`list_dir(path?, max_depth?, max_entries?, include_hidden?)`

List files and directories as a tree. Defaults: depth 2, up to 200 entries. File entries include a size suffix. Common build / cache directories are skipped unless passed explicitly.

## `glob`

`glob(pattern, path?, limit?)`

Find files by name pattern. Returns matching absolute paths sorted by modification time (newest first). Default limit 200.

Patterns without a slash are auto-prefixed with `**/`. Supports `**`, `*`, `?`, `[abc]`, and brace expansion (`*.{ts,tsx}`).

## `grep`

`grep(pattern, path?, output_mode?, glob?, type?, -A?, -B?, -C?, -i?, head_limit?, limit_per_file?)`

Search file contents by regex. `pattern` accepts a single string or an array of strings (combined with OR — useful for snake_case / PascalCase / camelCase variants in one call).

Smart case: an all-lowercase pattern is matched case-insensitively automatically. Pass `-i: true` (or `-i: false`) to override.

Defaults: returns up to 100 entries overall, 15 matching lines per file, lines capped at 2000 chars. Skips common build / cache directories unless passed as `path`.

Key parameters:
- `output_mode`: `"files_with_matches"` (default), `"content"`, `"count"`.
- `glob`: Filter by name pattern (e.g. `"*.ts"`).
- `type`: Filter by file extension.
- `-A`, `-B`, `-C`: context lines (content mode only).
- `-i`: force case-insensitive.
- `head_limit`, `limit_per_file`: result caps.

Recommended workflow: `grep` to locate, then `read_file` to inspect the matching region.

## `bash`

`bash(command, timeout?, cwd?)`

Execute shell commands. Returns stdout, stderr, and exit code.

**Use `bash` for:** running builds, installing dependencies, running tests, git operations, short one-off scripts, checking system state (`ps`, `df`, `env`, `uname`), and operations that genuinely have no dedicated tool.

### Do NOT use `bash` to substitute for dedicated tools

These are hard rules, not preferences. If you catch yourself reaching for one of these patterns, stop and use the right tool.

| ❌ Do not do this in bash | ✅ Use this instead |
|---|---|
| `echo "..." > file.txt`, `cat > file <<EOF`, `printf ... > file`, `tee file` | **`write_file`** |
| `sed -i ...`, `awk -i inplace ...`, `perl -i -pe ...`, any in-place stream edit | **`edit_file`** |
| `cat file.txt`, `head`, `tail`, `less`, `more`, `bat` | **`read_file`** |
| `grep -r`, `rg`, `ag`, `ack` | the dedicated **`grep`** tool |
| `find . -name ...`, `ls -R`, `tree` | **`glob`** or **`list_dir`** |

**Why these restrictions exist:**
- The dedicated tools apply access controls and safety checks that the bash path bypasses.
- They return structured output the system can track, show in the UI, and include in file-change summaries. Bash redirection is invisible to these systems — the user's interface cannot display a file change that was made through `echo >`.
- They respect mtime validation and atomic-write guarantees that `edit_file` / `write_file` provide. A `sed -i` loses all of this.

There are **no exceptions**. Even for "just a one-liner" or "it's faster this way" — use the right tool.

### Allowed bash patterns for filesystem work

Some filesystem operations have no dedicated tool; these are fine via bash:
- `mkdir -p path/to/dir` — creating directories.
- `rm`, `rmdir`, `mv`, `cp` — deleting, moving, copying files (there are no dedicated tools for these; bash is the right path).
- `chmod`, `chown`, `ln` — permissions and links.
- `git` operations on files (`git add`, `git mv`, `git rm`, etc.).

**Before creating a file or directory via bash**, verify the parent directory exists first (via `list_dir` or a separate `mkdir -p`).

### Other notes

- **Timeouts:** Default 60s, max 600s. Long-running commands should specify a timeout explicitly.
- **Output limit:** ~200KB per stream. When a stream exceeds the cap the head and tail are kept and the middle is dropped; the **full untruncated output is also written to a temp file** and the path is included in the result, so you can `read_file` or `grep` the complete log if needed.
- **Working directory:** Use the `cwd` parameter for one-off directory changes rather than `cd path && command`.

## `bash_background`

`bash_background(command, cwd?, id?)`

Start a tracked background shell command. Use this for long-running processes like dev servers and watchers.

- Returns a shell ID and a stable log file path.
- Use `bash_output` to inspect logs later.
- Use `await_event(seconds=60)` if you want to await the process exit event.

## `bash_output`

`bash_output(id, tail_lines?, max_chars?)`

Read output from a tracked background shell.

- Without `tail_lines`, returns unread output since the last `bash_output` call for that shell.
- With `tail_lines`, returns the recent tail without advancing the unread cursor.
- `max_chars` defaults to 30000 (cap 80000). If output is truncated, prefer searching the full log file first.

## `kill_shell`

`kill_shell(ids, signal?)`

Terminate one or more tracked background shells. Default signal is `TERM`. The signal goes to the **entire process group** so tools that fork (`npm run dev`, `vite`, `cargo watch`) are killed in full.

After kill, the entry stays for log inspection via `bash_output`, but the process is gone — no HMR, no auto-restart. You can reuse the same `id` in a new `bash_background` once the prior shell has stopped.

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
