// ── Remote server metrics collection script ─────────────────
// Extracted from remoteTerminalService.ts for readability.
//
// This script is executed over SSH on the remote Linux host.
// It collects CPU, memory, disk, and network metrics and
// outputs the result as JSON on stdout.
//
// Security: this script runs ONLY on authenticated SSH sessions.
// It is never executed on the local machine.

export const METRICS_SCRIPT = String.raw`sh -s <<'__REMOTE_METRICS__'
set -eu

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

hostname_v=$(hostname 2>/dev/null || true)
kernel_v=$(uname -sr 2>/dev/null || true)
arch_v=$(uname -m 2>/dev/null || true)
os_v=""
if [ -r /etc/os-release ]; then
  os_v=$(awk -F= '/^PRETTY_NAME=/{gsub(/^"|"$/, "", $2); print $2; exit}' /etc/os-release)
fi
uptime_v=$(awk '{print int($1)}' /proc/uptime 2>/dev/null || echo 0)
load_v=$(cat /proc/loadavg 2>/dev/null || echo "0 0 0")
load1=$(printf '%s\n' "$load_v" | awk '{print $1}')
load5=$(printf '%s\n' "$load_v" | awk '{print $2}')
load15=$(printf '%s\n' "$load_v" | awk '{print $3}')

cpu_cores=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 0)
read _ u1 n1 s1 i1 w1 irq1 sirq1 st1 rest1 < /proc/stat
sleep 1
read _ u2 n2 s2 i2 w2 irq2 sirq2 st2 rest2 < /proc/stat
idle1=$((i1 + w1))
idle2=$((i2 + w2))
total1=$((u1 + n1 + s1 + i1 + w1 + irq1 + sirq1 + st1))
total2=$((u2 + n2 + s2 + i2 + w2 + irq2 + sirq2 + st2))
total_delta=$((total2 - total1))
idle_delta=$((idle2 - idle1))
cpu_usage=$(awk -v t="$total_delta" -v i="$idle_delta" 'BEGIN { if (t <= 0) print 0; else printf "%.1f", (1 - i / t) * 100 }')

mem_total_kb=$(awk '/^MemTotal:/{print int($2)}' /proc/meminfo 2>/dev/null || echo 0)
mem_free_kb=$(awk '/^MemFree:/{print int($2)}' /proc/meminfo 2>/dev/null || echo 0)
mem_avail_kb=$(awk '/^MemAvailable:/{print int($2)}' /proc/meminfo 2>/dev/null || echo 0)
swap_total_kb=$(awk '/^SwapTotal:/{print int($2)}' /proc/meminfo 2>/dev/null || echo 0)
swap_free_kb=$(awk '/^SwapFree:/{print int($2)}' /proc/meminfo 2>/dev/null || echo 0)
mem_used_kb=$((mem_total_kb - mem_avail_kb))
swap_used_kb=$((swap_total_kb - swap_free_kb))
mem_total=$((mem_total_kb * 1024))
mem_free=$((mem_free_kb * 1024))
mem_avail=$((mem_avail_kb * 1024))
swap_total=$((swap_total_kb * 1024))
swap_free=$((swap_free_kb * 1024))
mem_used=$((mem_used_kb * 1024))
swap_used=$((swap_used_kb * 1024))

printf '{'
printf '"host":{"hostname":"%s","os":"%s","kernel":"%s","arch":"%s","uptimeSeconds":%s,"loadavg":[%s,%s,%s]},' \
  "$(json_escape "$hostname_v")" "$(json_escape "$os_v")" "$(json_escape "$kernel_v")" "$(json_escape "$arch_v")" "$uptime_v" "$load1" "$load5" "$load15"
printf '"cpu":{"usagePercent":%s,"cores":%s},' "$cpu_usage" "$cpu_cores"
printf '"memory":{"totalBytes":%s,"usedBytes":%s,"freeBytes":%s,"availableBytes":%s,"swapTotalBytes":%s,"swapUsedBytes":%s},' \
  "$mem_total" "$mem_used" "$mem_free" "$mem_avail" "$swap_total" "$swap_used"

printf '"disks":['
first=1
df -B1 -P 2>/dev/null | awk 'NR>1 {print $1 "\t" $2 "\t" $3 "\t" $4 "\t" $5 "\t" $6}' | while IFS="$(printf '\t')" read -r fs total used avail pct mount; do
  case "$fs" in tmpfs|devtmpfs) continue ;; esac
  pct_num=$(printf '%s' "$pct" | tr -d '%')
  case "$total:$used:$avail:$pct_num" in *[!0-9:]*|'') continue ;; esac
  if [ "$first" -eq 0 ]; then printf ','; fi
  first=0
  printf '{"filesystem":"%s","mount":"%s","totalBytes":%s,"usedBytes":%s,"availableBytes":%s,"usedPercent":%s}' \
    "$(json_escape "$fs")" "$(json_escape "$mount")" "$total" "$used" "$avail" "$pct_num"
done
printf '],'

printf '"network":['
first=1
awk -F'[: ]+' 'NR>2 {print $2, $3, $11}' /proc/net/dev 2>/dev/null | while read -r iface rx tx; do
  [ "$iface" = "lo" ] && continue
  if [ "$first" -eq 0 ]; then printf ','; fi
  first=0
  printf '{"iface":"%s","rxBytes":%s,"txBytes":%s}' "$(json_escape "$iface")" "$rx" "$tx"
done
printf ']'
printf '}'
__REMOTE_METRICS__`
