// src/sidebar/i18n.ts — flat bilingual string table. No i18n library; the UI
// only ever shows one of two languages, chosen in settings.
import type { Lang } from "../lib/prompts";

export type Dict = Record<string, string>;

const en: Dict = {
  appName: "AppSheet Assistant",
  settings: "Settings",
  theme: "Theme",
  language: "Language",

  tab_build: "Build",
  tab_formula: "Formula",
  tab_explain: "Explain",
  tab_fix: "Fix",
  tab_ask: "Ask AI",
  tab_types: "Types",
  tab_contact: "About",

  generate: "Generate",
  generating: "Thinking…",
  copy: "Copy",
  copied: "Copied",
  result: "Result",
  needKey: "Add your API key in Settings first.",
  clear: "Clear",

  ctx: "Context (optional)",
  ctx_live: "Live from the editor",
  ctx_table: "Table",
  ctx_column: "Column",
  ctx_usedAs: "Used as",
  ctx_pick: "—",
  ctx_other: "Other",
  types_fill: "Fill from table",

  build_ph: "Describe a column, view or action to build…",
  build_hint: "AI proposes AppSheet config. Review before applying — nothing is saved automatically.",
  build_check: "Check schema",
  build_checking: "Checking…",
  build_askClaude: "Ask Claude",
  build_askingClaude: "Asking Claude…",
  build_claudeHint: "Uses your logged-in claude.ai session (no API key).",
  build_noIssues: "No issues found",
  build_apply: "Build now",
  build_applied: "Done",
  build_applying: "Building…",
  build_applyHint: "Drives the editor to apply each change. Nothing is saved until you click Save in the editor.",
  build_saveReminder: "Review the changes, then click Save in the AppSheet editor to keep them.",
  build_parseErr: "Couldn't read the AI's JSON. Try Generate again.",
  build_planTitle: "Changes",
  build_noChanges: "The AI returned no applicable changes.",
  build_json: "Changeset JSON (editable)",
  build_json_hint: "The AI fills this on Generate. Edit freely — the plan below revalidates as you type.",
  build_json_ph: `{
  "changes": [
    { "op": "set_column", "table": "TABLE", "column": "col", "type": "Number",
      "properties": { "Maximum value": "100" } },
    { "op": "add_action", "table": "TABLE", "name": "MarkDone",
      "actionType": "SET_COLUMN_VALUE",
      "assignments": [{ "column": "status", "value": "\\"done\\"" }] }
  ]
}`,
  build_editorNotReady: "Open the AppSheet editor tab first — it isn't ready.",
  build_chip1: "Sum a money column",
  build_chip2: "Group a view by date",
  build_chip3: "Confirm before delete",
  build_chip4: "Fix a broken expression",

  formula_desc: "What should the expression do?",
  formula_desc_ph: "e.g. total of paid orders for the current customer",
  formula_current: "Existing expression (to improve)",
  formula_current_ph: "Leave empty to start fresh",
  formula_btn: "Generate expression",

  explain_expr: "Expression to explain",
  explain_ph: 'e.g. SUM(SELECT(Orders[Total], [Status]="Paid"))',
  explain_btn: "Explain",

  fix_expr: "Broken expression",
  fix_err: "Error message (if any)",
  fix_err_ph: "e.g. Cannot compare Number to Text",
  fix_intended: "What it should do",
  fix_intended_ph: "Short description of the intended behavior",
  fix_btn: "Fix expression",

  ask_ph: "Ask anything about AppSheet…",
  ask_send: "Send",
  ask_empty: "Ask about syntax, slices, security filters, automation…",

  types_table: "Table name (optional)",
  types_cols: "Column names (one per line)",
  types_cols_ph: "id : Text\ncustomer_id : Ref\namount : Price",
  types_btn: "Suggest types",
  types_apply: "Apply to editor",
  types_applying: "Applying…",
  types_applyHint: "Reads each 'column : Type' line and sets the type in the editor's column grid. Save in the editor to keep.",

  set_provider: "Provider",
  set_apiKey: "API key",
  set_baseUrl: "Base URL (optional — e.g. local Ollama)",
  set_dark: "Dark mode",
  set_instructions: "Build App conventions",
  set_instructions_ph: "e.g. Hidden helper actions use a '_' name prefix and position Hide. Always add a confirmation to DELETE_RECORD actions. Prefer EnumList base-type Ref for multi-select links.",
  set_instructions_hint: "The AI reads this before every Build App generation.",
  set_skills: "Skills",
  set_skills_hint: "Upload .skill/.md files or a .zip package (SKILL.md + references). The AI reads each skill's description and applies the ones matching your request.",
  set_skills_nodesc: "(no description)",
  set_skills_remove: "Remove skill",

  about_lead: "An open-source assistant for the AppSheet editor.",
  about_credit: "Reverse-engineered as a Firefox/Chrome port of “Assistant for AppSheet” by Hoadata.",
  about_original: "Original extension",
  about_license: "MIT licensed · community maintained",

  footer: "Independent project · not affiliated with Google/AppSheet",
};

const vi: Dict = {
  appName: "Trợ lý AppSheet",
  settings: "Cài đặt",
  theme: "Giao diện",
  language: "Ngôn ngữ",

  tab_build: "Dựng App",
  tab_formula: "Công thức",
  tab_explain: "Giải thích",
  tab_fix: "Sửa lỗi",
  tab_ask: "Hỏi AI",
  tab_types: "Đặt Type",
  tab_contact: "Giới thiệu",

  generate: "Tạo",
  generating: "Đang xử lý…",
  copy: "Sao chép",
  copied: "Đã chép",
  result: "Kết quả",
  needKey: "Nhập API key trong Cài đặt trước đã.",
  clear: "Xoá",

  ctx: "Ngữ cảnh (tuỳ chọn)",
  ctx_live: "Đọc trực tiếp từ editor",
  ctx_table: "Bảng",
  ctx_column: "Cột",
  ctx_usedAs: "Dùng làm",
  ctx_pick: "—",
  ctx_other: "Khác",
  types_fill: "Lấy từ bảng",

  build_ph: "Mô tả cột, view hoặc action cần tạo…",
  build_hint: "AI đề xuất cấu hình AppSheet. Kiểm tra trước khi áp dụng — không có gì được lưu tự động.",
  build_check: "Kiểm tra schema",
  build_checking: "Đang kiểm tra…",
  build_askClaude: "Hỏi Claude",
  build_askingClaude: "Đang hỏi Claude…",
  build_claudeHint: "Dùng phiên claude.ai đang đăng nhập (không tốn API key).",
  build_noIssues: "Không phát hiện vấn đề",
  build_apply: "Dựng ngay",
  build_applied: "Xong",
  build_applying: "Đang dựng…",
  build_applyHint: "Điều khiển editor áp dụng từng thay đổi. Chưa có gì được lưu cho đến khi bạn bấm Save trong editor.",
  build_saveReminder: "Kiểm tra các thay đổi rồi bấm Save trong AppSheet editor để lưu lại.",
  build_parseErr: "Không đọc được JSON từ AI. Thử bấm Tạo lại.",
  build_planTitle: "Các thay đổi",
  build_noChanges: "AI không trả về thay đổi nào áp dụng được.",
  build_json: "JSON changeset (sửa được)",
  build_json_hint: "AI điền khi bấm Tạo. Bạn sửa thoải mái — phần kế hoạch bên dưới tự kiểm lại khi gõ.",
  build_json_ph: `{
  "changes": [
    { "op": "set_column", "table": "TABLE", "column": "col", "type": "Number",
      "properties": { "Maximum value": "100" } },
    { "op": "add_action", "table": "TABLE", "name": "MarkDone",
      "actionType": "SET_COLUMN_VALUE",
      "assignments": [{ "column": "status", "value": "\\"done\\"" }] }
  ]
}`,
  build_editorNotReady: "Mở tab AppSheet editor trước — editor chưa sẵn sàng.",
  build_chip1: "Tính tổng cột tiền",
  build_chip2: "Gom view theo ngày",
  build_chip3: "Xác nhận trước khi xoá",
  build_chip4: "Sửa expression bị lỗi",

  formula_desc: "Expression cần làm gì?",
  formula_desc_ph: "vd: tổng các đơn đã thanh toán của khách hàng hiện tại",
  formula_current: "Expression hiện tại (để cải thiện)",
  formula_current_ph: "Để trống nếu tạo từ đầu",
  formula_btn: "Sinh expression",

  explain_expr: "Expression cần giải thích",
  explain_ph: 'vd: SUM(SELECT(Orders[Total], [Status]="Paid"))',
  explain_btn: "Giải thích",

  fix_expr: "Expression bị lỗi",
  fix_err: "Thông báo lỗi (nếu có)",
  fix_err_ph: "vd: Cannot compare Number to Text",
  fix_intended: "Lẽ ra phải làm gì",
  fix_intended_ph: "Mô tả ngắn hành vi mong muốn",
  fix_btn: "Sửa expression",

  ask_ph: "Hỏi bất cứ điều gì về AppSheet…",
  ask_send: "Gửi",
  ask_empty: "Hỏi về cú pháp, slice, security filter, automation…",

  types_table: "Tên bảng (tuỳ chọn)",
  types_cols: "Tên các cột (mỗi dòng một cột)",
  types_cols_ph: "id : Text\nkhach_hang_id : Ref\nso_tien : Price",
  types_btn: "Đề xuất Type",
  types_apply: "Áp dụng vào editor",
  types_applying: "Đang áp dụng…",
  types_applyHint: "Đọc từng dòng 'cột : Type' và đặt type trong lưới cột của editor. Bấm Save trong editor để lưu.",

  set_provider: "Nhà cung cấp",
  set_apiKey: "API key",
  set_baseUrl: "Base URL (tuỳ chọn — vd: Ollama nội bộ)",
  set_dark: "Chế độ tối",
  set_instructions: "Quy ước dựng app",
  set_instructions_ph: "vd: Action phụ ẩn đặt tên tiền tố '_' và position Hide. Luôn thêm xác nhận cho action DELETE_RECORD. Ưu tiên EnumList base-type Ref cho liên kết nhiều giá trị.",
  set_instructions_hint: "AI đọc phần này trước mỗi lần dựng app.",
  set_skills: "Skills",
  set_skills_hint: "Tải lên file .skill/.md hoặc gói .zip (SKILL.md + references). AI đọc description của từng skill và áp dụng cái khớp yêu cầu.",
  set_skills_nodesc: "(không có mô tả)",
  set_skills_remove: "Xoá skill",

  about_lead: "Trợ lý mã nguồn mở cho trình chỉnh sửa AppSheet.",
  about_credit: "Được dịch ngược thành bản port Firefox/Chrome của “Assistant for AppSheet” bởi Hoadata.",
  about_original: "Tiện ích gốc",
  about_license: "Giấy phép MIT · cộng đồng duy trì",

  footer: "Dự án độc lập · không liên kết với Google/AppSheet",
};

const TABLES: Record<Lang, Dict> = { en, vi };

export function dict(lang: Lang): Dict {
  return TABLES[lang];
}
