// 내장 테마의 원래 값. Ghostty 테마 파일과 Orca 내장 값에서 그대로 옮겼다.
// 출처는 테마마다 적었다. ghostty: 뒤는 Ghostty 가 싣는 iTerm2-Color-Schemes 파일 이름이고, orca 는 Orca 내장 값이다 (NOTICE).
// 밝은 테마의 읽기 보정은 여기가 아니라 catalog.ts 에서 한다.

import type { TerminalTheme } from "./types";

export const RAW_THEMES: readonly TerminalTheme[] = [
  // orca (Orca 가 Ghostty 값을 손본 기본 테마)
  {
    id: "ghostty-default-style-dark",
    name: "Ghostty Default Style Dark",
    scheme: "dark",
    foreground: "#ffffff",
    background: "#282c34",
    cursor: "#ffffff",
    cursorText: "#282c34",
    selectionBackground: "#5a7898",
    selectionForeground: "#ffffff",
    palette: [
      "#1d1f21", "#cc6666", "#b5bd68", "#f0c674", "#81a2be", "#b294bb", "#8abeb7", "#c5c8c6",
      "#666666", "#d54e53", "#b9ca4a", "#e7c547", "#7aa6da", "#c397d8", "#70c0b1", "#eaeaea",
    ],
  },
  // orca (Orca 가 Ghostty 값을 손본 기본 테마)
  {
    id: "builtin-tango-light",
    name: "Builtin Tango Light",
    scheme: "light",
    foreground: "#2e3434",
    background: "#ffffff",
    cursor: "#2e3434",
    cursorText: "#ffffff",
    selectionBackground: "#accef7",
    selectionForeground: "#2e3434",
    palette: [
      "#2e3436", "#cc0000", "#4e9a06", "#8e7700", "#3465a4", "#75507b", "#05727e", "#6a6a6a",
      "#555753", "#ef2929", "#1b7a1b", "#6d5a00", "#204a87", "#ad7fa8", "#034b50", "#3d3d3d",
    ],
  },
  // ghostty: Dracula
  {
    id: "dracula",
    name: "Dracula",
    scheme: "dark",
    foreground: "#f8f8f2",
    background: "#282a36",
    cursor: "#f8f8f2",
    cursorText: "#282a36",
    selectionBackground: "#44475a",
    selectionForeground: "#ffffff",
    palette: [
      "#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
      "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff",
    ],
  },
  // ghostty: Atom One Dark
  {
    id: "one-dark",
    name: "One Dark",
    scheme: "dark",
    foreground: "#abb2bf",
    background: "#21252b",
    cursor: "#abb2bf",
    cursorText: "#21252b",
    selectionBackground: "#323844",
    selectionForeground: "#abb2bf",
    palette: [
      "#21252b", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf",
      "#767676", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf",
    ],
  },
  // ghostty: Nord
  {
    id: "nord",
    name: "Nord",
    scheme: "dark",
    foreground: "#d8dee9",
    background: "#2e3440",
    cursor: "#eceff4",
    cursorText: "#282828",
    selectionBackground: "#eceff4",
    selectionForeground: "#4c566a",
    palette: [
      "#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0",
      "#596377", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4",
    ],
  },
  // orca
  {
    id: "monokai",
    name: "Monokai",
    scheme: "dark",
    foreground: "#f8f8f2",
    background: "#272822",
    cursor: "#f8f8f0",
    cursorText: "#272822",
    selectionBackground: "#49483e",
    selectionForeground: "#f8f8f2",
    palette: [
      "#272822", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2",
      "#75715e", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f9f8f5",
    ],
  },
  // ghostty: TokyoNight
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    scheme: "dark",
    foreground: "#c0caf5",
    background: "#1a1b26",
    cursor: "#c0caf5",
    cursorText: "#15161e",
    selectionBackground: "#33467c",
    selectionForeground: "#c0caf5",
    palette: [
      "#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6",
      "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5",
    ],
  },
  // ghostty: Gruvbox Dark
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    scheme: "dark",
    foreground: "#ebdbb2",
    background: "#282828",
    cursor: "#ebdbb2",
    cursorText: "#282828",
    selectionBackground: "#665c54",
    selectionForeground: "#ebdbb2",
    palette: [
      "#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984",
      "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2",
    ],
  },
  // ghostty: Catppuccin Mocha
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    scheme: "dark",
    foreground: "#cdd6f4",
    background: "#1e1e2e",
    cursor: "#f5e0dc",
    cursorText: "#1e1e2e",
    selectionBackground: "#f5e0dc",
    selectionForeground: "#1e1e2e",
    palette: [
      "#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de",
      "#585b70", "#f7aec2", "#c2ecbf", "#fcd682", "#aeccfc", "#f398da", "#b1eae1", "#a6adc8",
    ],
  },
  // ghostty: iTerm2 Solarized Dark
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    scheme: "dark",
    foreground: "#839496",
    background: "#002b36",
    cursor: "#839496",
    cursorText: "#073642",
    selectionBackground: "#073642",
    selectionForeground: "#93a1a1",
    palette: [
      "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
      "#335e69", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
    ],
  },
  // ghostty: GitHub Dark Default
  {
    id: "github-dark",
    name: "GitHub Dark",
    scheme: "dark",
    foreground: "#e6edf3",
    background: "#0d1117",
    cursor: "#2f81f7",
    cursorText: "#6fc1ff",
    selectionBackground: "#e6edf3",
    selectionForeground: "#0d1117",
    palette: [
      "#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4",
      "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff",
    ],
  },
  // ghostty: Material Dark
  {
    id: "material-dark",
    name: "Material Dark",
    scheme: "dark",
    foreground: "#e5e5e5",
    background: "#232322",
    cursor: "#16afca",
    cursorText: "#dfdfdf",
    selectionBackground: "#dfdfdf",
    selectionForeground: "#3d3d3d",
    palette: [
      "#212121", "#b7141f", "#457b24", "#f6981e", "#134eb2", "#701aa2", "#0e717c", "#efefef",
      "#4f4f4f", "#e83b3f", "#7aba3a", "#ffea2e", "#54a4f3", "#aa4dbc", "#26bbd1", "#d9d9d9",
    ],
  },
  // ghostty: Ayu
  {
    id: "ayu-dark",
    name: "Ayu Dark",
    scheme: "dark",
    foreground: "#bfbdb6",
    background: "#0b0e14",
    cursor: "#e6b450",
    cursorText: "#0b0e14",
    selectionBackground: "#409fff",
    selectionForeground: "#0b0e14",
    palette: [
      "#11151c", "#ea6c73", "#7fd962", "#f9af4f", "#53bdfa", "#cda1fa", "#90e1c6", "#c7c7c7",
      "#686868", "#f07178", "#aad94c", "#ffb454", "#59c2ff", "#d2a6ff", "#95e6cb", "#ffffff",
    ],
  },
  // ghostty: Nightfox
  {
    id: "nightfox",
    name: "Nightfox",
    scheme: "dark",
    foreground: "#cdcecf",
    background: "#192330",
    cursor: "#cdcecf",
    cursorText: "#192330",
    selectionBackground: "#2b3b51",
    selectionForeground: "#cdcecf",
    palette: [
      "#393b44", "#c94f6d", "#81b29a", "#dbc074", "#719cd6", "#9d79d6", "#63cdcf", "#dfdfe0",
      "#575860", "#d16983", "#8ebaa4", "#e0c989", "#86abdc", "#baa1e2", "#7ad5d6", "#e4e4e5",
    ],
  },
  // ghostty: Kanagawa Wave
  {
    id: "kanagawa",
    name: "Kanagawa",
    scheme: "dark",
    foreground: "#dcd7ba",
    background: "#1f1f28",
    cursor: "#dcd7ba",
    cursorText: "#1f1f28",
    selectionBackground: "#dcd7ba",
    selectionForeground: "#1f1f28",
    palette: [
      "#090618", "#c34043", "#76946a", "#c0a36e", "#7e9cd8", "#957fb8", "#6a9589", "#c8c093",
      "#727169", "#e82424", "#98bb6c", "#e6c384", "#7fb4ca", "#938aa9", "#7aa89f", "#dcd7ba",
    ],
  },
  // ghostty: Rose Pine
  {
    id: "rose-pine",
    name: "Rose Pine",
    scheme: "dark",
    foreground: "#e0def4",
    background: "#191724",
    cursor: "#e0def4",
    cursorText: "#191724",
    selectionBackground: "#403d52",
    selectionForeground: "#e0def4",
    palette: [
      "#26233a", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4",
      "#6e6a86", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4",
    ],
  },
  // orca
  {
    id: "everforest-dark",
    name: "Everforest Dark",
    scheme: "dark",
    foreground: "#d3c6aa",
    background: "#2d353b",
    cursor: "#d3c6aa",
    cursorText: "#2d353b",
    selectionBackground: "#543a48",
    selectionForeground: "#d3c6aa",
    palette: [
      "#475258", "#e67e80", "#a7c080", "#dbbc7f", "#7fbbb3", "#d699b6", "#83c092", "#d3c6aa",
      "#697379", "#e67e80", "#a7c080", "#dbbc7f", "#7fbbb3", "#d699b6", "#83c092", "#d3c6aa",
    ],
  },
  // orca
  {
    id: "palenight",
    name: "Palenight",
    scheme: "dark",
    foreground: "#a6accd",
    background: "#292d3e",
    cursor: "#ffcc00",
    cursorText: "#292d3e",
    selectionBackground: "#434758",
    selectionForeground: "#a6accd",
    palette: [
      "#292d3e", "#f07178", "#c3e88d", "#ffcb6b", "#82aaff", "#c792ea", "#89ddff", "#a6accd",
      "#676e95", "#f07178", "#c3e88d", "#ffcb6b", "#82aaff", "#c792ea", "#89ddff", "#ffffff",
    ],
  },
  // ghostty: Horizon
  {
    id: "horizon-dark",
    name: "Horizon Dark",
    scheme: "dark",
    foreground: "#d5d8da",
    background: "#1c1e26",
    cursor: "#6c6f93",
    cursorText: "#9fa2c6",
    selectionBackground: "#6c6f93",
    selectionForeground: "#1c1e26",
    palette: [
      "#000000", "#e95678", "#29d398", "#fab795", "#26bbd9", "#ee64ac", "#59e1e3", "#e5e5e5",
      "#666666", "#ec6a88", "#3fdaa4", "#fbc3a7", "#3fc4de", "#f075b5", "#6be4e6", "#e5e5e5",
    ],
  },
  // ghostty: Night Owl
  {
    id: "night-owl",
    name: "Night Owl",
    scheme: "dark",
    foreground: "#d6deeb",
    background: "#011627",
    cursor: "#7e57c2",
    cursorText: "#ffffff",
    selectionBackground: "#5f7e97",
    selectionForeground: "#dfe5ee",
    palette: [
      "#011627", "#ef5350", "#22da6e", "#addb67", "#82aaff", "#c792ea", "#21c7a8", "#ffffff",
      "#575656", "#ef5350", "#22da6e", "#ffeb95", "#82aaff", "#c792ea", "#7fdbca", "#ffffff",
    ],
  },
  // ghostty: iTerm2 Solarized Light
  {
    id: "solarized-light",
    name: "Solarized Light",
    scheme: "light",
    foreground: "#657b83",
    background: "#fdf6e3",
    cursor: "#657b83",
    cursorText: "#eee8d5",
    selectionBackground: "#eee8d5",
    selectionForeground: "#586e75",
    palette: [
      "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#bbb5a2",
      "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
    ],
  },
  // orca
  {
    id: "one-light",
    name: "One Light",
    scheme: "light",
    foreground: "#383a42",
    background: "#fafafa",
    cursor: "#526fff",
    cursorText: "#fafafa",
    selectionBackground: "#e5e5e6",
    selectionForeground: "#383a42",
    palette: [
      "#383a42", "#e45649", "#50a14f", "#c18401", "#4078f2", "#a626a4", "#0184bc", "#a0a1a7",
      "#696c77", "#e45649", "#50a14f", "#c18401", "#4078f2", "#a626a4", "#0184bc", "#fafafa",
    ],
  },
  // ghostty: Catppuccin Latte
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    scheme: "light",
    foreground: "#4c4f69",
    background: "#eff1f5",
    cursor: "#dc8a78",
    cursorText: "#eff1f5",
    selectionBackground: "#dc8a78",
    selectionForeground: "#eff1f5",
    palette: [
      "#bcc0cc", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#5c5f77",
      "#acb0be", "#e7103f", "#46b02f", "#e49931", "#3878f6", "#ef95d7", "#19a1a8", "#6c6f85",
    ],
  },
  // orca
  {
    id: "github-light",
    name: "GitHub Light",
    scheme: "light",
    foreground: "#24292e",
    background: "#ffffff",
    cursor: "#044289",
    cursorText: "#ffffff",
    selectionBackground: "#c8c8fa",
    selectionForeground: "#24292e",
    palette: [
      "#24292e", "#d73a49", "#28a745", "#dbab09", "#0366d6", "#5a32a3", "#0598bc", "#6a737d",
      "#959da5", "#cb2431", "#22863a", "#b08800", "#005cc5", "#5a32a3", "#3192aa", "#d1d5da",
    ],
  },
  // ghostty: Rose Pine Dawn
  {
    id: "rose-pine-dawn",
    name: "Rose Pine Dawn",
    scheme: "light",
    foreground: "#575279",
    background: "#faf4ed",
    cursor: "#575279",
    cursorText: "#faf4ed",
    selectionBackground: "#dfdad9",
    selectionForeground: "#575279",
    palette: [
      "#f2e9e1", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#575279",
      "#9893a5", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#575279",
    ],
  },
  // ghostty: Gruvbox Light
  {
    id: "gruvbox-light",
    name: "Gruvbox Light",
    scheme: "light",
    foreground: "#3c3836",
    background: "#fbf1c7",
    cursor: "#3c3836",
    cursorText: "#fbf1c7",
    selectionBackground: "#3c3836",
    selectionForeground: "#fbf1c7",
    palette: [
      "#fbf1c7", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#7c6f64",
      "#928374", "#9d0006", "#79740e", "#b57614", "#076678", "#8f3f71", "#427b58", "#3c3836",
    ],
  },
  // orca
  {
    id: "tokyo-night-light",
    name: "Tokyo Night Light",
    scheme: "light",
    foreground: "#343b58",
    background: "#d5d6db",
    cursor: "#343b58",
    cursorText: "#d5d6db",
    selectionBackground: "#9699a3",
    selectionForeground: "#343b58",
    palette: [
      "#0f0f14", "#8c4351", "#485e30", "#8f5e15", "#34548a", "#5a4a78", "#0f4b6e", "#343b58",
      "#9699a3", "#8c4351", "#485e30", "#8f5e15", "#34548a", "#5a4a78", "#0f4b6e", "#343b58",
    ],
  },
  // orca
  {
    id: "everforest-light",
    name: "Everforest Light",
    scheme: "light",
    foreground: "#5c6a72",
    background: "#fdf6e3",
    cursor: "#5c6a72",
    cursorText: "#fdf6e3",
    selectionBackground: "#e6e2cc",
    selectionForeground: "#5c6a72",
    palette: [
      "#5c6a72", "#f85552", "#8da101", "#dfa000", "#3a94c5", "#df69ba", "#35a77c", "#dfd9a8",
      "#939f91", "#f85552", "#8da101", "#dfa000", "#3a94c5", "#df69ba", "#35a77c", "#fdf6e3",
    ],
  },
  // ghostty: Builtin Tango Dark
  {
    id: "tango-dark",
    name: "Tango Dark",
    scheme: "dark",
    foreground: "#ffffff",
    background: "#000000",
    cursor: "#ffffff",
    cursorText: "#000000",
    selectionBackground: "#b5d5ff",
    selectionForeground: "#000000",
    palette: [
      "#000000", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
      "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
    ],
  },
  // ghostty: Homebrew
  {
    id: "homebrew",
    name: "Homebrew",
    scheme: "dark",
    foreground: "#00ff00",
    background: "#000000",
    cursor: "#23ff18",
    cursorText: "#ff0018",
    selectionBackground: "#083905",
    selectionForeground: "#ffffff",
    palette: [
      "#000000", "#990000", "#00a600", "#999900", "#0d0dbf", "#b200b2", "#00a6b2", "#bfbfbf",
      "#666666", "#e50000", "#00d900", "#e5e500", "#0000ff", "#e500e5", "#00e5e5", "#e5e5e5",
    ],
  },
  // ghostty: Snazzy
  {
    id: "snazzy",
    name: "Snazzy",
    scheme: "dark",
    foreground: "#ebece6",
    background: "#1e1f29",
    cursor: "#e4e4e4",
    cursorText: "#a9a9a9",
    selectionBackground: "#81aec6",
    selectionForeground: "#000000",
    palette: [
      "#000000", "#fc4346", "#50fb7c", "#f0fb8c", "#49baff", "#fc4cb4", "#8be9fe", "#ededec",
      "#555555", "#fc4346", "#50fb7c", "#f0fb8c", "#49baff", "#fc4cb4", "#8be9fe", "#ededec",
    ],
  },
];
