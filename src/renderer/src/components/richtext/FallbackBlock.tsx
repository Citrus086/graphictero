/**
 * M4 lane/render：降级块（D19/D20）——未知 part 类型或 zod 校验失败的 part
 * 渲染成灰色块并标明原因：不崩、不静默丢弃。
 */
export function FallbackBlock({ type, reason }: { type: string; reason?: string }): React.JSX.Element {
  return (
    <div className="gt-part-fallback" data-testid="part-fallback" data-part-type={type}>
      <span className="gt-fallback-tag">不支持的块类型</span>
      <code className="gt-fallback-type">{type}</code>
      {reason ? <span className="gt-fallback-reason">{reason}</span> : null}
    </div>
  )
}
