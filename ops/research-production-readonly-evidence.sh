#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C

TARGET_RESEARCH_SHA="${TARGET_RESEARCH_SHA:-}"
[[ "$TARGET_RESEARCH_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'TARGET_RESEARCH_SHA must be an exact lowercase 40-character SHA' >&2
  exit 64
}

ROOT=/opt/investment-research
STATE=/var/lib/investment-research-production
EXPECTED_RELEASE="$ROOT/releases/$TARGET_RESEARCH_SHA"
CURRENT="$ROOT/current"

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
else
  SUDO=(sudo -n)
  "${SUDO[@]}" true
fi

one_line() {
  tr '\t\r\n ' '_____'
}

read_file() {
  "${SUDO[@]}" cat -- "$1"
}

file_exists() {
  "${SUDO[@]}" test -f "$1"
}

systemd_value() {
  local unit="$1"
  local property="$2"
  "${SUDO[@]}" systemctl show "$unit" --property="$property" --value 2>/dev/null | one_line
}

current_release="$("${SUDO[@]}" readlink -f -- "$CURRENT" 2>/dev/null || true)"
current_match=false
[[ "$current_release" == "$EXPECTED_RELEASE" ]] && current_match=true

app_sha=absent
if "${SUDO[@]}" test -s /opt/stock-app/.deploy/current-sha; then
  app_sha="$(read_file /opt/stock-app/.deploy/current-sha | tr -d '[:space:]')"
fi

printf '%s\n' \
  'RESEARCH_PRODUCTION_READONLY_EVIDENCE_BEGIN' \
  "target_research_sha=$TARGET_RESEARCH_SHA" \
  "current_release=$current_release" \
  "current_release_match=$current_match" \
  "existing_app_sha=$app_sha" \
  'server_files_written=0' \
  'server_files_deleted=0' \
  'server_processes_restarted=0' \
  'deployment_executed=0' \
  'database_changes=0' \
  'live_trading=false' \
  'private_api=false' \
  'order_authority=false' \
  'real_order_count=0'

for profile in forward fast-historical long-history; do
  timer="research-production-${profile}.timer"
  service="research-production@${profile}.service"
  enabled="$("${SUDO[@]}" systemctl is-enabled "$timer" 2>/dev/null || true)"
  active="$("${SUDO[@]}" systemctl is-active "$timer" 2>/dev/null || true)"
  printf 'TIMER profile=%s enabled=%s active=%s last_trigger=%s next_elapse=%s\n' \
    "$profile" "${enabled:-unknown}" "${active:-unknown}" \
    "$(systemd_value "$timer" LastTriggerUSec)" \
    "$(systemd_value "$timer" NextElapseUSecRealtime)"
  printf 'SERVICE profile=%s active=%s sub=%s result=%s exec_status=%s start=%s exit=%s\n' \
    "$profile" \
    "$(systemd_value "$service" ActiveState)" \
    "$(systemd_value "$service" SubState)" \
    "$(systemd_value "$service" Result)" \
    "$(systemd_value "$service" ExecMainStatus)" \
    "$(systemd_value "$service" ExecMainStartTimestamp)" \
    "$(systemd_value "$service" ExecMainExitTimestamp)"
done

emit_cycle() {
  local profile="$1"
  local file="$STATE/latest/$profile.json"
  if ! file_exists "$file"; then
    printf 'CYCLE profile=%s present=false\n' "$profile"
    return 0
  fi
  read_file "$file" | node -e '
    let raw="";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => raw += c);
    process.stdin.on("end", () => {
      const profile = process.argv[1];
      const value = JSON.parse(raw);
      const clean = x => String(x ?? "null").replace(/[\t\r\n ]/g, "_").slice(0, 300);
      console.log([
        "CYCLE",
        `profile=${clean(profile)}`,
        "present=true",
        `cycle_id=${clean(value.cycleId)}`,
        `research_sha=${clean(value.researchSha)}`,
        `generated_at=${clean(value.generatedAt)}`,
        `status=${clean(value.status)}`,
        `concurrency=${clean(value.concurrency)}`,
        `task_count=${clean(value.taskCount)}`,
        `success_count=${clean(value.successCount)}`,
        `blocked_data_count=${clean(value.blockedDataCount)}`,
        `failed_count=${clean(value.failedCount)}`,
      ].join(" "));
      for (const row of Array.isArray(value.results) ? value.results : []) {
        console.log([
          "TASK",
          `profile=${clean(profile)}`,
          `id=${clean(row.id)}`,
          `status=${clean(row.status)}`,
          `exit_code=${clean(row.exitCode)}`,
          `timed_out=${clean(row.timedOut)}`,
          `started_at=${clean(row.startedAt)}`,
          `ended_at=${clean(row.endedAt)}`,
          `duration_ms=${clean(row.durationMs)}`,
          `live_trading=${clean(row.liveTrading)}`,
          `private_api=${clean(row.privateApi)}`,
          `order_authority=${clean(row.orderAuthority)}`,
        ].join(" "));
      }
    });
  ' "$profile"
}

emit_cycle forward
emit_cycle fast-historical
emit_cycle long-history

paper_status="$STATE/forward/paper/status/runtime-status.json"
if file_exists "$paper_status"; then
  read_file "$paper_status" | node -e '
    let raw="";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => raw += c);
    process.stdin.on("end", () => {
      const v = JSON.parse(raw);
      const clean = x => String(x ?? "null").replace(/[\t\r\n ]/g, "_").slice(0, 300);
      const lanes = Array.isArray(v.lanes) ? v.lanes : [];
      console.log([
        "PAPER_RUNTIME",
        "present=true",
        `status=${clean(v.status)}`,
        `cycle_id=${clean(v.cycleId)}`,
        `schedule_active=${clean(v.scheduleActive)}`,
        `all_providers_ready=${clean(v.allProvidersReady)}`,
        `public_forward_evidence_accumulating=${clean(v.publicForwardEvidenceAccumulating)}`,
        `paper_trade_outcome_accumulating=${clean(v.paperTradeOutcomeAccumulating)}`,
        `lane_count=${lanes.length}`,
        `lane_states=${clean(lanes.map(x => `${x.market ?? x.lane ?? x.provider ?? "lane"}:${x.status ?? "unknown"}`).join(","))}`,
        `private_request_count=${clean(v.privateRequestCount)}`,
        `financial_mutation_count=${clean(v.financialMutationCount)}`,
        `order_count=${clean(v.orderCount)}`,
        `live_trading=${clean(v.liveTrading)}`,
        `order_authority=${clean(v.orderAuthority)}`,
      ].join(" "));
    });
  '
else
  echo 'PAPER_RUNTIME present=false'
fi

paper_state="$STATE/forward/paper/state/recurring-paper-loop.json"
if file_exists "$paper_state"; then
  read_file "$paper_state" | node -e '
    let raw="";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => raw += c);
    process.stdin.on("end", () => {
      const v = JSON.parse(raw);
      console.log([
        "PAPER_LEDGER",
        "present=true",
        `cycle_count=${Array.isArray(v.cycles) ? v.cycles.length : 0}`,
        `position_count=${Array.isArray(v.positions) ? v.positions.length : 0}`,
        `settlement_count=${Array.isArray(v.settlements) ? v.settlements.length : 0}`,
      ].join(" "));
    });
  '
else
  echo 'PAPER_LEDGER present=false'
fi

shadow_summary="$STATE/forward/shadow-summary.json"
shadow_state="$STATE/forward/shadow-state.json"
if file_exists "$shadow_summary"; then
  read_file "$shadow_summary" | node -e '
    let raw="";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => raw += c);
    process.stdin.on("end", () => {
      const root = JSON.parse(raw);
      const clean = x => String(x ?? "null").replace(/[\t\r\n ]/g, "_").slice(0, 300);
      console.log("SHADOW_SUMMARY present=true");
      const candidates = root.groups && typeof root.groups === "object" ? root.groups : root;
      for (const [name, value] of Object.entries(candidates)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const total = value.total ?? value.totalCount ?? value.records ?? value.sampleSize;
        const settled = value.settled ?? value.settledCount;
        const pending = value.pending ?? value.pendingCount;
        const collapsed = value.predictionHealth?.collapsed ?? value.collapsed;
        const macroF1 = value.macroF1 ?? value.metrics?.macroF1;
        const balanced = value.balancedAccuracy ?? value.metrics?.balancedAccuracy;
        if ([total, settled, pending, collapsed, macroF1, balanced].every(x => x === undefined)) continue;
        console.log([
          "SHADOW_GROUP",
          `name=${clean(name)}`,
          `total=${clean(total)}`,
          `settled=${clean(settled)}`,
          `pending=${clean(pending)}`,
          `collapsed=${clean(collapsed)}`,
          `macro_f1=${clean(macroF1)}`,
          `balanced_accuracy=${clean(balanced)}`,
        ].join(" "));
      }
    });
  '
else
  echo 'SHADOW_SUMMARY present=false'
fi

if file_exists "$shadow_state"; then
  read_file "$shadow_state" | node -e '
    let raw="";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => raw += c);
    process.stdin.on("end", () => {
      const v = JSON.parse(raw);
      let total=0, settled=0, pending=0;
      const visit = value => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) { for (const item of value) visit(item); return; }
        if (Array.isArray(value.records)) {
          total += value.records.length;
          settled += value.records.filter(x => x?.status === "settled").length;
          pending += value.records.filter(x => x?.status === "pending").length;
        }
        for (const child of Object.values(value)) if (child && typeof child === "object" && child !== value.records) visit(child);
      };
      visit(v);
      console.log(`SHADOW_STATE present=true total_records=${total} settled_records=${settled} pending_records=${pending}`);
    });
  '
else
  echo 'SHADOW_STATE present=false'
fi

printf '%s\n' 'RESEARCH_PRODUCTION_READONLY_EVIDENCE_END'
