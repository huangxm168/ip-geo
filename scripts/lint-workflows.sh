#!/usr/bin/env bash
# 检查 GitHub Actions 工作流 —— npm run lint:workflows（本地与 CI 共用这一份）
#
# - actionlint：语法、表达式、作业之间的引用；官方镜像自带 shellcheck，顺带检查每段 run: 脚本
# - zizmor：工作流的安全问题（action 没钉提交号、权限过大、缓存投毒、把外部输入拼进命令等）。
#   设了 GH_TOKEN 时连同联网审计一起跑（CI 里给只读的 github.token；本地可用 GH_TOKEN=$(gh auth token)），
#   否则只跑离线审计
#
# 两个工具都用官方镜像、按摘要钉死，不走 npm：actionlint 没有官方的 npm 发布，第三方封装包在安装时下载二进制文件。
# 升级时版本与摘要一起改，并让新版本先放两周；仓库只读挂进容器

set -euo pipefail

ACTIONLINT_IMAGE="rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667"
ZIZMOR_IMAGE="ghcr.io/zizmorcore/zizmor:1.31.1@sha256:42d409dbb851d4c5d35a058cf042b828bea1e3f2884378c526eb0974780e18d9"

cd "$(dirname "$0")/.."

echo "[lint:workflows] actionlint"
docker run --rm -v "$PWD:/repo:ro" --workdir /repo "$ACTIONLINT_IMAGE" -color

if [ -n "${GH_TOKEN:-}" ]; then
  echo "[lint:workflows] zizmor（含联网审计）"
  docker run --rm -v "$PWD:/repo:ro" --workdir /repo -e GH_TOKEN "$ZIZMOR_IMAGE" .
else
  echo "[lint:workflows] zizmor（仅离线审计）"
  docker run --rm -v "$PWD:/repo:ro" --workdir /repo "$ZIZMOR_IMAGE" --offline .
fi
