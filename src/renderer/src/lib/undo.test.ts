import { describe, expect, it, vi } from 'vitest'
import { UndoGroupError, UndoStack } from './undo'

function makeEntry(label: string, calls: string[]): { entry: { label: string; undo: () => Promise<void>; redo: () => Promise<void> }; seq: () => string } {
  return {
    entry: {
      label,
      undo: async () => {
        calls.push(`${label}:undo`)
      },
      redo: async () => {
        calls.push(`${label}:redo`)
      }
    },
    seq: () => calls.join(',')
  }
}

describe('UndoStack（D77/D88）', () => {
  it('push 后 undo 逆序执行并进入 redo 缓存', async () => {
    const calls: string[] = []
    const s = new UndoStack()
    const a = makeEntry('A', calls)
    const b = makeEntry('B', calls)
    s.push(a.entry)
    s.push(b.entry)
    expect(s.canUndo).toBe(true)
    expect(await s.undo()).toBe('B')
    expect(await s.undo()).toBe('A')
    expect(calls.join(',')).toBe('B:undo,A:undo')
    expect(s.canUndo).toBe(false)
    expect(s.canRedo).toBe(true)
  })

  it('redo 重放最近撤销的一条', async () => {
    const calls: string[] = []
    const s = new UndoStack()
    const a = makeEntry('A', calls)
    s.push(a.entry)
    await s.undo()
    expect(await s.redo()).toBe('A')
    expect(calls.join(',')).toBe('A:undo,A:redo')
    expect(s.canRedo).toBe(false)
    expect(s.canUndo).toBe(true)
  })

  it('无可撤 / 无可重做时返回 null', async () => {
    const s = new UndoStack()
    expect(await s.undo()).toBeNull()
    expect(await s.redo()).toBeNull()
  })

  it('新操作截断 redo 历史（D36 语义）', async () => {
    const calls: string[] = []
    const s = new UndoStack()
    const a = makeEntry('A', calls)
    const b = makeEntry('B', calls)
    s.push(a.entry)
    await s.undo()
    s.push(b.entry)
    expect(s.canRedo).toBe(false)
    expect(await s.redo()).toBeNull()
    expect(await s.undo()).toBe('B')
    expect(calls.join(',')).toBe('A:undo,B:undo')
  })

  it('clear 清空双向历史', async () => {
    const s = new UndoStack()
    const e = makeEntry('A', [])
    s.push(e.entry)
    await s.undo()
    s.clear()
    expect(s.canUndo).toBe(false)
    expect(s.canRedo).toBe(false)
    expect(await s.undo()).toBeNull()
  })

  it('评审建议修 7：undo() 抛错时条目推回 past 再 rethrow，历史不丢、可重试', async () => {
    const calls: string[] = []
    const s = new UndoStack()
    let fail = true
    s.push({
      label: '删除关系',
      undo: async () => {
        calls.push('A:undo')
        if (fail) throw new Error('IPC 瞬时失败')
      },
      redo: vi.fn()
    })
    s.push(makeEntry('B', calls).entry)
    expect(await s.undo()).toBe('B') // B 先撤，成功
    await expect(s.undo()).rejects.toThrow('IPC 瞬时失败') // A 失败：推回 past
    expect(s.canUndo).toBe(true) // 没丢
    expect(calls.join(',')).toBe('B:undo,A:undo') // 失败那次也执行过，推回后可重试
    fail = false
    expect(await s.undo()).toBe('删除关系')
    expect(calls.join(',')).toBe('B:undo,A:undo,A:undo')
    expect(s.canUndo).toBe(false)
  })

  it('评审建议修 7：redo() 抛错时条目推回 future 再 rethrow', async () => {
    const s = new UndoStack()
    let fail = true
    s.push({
      label: 'A',
      undo: vi.fn(),
      redo: async () => {
        if (fail) throw new Error('redo 失败')
      }
    })
    await s.undo()
    await expect(s.redo()).rejects.toThrow('redo 失败')
    expect(s.canRedo).toBe(true)
    fail = false
    expect(await s.redo()).toBe('A')
    expect(s.canRedo).toBe(false)
  })

  it('push 同步记录 label，供 ⌘Z 提示展示', () => {
    const s = new UndoStack()
    s.push({ label: '删除关系', undo: vi.fn(), redo: vi.fn() })
    // label 通过 undo() 的返回值透出（见第一条用例）
    expect(s.canUndo).toBe(true)
  })

  // ── M5 lane/chat 批 3：撤销组（D119，一组 N 条按逆序恢复）──

  it('pushGroup：撤销按逆序逐条恢复，redo 按正序', async () => {
    const s = new UndoStack()
    const calls: string[] = []
    const mk = (label: string) => ({
      label,
      undo: async () => {
        calls.push(`${label}:undo`)
      },
      redo: async () => {
        calls.push(`${label}:redo`)
      }
    })
    s.pushGroup('本轮改动', [mk('A'), mk('B'), mk('C')])
    expect(await s.undo()).toBe('本轮改动')
    expect(calls.join(',')).toBe('C:undo,B:undo,A:undo')
    expect(s.canRedo).toBe(true)
    await s.redo()
    expect(calls.join(',')).toBe('C:undo,B:undo,A:undo,A:redo,B:redo,C:redo')
  })

  it('组撤销失败即停（§8 风险 4）：已恢复不回滚，剩余丢弃，UndoGroupError 报告条数', async () => {
    const s = new UndoStack()
    const calls: string[] = []
    const mk = (label: string, failUndo = false) => ({
      label,
      undo: async () => {
        calls.push(`${label}:undo`)
        if (failUndo) throw new Error(`${label} 失败`)
      },
      redo: async () => {
        calls.push(`${label}:redo`)
      }
    })
    s.pushGroup('本轮改动', [mk('A'), mk('B', true), mk('C')])
    let err: unknown = null
    try {
      await s.undo()
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(UndoGroupError)
    const ge = err as UndoGroupError
    expect(ge.undone).toBe(1) // C 已撤销
    expect(ge.remaining).toBe(2) // B（失败）+ A 未撤销
    expect(ge.message).toContain('已撤销 1 条')
    expect(calls.join(',')).toBe('C:undo,B:undo') // A 未执行
    expect(s.canUndo).toBe(false) // 组不回栈（部分撤销被承认）
    expect(s.canRedo).toBe(false)
  })

  it('空组不入栈', () => {
    const s = new UndoStack()
    s.pushGroup('空组', [])
    expect(s.canUndo).toBe(false)
  })
})
