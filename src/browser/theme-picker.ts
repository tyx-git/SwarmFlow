/**
 * Generates a self-contained HTML page for the browser-based theme customizer.
 * All CSS and JS are inlined — no external dependencies.
 */

import { PRESETS, EDITABLE_COLORS } from "./default-palette.js";

/**
 * Generate the theme picker HTML page content.
 * @param initialPreset - Name of the preset to start with (default: "Dracula")
 */
export function generateThemePickerHtml(initialPreset: string = "Dracula"): string {
  const preset = PRESETS.find((p) => p.name === initialPreset) ?? PRESETS[0];
  const presetOptions = PRESETS.map(
    (p) => `<button class="preset-btn${p.name === preset.name ? " active" : ""}" data-preset="${p.name}">${p.name}</button>`
  ).join("\n        ");

  const colorFields = EDITABLE_COLORS.map(
    (c) => `
        <div class="color-row">
          <label for="color-${c.key}" title="${c.description}">${c.label}</label>
          <input type="color" id="color-${c.key}" data-key="${c.key}" value="${preset.colors[c.key] ?? "#888888"}">
          <span class="color-hex" id="hex-${c.key}">${preset.colors[c.key] ?? "#888888"}</span>
        </div>`
  ).join("\n");

  const cssVars = Object.entries(preset.colors)
    .map(([k, v]) => `  --${k}: ${v};`)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SwarmFlow Theme Customizer</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
${cssVars}
    --bg: #1e1e2e;
    --surface: #282840;
    --surface2: #313148;
  }

  body {
    font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  header h1 {
    font-size: 18px;
    font-weight: 600;
    color: var(--accent);
  }

  header .beta {
    font-size: 11px;
    background: var(--accentDim);
    color: var(--text);
    padding: 2px 8px;
    border-radius: 10px;
    font-weight: 500;
  }

  .presets-bar {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 10px 24px;
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .presets-bar span {
    font-size: 12px;
    color: var(--dim);
    margin-right: 4px;
  }

  .preset-btn {
    background: var(--surface2);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 5px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    transition: all 0.15s;
  }

  .preset-btn:hover {
    border-color: var(--accent);
    background: var(--border);
  }

  .preset-btn.active {
    background: var(--accent);
    color: var(--bg);
    border-color: var(--accent);
    font-weight: 600;
  }

  .main {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  .editor {
    width: 320px;
    min-width: 320px;
    background: var(--surface);
    border-right: 1px solid var(--border);
    padding: 16px;
    overflow-y: auto;
  }

  .editor h2 {
    font-size: 13px;
    color: var(--dim);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 12px;
  }

  .color-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }

  .color-row label {
    width: 90px;
    font-size: 13px;
    color: var(--text);
    flex-shrink: 0;
  }

  .color-row input[type="color"] {
    width: 36px;
    height: 28px;
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
    background: none;
    padding: 1px;
  }

  .color-row input[type="color"]::-webkit-color-swatch-wrapper {
    padding: 2px;
  }

  .color-row input[type="color"]::-webkit-color-swatch {
    border: none;
    border-radius: 2px;
  }

  .color-hex {
    font-size: 11px;
    font-family: "SF Mono", "Cascadia Code", "Fira Code", monospace;
    color: var(--muted);
    min-width: 70px;
  }

  .preview {
    flex: 1;
    padding: 24px;
    overflow-y: auto;
  }

  .preview h2 {
    font-size: 13px;
    color: var(--dim);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 16px;
  }

  /* ── Preview: Chat Bubble ── */
  .preview-chat {
    margin-bottom: 20px;
  }

  .chat-bubble {
    background: var(--userBg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 16px;
    max-width: 480px;
    margin-bottom: 8px;
  }

  .chat-bubble .sender {
    font-size: 12px;
    color: var(--accent);
    font-weight: 600;
    margin-bottom: 4px;
  }

  .chat-bubble .content {
    font-size: 14px;
    color: var(--text);
    line-height: 1.5;
  }

  .chat-bubble .dim-text {
    color: var(--dim);
    font-size: 12px;
  }

  /* ── Preview: Code Block ── */
  .preview-code {
    margin-bottom: 20px;
  }

  .code-block {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
    max-width: 480px;
  }

  .code-header {
    background: var(--surface2);
    padding: 6px 12px;
    font-size: 11px;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
  }

  .code-body {
    padding: 12px 16px;
    font-family: "SF Mono", "Cascadia Code", "Fira Code", monospace;
    font-size: 13px;
    line-height: 1.6;
  }

  .code-body .kw { color: var(--accent); }
  .code-body .fn { color: var(--cyan); }
  .code-body .str { color: var(--green); }
  .code-body .num { color: var(--orange); }
  .code-body .cmt { color: var(--muted); }
  .code-body .typ { color: var(--yellow); }

  /* ── Preview: Diff ── */
  .preview-diff {
    margin-bottom: 20px;
  }

  .diff-block {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
    max-width: 480px;
    font-family: "SF Mono", "Cascadia Code", "Fira Code", monospace;
    font-size: 13px;
  }

  .diff-line-add {
    background: rgba(80, 250, 123, 0.1);
    color: var(--green);
    padding: 2px 12px;
  }

  .diff-line-del {
    background: rgba(255, 85, 85, 0.1);
    color: var(--red);
    padding: 2px 12px;
  }

  .diff-line-ctx {
    color: var(--dim);
    padding: 2px 12px;
  }

  /* ── Preview: Sidebar ── */
  .preview-sidebar {
    margin-bottom: 20px;
  }

  .sidebar-mock {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px;
    max-width: 200px;
  }

  .sidebar-mock .item {
    padding: 6px 8px;
    border-radius: 4px;
    margin-bottom: 4px;
    font-size: 13px;
    color: var(--text);
  }

  .sidebar-mock .item.active {
    background: var(--userBg);
    color: var(--accent);
    font-weight: 600;
  }

  .sidebar-mock .item .muted {
    color: var(--muted);
    font-size: 11px;
  }

  /* ── Preview: Semantic Colors ── */
  .preview-semantic {
    margin-bottom: 20px;
  }

  .semantic-row {
    display: flex;
    gap: 12px;
    margin-bottom: 8px;
    align-items: center;
  }

  .semantic-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .semantic-label {
    font-size: 13px;
    color: var(--text);
  }

  /* ── Footer / Save ── */
  footer {
    background: var(--surface);
    border-top: 1px solid var(--border);
    padding: 12px 24px;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  footer input[type="text"] {
    background: var(--surface2);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 13px;
    width: 200px;
  }

  footer input[type="text"]::placeholder {
    color: var(--muted);
  }

  footer input[type="text"]:focus {
    outline: none;
    border-color: var(--accent);
  }

  .save-btn {
    background: var(--accent);
    color: var(--bg);
    border: none;
    padding: 6px 20px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.15s;
  }

  .save-btn:hover {
    opacity: 0.85;
  }

  .save-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .save-status {
    font-size: 12px;
    color: var(--green);
    margin-left: 8px;
    opacity: 0;
    transition: opacity 0.3s;
  }

  .save-status.show {
    opacity: 1;
  }
</style>
</head>
<body>

<header>
  <h1>SwarmFlow Theme Customizer</h1>
  <span class="beta">beta</span>
</header>

<div class="presets-bar">
  <span>Preset:</span>
  ${presetOptions}
</div>

<div class="main">
  <div class="editor">
    <h2>Colors</h2>
    ${colorFields}
  </div>
  <div class="preview">
    <h2>Live Preview</h2>

    <div class="preview-chat">
      <div class="chat-bubble">
        <div class="sender">Assistant</div>
        <div class="content">Hello! I can help you with your project. What would you like to work on?</div>
      </div>
      <div class="chat-bubble">
        <div class="sender">User</div>
        <div class="content">Show me how the code block looks with this theme.</div>
      </div>
    </div>

    <div class="preview-code">
      <div class="code-block">
        <div class="code-header">main.ts</div>
        <div class="code-body">
          <span class="kw">import</span> { <span class="fn">createTheme</span> } <span class="kw">from</span> <span class="str">"./theme"</span>;<br>
          <span class="cmt">// Initialize the theme</span><br>
          <span class="kw">const</span> <span class="fn">theme</span> = <span class="fn">createTheme</span>({<br>
          &nbsp;&nbsp;accent: <span class="str">"#bd93f9"</span>,<br>
          &nbsp;&nbsp;radius: <span class="num">8</span>,<br>
          });
        </div>
      </div>
    </div>

    <div class="preview-diff">
      <div class="diff-block">
        <div class="diff-line-ctx">  padding: 12px;</div>
        <div class="diff-line-del">- background: #ffffff;</div>
        <div class="diff-line-add">+ background: var(--surface);</div>
        <div class="diff-line-ctx">  border-radius: 6px;</div>
      </div>
    </div>

    <div class="preview-sidebar">
      <div class="sidebar-mock">
        <div class="item active">Sessions <span class="muted">3</span></div>
        <div class="item">Settings</div>
        <div class="item">Models</div>
      </div>
    </div>

    <div class="preview-semantic">
      <div class="semantic-row">
        <div class="semantic-dot" style="background: var(--green)"></div>
        <span class="semantic-label">Success / Addition</span>
      </div>
      <div class="semantic-row">
        <div class="semantic-dot" style="background: var(--red)"></div>
        <span class="semantic-label">Error / Deletion</span>
      </div>
      <div class="semantic-row">
        <div class="semantic-dot" style="background: var(--yellow)"></div>
        <span class="semantic-label">Warning / Waiting</span>
      </div>
      <div class="semantic-row">
        <div class="semantic-dot" style="background: var(--cyan)"></div>
        <span class="semantic-label">Info / Link</span>
      </div>
      <div class="semantic-row">
        <div class="semantic-dot" style="background: var(--orange)"></div>
        <span class="semantic-label">Orange / Number</span>
      </div>
    </div>
  </div>
</div>

<footer>
  <input type="text" id="theme-name" placeholder="Enter theme name...">
  <button class="save-btn" id="save-btn" disabled>Save Theme</button>
  <span class="save-status" id="save-status">Saved!</span>
</footer>

<script>
  const PRESETS = ${JSON.stringify(PRESETS.map((p) => ({ name: p.name, colors: p.colors })))};
  const ROOT = document.documentElement;
  const nameInput = document.getElementById("theme-name");
  const saveBtn = document.getElementById("save-btn");
  const saveStatus = document.getElementById("save-status");

  // Enable save button only when name is non-empty
  nameInput.addEventListener("input", () => {
    saveBtn.disabled = !nameInput.value.trim();
  });

  // Color picker change → update CSS variable + hex display
  document.querySelectorAll('input[type="color"]').forEach((input) => {
    input.addEventListener("input", () => {
      const key = input.dataset.key;
      ROOT.style.setProperty("--" + key, input.value);
      document.getElementById("hex-" + key).textContent = input.value;
    });
  });

  // Preset button click → load preset colors
  document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = PRESETS.find((p) => p.name === btn.dataset.preset);
      if (!preset) return;

      document.querySelectorAll(".preset-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      for (const [key, value] of Object.entries(preset.colors)) {
        ROOT.style.setProperty("--" + key, value);
        const picker = document.querySelector('input[data-key="' + key + '"]');
        if (picker) {
          picker.value = value;
          document.getElementById("hex-" + key).textContent = value;
        }
      }
    });
  });

  // Save theme → POST to server
  saveBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) return;

    const colors = {};
    document.querySelectorAll('input[type="color"]').forEach((input) => {
      colors[input.dataset.key] = input.value;
    });

    try {
      const res = await fetch("/save-theme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, colors }),
      });
      const data = await res.json();
      if (data.ok) {
        saveStatus.textContent = "Saved!";
        saveStatus.classList.add("show");
        setTimeout(() => saveStatus.classList.remove("show"), 2000);
      } else {
        saveStatus.textContent = "Error: " + (data.error || "unknown");
        saveStatus.style.color = "var(--red)";
        saveStatus.classList.add("show");
        setTimeout(() => {
          saveStatus.classList.remove("show");
          saveStatus.style.color = "";
        }, 3000);
      }
    } catch (e) {
      saveStatus.textContent = "Network error";
      saveStatus.style.color = "var(--red)";
      saveStatus.classList.add("show");
      setTimeout(() => {
        saveStatus.classList.remove("show");
        saveStatus.style.color = "";
      }, 3000);
    }
  });
</script>

</body>
</html>`;
}
