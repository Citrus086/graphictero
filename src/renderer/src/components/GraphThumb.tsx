/** 首页图谱卡片缩略图：简易 SVG 占位（与原型 thumb() 同思路，按 seed 取 4 种布局） */
const LAYOUTS: number[][][] = [
  [[110, 22], [60, 62], [160, 62], [110, 102], [210, 102]],
  [[80, 30], [180, 30], [130, 75], [130, 118]],
  [[70, 24], [170, 24], [70, 70], [170, 70], [120, 116], [220, 116]],
  [[90, 40], [190, 40], [140, 100]]
]
const EDGES: number[][][] = [
  [[0, 1], [0, 2], [2, 3], [2, 4]],
  [[0, 2], [1, 2], [2, 3]],
  [[0, 2], [1, 3], [2, 4], [3, 4], [3, 5]],
  [[0, 2], [1, 2]]
]

export function GraphThumb({ seed }: { seed: number }): React.JSX.Element {
  const idx = ((seed % LAYOUTS.length) + LAYOUTS.length) % LAYOUTS.length
  const nodes = LAYOUTS[idx]
  const edges = EDGES[idx]
  const w = 56
  const h = 20
  return (
    <svg width="100%" height="150" viewBox="10 0 280 140" preserveAspectRatio="xMidYMid meet">
      {edges.map(([a, b]) => {
        const A = nodes[a]
        const B = nodes[b]
        const y1 = A[1] + h / 2
        const y2 = B[1] - h / 2
        const my = (y1 + y2) / 2
        return <path key={`${a}-${b}`} d={`M${A[0]} ${y1}C${A[0]} ${my} ${B[0]} ${my} ${B[0]} ${y2}`} stroke="var(--edge)" strokeWidth="1" fill="none" />
      })}
      {nodes.map((p, i) => (
        <g key={i}>
          <rect x={p[0] - w / 2} y={p[1] - h / 2} width={w} height={h} rx="4" fill="var(--node)" stroke="var(--nodeb)" />
          <rect x={p[0] - w / 2 + 7} y={p[1] - 3} width={w - 22} height="3" rx="1.5" fill="var(--edge2)" />
          <rect x={p[0] - w / 2 + 7} y={p[1] + 3} width={w - 34} height="2.5" rx="1.25" fill="var(--line2)" />
        </g>
      ))}
    </svg>
  )
}
