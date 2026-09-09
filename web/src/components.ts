export function createElement<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
export function statusBadge(text: string, tone: "live" | "success" | "warning" | "danger" | "muted" = "muted"): HTMLSpanElement {
  const badge = createElement("span", `status-badge ${tone}`);
  badge.innerHTML = `<i></i>${escapeHtml(text)}`;
  return badge;
}

export function setStatusBadge(target: HTMLElement, text: string, tone: "live" | "success" | "warning" | "danger" | "muted"): void {
  target.className = `status-badge ${tone}`;
  target.innerHTML = `<i></i>${escapeHtml(text)}`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char] ?? char);
}

export function formatDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safeSeconds / 60)).padStart(2, "0")}:${String(safeSeconds % 60).padStart(2, "0")}`;
}

export function formatNumber(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat("zh-CN").format(number) : "—";
}
