#!/usr/bin/env bash
# Regenerates test/fixtures from lease.html. Needs LibreOffice (soffice) on PATH.
set -euo pipefail
cd "$(dirname "$0")/../test/fixtures"
tmp=$(mktemp -d)
soffice --headless --convert-to "docx:MS Word 2007 XML" lease.html >/dev/null
soffice --headless --convert-to pdf lease.docx >/dev/null
npx tsx ../../scripts/render-photo.ts lease.pdf lease-photo.jpg
soffice --headless --convert-to pdf --outdir "$tmp" lease-photo.jpg >/dev/null
mv "$tmp/lease-photo.pdf" lease-scan.pdf
head -c 3000 lease.pdf > broken.pdf
printf 'PK\003\004 not really a docx' > broken.docx
rm -rf "$tmp"
ls -la
