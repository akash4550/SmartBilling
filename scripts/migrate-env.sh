#!/usr/bin/env bash
# =============================================================================
# migrate-env.sh — codemod raw process.env.XYZ reads to the validated `env` obj
#
# Usage:
#   chmod +x scripts/migrate-env.sh
#   ./scripts/migrate-env.sh           # dry-run (prints diff-equivalent report)
#   ./scripts/migrate-env.sh --write   # rewrites files in place
#
# What it does:
#   1. Adds `import { env } from "@/env";` near the top of every file that
#      touches process.env, unless the import already exists.
#   2. Replaces `process.env.FOO` with `env.FOO` for every FOO declared in
#      the server + client schemas.
#   3. Does NOT touch process.env accesses for keys we have not yet added
#      to src/env.ts (it prints them so you can add them to the schema
#      and re-run).
#   4. Skips node_modules/, .next/, prisma/migrations, and e2e/.
#
# After running:
#   - Run `./node_modules/.bin/tsc --noEmit` to catch any stragglers.
#   - Run `npm run build` as the authoritative check.
#   - Review each file manually — this is a best-effort sed, not a parser.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

WRITE=0
if [[ "${1:-}" == "--write" ]]; then
  WRITE=1
fi

# Keys we currently validate — expand this as you migrate more env vars
# into src/env.ts.
ENV_KEYS=(
  DATABASE_URL
  NODE_ENV
  AUTH_SECRET NEXTAUTH_SECRET
  UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN
  STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET
  RAZORPAY_KEY_ID RAZORPAY_KEY_SECRET RAZORPAY_WEBHOOK_SECRET
  RESEND_API_KEY FROM_EMAIL
  OPENAI_API_KEY
  CRON_SECRET
  TEMPORAL_ADDRESS TEMPORAL_NAMESPACE TEMPORAL_TASK_QUEUE
  SMARTBILL_READ_ONLY
  HOSTNAME
  NEXT_PUBLIC_SITE_URL NEXT_PUBLIC_RAZORPAY_KEY_ID
  VERCEL_URL VERCEL_PROJECT_PRODUCTION_URL APP_URL
)

FILES=$(grep -rl "process\.env\." src/ \
  --include='*.ts' --include='*.tsx' \
  | grep -v node_modules | grep -v '.next' | grep -v 'src/env.ts')

REPORT_UNCOVERED=()

SED_ARGS=(-i '')
if [[ $WRITE -eq 0 ]]; then
  # Dry-run mode: use -n p replacement via a different path (we'll just
  # print a report instead of touching).
  echo "=== DRY RUN (re-run with --write to modify files) ==="
fi

for f in $FILES; do
  # Detect which declared keys this file uses
  used_keys=()
  for k in "${ENV_KEYS[@]}"; do
    if grep -q "process\.env\.$k\b" "$f"; then
      used_keys+=("$k")
    fi
  done

  # Find undeclared keys used in this file (warn, don't auto-fix)
  undeclared=$(grep -oE 'process\.env\.[A-Z][A-Z0-9_]*' "$f" \
    | sort -u \
    | sed 's/process\.env\.//' \
    | while read -r k; do
        found=0
        for dk in "${ENV_KEYS[@]}"; do
          if [[ "$k" == "$dk" ]]; then found=1; break; fi
        done
        if [[ $found -eq 0 ]]; then echo "$k"; fi
      done)
  if [[ -n "$undeclared" ]]; then
    while read -r uk; do
      [[ -z "$uk" ]] && continue
      REPORT_UNCOVERED+=("$f: $uk")
    done <<<"$undeclared"
  fi

  if [[ ${#used_keys[@]} -eq 0 ]]; then
    continue
  fi

  if [[ $WRITE -eq 1 ]]; then
    # 1. Add import if missing
    if ! grep -q 'import { env } from "@/env";' "$f"; then
      # Insert after the first import "server-only" line if present,
      # else after the first import line.
      if grep -q '^import "server-only";' "$f"; then
        sed -i '' '/^import "server-only";/a\
\
import { env } from "@/env";
' "$f"
      else
        sed -i '' '1{
/^import /a\
import { env } from "@/env";
}' "$f"
      fi
    fi
    # 2. Replace process.env.FOO → env.FOO for declared keys
    for k in "${used_keys[@]}"; do
      # Match `process.env.FOO` as a word boundary (\b on the key name)
      # to avoid partial matches like FOO_OLD.
      sed -i '' "s/process\\.env\\.${k}\\b/env.${k}/g" "$f"
    done
    echo "OK  $f  (${used_keys[*]})"
  else
    echo "PLAN $f  -> ${used_keys[*]}"
  fi
done

if [[ ${#REPORT_UNCOVERED[@]} -gt 0 ]]; then
  echo
  echo "--- process.env keys NOT yet declared in src/env.ts (add them first): ---"
  printf '  %s\n' "${REPORT_UNCOVERED[@]}"
fi

echo
if [[ $WRITE -eq 1 ]]; then
  echo "Migration complete. Run \`./node_modules/.bin/tsc --noEmit\` next."
else
  echo "Re-run with --write to apply."
fi
