#!/usr/bin/env bash
# Vulnerability scan of the built images with Trivy (runs in a container; nothing to install).
# Output: results/trivy-<image>.txt and a summary table in results/scan-summary.md
source "$(dirname "$0")/lib.sh"
TRIVY=aquasec/trivy:0.56.2
docker compose --progress plain build >/dev/null 2>&1

images=$(docker compose config --images | grep vss-)
[[ ${1:-} == "--with-naive" ]] && images+=$'\n'"vss-upload-web:naive"$'\n'"vss-file-service:naive"

{
  echo "| Image | Critical | High | Medium | Low |"
  echo "|---|---:|---:|---:|---:|"
} > results/scan-summary.md

for img in $images; do
  name=$(basename "${img%%:*}")-${img##*:}
  log "scanning $img"
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v trivy-cache:/root/.cache "$TRIVY" \
    image --quiet --scanners vuln --format json "$img" > "results/trivy-$name.json"
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v trivy-cache:/root/.cache "$TRIVY" \
    image --quiet --scanners vuln --severity HIGH,CRITICAL "$img" > "results/trivy-$name.txt"
  counts=$(docker run --rm -i "$NODE_IMAGE" node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const c={CRITICAL:0,HIGH:0,MEDIUM:0,LOW:0};
    for(const r of j.Results||[])for(const v of r.Vulnerabilities||[])if(c[v.Severity]!==undefined)c[v.Severity]++;
    console.log([c.CRITICAL,c.HIGH,c.MEDIUM,c.LOW].join(" | "))})' < "results/trivy-$name.json")
  echo "| \`$img\` | $counts |" >> results/scan-summary.md
done
cat results/scan-summary.md
echo; echo "Full HIGH/CRITICAL findings: results/trivy-*.txt"