"""M0 探针：批量解析 probes/fixtures/pdfs 下全部 PDF，并发 1，结果写 JSON。

PDF 只放本地（probes/fixtures/pdfs/ 已 gitignore），绝不提交。

用法（在仓库根目录跑）：
    cd sidecar/mineru && uv run python parse_batch.py
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from parse_one import parse_one  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
PDF_DIR = ROOT / "probes" / "fixtures" / "pdfs"
RESULT_JSON = ROOT / "probes" / "results" / "mineru-batch.json"


def main() -> None:
    pdfs = sorted(PDF_DIR.glob("*.pdf"))
    assert pdfs, f"no PDFs found in {PDF_DIR}"
    results = []
    t_start = time.monotonic()
    for pdf in pdfs:  # 并发 1：严格顺序执行
        out = ROOT / "probes" / "results" / "mineru" / pdf.stem
        print(f"[batch] {pdf.name} ...", flush=True)
        r = parse_one(pdf, out, tier="standard")
        results.append(r)
        print(f"[batch]   -> rc={r['returncode']} {r['elapsed_sec']}s peak={r['peak_rss_mb']}MB", flush=True)
        RESULT_JSON.write_text(
            json.dumps({"total_elapsed_sec": round(time.monotonic() - t_start, 1), "results": results}, ensure_ascii=False, indent=2)
        )
    ok = sum(1 for r in results if r["returncode"] == 0)
    print(f"[batch] done: {ok}/{len(results)} succeeded, results in {RESULT_JSON}")


if __name__ == "__main__":
    main()
