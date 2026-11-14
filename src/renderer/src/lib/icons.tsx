/** 原型 app.js 里的 16px 线性图标子集，路径原样搬过来。 */
const PATHS: Record<string, string> = {
  back: '<path d="M10 3.5L5.5 8l4.5 4.5"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  search: '<circle cx="7" cy="7" r="4.25"/><path d="M10.2 10.2l3.3 3.3"/>',
  close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  folder: '<path d="M2.5 4.5v7a1 1 0 001 1h9a1 1 0 001-1V6.5a1 1 0 00-1-1H8L6.5 4h-3a1 1 0 00-1 .5z"/>',
  import: '<path d="M8 2.5V10M5 7l3 3 3-3M3 9.5v3.5h10V9.5"/>',
  sliders: '<path d="M2.5 5h7M12.5 5h1M2.5 11h1M6.5 11h7"/><circle cx="11" cy="5" r="1.5"/><circle cx="5" cy="11" r="1.5"/>',
  lib: '<path d="M3 2.5v11M6 2.5v11M9 3l3 10.5"/>',
  tree: '<rect x="5.5" y="2" width="5" height="3.2" rx=".8"/><rect x="2" y="10.8" width="5" height="3.2" rx=".8"/><rect x="9" y="10.8" width="5" height="3.2" rx=".8"/><path d="M8 5.2v2.8M4.5 10.8V8h7v2.8"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  chevD: '<path d="M4.5 6.2L8 9.7l3.5-3.5"/>',
  export: '<path d="M8 10V2.5M5 5.5l3-3 3 3M3 9.5v3.5h10V9.5"/>',
  doc: '<path d="M4.5 2.5h4.5l2.5 2.5v8.5h-7z"/><path d="M9 2.5V5h2.5"/>',
  arrowD: '<path d="M8 3v10M4.5 9.5L8 13l3.5-3.5"/>',
  gear: '<circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2"/>',
  info: '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.3V11M8 5.2v.1"/>',
  warn: '<path d="M8 3.2L14 13H2z"/><path d="M8 7.2V10M8 11.4v.1"/>',
  refresh: '<path d="M13 8A5 5 0 1 1 11.5 4.4M13 2.5v2.6h-2.6"/>',
  zoomIn: '<circle cx="7" cy="7" r="4.5"/><path d="M7 5v4M5 7h4M10.5 10.5L14 14"/>',
  zoomOut: '<circle cx="7" cy="7" r="4.5"/><path d="M5 7h4M10.5 10.5L14 14"/>',
  book: '<path d="M3 3.5h4a1.5 1.5 0 011.5 1.5v8a1.5 1.5 0 00-1.5-1.5H3zM13 3.5H9A1.5 1.5 0 007.5 5v8a1.5 1.5 0 011.5-1.5h4z"/>',
  marker: '<path d="M9.8 2.8l3.4 3.4-6 6H3.8V8.8z"/><path d="M2.5 14h11"/>',
  note: '<path d="M3 2.5h10v7.5l-3.5 3.5H3z"/><path d="M13 10H9.5v3.5"/>',
  chat: '<path d="M3 3.5h10a.5.5 0 01.5.5v6.5a.5.5 0 01-.5.5H7.5L4.5 13.5V11H3a.5.5 0 01-.5-.5V4a.5.5 0 01.5-.5z"/>',
  // uat2b：补 more / rewrite（GraphPage「更多」按钮与「重新生成关系…」在用；原型 app.js 原样路径）
  more: '<circle cx="3.6" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="12.4" cy="8" r=".6"/>',
  rewrite: '<path d="M13 8a5 5 0 01-8.8 3.2M3 8a5 5 0 018.8-3.2"/><path d="M12 2.5v2.5H9.5M4 13.5V11h2.5"/>',
  // uat3：阅读器搜索（chevU 上一个 / copy 复制）
  chevU: '<path d="M4.5 9.8L8 6.3l3.5 3.5"/>',
  copy: '<rect x="5.5" y="5.5" width="7" height="7" rx="1"/><path d="M10.5 5.5V4a1 1 0 00-1-1H4a1 1 0 00-1 1v5.5a1 1 0 001 1h1.5"/>',
  // uat8c：原型 app.js 的 sum / thumbs / grid / clock，外加外观用的对比度（半圆 + 直径，不与其它项重复）
  sum: '<path d="M3 4h10M3 7h10M3 10h6"/>',
  thumbs: '<rect x="2.5" y="2.5" width="4.5" height="5.5" rx=".8"/><rect x="9" y="2.5" width="4.5" height="5.5" rx=".8"/><path d="M2.5 11h4.5M9 11h4.5M2.5 13.5h4.5M9 13.5h4.5"/>',
  grid: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/>',
  contrast: '<circle cx="8" cy="8" r="5.25"/><path d="M8 2.75v10.5"/>'
}

export function Ic({ name, size = 16, w = 1.4 }: { name: string; size?: number; w?: number }): React.JSX.Element {
  return (
    <svg
      className="ic"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={w}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: PATHS[name] ?? '' }}
    />
  )
}
