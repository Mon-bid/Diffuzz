#!/bin/sh
# 打包发布 zip：仅包含扩展运行所需文件
set -e
cd "$(dirname "$0")/.."
out="diffuzz-$(date +%Y%m%d).zip"
zip -r "$out" manifest.json devtools panel background core README.md LICENSE
echo "打包完成: $out"
