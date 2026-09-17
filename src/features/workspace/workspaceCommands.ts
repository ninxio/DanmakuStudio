export type WorkspacePage = "materials" | "matching" | "editing" | "export";

export type WorkspaceCommandIntent =
  | { type: "navigate"; page: WorkspacePage }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "toggle-project-sidebar" }
  | { type: "toggle-context-panel" };

export interface WorkspaceCommand {
  id: string;
  label: string;
  description: string;
  group: "工作流" | "编辑" | "工作区";
  keywords: readonly string[];
  shortcut?: string;
  enabled: boolean;
  disabledReason?: string;
  intent: WorkspaceCommandIntent;
}

export type WorkspaceShortcutId =
  | "command-palette"
  | "toggle-playback"
  | "undo"
  | "redo"
  | "select-all-clips"
  | "split-clips"
  | "merge-clips"
  | "delete-selection"
  | "nudge-left"
  | "nudge-right"
  | "timeline-start"
  | "timeline-end"
  | "clear-selection"
  | "add-marker"
  | "select-tool"
  | "blade-tool"
  | "fit-timeline"
  | "zoom-in"
  | "zoom-out";

interface ShortcutBinding {
  keys: readonly string[];
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  allowShift?: boolean;
  allowAlt?: boolean;
}

export interface WorkspaceShortcut {
  id: WorkspaceShortcutId;
  label: string;
  description: string;
  displayKeys: string;
  group: "全局" | "编辑" | "时间线";
  binding: ShortcutBinding;
}

export interface ShortcutInput {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface WorkspaceCommandContext {
  currentPage: WorkspacePage;
  canUndo: boolean;
  canRedo: boolean;
  projectSidebarCollapsed: boolean;
  contextPanelCollapsed: boolean;
}

const pageNames: Record<WorkspacePage, string> = {
  materials: "素材",
  matching: "匹配",
  editing: "编辑",
  export: "导出"
};

const navigationCommands: ReadonlyArray<{
  id: string;
  page: WorkspacePage;
  description: string;
  keywords: readonly string[];
}> = [
  {
    id: "go-materials",
    page: "materials",
    description: "导入 XML、B 站参考素材和原片，处理素材异常",
    keywords: ["素材", "导入", "xml", "b站", "参考素材", "原片", "音轨"]
  },
  {
    id: "go-matching",
    page: "matching",
    description: "查看当前批次的匹配阻断、运行队列和结果",
    keywords: ["匹配", "当前批次", "队列", "运行", "关系"]
  },
  {
    id: "go-editing",
    page: "editing",
    description: "复核异常关系并精调正式 TimeMap",
    keywords: ["编辑", "复核", "异常", "timemap", "时间映射", "校准"]
  },
  {
    id: "go-export",
    page: "export",
    description: "检查交付就绪状态并批量导出修正弹幕",
    keywords: ["导出", "交付", "xml", "目录", "阻断"]
  }
];

export const WORKSPACE_SHORTCUTS: readonly WorkspaceShortcut[] = [
  {
    id: "command-palette",
    label: "打开命令入口",
    description: "搜索页面、动作和快捷键帮助",
    displayKeys: "Ctrl+K",
    group: "全局",
    binding: { keys: ["k"], mod: true }
  },
  {
    id: "toggle-playback",
    label: "播放或暂停",
    description: "切换当前预览的播放状态",
    displayKeys: "Space",
    group: "编辑",
    binding: { keys: [" "], allowShift: true }
  },
  {
    id: "undo",
    label: "撤销",
    description: "撤销上一次项目编辑",
    displayKeys: "Ctrl+Z",
    group: "编辑",
    binding: { keys: ["z"], mod: true }
  },
  {
    id: "redo",
    label: "重做",
    description: "恢复最近撤销的项目编辑",
    displayKeys: "Ctrl+Shift+Z",
    group: "编辑",
    binding: { keys: ["z"], mod: true, shift: true }
  },
  {
    id: "select-all-clips",
    label: "选择全部片段",
    description: "选择时间线中的全部内容片段",
    displayKeys: "Ctrl+A",
    group: "时间线",
    binding: { keys: ["a"], mod: true }
  },
  {
    id: "split-clips",
    label: "在播放头处分割",
    description: "分割播放头所在的已选片段",
    displayKeys: "Ctrl+Shift+K",
    group: "时间线",
    binding: { keys: ["k"], mod: true, shift: true }
  },
  {
    id: "merge-clips",
    label: "合并相邻片段",
    description: "合并连续且兼容的已选片段",
    displayKeys: "Ctrl+J",
    group: "时间线",
    binding: { keys: ["j"], mod: true }
  },
  {
    id: "delete-selection",
    label: "删除所选内容",
    description: "删除选中的片段或锚点",
    displayKeys: "Delete",
    group: "时间线",
    binding: { keys: ["delete", "backspace"] }
  },
  {
    id: "nudge-left",
    label: "向前微调",
    description: "移动播放头或所选内容；Shift 为 100 ms，Alt 为 1 s",
    displayKeys: "←",
    group: "时间线",
    binding: { keys: ["arrowleft"], allowShift: true, allowAlt: true }
  },
  {
    id: "nudge-right",
    label: "向后微调",
    description: "移动播放头或所选内容；Shift 为 100 ms，Alt 为 1 s",
    displayKeys: "→",
    group: "时间线",
    binding: { keys: ["arrowright"], allowShift: true, allowAlt: true }
  },
  {
    id: "timeline-start",
    label: "跳到时间线起点",
    description: "将播放头移动到时间线开头",
    displayKeys: "Home",
    group: "时间线",
    binding: { keys: ["home"] }
  },
  {
    id: "timeline-end",
    label: "跳到时间线终点",
    description: "将播放头移动到时间线结尾",
    displayKeys: "End",
    group: "时间线",
    binding: { keys: ["end"] }
  },
  {
    id: "clear-selection",
    label: "清除选择",
    description: "退出工具操作并清除当前选择",
    displayKeys: "Esc",
    group: "编辑",
    binding: { keys: ["escape"] }
  },
  {
    id: "add-marker",
    label: "添加剪切标记",
    description: "在播放头位置添加剪切标记",
    displayKeys: "M",
    group: "时间线",
    binding: { keys: ["m"] }
  },
  {
    id: "select-tool",
    label: "选择工具",
    description: "切换到选择工具",
    displayKeys: "V",
    group: "编辑",
    binding: { keys: ["v"] }
  },
  {
    id: "blade-tool",
    label: "刀片工具",
    description: "切换到刀片工具",
    displayKeys: "B / C",
    group: "编辑",
    binding: { keys: ["b", "c"] }
  },
  {
    id: "fit-timeline",
    label: "适配时间线",
    description: "让全部时间线内容适配可见宽度",
    displayKeys: "F",
    group: "时间线",
    binding: { keys: ["f"] }
  },
  {
    id: "zoom-in",
    label: "放大时间线",
    description: "提高时间线缩放精度",
    displayKeys: "+",
    group: "时间线",
    binding: { keys: ["+", "="], allowShift: true }
  },
  {
    id: "zoom-out",
    label: "缩小时间线",
    description: "降低时间线缩放精度",
    displayKeys: "−",
    group: "时间线",
    binding: { keys: ["-", "_"], allowShift: true }
  }
];

export function createWorkspaceCommands(context: WorkspaceCommandContext): WorkspaceCommand[] {
  const routeCommands = navigationCommands.map<WorkspaceCommand>((command) => ({
    id: command.id,
    label: `前往${pageNames[command.page]}页`,
    description: command.description,
    group: "工作流",
    keywords: command.keywords,
    enabled: command.page !== context.currentPage,
    disabledReason:
      command.page === context.currentPage ? `当前已在${pageNames[command.page]}页` : undefined,
    intent: { type: "navigate", page: command.page }
  }));
  const sidebarsAvailable = context.currentPage !== "editing";

  return [
    ...routeCommands,
    {
      id: "undo",
      label: "撤销",
      description: "撤销上一次项目编辑",
      group: "编辑",
      keywords: ["撤销", "undo", "历史"],
      shortcut: "Ctrl+Z",
      enabled: context.canUndo,
      disabledReason: context.canUndo ? undefined : "当前没有可撤销的操作",
      intent: { type: "undo" }
    },
    {
      id: "redo",
      label: "重做",
      description: "恢复最近撤销的项目编辑",
      group: "编辑",
      keywords: ["重做", "redo", "历史"],
      shortcut: "Ctrl+Shift+Z",
      enabled: context.canRedo,
      disabledReason: context.canRedo ? undefined : "当前没有可重做的操作",
      intent: { type: "redo" }
    },
    {
      id: "toggle-project-sidebar",
      label: context.projectSidebarCollapsed ? "打开项目与分集" : "关闭项目与分集",
      description: "查看分集、最近项目和恢复记录",
      group: "工作区",
      keywords: ["项目", "侧栏", "最近项目", "左侧"],
      enabled: sidebarsAvailable,
      disabledReason: sidebarsAvailable ? undefined : "编辑工作台使用固定同屏布局",
      intent: { type: "toggle-project-sidebar" }
    },
    {
      id: "toggle-context-panel",
      label: context.contextPanelCollapsed ? "展开上下文面板" : "收起上下文面板",
      description: "查看项目状态和待处理问题",
      group: "工作区",
      keywords: ["上下文", "摘要", "右侧", "面板"],
      enabled: sidebarsAvailable,
      disabledReason: sidebarsAvailable ? undefined : "编辑工作台使用固定同屏布局",
      intent: { type: "toggle-context-panel" }
    }
  ];
}

export function searchWorkspaceCommands(
  commands: readonly WorkspaceCommand[],
  query: string
): WorkspaceCommand[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return [...commands];
  }

  return commands.filter((command) =>
    [command.label, command.description, command.group, ...command.keywords]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  );
}

export function resolveWorkspaceShortcut(input: ShortcutInput): WorkspaceShortcutId | null {
  const key = input.code === "Space" ? " " : input.key.toLocaleLowerCase();
  const hasMod = input.ctrlKey || input.metaKey;

  for (const shortcut of WORKSPACE_SHORTCUTS) {
    const binding = shortcut.binding;
    if (!binding.keys.includes(key)) {
      continue;
    }
    if ((binding.mod ?? false) !== hasMod) {
      continue;
    }
    if (!binding.allowShift && (binding.shift ?? false) !== input.shiftKey) {
      continue;
    }
    if (!binding.allowAlt && (binding.alt ?? false) !== input.altKey) {
      continue;
    }
    return shortcut.id;
  }

  return null;
}
