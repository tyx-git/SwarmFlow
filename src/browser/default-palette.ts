/**
 * Built-in theme presets for the browser-based color picker.
 * Each preset provides the key color values from DisplayThemeColorTokens
 * that users can customize in the theme picker UI.
 */

export interface ColorPreset {
  name: string;
  colors: Record<string, string>;
}

/** Key colors exposed in the color picker (subset of DisplayThemeColorTokens). */
export const EDITABLE_COLORS = [
  { key: "text", label: "Text", description: "Primary text color" },
  { key: "dim", label: "Dim", description: "Secondary text color" },
  { key: "muted", label: "Muted", description: "Tertiary/hidden text" },
  { key: "accent", label: "Accent", description: "Primary accent color" },
  { key: "accentDim", label: "Accent Dim", description: "Dimmed accent" },
  { key: "border", label: "Border", description: "Border and divider lines" },
  { key: "userBg", label: "User BG", description: "User message background" },
  { key: "orange", label: "Orange", description: "Semantic orange" },
  { key: "red", label: "Red", description: "Error/deletion color" },
  { key: "yellow", label: "Yellow", description: "Warning/waiting color" },
  { key: "green", label: "Green", description: "Success/addition color" },
  { key: "cyan", label: "Cyan", description: "Info/link color" },
] as const;

export const PRESETS: ColorPreset[] = [
  {
    name: "Dracula",
    colors: {
      text: "#f8f8f2",
      dim: "#6272a4",
      muted: "#5a5e7c",
      accent: "#bd93f9",
      accentDim: "#7c3aed",
      border: "#44475a",
      userBg: "#44475a",
      orange: "#ffb86c",
      red: "#ff5555",
      yellow: "#f1fa8c",
      green: "#50fa7b",
      cyan: "#8be9fd",
    },
  },
  {
    name: "Nord",
    colors: {
      text: "#d8dee9",
      dim: "#616e88",
      muted: "#4c566a",
      accent: "#88c0d0",
      accentDim: "#5e81ac",
      border: "#3b4252",
      userBg: "#3b4252",
      orange: "#d08770",
      red: "#bf616a",
      yellow: "#ebcb8b",
      green: "#a3be8c",
      cyan: "#8fbcbb",
    },
  },
  {
    name: "Catppuccin",
    colors: {
      text: "#cdd6f4",
      dim: "#6c7086",
      muted: "#585b70",
      accent: "#cba6f7",
      accentDim: "#7c3aed",
      border: "#45475a",
      userBg: "#313244",
      orange: "#fab387",
      red: "#f38ba8",
      yellow: "#f9e2af",
      green: "#a6e3a1",
      cyan: "#94e2d5",
    },
  },
  {
    name: "Dark",
    colors: {
      text: "#d0d6e0",
      dim: "#636a76",
      muted: "#454a54",
      accent: "#8ab4f8",
      accentDim: "#5a7eb0",
      border: "#2a2630",
      userBg: "#2a2632",
      orange: "#fb8500",
      red: "#f85656",
      yellow: "#e8c468",
      green: "#8cc252",
      cyan: "#86ded4",
    },
  },
  {
    name: "Light",
    colors: {
      text: "#1f2328",
      dim: "#656d76",
      muted: "#afb8c1",
      accent: "#0969da",
      accentDim: "#5a7eaf",
      border: "#d0d7de",
      userBg: "#eef0f3cc",
      orange: "#bc4c00",
      red: "#cf222e",
      yellow: "#9a6700",
      green: "#1a7f37",
      cyan: "#0e7490",
    },
  },
];

/** Get a preset by name (case-insensitive). */
export function getPreset(name: string): ColorPreset | undefined {
  return PRESETS.find((p) => p.name.toLowerCase() === name.toLowerCase());
}
