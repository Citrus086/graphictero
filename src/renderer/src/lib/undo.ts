/**
 * 撤销栈（⌘Z / ⌘⇧Z，D77/D88）。
 *
 * 只管「手动编辑」产生的操作：关系的手动创建 / 编辑 / 删除各算一条，
 * 首次建图、新增论文、重新生成的批量关系不进栈（D88，想重来用「重新生成关系」）。
 * undo / redo 的具体数据搬运（restoreRelation / deleteRelation IPC）由调用方注入，
 * 本模块只维护历史顺序与重做缓存；历史只在本次运行期间保留（D36）。
 *
 * M5 lane/chat 批 3：撤销组（D119）——一个 Agent 回合的一组改动（N 条）作为整体入栈，
 * 撤销时按**逆序**逐条恢复；失败语义按计划 §8 风险 4「尽力逆序 + 失败即停并提示」：
 * 已恢复的条目不回滚（部分撤销被承认），失败条目与未处理条目丢弃并抛 UndoGroupError，
 * 由调用方提示用户「已撤销 x 条，剩余 y 条失败/未撤销」。
 */

export interface UndoEntry {
  label: string
  undo(): Promise<void>
  redo(): Promise<void>
}

/** 撤销组：一组按逆序恢复的条目（D119） */
export interface UndoGroup {
  label: string
  entries: UndoEntry[]
}

/** 组撤销/重做中途失败的错误信息（尽力逆序 + 失败即停） */
export class UndoGroupError extends Error {
  constructor(
    message: string,
    readonly undone: number,
    readonly remaining: number
  ) {
    super(message)
    this.name = 'UndoGroupError'
  }
}

type StackItem = UndoEntry | UndoGroup

function isGroup(item: StackItem): item is UndoGroup {
  return 'entries' in item
}

export class UndoStack {
  private past: StackItem[] = []
  private future: StackItem[] = []

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  /** 记一条新操作；之后不可重做（D36 语义：新分支截断 redo 历史） */
  push(entry: UndoEntry): void {
    this.past.push(entry)
    this.future = []
  }

  /** 记一个撤销组（D119）：N 条作为整体，撤销按逆序逐条恢复。空组不入栈 */
  pushGroup(label: string, entries: UndoEntry[]): void {
    if (entries.length === 0) return
    this.past.push({ label, entries })
    this.future = []
  }

  /** 撤销最近一条/一组；无可撤返回 null。撤销过的条目进入 redo 缓存。
   * 评审建议修 7：单条 entry.undo() 抛错时把条目推回 past 再 rethrow，不丢历史、可重试；
   * 组撤销失败语义见 UndoGroupError（不回栈，部分撤销被承认）。 */
  async undo(): Promise<string | null> {
    const item = this.past.pop()
    if (!item) return null
    if (isGroup(item)) {
      // 逆序逐条恢复；失败即停：已恢复不回滚，剩余丢弃并抛错（§8 风险 4）
      for (let i = item.entries.length - 1; i >= 0; i--) {
        try {
          await item.entries[i].undo()
        } catch (e) {
          const undone = item.entries.length - 1 - i
          throw new UndoGroupError(
            `撤销组「${item.label}」失败：${e instanceof Error ? e.message : String(e)}（已撤销 ${undone} 条，剩余 ${i + 1} 条未撤销）`,
            undone,
            i + 1
          )
        }
      }
      this.future.push(item)
      return item.label
    }
    try {
      await item.undo()
    } catch (e) {
      this.past.push(item)
      throw e
    }
    this.future.push(item)
    return item.label
  }

  /** 重做最近撤销的一条/一组；无可重做返回 null。组重做按正序，失败同样不回栈 */
  async redo(): Promise<string | null> {
    const item = this.future.pop()
    if (!item) return null
    if (isGroup(item)) {
      for (let i = 0; i < item.entries.length; i++) {
        try {
          await item.entries[i].redo()
        } catch (e) {
          const done = i
          throw new UndoGroupError(
            `重做组「${item.label}」失败：${e instanceof Error ? e.message : String(e)}（已重做 ${done} 条，剩余 ${item.entries.length - i} 条未重做）`,
            done,
            item.entries.length - i
          )
        }
      }
      this.past.push(item)
      return item.label
    }
    try {
      await item.redo()
    } catch (e) {
      this.future.push(item)
      throw e
    }
    this.past.push(item)
    return item.label
  }

  /** 换图谱 / 卸载时清空（历史不跨界面、不跨图谱、不跨运行保留） */
  clear(): void {
    this.past = []
    this.future = []
  }
}
