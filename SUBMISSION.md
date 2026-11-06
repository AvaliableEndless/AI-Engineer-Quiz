# 素材检索与结果导出：交付说明

Fork：<https://github.com/AvaliableEndless/AI-Engineer-Quiz>；分支：`feat/asset-search-export`。
开发起点：`3aa137ccde6f981981582f6f71b81448c72a9dab`。保留上游历史，按实际阶段提交，未 squash、amend 或 rebase。最终 SHA 通过 `git rev-parse HEAD` 获取并随邮件提供。

## 运行与生成数据

Python 3.10+（本机实测 3.12.4），需要 SQLite FTS5。以下在仓库根目录用 PowerShell 执行：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e '.[dev]'
.\.venv\Scripts\python.exe -X utf8 scripts/seed_quiz.py --data-dir data/quiz-demo
$env:KEEPSTACK_DATA_DIR = (Resolve-Path data/quiz-demo).Path
$env:KEEPSTACK_AI_ENABLED = 'false'
$env:KEEPSTACK_OCR_ENABLED = 'false'
$env:KEEPSTACK_HOST = '127.0.0.1'
$env:KEEPSTACK_PORT = '8001'
.\.venv\Scripts\python.exe -m keepstack
```

打开 <http://127.0.0.1:8001>，本地演示账号 `admin` / `admin`。已存在非空数据目录时脚本拒绝运行，改用新目录并同步调整环境变量；不会删除或覆盖原有数据。生成的数据库、图片及日志位于被忽略的 `data/`，不提交。

Linux/macOS 使用 `.venv/bin/python`，环境变量使用 `export KEEPSTACK_DATA_DIR="$PWD/data/quiz-demo"` 等对应写法，其他 Python 命令相同。也可用 uv 建立环境及安装依赖。

数据包括 54 条素材、52 条 active、2 个集合。选择 `Harbor campaign`，搜索 `harbor`，类型 `image`，包含 `approved`、`campaign`，排除 `internal`：匹配 45 条，三页为 20、20、5 条；前 30 条匹配素材创建时间相同。对照素材覆盖缺标签、排除标签、其他/无集合、其他类型、非 active 和无关键词；另含中文、逗号、引号、换行与特殊字符标签。

## 自动化验证与实测

另开终端执行：

```powershell
.\.venv\Scripts\python.exe -X utf8 -m pytest -q --tb=short --basetemp ('data/pytest-' + [guid]::NewGuid().ToString('N'))
node --check web/app.js
git diff --check
```

最终完整 pytest：**56 passed、2 skipped、3 warnings**。跳过的是未安装模型的 CLIP 和未安装二进制的 Tesseract；警告来自上游 FastAPI `on_event` 与新版 Starlette/httpx 弃用提示。一次运行出现本机临时内存分配失败，串行重跑同一完整命令通过，未降低鉴权参数或跳过新增测试。

测试覆盖组合条件、标签语义、FTS 特殊输入、非法和超大参数、同时间三页无重漏、四种排序的列表/CSV 完全一致、205 条全量导出、空表头、鉴权，以及通过真实 PATCH/标签接口修改后的查询和导出。数据脚本测试独立生成两套相同记录并验证拒绝覆盖。

可选浏览器回归需要 Node.js、Playwright 和浏览器；应用本身不依赖 Node。保持上面的独立演示服务运行：

```powershell
npm install --prefix data/browser-tools --no-save playwright
$env:NODE_PATH = (Resolve-Path data/browser-tools/node_modules).Path
$env:KEEPSTACK_TEST_URL = 'http://127.0.0.1:8001'
$env:KEEPSTACK_TEST_PYTHON = (Resolve-Path .venv/Scripts/python.exe).Path
$env:PLAYWRIGHT_CHANNEL = 'msedge'
node tests/browser_smoke.cjs
```

上例使用已安装的 Edge；也可将 channel 改为 `chrome`。若使用 Playwright 自带 Chromium，先执行 `npx --prefix data/browser-tools playwright install chromium`，再取消 `PLAYWRIGHT_CHANNEL` 环境变量。脚本会短暂修改并恢复演示素材，仅对独立测试目录运行。

实测 Edge 无头浏览器通过：真实登录、组合选择、前后翻页、排序/条件变更回首页、第二页导出 45 条、零结果导出、特殊标签、详情编辑、删除/恢复标签、加载/下载失败、重试、旧响应延迟返回、清除筛选。检查 1440px 桌面和 390px 手机截图、缩略图加载及横向溢出；截图和下载 CSV 位于 `data/browser-output/`。

## 主要取舍与限制

- 保持 FastAPI、SQLite/FTS5、原生 JS 和现有页面，无新增应用运行依赖。可选 Playwright 的收益是验证真实页面和下载，成本是测试时安装 Node/浏览器。
- 共享 `AssetFilters` 和 SQL 条件；包含标签取 AND，排除标签取 ANY，名称按原有 `strip().lower()` 完整匹配。重复标签去重，包含/排除冲突返回零条。只有 active 可查询、导出。
- 沿用 FTS 字段、清洗和分词器。空白不限制关键词；非空但清洗后没有词（如 `!!!`）返回零条。语义入口隐藏，查询/导出仅接受 keyword。
- 每页 20，API limit 1–200、offset 非负；时间排序附加唯一 ID，关键词不改变排序。分页使用 offset，不提供跨请求快照，符合题目数据不变时验收条件。
- CSV 使用标准库、UTF-8 BOM；固定七列 `uuid,title,description,filename,media_type,tags,created_at`。tags 为按名称排序的 JSON 字符串数组，无标签为 `[]`；保留字段中的逗号、引号和换行，零结果有表头。
- 导出共享查询及排序，忽略分页，沿用 Bearer 登录。同步在内存生成 CSV，超大数据量会增加内存与等待时间，未增加异步任务或流式导出。
- 页面用条件快照、请求序号和 AbortController 防止旧响应覆盖；标签修改后主动刷新列表，复用已有 FTS 更新逻辑。侧栏数字标明全库 active 统计。
- 未完成项：本题要求内暂无已知缺口；未实施题目不要求的模型接入、异步导出、跨请求快照或线上部署。未扩展修复上游其他功能，例如原文件下载链接不能自动携带 Bearer token；本题 CSV 下载已单独处理鉴权。

开发过程和代码入口见 [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)。提交邮件提供 Fork、分支和最终 SHA 即可，无需向上游 Keepstack 提 PR。
