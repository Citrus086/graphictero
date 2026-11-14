/**
 * D74：入库前用 Intl.Segmenter('zh', { granularity: 'word' }) 分词，
 * 英文按空白/词边界分词后统一小写，分出的词用空格 join 后写入 FTS5。
 * 用户查询串也必须先过这里再 MATCH（M0 实测：整串丢给 FTS5 会被
 * unicode61 当成一个 token 而查不到）。
 */
export function segmentText(text: string, locale = 'zh'): string {
  const segmenter = new Intl.Segmenter(locale, { granularity: 'word' })
  const words: string[] = []
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (!isWordLike) continue
    const w = segment.toLowerCase()
    if (w.trim().length > 0) words.push(w)
  }
  return words.join(' ')
}
