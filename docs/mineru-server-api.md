# MinerU server API 样例（M0 留档，供 M2 实现 D73 参考）

实测环境：MinerU **4.0.12**，`mineru server start`（托管 api-server，`127.0.0.1:16580`）。
版本锁在 `sidecar/mineru/uv.lock`，4.x 内格式相对稳定，但以下均为**实测样例而非 API 承诺**。

## 生命周期（D73：App 自己管理子进程）

```bash
mineru server start   # 后台启动（写 PID，PID 66065 实测）
mineru server status  # 查看状态
mineru server stop    # 优雅停止
```

M2 提醒：端口/状态目录默认 `~/.mineru/`（有 `config.yaml.lock`、`doclib.sock`、日志）。
App 需自己 fork 并管理 `mineru server` 子进程：随机端口 + pidfile 清孤儿（当前探针是手工启停）。

## GET /v1/health（无需鉴权）

```json
{"status":"ok","version":"4.0.12","features":{"webhook":false,"output_formats":["markdown","middle_json","structured_content","zip"],"sources":["file_id","url","inline","local"]}}
```

## 上传 → 建 job 流程

MinerU 4.x 的 `/v1/parse/jobs` **不接 multipart 文件**，要先走 uploads 拿 `file_id`：

1. `POST /v1/uploads`（JSON：`filename/bytes/mime_type/purpose:"parse"/sha256sum`）
   → 返回 `upload_url`（同站 PUT 传字节）+ `upload_headers`（`Content-Type`）。
   若服务端已有同 sha 文件则直接 `status:"completed"` 并给 `file.id`（秒传）。
   样例：`post-uploads-response.json`。
2. `PUT {upload_url}`（原始 PDF 字节）→ `POST /v1/uploads/{id}/complete`
   → `status:"completed"`，`file.id` = `file-f9e14e85...`。样例：`post-uploads-complete-response.json`。
3. `POST /v1/parse/jobs`（JSON body）：

```json
{
  "files": [{ "source": { "type": "file_id", "file_id": "file-f9e14e856bd4cd3077d3550f" } }],
  "output_formats": ["markdown"]
}
```

`source` 是判别联合：`file_id | url | inline（name+data base64）| local（path，服务端本地路径）`。
还可带 `tier`、`ocr_mode:"auto"|"txt"|"ocr"`、`callback:{url,secret}`（webhook 特性本次 features 里为 false）。
样例：`post-jobs-response.json`（返回 `job_id`、`links.self/cancel`）。

## jobs 状态机（轮询 GET /v1/parse/jobs/{job_id}）

状态枚举：**queued → running → completed / failed / canceled**（DELETE /v1/parse/jobs/{id} 取消）。
响应要点：

- 顶层 `status` + `progress:{completed,failed,total}`（**文件级计数，无页级进度**）；
- `files[]` 每文件一个状态：`queued → running → completed/failed`，
  completed 后带 `parse:{duration_ms,parser_version}` 与 `output_files.markdown.file_id`
  （再 GET `/v1/files/{file_id}/content` 拿正文——正文不入库 git）；
- 实测 2 页 PDF：`queued`（21:06:03）→ 轮询第 1 次 `running` → 第 2 次 `completed`（21:06:07，约 4s，缓存命中）。
  样例：`get-job-running-response.json`、`get-job-completed-response.json`。

## 页级进度（D72 结论的佐证）

- API 只有文件级 progress；CLI 客户端 stdout 只有「解析状态: parsing」；
- 服务端按 **window** 在日志汇报（`~/.mineru/logs/doclib.log`）：

```
Hybrid processing-window run. page_count=2, window_size=64, total_windows=1
Hybrid processing window 1/1: pages 1-2/2 (2 pages)
```

格式样例见 `server-window-log-sample.txt`。M2 若想要页码感，只能 App 自己拉起的
server 子进程 stdout/日志里 best-effort 解析 window 行，解析不到就回退
「阶段 + 已用时长 + 预计总时长」的时间估算（M0 报告 §3 与评审推荐方案）。
