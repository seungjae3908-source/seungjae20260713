#!/usr/bin/env python3
from pathlib import Path

path = Path('scripts/agent_hub_policy.py')
text = path.read_text(encoding='utf-8')

old_guard = '''    elif proposal.action_type not in worker.allowed_action_types:
        reason_override = "worker가 허용하지 않는 action_type"
'''
new_guard = '''    elif action_rule["decision"] == "ready" and proposal.action_type not in worker.allowed_action_types:
        reason_override = "worker가 자동 허용하지 않는 action_type"
'''
if text.count(old_guard) != 1:
    raise SystemExit('approval action guard target mismatch')
text = text.replace(old_guard, new_guard)

old_merge = '''    merge_p = Proposal(**{**proposal.__dict__, "action_type":"merge_pr"})
    d = evaluate_proposal(proposal=merge_p, policy=policy, workers=workers, repository="owner/repo",
        task_id="task-3", report_comment_id=103, report_head_sha=base, base_sha="b"*40, current_branch_sha=base)
    check(d.fields["status"] == "blocked", "worker not allowed merge must be blocked")
'''
new_merge = '''    merge_p = Proposal(**{**proposal.__dict__, "action_type":"merge_pr"})
    d = evaluate_proposal(proposal=merge_p, policy=policy, workers=workers, repository="owner/repo",
        task_id="task-3", report_comment_id=103, report_head_sha=base, base_sha="b"*40, current_branch_sha=base)
    check(d.fields["status"] == "waiting_approval", "merge must always wait approval")
    check(d.fields["requires_user_approval"] == "true", "merge approval flag missing")
    check(all(field in d.approval_details for field in policy["approval_request_fields"]), "merge approval fields missing")
'''
if text.count(old_merge) != 1:
    raise SystemExit('merge test target mismatch')
text = text.replace(old_merge, new_merge)

marker = '''    check(d.fields["status"] == "waiting_approval", "staging deploy must wait approval")
    check(all(field in d.approval_details for field in policy["approval_request_fields"]), "approval fields missing")
'''
addition = marker + '''
    production_p = Proposal(**{**ops_p.__dict__, "action_type":"prepare_production_deploy"})
    d = evaluate_proposal(proposal=production_p, policy=policy, workers=workers, repository="owner/repo",
        task_id="task-4-production", report_comment_id=1004, report_head_sha=base, base_sha="b"*40, current_branch_sha=base)
    check(d.fields["status"] == "waiting_approval", "production deploy preparation must wait approval")
    check(d.fields["required_approval_phrase"].startswith("승인:prepare_production_deploy:"), "production approval phrase missing")
'''
if text.count(marker) != 1:
    raise SystemExit('production approval test insertion target mismatch')
text = text.replace(marker, addition)

path.write_text(text, encoding='utf-8')
Path(__file__).unlink()
print('Agent Hub approval policy corrected.')
