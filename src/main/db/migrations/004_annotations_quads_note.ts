import type Database from 'better-sqlite3'
import type { Migration } from './index'

/**
 * 004 阅读器高亮/笔记的渲染与笔记字段（D27，lane/pdf 第三批）。
 *
 * 高亮按行渲染需要行级矩形：quads 存 JSON [[x,y,w,h],...]（页面坐标，PDF 点，
 * 左上原点，与 bbox 同坐标系）；bbox 保持 001 里的并集矩形 [x,y,w,h]。
 * note 挂在高亮上的笔记内容（可空；D27「高亮 / 笔记」中的笔记）。
 */
export const migration004: Migration = {
  version: 4,
  name: 'annotations_quads_note',
  up(db: Database.Database): void {
    db.exec(`
ALTER TABLE annotations ADD COLUMN quads TEXT;  -- JSON 行级矩形 [[x,y,w,h],...]
ALTER TABLE annotations ADD COLUMN note TEXT;   -- 挂在高亮上的笔记内容（可空）
`)
  }
}
