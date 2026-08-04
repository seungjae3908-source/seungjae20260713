#!/usr/bin/env bash
set -uo pipefail
export LC_ALL=C

: "${INCIDENT_START:?INCIDENT_START is required}"
: "${INCIDENT_END:?INCIDENT_END is required}"
: "${INCIDENT_RUN_ID:?INCIDENT_RUN_ID is required}"

section() {
  printf '\n===== %s =====\n' "$1"
}

sanitize() {
  sed -E \
    -e 's#https?://[^[:space:]"<>]+#<URL_REDACTED>#g' \
    -e 's#(authorization|apikey|api_key|token|secret|password)[=:][^[:space:]]+#\1=<REDACTED>#Ig' \
    -e 's#eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}#<JWT_REDACTED>#g' \
    -e 's#\b([0-9]{1,3}\.){3}[0-9]{1,3}\b#<IP_REDACTED>#g' \
    -e 's#/home/[^/[:space:]]+#/home/<user>#g' \
    -e 's#/root([/[:space:]]|$)#/<root>\1#g'
}

low_io_du() {
  if command -v ionice >/dev/null 2>&1; then
    ionice -c3 nice -n 19 du "$@"
  else
    nice -n 19 du "$@"
  fi
}

size_of() {
  local target="$1"
  low_io_du -x -B1 -s -- "$target" 2>/dev/null | awk '{print $1}'
}

inventory_root() {
  local root="$1"
  [[ -d "$root" ]] || return 0
  local total count
  total="$(size_of "$root")"
  count="$(find "$root" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  printf 'ROOT\t%s\tcount=%s\tbytes=%s\n' "$root" "$count" "${total:-unavailable}" | sanitize
  find "$root" -mindepth 1 -maxdepth 1 -type d \
    -printf '%T@|%TY-%Tm-%TdT%TH:%TM:%TSZ|%p\n' 2>/dev/null \
    | sort -t'|' -k1,1nr \
    | while IFS='|' read -r _epoch modified path; do
        [[ -n "$path" ]] || continue
        printf 'ENTRY\t%s\tbytes=%s\tmodified=%s\n' "$path" "$(size_of "$path")" "$modified" | sanitize
      done
}

pm2_safe_inventory() {
  if ! command -v pm2 >/dev/null 2>&1; then
    printf 'PM2_UNAVAILABLE\n'
    return 0
  fi
  pm2 jlist 2>/dev/null | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const rows = JSON.parse(input);
        const safe = rows.map((row) => ({
          name: String(row.name ?? ""),
          status: String(row.pm2_env?.status ?? "missing"),
          pid: Number(row.pid ?? 0),
          restart_count: Number(row.pm2_env?.restart_time ?? -1),
          cwd: String(row.pm2_env?.pm_cwd ?? ""),
          exec_path: String(row.pm2_env?.pm_exec_path ?? ""),
          out_log: String(row.pm2_env?.pm_out_log_path ?? ""),
          err_log: String(row.pm2_env?.pm_err_log_path ?? ""),
          created_at: Number(row.pm2_env?.created_at ?? 0),
          cpu_percent: Number(row.monit?.cpu ?? 0),
          memory_bytes: Number(row.monit?.memory ?? 0),
        }));
        process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
      } catch (error) {
        process.stdout.write(`PM2_PARSE_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    });
  ' | sanitize
}

pm2_log_paths() {
  command -v pm2 >/dev/null 2>&1 || return 0
  pm2 jlist 2>/dev/null | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        for (const row of JSON.parse(input)) {
          const name = String(row.name ?? "unknown").replace(/[\t\n\r]/g, "_");
          for (const kind of ["pm_out_log_path", "pm_err_log_path"]) {
            const value = String(row.pm2_env?.[kind] ?? "");
            if (value) process.stdout.write(`${name}\t${kind}\t${value}\n`);
          }
        }
      } catch {}
    });
  '
}

section 'diagnostic_identity'
printf 'mode=read_only\nincident_run_id=%s\nincident_start=%s\nincident_end=%s\ncollected_at=%s\n' \
  "$INCIDENT_RUN_ID" "$INCIDENT_START" "$INCIDENT_END" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'kernel='; uname -srmo 2>/dev/null | sanitize || true
printf 'uptime='; uptime 2>/dev/null | sanitize || true
printf 'cpu_count='; getconf _NPROCESSORS_ONLN 2>/dev/null || true

section 'df_h'
df -hP 2>&1 | sanitize

section 'df_i'
df -iP 2>&1 | sanitize

section 'root_filesystem_bytes'
df -B1P / 2>&1 | sanitize

section 'mounts'
if command -v findmnt >/dev/null 2>&1; then
  findmnt -rn -o TARGET,FSTYPE,OPTIONS 2>&1 | sanitize
else
  printf 'findmnt unavailable\n'
fi

section 'memory_and_swap'
free -b 2>&1 | sanitize
if command -v swapon >/dev/null 2>&1; then
  swapon --show --bytes --noheadings --output=TYPE,SIZE,USED,PRIO 2>&1 | sanitize
else
  printf 'swapon unavailable\n'
fi
grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree|Dirty|Writeback):' /proc/meminfo 2>/dev/null | sanitize || true

section 'current_load_and_processes'
if command -v vmstat >/dev/null 2>&1; then vmstat 1 5 2>&1 | sanitize; fi
if command -v iostat >/dev/null 2>&1; then iostat -xz 1 3 2>&1 | sanitize; fi
ps -eo pid,comm,%cpu,%mem,rss,vsz,etimes --sort=-%cpu 2>/dev/null | head -n 31 | sanitize

section 'srv_top_directories_bytes'
low_io_du -x -B1 -d 2 /srv 2>/dev/null | sort -nr | head -n 100 | sanitize

section 'opt_top_directories_bytes'
low_io_du -x -B1 -d 2 /opt 2>/dev/null | sort -nr | head -n 80 | sanitize

section 'release_and_backup_inventory'
{
  printf '%s\n' \
    /srv/seungjae-staging-releases \
    /srv/seungjae-staging-backups \
    /srv/stock-app-releases \
    /srv/stock-app-backups \
    /srv/seungjae-production-releases \
    /srv/seungjae-production-backups \
    /opt/stock-app-releases \
    /opt/stock-app-backups
  find /srv /opt -maxdepth 2 -type d \( -iname '*releases*' -o -iname '*backups*' \) -print 2>/dev/null
} | awk 'NF && !seen[$0]++' | while IFS= read -r root; do inventory_root "$root"; done

section 'deployment_state_files'
find /srv /opt -maxdepth 5 -type f \
  \( -path '*/.deploy/current-sha' -o -path '*/.deploy/last-backup' -o -name 'previous-sha.txt' \) \
  -print 2>/dev/null | sort | while IFS= read -r file; do
    printf 'STATE\t%s\tvalue=' "$file" | sanitize
    sed -n '1p' "$file" 2>/dev/null | sanitize
  done

section 'current_release_links'
find /srv /opt -maxdepth 4 -type l \
  \( -name current -o -name current-release -o -name production -o -name staging \) \
  -print 2>/dev/null | sort | while IFS= read -r link; do
    printf 'LINK\t%s\ttarget=%s\n' "$link" "$(readlink -f "$link" 2>/dev/null || true)" | sanitize
  done

section 'pm2_safe_inventory'
pm2_safe_inventory

section 'pm2_log_sizes'
pm2_log_paths | while IFS=$'\t' read -r name kind path; do
  [[ -n "$path" ]] || continue
  if [[ -e "$path" ]]; then
    printf 'PM2_LOG\tname=%s\tkind=%s\tbytes=%s\tmodified=%s\tpath=%s\n' \
      "$name" "$kind" "$(stat -c %s "$path" 2>/dev/null || printf unavailable)" \
      "$(stat -c %y "$path" 2>/dev/null || printf unavailable)" "$path" | sanitize
  fi
done
if [[ -d "$HOME/.pm2/logs" ]]; then low_io_du -x -B1 -d 1 "$HOME/.pm2/logs" 2>/dev/null | sort -nr | sanitize; fi

section 'system_log_sizes'
if [[ -d /var/log ]]; then low_io_du -x -B1 -d 2 /var/log 2>/dev/null | sort -nr | head -n 100 | sanitize; fi
if command -v journalctl >/dev/null 2>&1; then journalctl --disk-usage 2>&1 | sanitize; fi

section 'package_and_browser_cache_sizes'
for cache in \
  "$HOME/.pnpm-store" \
  "$HOME/.local/share/pnpm/store" \
  "$HOME/.cache/pnpm" \
  "$HOME/.npm" \
  "$HOME/.cache/ms-playwright" \
  /root/.pnpm-store \
  /root/.local/share/pnpm/store \
  /root/.cache/pnpm \
  /root/.npm \
  /root/.cache/ms-playwright; do
  [[ -d "$cache" ]] || continue
  printf 'CACHE\t%s\tbytes=%s\n' "$cache" "$(size_of "$cache")" | sanitize
done
find /home -maxdepth 4 -type d \( -name ms-playwright -o -name '.pnpm-store' -o -name '.npm' \) -print 2>/dev/null \
  | while IFS= read -r cache; do printf 'CACHE\t%s\tbytes=%s\n' "$cache" "$(size_of "$cache")" | sanitize; done

section 'tmp_and_temporary_build_directories'
low_io_du -x -B1 -d 1 /tmp 2>/dev/null | sort -nr | head -n 100 | sanitize
find /tmp -mindepth 1 -maxdepth 2 -type d \
  \( -name 'seungjae-staging-source.*' -o -name '*build*' -o -name '*release*' -o -name 'pnpm-*' \) \
  -printf '%T@|%TY-%Tm-%TdT%TH:%TM:%TSZ|%p\n' 2>/dev/null \
  | sort -t'|' -k1,1nr \
  | head -n 100 \
  | while IFS='|' read -r _epoch modified path; do
      printf 'TEMP_DIR\t%s\tbytes=%s\tmodified=%s\n' "$path" "$(size_of "$path")" "$modified" | sanitize
    done

section 'open_deleted_files'
if command -v lsof >/dev/null 2>&1; then
  lsof -nP +L1 2>/dev/null \
    | awk 'NR==1 {print; next} {size=$7; if (size ~ /^[0-9]+$/) total+=size; print} END {print "OPEN_DELETED_TOTAL_BYTES", total+0}' \
    | head -n 100 | sanitize
else
  printf 'lsof unavailable\n'
fi

section 'incident_system_and_proxy_logs'
if command -v journalctl >/dev/null 2>&1; then
  journalctl --since "$INCIDENT_START" --until "$INCIDENT_END" --no-pager -o short-iso 2>&1 \
    | grep -Ei '502|watchlist|scanner|seungjae-staging|ENOSPC|No space left|ENOMEM|out of memory|oom|timeout|ECONN|EAI_AGAIN|upstream|SIG' \
    | tail -n 600 | sanitize || true
else
  printf 'journalctl unavailable\n'
fi

section 'incident_pm2_application_logs'
pm2_log_paths | while IFS=$'\t' read -r name kind path; do
  [[ -r "$path" ]] || continue
  matches="$(tail -n 20000 "$path" 2>/dev/null \
    | grep -Ei '\[watchlist\]|WATCHLIST_STORE_ERROR|/api/watchlist/sync|scanner|502|ENOSPC|No space left|ENOMEM|out of memory|oom|timeout|ECONN|EAI_AGAIN|SIG' \
    | tail -n 300 || true)"
  [[ -n "$matches" ]] || continue
  printf -- '--- PM2_LOG_MATCH name=%s kind=%s path=%s ---\n' "$name" "$kind" "$path" | sanitize
  printf '%s\n' "$matches" | sanitize
done

section 'incident_proxy_log_files'
find /var/log -maxdepth 3 -type f \( -iname '*caddy*' -o -path '*/nginx/*' \) -print 2>/dev/null \
  | head -n 50 \
  | while IFS= read -r path; do
      [[ -r "$path" ]] || continue
      matches="$(tail -n 20000 "$path" 2>/dev/null \
        | grep -Ei '502|/api/watchlist/sync|/scanner|upstream|timeout|connect' \
        | tail -n 300 || true)"
      [[ -n "$matches" ]] || continue
      printf -- '--- PROXY_LOG_MATCH path=%s ---\n' "$path" | sanitize
      printf '%s\n' "$matches" | sanitize
    done

section 'kernel_resource_pressure_signals'
if command -v journalctl >/dev/null 2>&1; then
  journalctl -k --since "$INCIDENT_START" --until "$INCIDENT_END" --no-pager -o short-iso 2>&1 \
    | grep -Ei 'oom|out of memory|killed process|ENOSPC|No space left|I/O error|blocked for more than|ext4|xfs' \
    | tail -n 300 | sanitize || true
fi

section 'read_only_contract'
printf 'server_files_written=0\nserver_files_deleted=0\nserver_processes_restarted=0\nserver_processes_stopped=0\ndeployment_executed=0\nsecret_values_collected=0\nREAD_ONLY_DIAGNOSTICS_COMPLETE\n'
