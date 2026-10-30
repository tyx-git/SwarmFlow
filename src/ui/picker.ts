/** TUI 选择器共享的展示契约：输入区/页脚布局与命令选择器元数据。 */
export interface InputAreaPickerConfig {
  /** 在输入区位置渲染选择器，而不是页脚浮层。 */
  inputArea?: boolean;
  /** 显示在选择器列表上方的可选标题。 */
  title?: string;
}

/** 斜杠命令选择器各实现共享的注册元数据。 */
export interface CommandPickerPresentation extends InputAreaPickerConfig {
  /** 单层/层级选择器，或只有一项的开关选择器。 */
  mode?: "single" | "toggle";
  /** 在命令选择器上启用可选的备注输入框。 */
  allowNote?: boolean;
}
