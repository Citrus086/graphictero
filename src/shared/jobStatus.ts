/**
 * 论文处理任务的七种状态（D70）——并行车道共享的类型。
 * lane/pdf（解析队列 / 进度 / 失败标记）与 lane/relations（关系生成任务）都引用同一份，
 * 不各自定义口径。状态机与调度逻辑仍在 src/main/jobs/。
 */

export const JOB_STATUSES = [
  'queued',
  'running',
  'waiting_network',
  'waiting_key',
  'failed_retryable',
  'failed_action',
  'succeeded'
] as const
export type JobStatus = (typeof JOB_STATUSES)[number]
