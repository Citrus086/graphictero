import type { GraphChangePart } from '../../../../shared/parts'
import { UndoStack, UndoGroupError, type UndoEntry } from '../../lib/undo'

/**
 * M5 lane/chat：改图小结行的「撤销本轮改动」执行器（D119）。
 *
 * 按计划 §8 风险 4「一组 N 条按逆序恢复，尽力逆序 + 失败即停并提示」：
 * - addRelation：M6 前置 2a 起新数据都是真新建边 → 删除撤销（createdAt ≥ 回合起点，
 *   旧守卫保留防误删回合前已存在的边）。带 snapshotIds 的旧式 part（upsert 改写）→
 *   按快照还原（D129）。
 * - updateRelation / deleteRelation：有 snapshotIds → 逐条 `rel:restoreSnapshot` 按改动前
 *   快照还原（含原 source_type；较新回合又改过同一条边时主进程按 D104 守卫拒绝，中文
 *   原因，失败即停）；无 snapshotIds 的旧数据 → 该条抛「缺少改动前快照」，如实报条数。
 * - 其他 changeType（如 addCandidate，真实产出端不产）：诚实报「暂不支持撤销」。
 * - redo：组撤销由小结行按钮即时执行（局部栈用后即弃，不入画布手动栈，D88 不污染），
 *   **无 redo 入口（D119 未要求）**——条目 redo 为 no-op 占位。
 */

export interface GraphUndoResult {
  label: string
  undone: number
  failed: number
  message: string
}

/** redo 占位：按钮组撤销无 redo 入口（D119 未要求），撤销栈局部用后即弃 */
const NO_REDO = async (): Promise<void> => {}

export async function undoGraphChange(graphId: number, part: GraphChangePart, turnStart: string | null): Promise<GraphUndoResult> {
  const api = window.graphictero
  const entries: UndoEntry[] = []

  if (part.changeType === 'addRelation' && part.snapshotIds != null && part.snapshotIds.length > 0) {
    // 旧式 upsert 改写 part（带快照）：按快照还原，不删边（D129）
    for (const sid of part.snapshotIds) {
      entries.push({
        label: `按快照 #${sid} 还原`,
        redo: NO_REDO,
        undo: async () => {
          await api.restoreRelationSnapshot(sid)
        }
      })
    }
  } else if (part.changeType === 'addRelation') {
    for (const rid of part.relationIds) {
      entries.push({
        label: `新增的关系 #${rid}`,
        redo: NO_REDO,
        undo: async () => {
          const gd = await api.getGraph(graphId)
          const rel = gd.relations.find((r) => r.id === rid)
          if (!rel) throw new Error(`关系 #${rid} 已不存在`)
          // D104 守卫：本回合前已存在的边不能删除撤销（旧数据无快照，如实拒绝）
          if (turnStart != null && rel.createdAt < turnStart) {
            throw new Error('该关系在本回合前已存在（本轮只是改写），删除撤销需改动前快照')
          }
          await api.deleteRelation(rid)
        }
      })
    }
  } else if (part.changeType === 'updateRelation' || part.changeType === 'deleteRelation') {
    if (part.snapshotIds != null && part.snapshotIds.length > 0) {
      // M6 前置 2a（D129）：按改动前快照还原（含原 source_type；跨回合守卫在主进程）
      const label = part.changeType === 'updateRelation' ? '修改的' : '删除的'
      for (const sid of part.snapshotIds) {
        entries.push({
          label: `${label}关系（快照 #${sid}）`,
          redo: NO_REDO,
          undo: async () => {
            await api.restoreRelationSnapshot(sid)
          }
        })
      }
    } else {
      // 旧数据无快照 → 诚实失败
      for (const rid of part.relationIds) {
        entries.push({
          label: `${part.changeType === 'updateRelation' ? '修改的' : '删除的'}关系 #${rid}`,
          redo: NO_REDO,
          undo: async () => {
            throw new Error('缺少改动前快照，该条暂不能撤销')
          }
        })
      }
    }
  } else {
    entries.push({
      label: `不支持的改动类型 ${part.changeType}`,
      redo: NO_REDO,
      undo: async () => {
        throw new Error(`改图类型 ${part.changeType} 暂不支持撤销（待 lane/agent 通道）`)
      }
    })
  }

  const stack = new UndoStack()
  stack.pushGroup(part.summary, entries)
  try {
    await stack.undo()
    return { label: part.summary, undone: entries.length, failed: 0, message: `已撤销本轮全部 ${entries.length} 条改动` }
  } catch (e) {
    if (e instanceof UndoGroupError) {
      return { label: part.summary, undone: e.undone, failed: e.remaining, message: e.message }
    }
    throw e
  }
}
