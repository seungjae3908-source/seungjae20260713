#!/usr/bin/env bash
set -uo pipefail
export LC_ALL=C

: "${EXPECTED_PRODUCTION_SHA:?EXPECTED_PRODUCTION_SHA is required}"
: "${EXPECTED_STAGING_SHA:?EXPECTED_STAGING_SHA is required}"
: "${EXPECTED_PUBLIC_IP:?EXPECTED_PUBLIC_IP is required}"

failures=0

section() { printf '\n===== %s =====\n' "$1"; }

sanitize() {
  sed -E \
    -e 's#https?://[^[:space:]"<>]+#<URL_REDACTED>#g' \
    -e 's#(authorization|apikey|api_key|token|secret|password)[=:][[:space:]]*(Bearer[[:space:]]+)?[^[:space:]]+#\1=<REDACTED>#Ig' \
    -e 's#([?&](token|apikey|api_key|key|secret|password)=)[^&[:space:]]+#\1<REDACTED>#Ig' \
    -e 's#eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}#<JWT_REDACTED>#g' \
    -e 's#\b([0-9]{1,3}\.){3}[0-9]{1,3}\b#<IP_REDACTED>#g' \
    -e 's#/home/[^/[:space:]]+#/home/<user>#g' \
    -e 's#/root([/[:space:]]|$)#/<root>\1#g'
}

record_failure() {
  failures=$((failures + 1))
  printf 'DIAGNOSTIC_FAILURE\t%s\n' "$1" | sanitize
}

low_io_du() {
  if command -v ionice >/dev/null 2>&1; then
    ionice -c3 nice -n 19 du "$@"
  else
    nice -n 19 du "$@"
  fi
}

size_of() {
  local path="$1"
  low_io_du -x -B1 -s -- "$path" 2>/dev/null | awk '{print $1}'
}

state_for_pct() {
  local value="$1" warn="$2" critical="$3"
  if ! [[ "$value" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    printf 'UNAVAILABLE'
    return
  fi
  awk -v v="$value" -v w="$warn" -v c="$critical" 'BEGIN {
    if (v >= c) print "CRITICAL";
    else if (v >= w) print "WARN";
    else print "OK";
  }'
}

emit_resource_summary() {
  local disk inode mem_total mem_available mem swap_total swap_free swap load5 cpus load_capacity
  disk="$(df -P / 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
  inode="$(df -iP / 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
  mem_total="$(awk '/^MemTotal:/ {print $2; exit}' /proc/meminfo 2>/dev/null)"
  mem_available="$(awk '/^MemAvailable:/ {print $2; exit}' /proc/meminfo 2>/dev/null)"
  swap_total="$(awk '/^SwapTotal:/ {print $2; exit}' /proc/meminfo 2>/dev/null)"
  swap_free="$(awk '/^SwapFree:/ {print $2; exit}' /proc/meminfo 2>/dev/null)"
  load5="$(awk '{print $2}' /proc/loadavg 2>/dev/null)"
  cpus="$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf 0)"

  mem=unavailable
  if [[ "$mem_total" =~ ^[0-9]+$ && "$mem_available" =~ ^[0-9]+$ && "$mem_total" -gt 0 ]]; then
    mem="$(awk -v t="$mem_total" -v a="$mem_available" 'BEGIN {printf "%.1f", ((t-a)/t)*100}')"
  fi

  swap=0
  if [[ "$swap_total" =~ ^[0-9]+$ && "$swap_total" -gt 0 && "$swap_free" =~ ^[0-9]+$ ]]; then
    swap="$(awk -v t="$swap_total" -v f="$swap_free" 'BEGIN {printf "%.1f", ((t-f)/t)*100}')"
  fi

  load_capacity=unavailable
  if [[ "$cpus" =~ ^[0-9]+$ && "$cpus" -gt 0 && "$load5" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    load_capacity="$(awk -v l="$load5" -v c="$cpus" 'BEGIN {printf "%.1f", (l/c)*100}')"
  fi

  local disk_state inode_state mem_state swap_state load_state criticals=0
  disk_state="$(state_for_pct "${disk:-unavailable}" 75 85)"
  inode_state="$(state_for_pct "${inode:-unavailable}" 75 90)"
  mem_state="$(state_for_pct "$mem" 75 90)"
  swap_state="$(state_for_pct "$swap" 30 60)"
  load_state="$(state_for_pct "$load_capacity" 70 90)"
  printf 'RESOURCE_HEALTH\tmetric=root_disk_used_pct\tvalue=%s\tstate=%s\twarn=75\tcritical=85\n' "${disk:-unavailable}" "$disk_state"
  printf 'RESOURCE_HEALTH\tmetric=root_inode_used_pct\tvalue=%s\tstate=%s\twarn=75\tcritical=90\n' "${inode:-unavailable}" "$inode_state"
  printf 'RESOURCE_HEALTH\tmetric=memory_used_pct\tvalue=%s\tstate=%s\twarn=75\tcritical=90\n' "$mem" "$mem_state"
  printf 'RESOURCE_HEALTH\tmetric=swap_used_pct\tvalue=%s\tstate=%s\twarn=30\tcritical=60\n' "$swap" "$swap_state"
  printf 'RESOURCE_HEALTH\tmetric=load5_capacity_pct\tvalue=%s\tstate=%s\twarn=70\tcritical=90\n' "$load_capacity" "$load_state"
  for state in "$disk_state" "$inode_state" "$mem_state" "$swap_state" "$load_state"; do
    [[ "$state" == CRITICAL ]] && criticals=$((criticals+1))
  done
  [[ "$criticals" -eq 0 ]] || record_failure critical_resource_pressure
}

public_ipv4() {
  ip -4 -o addr show scope global 2>/dev/null \
    | awk '{split($4,a,"/"); print a[1]}' \
    | awk '
      function private(ip,a) {
        split(ip,a,".");
        return a[1]==10 || (a[1]==172 && a[2]>=16 && a[2]<=31) ||
          (a[1]==192 && a[2]==168) || a[1]==127 || (a[1]==169 && a[2]==254);
      }
      !private($0) {print; exit}
    '
}

pm2_inventory() {
  if ! command -v pm2 >/dev/null 2>&1; then
    printf 'PM2_STATUS\tavailable=false\n'
    record_failure pm2_unavailable
    return
  fi
  pm2 jlist 2>/dev/null | node -e '
    let input="";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => input += c);
    process.stdin.on("end", () => {
      try {
        const rows=JSON.parse(input);
        const stable=[
          ["kiwoom-proxy","online","/opt/kiwoom-proxy"],
          ["stock-app","online","/opt/stock-app"],
          ["seungjae-staging","online","/srv/seungjae-staging/api-server"],
        ];
        for (const [name,expectedStatus,expectedCwd] of stable) {
          const row=rows.find(r => String(r.name ?? "")===name);
          const status=String(row?.pm2_env?.status ?? "missing");
          const cwd=String(row?.pm2_env?.pm_cwd ?? "missing");
          const match=status===expectedStatus && cwd===expectedCwd ? 1 : 0;
          process.stdout.write([
            "PM2_STABLE",
            `name=${name}`,
            `status=${status}`,
            `expected_status=${expectedStatus}`,
            `cwd=${cwd}`,
            `expected_cwd=${expectedCwd}`,
            `restart_count=${Number(row?.pm2_env?.restart_time ?? -1)}`,
            `memory_bytes=${Number(row?.monit?.memory ?? 0)}`,
            `cpu_pct=${Number(row?.monit?.cpu ?? 0)}`,
            `match=${match}`,
          ].join("\t")+"\n");
        }
        const pattern=/^(stock-app|stock-signal-worker)-([0-9a-f]{7,40})-(canary|production)$/i;
        for (const row of rows) {
          const name=String(row.name ?? "");
          const match=pattern.exec(name);
          if (!match) continue;
          process.stdout.write([
            "PM2_RELEASE_PROCESS",
            `name=${name}`,
            `service=${match[1]}`,
            `release_sha=${match[2].toLowerCase()}`,
            `role=${match[3].toLowerCase()}`,
            `status=${String(row.pm2_env?.status ?? "missing")}`,
            `cwd=${String(row.pm2_env?.pm_cwd ?? "")}`,
            `restart_count=${Number(row.pm2_env?.restart_time ?? -1)}`,
            `memory_bytes=${Number(row.monit?.memory ?? 0)}`,
            `cpu_pct=${Number(row.monit?.cpu ?? 0)}`,
            "required_for_service_verdict=false",
          ].join("\t")+"\n");
        }
      } catch {
        process.stdout.write("PM2_STATUS\tavailable=true\tparse_ok=false\n");
      }
    });
  ' | sanitize
}

stable_pm2_failures() {
  pm2 jlist 2>/dev/null | node -e '
    let input="";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => input += c);
    process.stdin.on("end", () => {
      try {
        const rows=JSON.parse(input);
        const stable=[
          ["kiwoom-proxy","online","/opt/kiwoom-proxy"],
          ["stock-app","online","/opt/stock-app"],
          ["seungjae-staging","online","/srv/seungjae-staging/api-server"],
        ];
        let failures=0;
        for (const [name,status,cwd] of stable) {
          const row=rows.find(r => String(r.name ?? "")===name);
          if (String(row?.pm2_env?.status ?? "")!==status ||
              String(row?.pm2_env?.pm_cwd ?? "")!==cwd) failures++;
        }
        process.stdout.write(String(failures));
      } catch { process.stdout.write("3"); }
    });
  '
}

inventory_root() {
  local root="$1"
  [[ -d "$root" ]] || return
  local count bytes
  count="$(find "$root" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  bytes="$(size_of "$root")"
  printf 'INVENTORY_ROOT\tpath=%s\tcount=%s\tbytes=%s\n' "$root" "$count" "${bytes:-unavailable}" | sanitize
}

allowed_backup_path() {
  case "$1" in
    /srv/seungjae-staging-backups/*|/srv/stock-app-backups/*|/srv/seungjae-production-backups/*|/opt/stock-app-backups/*) return 0 ;;
    *) return 1 ;;
  esac
}

backup_summary() {
  local target="$1" live="$2"
  shift 2
  local marker root count=0 newest='' newest_age=unavailable newest_bytes=unavailable newest_modified=unavailable marker_exists=0 previous_sha=0 previous_sha_differs=unavailable status=unverified
  marker="$(sed -n '1p' "$live/.deploy/last-backup" 2>/dev/null | tr -d '\r\n')"

  root=''
  if [[ -n "$marker" ]] && allowed_backup_path "$marker" && [[ -d "$marker" ]]; then
    marker_exists=1
    root="$(dirname "$marker")"
  else
    local candidate
    for candidate in "$@"; do
      if [[ -d "$candidate" ]]; then root="$candidate"; break; fi
    done
  fi

  if [[ -n "$root" && -d "$root" ]]; then
    count="$(find "$root" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
    newest="$(find "$root" -mindepth 1 -maxdepth 1 -type d -printf '%T@|%p\n' 2>/dev/null | sort -t'|' -k1,1nr | head -n1 | cut -d'|' -f2-)"
    if [[ -n "$newest" && -d "$newest" ]]; then
      newest_bytes="$(size_of "$newest")"
      newest_modified="$(stat -c %y "$newest" 2>/dev/null || printf unavailable)"
      local epoch
      epoch="$(stat -c %Y "$newest" 2>/dev/null || true)"
      [[ "$epoch" =~ ^[0-9]+$ ]] && newest_age="$(($(date +%s)-epoch))"
    fi
  fi

  if [[ "$marker_exists" -eq 1 ]]; then
    if [[ -r "$marker/previous-sha.txt" ]] && grep -Eq '^[0-9a-fA-F]{40}$' "$marker/previous-sha.txt"; then
      previous_sha=1
      local previous expected_current
      previous="$(sed -n '1p' "$marker/previous-sha.txt" | tr -d '\r\n')"
      if [[ "$target" == production ]]; then expected_current="$EXPECTED_PRODUCTION_SHA"; else expected_current="$EXPECTED_STAGING_SHA"; fi
      if [[ "$previous" != "$expected_current" ]]; then previous_sha_differs=1; else previous_sha_differs=0; fi
      status=material_present_restore_unverified
    else
      status=marker_present_previous_sha_unverified
    fi
  elif [[ "$count" -gt 0 ]]; then
    status=inventory_present_marker_unverified
  fi

  printf 'LOCAL_BACKUP\ttarget=%s\tstatus=%s\troot=%s\tcount=%s\tnewest_bytes=%s\tnewest_modified=%s\tnewest_age_seconds=%s\tlast_backup_marker_present=%s\tmarker_target_exists=%s\tprevious_sha_present=%s\tprevious_sha_differs_from_current=%s\n' \
    "$target" "$status" "${root:-unavailable}" "$count" "$newest_bytes" "$newest_modified" "$newest_age" \
    "$([[ -n "$marker" ]] && printf 1 || printf 0)" "$marker_exists" "$previous_sha" "$previous_sha_differs" | sanitize
}

db_backup_summary() {
  local roots=(
    /srv/postgres-backups
    /srv/database-backups
    /srv/stock-app-backups/postgres
    /srv/seungjae-production-backups/postgres
    /opt/stock-app-backups/postgres
    /var/backups/postgresql
  )
  local count=0 newest_epoch=0 newest_bytes=unavailable root line epoch bytes
  for root in "${roots[@]}"; do
    [[ -d "$root" ]] || continue
    while IFS='|' read -r epoch bytes; do
      [[ "$epoch" =~ ^[0-9]+([.][0-9]+)?$ ]] || continue
      count=$((count+1))
      if awk -v a="$epoch" -v b="$newest_epoch" 'BEGIN {exit !(a>b)}'; then
        newest_epoch="$epoch"
        newest_bytes="$bytes"
      fi
    done < <(find "$root" -maxdepth 4 -type f \
      \( -iname '*.dump' -o -iname '*.backup' -o -iname '*.pgdump' -o -iname '*.sql' -o -iname '*.sql.gz' \) \
      -printf '%T@|%s\n' 2>/dev/null)
  done

  local status=unverified_no_dedicated_artifact_evidence newest_age=unavailable epoch_int
  if [[ "$count" -gt 0 ]]; then
    status=artifact_evidence_present_restore_unverified
    epoch_int="${newest_epoch%%.*}"
    [[ "$epoch_int" =~ ^[0-9]+$ ]] && newest_age="$(($(date +%s)-epoch_int))"
  fi
  printf 'DB_BACKUP\tstatus=%s\tartifact_count=%s\tnewest_bytes=%s\tnewest_age_seconds=%s\tcredentialed_db_probe=false\trestore_verified=false\n' \
    "$status" "$count" "$newest_bytes" "$newest_age"
}

restore_drill_summary() {
  local target="$1" live="$2" marker="$2/.deploy/last-restore-drill"
  if [[ -s "$marker" ]]; then
    printf 'RESTORE_DRILL\ttarget=%s\tstatus=marker_evidence_present_restore_not_reexecuted\tmarker_present=1\n' "$target"
  else
    printf 'RESTORE_DRILL\ttarget=%s\tstatus=UNVERIFIED\tmarker_present=0\n' "$target"
  fi
}

health_probe() {
  local target="$1" url="$2" expected_sha="$3"
  local response rc status body sha ok match=0
  response="$(curl -sS --connect-timeout 5 --max-time 15 --max-filesize 262144 -w $'\n__STATUS__%{http_code}' "$url" 2>/dev/null)"
  rc=$?
  status="$(printf '%s\n' "$response" | tail -n1 | sed 's/^__STATUS__//')"
  body="$(printf '%s\n' "$response" | sed '$d')"
  read -r sha ok < <(printf '%s' "$body" | node -e '
    let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>{
      try { const j=JSON.parse(s); const sha=String(j.sha ?? j.deploySha ?? "") || "-"; const ok=j.ok===true || j.status==="ok"; process.stdout.write(`${sha} ${ok}`); }
      catch { process.stdout.write("- false"); }
    });
  ')
  [[ "$sha" == "-" ]] && sha=''
  [[ "$sha" == "$expected_sha" ]] && match=1
  printf 'HEALTH\ttarget=%s\tstatus=%s\ttransport_ok=%s\tok=%s\tsha_present=%s\tsha_match=%s\texpected_sha=%s\n' \
    "$target" "${status:-000}" "$([[ "$rc" -eq 0 ]] && printf 1 || printf 0)" "$ok" \
    "$([[ -n "$sha" ]] && printf 1 || printf 0)" "$match" "$expected_sha"
  if [[ "$rc" -ne 0 || "$status" != 200 || "$ok" != true || "$match" -ne 1 ]]; then
    record_failure "health_${target}"
  fi
}

section diagnostic_identity
printf 'mode=read_only\ncollected_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'hostname='; hostname 2>/dev/null | sanitize || true
printf 'kernel='; uname -srmo 2>/dev/null | sanitize || true
printf 'uptime='; uptime 2>/dev/null | sanitize || true
printf 'cpu_count='; getconf _NPROCESSORS_ONLN 2>/dev/null || true
current_ip="$(public_ipv4)"
printf 'public_ip_present=%s\n' "$([[ -n "$current_ip" ]] && printf 1 || printf 0)"
printf 'public_ip_match=%s\n' "$([[ "$current_ip" == "$EXPECTED_PUBLIC_IP" ]] && printf 1 || printf 0)"
[[ "$current_ip" == "$EXPECTED_PUBLIC_IP" ]] || record_failure public_ip_mismatch

section resource_health
df -hP 2>&1 | sanitize
df -iP 2>&1 | sanitize
free -b 2>&1 | sanitize
emit_resource_summary
ps -eo pid,comm,%cpu,%mem,rss,vsz,etimes --sort=-%cpu 2>/dev/null | head -n31 | sanitize

section filesystem_inventory
low_io_du -x -B1 -d 2 /srv 2>/dev/null | sort -nr | head -n100 | sanitize
low_io_du -x -B1 -d 2 /opt 2>/dev/null | sort -nr | head -n80 | sanitize
for root in \
  /srv/seungjae-staging-releases /srv/seungjae-staging-backups \
  /srv/stock-app-releases /srv/stock-app-backups \
  /srv/seungjae-production-releases /srv/seungjae-production-backups \
  /opt/stock-app-releases /opt/stock-app-backups; do
  inventory_root "$root"
done

section deployment_identity
production_sha="$(sed -n '1p' /opt/stock-app/.deploy/current-sha 2>/dev/null | tr -d '\r\n')"
staging_sha="$(sed -n '1p' /srv/seungjae-staging/.deploy/current-sha 2>/dev/null | tr -d '\r\n')"
printf 'SHA_CHECK\ttarget=production\tactual=%s\texpected=%s\tmatch=%s\n' \
  "${production_sha:-unavailable}" "$EXPECTED_PRODUCTION_SHA" "$([[ "$production_sha" == "$EXPECTED_PRODUCTION_SHA" ]] && printf 1 || printf 0)"
printf 'SHA_CHECK\ttarget=staging\tactual=%s\texpected=%s\tmatch=%s\n' \
  "${staging_sha:-unavailable}" "$EXPECTED_STAGING_SHA" "$([[ "$staging_sha" == "$EXPECTED_STAGING_SHA" ]] && printf 1 || printf 0)"
[[ "$production_sha" == "$EXPECTED_PRODUCTION_SHA" ]] || record_failure production_sha_mismatch
[[ "$staging_sha" == "$EXPECTED_STAGING_SHA" ]] || record_failure staging_sha_mismatch

section pm2_processes
printf 'release_scoped_processes_are_dynamic=true\nrelease_scoped_processes_required_for_service_verdict=false\n'
pm2_inventory
if command -v pm2 >/dev/null 2>&1; then
  pm2_failures="$(stable_pm2_failures)"
  [[ "$pm2_failures" == 0 ]] || record_failure stable_pm2_mismatch
fi

section caddy
caddy_active="$(systemctl is-active caddy 2>/dev/null || true)"
printf 'CADDY_SERVICE\tactive_state=%s\n' "${caddy_active:-unavailable}"
[[ "$caddy_active" == active ]] || record_failure caddy_not_active
if command -v caddy >/dev/null 2>&1; then
  if caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    printf 'CADDY_VALIDATE\tvalid=1\n'
  else
    printf 'CADDY_VALIDATE\tvalid=0\n'
    record_failure caddy_config_invalid
  fi
else
  printf 'CADDY_VALIDATE\tvalid=0\n'
  record_failure caddy_unavailable
fi

section health
health_probe production-external 'https://lsj119.duckdns.org/api/health' "$EXPECTED_PRODUCTION_SHA"
health_probe staging-external 'https://lsj119-staging.duckdns.org/api/health' "$EXPECTED_STAGING_SHA"

section resilience_readiness
backup_summary production /opt/stock-app \
  /opt/stock-app-backups /srv/stock-app-backups /srv/seungjae-production-backups
backup_summary staging /srv/seungjae-staging /srv/seungjae-staging-backups
db_backup_summary
printf 'OFFSITE_BACKUP\tstatus=UNVERIFIED\treason=external_store_probe_not_in_read_only_contract\n'
restore_drill_summary production /opt/stock-app
restore_drill_summary staging /srv/seungjae-staging
printf 'RESILIENCE_SUMMARY\toverall_evidence_state=PARTIAL_UNVERIFIED\tlocal_backup_is_not_offsite_backup=true\tdb_artifact_presence_is_not_restore_proof=true\tunknown_is_never_pass=true\n'

section cache_tmp_log_sizes
for path in \
  "$HOME/.pnpm-store" "$HOME/.local/share/pnpm/store" "$HOME/.cache/pnpm" "$HOME/.npm" "$HOME/.cache/ms-playwright" \
  /root/.pnpm-store /root/.local/share/pnpm/store /root/.cache/pnpm /root/.npm /root/.cache/ms-playwright; do
  [[ -d "$path" ]] || continue
  printf 'CACHE\tpath=%s\tbytes=%s\n' "$path" "$(size_of "$path")" | sanitize
done
low_io_du -x -B1 -d 1 /tmp 2>/dev/null | sort -nr | head -n100 | sanitize
if [[ -d /var/log ]]; then low_io_du -x -B1 -d 2 /var/log 2>/dev/null | sort -nr | head -n100 | sanitize; fi
if command -v journalctl >/dev/null 2>&1; then journalctl --disk-usage 2>&1 | sanitize; fi

section resource_pressure_logs
if command -v journalctl >/dev/null 2>&1; then
  journalctl -k -b --no-pager -n 500 2>/dev/null \
    | grep -Ei 'oom|out of memory|killed process|ENOSPC|No space left|I/O error|blocked for more than|ext4|xfs' \
    | tail -n100 | sanitize || true
fi

section verdict
printf 'diagnostic_failures=%s\n' "$failures"
if [[ "$failures" -eq 0 ]]; then
  printf 'server_resilience_diagnostic_status=passed\n'
else
  printf 'server_resilience_diagnostic_status=failed\n'
fi

section read_only_contract
printf 'server_files_written=0\nserver_files_deleted=0\nserver_processes_restarted=0\nserver_processes_stopped=0\ndeployment_executed=0\ndatabase_changes=0\nsecret_values_collected=0\nSERVER_RESILIENCE_READ_ONLY_DIAGNOSTICS_COMPLETE\n'
