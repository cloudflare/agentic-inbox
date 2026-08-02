# Credential Recovery Rollout And SES Callback Runbook

This is the single procedure for Whispyr and Wiser. Recovery stays frozen unless
the exact D1 row `credential_recovery_control('global')` exists with `enabled =
1`. A missing migration, missing row, unreadable D1 response, or any other value
returns private no-store 503 from all public recovery routes and skips every
recovery maintenance lane. Unrelated agent-revocation maintenance continues.

The code-first order below assumes migrations 0006 through 0011 are already in
the remote ledger. Wiser's live database currently has only migrations 0001 and
0002. For that exact baseline, follow the migration-first branch in
[`docs/wiser-go-live-runbook.md`](wiser-go-live-runbook.md) before returning here
for the callback, control-enable, and end-to-end proof gates.

Every remote write in this document requires separate same-turn approval naming
the exact brand, account, and action. Local builds, verifier dry-runs, and
read-only inventory do not authorize AWS, Cloudflare, D1, DNS, secret, or deploy
changes.

## Brand Parameters

Set one brand per shell. Never operate on both brands from one command block.

```bash
set -eu
BRAND="wiser" # or whispyr
AWS_REGION="eu-west-2"
SES_CONFIGURATION_SET="mail-portal-events"
ALERT_EMAIL="${ALERT_EMAIL:?set the independently monitored operator address}"
OPERATOR_IAM_PRINCIPAL_ARN="${OPERATOR_IAM_PRINCIPAL_ARN:?set the exact backing IAM user or role ARN for these AWS credentials}"
SES_EVENT_WEBHOOK_SECRET="${SES_EVENT_WEBHOOK_SECRET:?load the exact brand callback secret without printing it}"

case "$BRAND" in
  wiser)
    CF_ENV="wiser"
    MAIL_DOMAIN="wiserchat.ai"
    MAIL_ORIGIN="https://mail.wiserchat.ai"
    DEPLOY_SCRIPT="deploy:wiser"
    ;;
  whispyr)
    CF_ENV="whispyr"
    MAIL_DOMAIN="whispyrcrm.com"
    MAIL_ORIGIN="https://mail.whispyrcrm.com"
    DEPLOY_SCRIPT="deploy:whispyr"
    ;;
  *)
    echo "BRAND must be wiser or whispyr" >&2
    exit 2
    ;;
esac

CALLBACK_URL="${MAIL_ORIGIN}/webhooks/ses"
EVENT_RULE="mail-portal-${BRAND}-ses-events"
CANARY_RULE="mail-portal-${BRAND}-ses-callback-canary"
CONNECTION_NAME="mail-portal-${BRAND}-ses-callback"
API_DESTINATION_NAME="mail-portal-${BRAND}-ses-callback"
DLQ_NAME="mail-portal-${BRAND}-ses-callback-dlq"
TARGET_ID="callback"
CANARY_TARGET_ID="callback-canary"
TARGET_ROLE_NAME="mail-portal-${BRAND}-eventbridge-api-destination"
TARGET_POLICY_NAME="InvokeExactApiDestination"
ALERT_TOPIC_NAME="mail-portal-${BRAND}-operator-pages"
ALARM_PREFIX="mail-portal-${BRAND}"

AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text)"
EVENT_BUS_ARN="arn:aws:events:${AWS_REGION}:${AWS_ACCOUNT_ID}:event-bus/default"
```

The source configuration and generated deployment artifact must both resolve to
`AWS_REGION=eu-west-2`, `SES_CONFIGURATION_SET=mail-portal-events`,
`compatibility_date=2025-11-28`, `observability.enabled=true`, `main=index.js`,
the exact ES module rules, and `no_bundle=true`.

## Mandatory Rollout Order

Do not reorder these gates.

### 1. Build, verify, and deploy the code-first freeze

```bash
npm test
npm run test:workerd:inbound-exact-size
npm run typecheck
npm run typecheck:wiser
npm run "verify:env:${BRAND}"
npm run "$DEPLOY_SCRIPT" -- --dry-run --outdir "/tmp/mail-portal-${BRAND}-dry-run"
```

After exact deploy approval:

```bash
npm run "$DEPLOY_SCRIPT"
```

The deployment script holds an exact primary/guard lock pair across build,
verifier, and deploy. It removes the prior generated configuration only after
proving it is an owned regular single-link file, requires the build to create a
fresh file, copies the complete build into a private read-only staging directory,
verifies that copy, rechecks every staged byte immediately before and after
Wrangler, and writes detailed output under `script-logs/`. The effective command
uses the unpredictable absolute staged path:

```text
wrangler deploy --config /private/staging/path/server/wrangler.json
```

Only `--dry-run`, `--outdir <path>`, and `--secrets-file <path>` are accepted
after the npm `--` separator. A secrets path must name the owned, private,
brand-bound JSON envelope defined below. Every topology, environment, runtime,
compatibility, binding, route, migration, asset, name, config, positional,
unknown, repeated, or malformed flag is rejected before the lock or build.

`npm run test:workerd:inbound-exact-size` is a production gate. A local sandbox
that blocks the workerd listener is an environmental test failure, not a waiver.
Move the proof to an approved host where workerd can bind and record the passing
result before either dry-run.

### Stale artifact lock after SIGKILL

SIGINT, SIGTERM, and SIGHUP stop the child and remove the exact held lock pair.
SIGKILL and host loss cannot run cleanup. Never use `rm`, `unlink`, a wildcard,
or a file browser on either lock path. First inspect from the repository root:

```bash
node scripts/manage-artifact-lock.mjs
```

The inspector accepts the complete pair or the single primary/guard residue
that SIGKILL can leave between pair creation or pair release. Every present path
must be an owned regular 0600 single-link file. A complete pair must have
matching version, token, PID, brand, mode, and start time. The inspector checks
the PID without returning or printing the token. If it reports `active`, stop.
Confirm the same PID and command independently:

```bash
ps -p EXACT_PID -o pid=,ppid=,lstart=,command=
```

Only when inspection reports `stale`, `ps` returns no process, and the recorded
operation is known to have died by SIGKILL or host loss, request approval for
the exact local lock removal. Copy the numeric PID and `startedAt` printed by
inspection:

```bash
EXACT_PID="${EXACT_PID:?copy PID from the immediately preceding inspection}"
EXACT_STARTED_AT="${EXACT_STARTED_AT:?copy startedAt from the immediately preceding inspection}"
node scripts/manage-artifact-lock.mjs \
  --remove \
  --expected-pid "$EXACT_PID" \
  --expected-started-at "$EXACT_STARTED_AT"
```

Removal reopens every present file and revalidates its inode, exact bytes, and
pair-or-single topology. It requires the PID to remain absent before every
unlink, then unlinks only the exact held inode or inodes. It refuses replaced,
symlinked, hard-linked, public-mode, mismatched, active, or changed evidence.
Escalate any refusal for forensic inspection. Do not improvise cleanup.

If this is the first Worker version and Wrangler requires all declared secrets,
use the trap-clean temporary secret-file procedure below during this code-first
deploy. Supplying the secrets does not enable recovery. Before migration 0012,
the missing control table is the freeze.

Read-only route proof before touching legacy data:

```bash
for path in /account/recover /account/recover/request; do
  curl -sS -o /dev/null -D - "${MAIL_ORIGIN}${path}"
done
```

Both GET routes must be 503 with `Cache-Control: private, no-store`. POST routes
must have the same result. Never submit a real recovery address for this proof.

### 2. Privately export and reconcile legacy destinations

```bash
npx wrangler d1 execute DB --env "$CF_ENV" --remote \
  --command "SELECT COUNT(*) AS remaining_legacy_recovery_destinations FROM users WHERE recovery_email IS NOT NULL"
```

If the count is non-zero, create a private export without printing its contents:

```bash
umask 077
LEGACY_RECOVERY_EXPORT="$(mktemp "/tmp/${BRAND}-legacy-recovery.XXXXXX.json")"
npx wrangler d1 execute DB --env "$CF_ENV" --remote \
  --command "SELECT email, recovery_email FROM users WHERE recovery_email IS NOT NULL ORDER BY email" \
  --json > "$LEGACY_RECOVERY_EXPORT"
chmod 600 "$LEGACY_RECOVERY_EXPORT"
```

Reconcile the export against the approved `ACCOUNT_RECOVERY_DIRECTORY`. Every
normalized portal address must resolve to the approved destination, using its
exact entry before the `"*"` default. Unresolved addresses, extra exact entries,
malformed values, duplicate-after-normalization entries, or different resolved
values stop the rollout. Keep the export private through the rollback observation
window.

### 3. Run the separately approved legacy scrub

This is a destructive production D1 write and needs its own approval.

```bash
npx wrangler d1 execute DB --env "$CF_ENV" --remote \
  --command "UPDATE users SET recovery_email = NULL WHERE recovery_email IS NOT NULL"
npx wrangler d1 execute DB --env "$CF_ENV" --remote \
  --command "SELECT COUNT(*) AS remaining_legacy_recovery_destinations FROM users WHERE recovery_email IS NOT NULL"
```

The second command must return zero. Do not continue otherwise.

### 4. Apply migration 0012 while recovery remains disabled

After separate migration approval:

```bash
npx wrangler d1 migrations apply DB --env "$CF_ENV" --remote
```

Migration 0012 rechecks the legacy count before creating recovery schema. It
creates the control row disabled. Never bypass its guard.

### 5. Verify schema and the disabled control

```bash
npx wrangler d1 execute DB --env "$CF_ENV" --remote --command \
  "SELECT type, name FROM sqlite_master WHERE name IN ('credential_recovery_control','credential_recovery_request_jobs','credential_recovery_delivery_outbox','credential_recovery_delivery_attempts','credential_recovery_delivery_events','credential_recovery_email_reject_insert','credential_recovery_email_reject_update') ORDER BY type, name"
npx wrangler d1 execute DB --env "$CF_ENV" --remote --command \
  "SELECT control_id, enabled FROM credential_recovery_control ORDER BY control_id"
```

The exact row must be `global | 0`. Repeat the four-route 503 proof. The minutely
Cron must log the agent lane normally and log recovery lanes as disabled without
querying recovery job, outbox, attempt, event, or retention tables.

### 6. Configure and prove secrets and the AWS callback graph

Complete the graph and proofs in the next section. The EventBridge synthetic
canary must receive 202 from the exact brand callback, retries and DLQ must be
configured, and CloudWatch alarms must be active. Keep D1 control at zero.

### 7. Attach and approve the independent monitor proof record

Complete the `Independent Application And Inbound Monitoring Gate` below while
the exact control row remains `global | 0`. The proof record must already exist,
contain a separately received test page for every named condition, and have
separate approval before the enable write is even requested. A dashboard,
manual query, Worker log, or CloudWatch alarm alone does not satisfy this gate.

Record the immutable monitor proof reference and its separate approval:

```bash
MONITOR_PROOF_RECORD="${MONITOR_PROOF_RECORD:?set the approved immutable proof record reference}"
MONITOR_PROOF_APPROVAL="${MONITOR_PROOF_APPROVAL:?set the separate approval reference}"
printf 'Monitor proof: %s\nMonitor approval: %s\n' \
  "$MONITOR_PROOF_RECORD" "$MONITOR_PROOF_APPROVAL"
```

Both references must identify this exact brand and rollout. Stop if either proof
was produced before the final monitor configuration, lacks a condition page, or
depends on the Worker, its Queues, Cron, D1, R2, or callback path to deliver the
page.

### 8. Explicitly enable the exact brand

This D1 write needs separate approval after the disabled-state proof, callback
canary proof, secret proof, every-alarm exercise, and independent monitor proof
record are approved.

```bash
npx wrangler d1 execute DB --env "$CF_ENV" --remote --command \
  "UPDATE credential_recovery_control SET enabled = 1, updated_at = unixepoch('now') * 1000 WHERE control_id = 'global' AND enabled = 0"
npx wrangler d1 execute DB --env "$CF_ENV" --remote --command \
  "SELECT control_id, enabled FROM credential_recovery_control ORDER BY control_id"
```

The exact row must now be `global | 1`. Any other result stops the rollout.

### 9. Run the exact end-to-end proof

Use one approved disposable account mapped to an external recovery address.

1. Record the proof start time.
2. Submit one eligible and one unknown portal address. Both public responses must
   be indistinguishable generic 202 responses.
3. Confirm exactly one recovery message reaches the external destination.
4. Confirm the link origin is the exact brand origin, is single-use, updates the
   password, invalidates prior sessions and MCP credentials, and cannot be used
   twice.
5. Confirm the durable request and delivery reach terminal truth, the accepted
   attempt matches the accepted provider message, and one exact Delivery,
   Bounce, or Complaint event is recorded by EventBridge.

Use an aggregate proof that does not select identities, ciphertext, tokens, or
provider identifiers:

```bash
npx wrangler d1 execute DB --env "$CF_ENV" --remote --command \
  "SELECT COUNT(*) AS exact_callback_proofs FROM credential_recovery_delivery_outbox o JOIN credential_recovery_delivery_attempts a ON a.outbox_id = o.id AND a.attempt_id = o.accepted_attempt_id JOIN credential_recovery_delivery_events e ON e.outbox_id = o.id AND e.attempt_id = a.attempt_id AND e.provider_message_id = o.provider_message_id WHERE o.state = 'accepted' AND a.state = 'accepted' AND o.created_at >= (unixepoch('now') - 3600) * 1000"
```

The count must increase by exactly one for the proof. SES event publication to
EventBridge is best effort and can be out of order, so absence is not proof of a
provider rejection. It is still a go-live failure because callback correlation
has not been proven.

## AWS SES To EventBridge To Worker Graph

AWS documents that an SES EventBridge event destination belongs to a
configuration set and publishes selected sending events to the default event
bus. AWS also documents that these SES events are best effort and may be out of
order. References: [SES EventBridge destination](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-add-event-destination-eventbridge.html),
[SES EventBridge monitoring and schema](https://docs.aws.amazon.com/ses/latest/dg/monitoring-eventbridge.html).

The graph is separate per brand after the shared SES configuration set:

```text
SES eu-west-2 / mail-portal-events
  -> default EventBridge bus
     -> source-domain suffix rule for one brand
        -> brand API Destination + brand Connection
           -> https://mail.<brand>/webhooks/ses
        -> brand SQS DLQ after bounded retries
     -> brand five-minute synthetic callback canary
        -> same brand API Destination + same DLQ
```

### Configuration set event destination

Inspect before mutating:

```bash
aws sesv2 get-configuration-set \
  --region "$AWS_REGION" \
  --configuration-set-name "$SES_CONFIGURATION_SET"
aws sesv2 get-configuration-set-event-destinations \
  --region "$AWS_REGION" \
  --configuration-set-name "$SES_CONFIGURATION_SET"
```

The enabled EventBridge destination must publish exactly `DELIVERY`, `BOUNCE`,
and `COMPLAINT`. Create or update it only after approval:

```bash
aws sesv2 create-configuration-set-event-destination \
  --region "$AWS_REGION" \
  --configuration-set-name "$SES_CONFIGURATION_SET" \
  --event-destination-name "mail-portal-eventbridge" \
  --event-destination "$(jq -cn --arg bus "$EVENT_BUS_ARN" \
    '{Enabled:true,MatchingEventTypes:["DELIVERY","BOUNCE","COMPLAINT"],EventBridgeDestination:{EventBusArn:$bus}}')"
aws sesv2 get-configuration-set-event-destinations \
  --region "$AWS_REGION" \
  --configuration-set-name "$SES_CONFIGURATION_SET" \
  --query "EventDestinations[?Name=='mail-portal-eventbridge']"
```

If the destination already exists, stop and compare the read-back before using
`update-configuration-set-event-destination` with the same exact payload.
Do not treat an `AlreadyExistsException` as success.

### Connection and bearer secret

EventBridge API Destinations use Connections for authorization. API Key
authorization can populate the `Authorization` header, and EventBridge stores
the connection secret in Secrets Manager. References: [API Destinations](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-api-destinations.html),
[Connection authorization](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-target-connection-auth.html).

The Connection API key name is exactly `Authorization`; its value is exactly
`Bearer <SES_EVENT_WEBHOOK_SECRET for this brand>`. Do not reuse either brand's
secret. Use a trap-clean private input file so the bearer secret is removed on
normal exit, interruption, or termination:

```bash
umask 077
CONNECTION_INPUT="$(mktemp "/tmp/${BRAND}-eventbridge-connection.XXXXXX.json")"
cleanup_connection_input() {
  if [ -n "${CONNECTION_INPUT:-}" ]; then
    rm -f -- "$CONNECTION_INPUT"
  fi
}
trap cleanup_connection_input EXIT HUP INT TERM
node -e '
  const fs = require("node:fs");
  const [path, name] = process.argv.slice(1);
  const secret = process.env.SES_EVENT_WEBHOOK_SECRET;
  if (!secret) throw new Error("SES_EVENT_WEBHOOK_SECRET is required");
  fs.writeFileSync(path, JSON.stringify({
    Name: name,
    AuthorizationType: "API_KEY",
    AuthParameters: {
      ApiKeyAuthParameters: {
        ApiKeyName: "Authorization",
        ApiKeyValue: `Bearer ${secret}`
      }
    }
  }), { mode: 0o600 });
' "$CONNECTION_INPUT" "$CONNECTION_NAME"
aws events create-connection \
  --region "$AWS_REGION" \
  --cli-input-json "file://${CONNECTION_INPUT}"
cleanup_connection_input
trap - EXIT HUP INT TERM
EVENTBRIDGE_CONNECTION_ARN="$(aws events describe-connection \
  --region "$AWS_REGION" \
  --name "$CONNECTION_NAME" \
  --query ConnectionArn \
  --output text)"

attempt=0
while :; do
  CONNECTION_STATE="$(aws events describe-connection \
    --region "$AWS_REGION" \
    --name "$CONNECTION_NAME" \
    --query ConnectionState \
    --output text)"
  [ "$CONNECTION_STATE" = "AUTHORIZED" ] && break
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || {
    echo "Connection did not become AUTHORIZED: $CONNECTION_STATE" >&2
    exit 1
  }
  sleep 2
done
aws events describe-connection \
  --region "$AWS_REGION" \
  --name "$CONNECTION_NAME" \
  --query '{Arn:ConnectionArn,State:ConnectionState,AuthorizationType:AuthorizationType}'
```

The secret is read from the environment inside Node and never appears in a
command argument. Never enable shell tracing, print the environment, or paste
the value into a ticket, repository file, shell history, or log. A preexisting
Connection is not a successful create. Stop, read it back, and use a separately
reviewed update with the same exact shape.

### API Destination, brand rule, retry policy, and DLQ

Create the brand API Destination with `POST` to `$CALLBACK_URL` and an invocation
rate that exceeds expected recovery and tracked outbound volume. The endpoint
must answer within EventBridge's five-second API Destination timeout.

```bash
aws events create-api-destination \
  --region "$AWS_REGION" \
  --name "$API_DESTINATION_NAME" \
  --connection-arn "$EVENTBRIDGE_CONNECTION_ARN" \
  --invocation-endpoint "$CALLBACK_URL" \
  --http-method POST \
  --invocation-rate-limit-per-second 10
EVENTBRIDGE_API_DESTINATION_ARN="$(aws events describe-api-destination \
  --region "$AWS_REGION" \
  --name "$API_DESTINATION_NAME" \
  --query ApiDestinationArn \
  --output text)"
aws events describe-api-destination \
  --region "$AWS_REGION" \
  --name "$API_DESTINATION_NAME" \
  --query '{Arn:ApiDestinationArn,State:ApiDestinationState,ConnectionArn:ConnectionArn,Endpoint:InvocationEndpoint,Method:HttpMethod,Rate:InvocationRateLimitPerSecond}'

EVENTBRIDGE_DLQ_URL="$(aws sqs create-queue \
  --region "$AWS_REGION" \
  --queue-name "$DLQ_NAME" \
  --attributes MessageRetentionPeriod=1209600 \
  --query QueueUrl \
  --output text)"
EVENTBRIDGE_DLQ_ARN="$(aws sqs get-queue-attributes \
  --region "$AWS_REGION" \
  --queue-url "$EVENTBRIDGE_DLQ_URL" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn \
  --output text)"
aws sqs get-queue-attributes \
  --region "$AWS_REGION" \
  --queue-url "$EVENTBRIDGE_DLQ_URL" \
  --attribute-names QueueArn MessageRetentionPeriod
```

Use a precise brand rule. AWS recommends precise event patterns and supports
suffix matching: [event-pattern best practices](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-patterns-best-practices.html),
[suffix operator](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-create-pattern-operators.html).

```bash
EVENT_PATTERN="$(jq -cn --arg suffix "@${MAIL_DOMAIN}" '{
  source:["aws.ses"],
  "detail-type":["Email Delivered","Email Bounced","Email Complaint Received"],
  detail:{
    eventType:["Delivery","Bounce","Complaint"],
    mail:{source:[{suffix:$suffix}]}
  }
}')"
aws events put-rule \
  --region "$AWS_REGION" \
  --name "$EVENT_RULE" \
  --event-pattern "$EVENT_PATTERN" \
  --state ENABLED
EVENT_RULE_ARN="$(aws events describe-rule \
  --region "$AWS_REGION" \
  --name "$EVENT_RULE" \
  --query Arn \
  --output text)"

aws events put-rule \
  --region "$AWS_REGION" \
  --name "$CANARY_RULE" \
  --schedule-expression "rate(5 minutes)" \
  --state ENABLED
CANARY_RULE_ARN="$(aws events describe-rule \
  --region "$AWS_REGION" \
  --name "$CANARY_RULE" \
  --query Arn \
  --output text)"

QUEUE_POLICY="$(jq -cn \
  --arg queue "$EVENTBRIDGE_DLQ_ARN" \
  --arg eventRule "$EVENT_RULE_ARN" \
  --arg canaryRule "$CANARY_RULE_ARN" '{
    Version:"2012-10-17",
    Statement:[{
      Sid:"AllowExactEventBridgeRules",
      Effect:"Allow",
      Principal:{Service:"events.amazonaws.com"},
      Action:"sqs:SendMessage",
      Resource:$queue,
      Condition:{ArnEquals:{"aws:SourceArn":[$eventRule,$canaryRule]}}
    }]
  }')"
aws sqs set-queue-attributes \
  --region "$AWS_REGION" \
  --queue-url "$EVENTBRIDGE_DLQ_URL" \
  --attributes "$(jq -cn --arg policy "$QUEUE_POLICY" '{Policy:$policy}')"
aws sqs get-queue-attributes \
  --region "$AWS_REGION" \
  --queue-url "$EVENTBRIDGE_DLQ_URL" \
  --attribute-names QueueArn Policy MessageRetentionPeriod
```

Create the exact target role. The trust policy admits only EventBridge and the
inline permission admits only `events:InvokeApiDestination` on this one API
Destination:

```bash
umask 077
AWS_INPUT_DIRECTORY="$(mktemp -d "/tmp/${BRAND}-eventbridge-inputs.XXXXXX")"
cleanup_aws_inputs() {
  if [ -n "${AWS_INPUT_DIRECTORY:-}" ]; then
    rm -f -- "${AWS_INPUT_DIRECTORY}"/*.json
    rmdir -- "$AWS_INPUT_DIRECTORY"
  fi
}
trap cleanup_aws_inputs EXIT HUP INT TERM

jq -n '{
  Version:"2012-10-17",
  Statement:[{
    Effect:"Allow",
    Principal:{Service:"events.amazonaws.com"},
    Action:"sts:AssumeRole"
  }]
}' > "${AWS_INPUT_DIRECTORY}/trust.json"
aws iam create-role \
  --role-name "$TARGET_ROLE_NAME" \
  --assume-role-policy-document "file://${AWS_INPUT_DIRECTORY}/trust.json"
EVENTBRIDGE_TARGET_ROLE_ARN="$(aws iam get-role \
  --role-name "$TARGET_ROLE_NAME" \
  --query Role.Arn \
  --output text)"

jq -n --arg destination "$EVENTBRIDGE_API_DESTINATION_ARN" '{
  Version:"2012-10-17",
  Statement:[{
    Sid:"InvokeExactApiDestination",
    Effect:"Allow",
    Action:"events:InvokeApiDestination",
    Resource:$destination
  }]
}' > "${AWS_INPUT_DIRECTORY}/invoke-policy.json"
aws iam put-role-policy \
  --role-name "$TARGET_ROLE_NAME" \
  --policy-name "$TARGET_POLICY_NAME" \
  --policy-document "file://${AWS_INPUT_DIRECTORY}/invoke-policy.json"
aws iam get-role --role-name "$TARGET_ROLE_NAME" \
  --query '{Arn:Role.Arn,Trust:Role.AssumeRolePolicyDocument}'
aws iam get-role-policy \
  --role-name "$TARGET_ROLE_NAME" \
  --policy-name "$TARGET_POLICY_NAME"

PASS_ROLE_DECISION="$(aws iam simulate-principal-policy \
  --policy-source-arn "$OPERATOR_IAM_PRINCIPAL_ARN" \
  --action-names iam:PassRole \
  --resource-arns "$EVENTBRIDGE_TARGET_ROLE_ARN" \
  --context-entries ContextKeyName=iam:PassedToService,ContextKeyValues=events.amazonaws.com,ContextKeyType=string \
  --query 'EvaluationResults[0].EvalDecision' \
  --output text)"
[ "$PASS_ROLE_DECISION" = "allowed" ] || {
  echo "iam:PassRole preflight failed for ${CALLER_ARN}: ${PASS_ROLE_DECISION}" >&2
  exit 1
}
```

Test the exact pattern with full positive, cross-brand negative, and foreign
negative fixtures. AWS identifies these events by both `source` and exact
`detail-type`; the detail includes `eventType` and the outbound source address.

```bash
case "$BRAND" in
  wiser) CROSS_BRAND_DOMAIN="whispyrcrm.com" ;;
  whispyr) CROSS_BRAND_DOMAIN="wiserchat.ai" ;;
esac
event_fixture() {
  jq -cn \
    --arg account "$AWS_ACCOUNT_ID" \
    --arg region "$AWS_REGION" \
    --arg sourceAddress "$1" '{
      version:"0",
      id:"11111111-2222-4333-8444-555555555555",
      "detail-type":"Email Delivered",
      source:"aws.ses",
      account:$account,
      time:"2026-01-01T00:00:00Z",
      region:$region,
      resources:[],
      detail:{
        eventType:"Delivery",
        mail:{
          timestamp:"2026-01-01T00:00:00Z",
          source:$sourceAddress,
          messageId:"pattern-test-only",
          destination:["pattern-test@example.net"]
        },
        delivery:{}
      }
    }'
}
POSITIVE_EVENT="$(event_fixture "recovery@${MAIL_DOMAIN}")"
CROSS_BRAND_EVENT="$(event_fixture "recovery@${CROSS_BRAND_DOMAIN}")"
FOREIGN_EVENT="$(event_fixture "recovery@example.net")"

[ "$(aws events test-event-pattern \
  --event-pattern "$EVENT_PATTERN" \
  --event "$POSITIVE_EVENT" \
  --query Result \
  --output text)" = "True" ]
[ "$(aws events test-event-pattern \
  --event-pattern "$EVENT_PATTERN" \
  --event "$CROSS_BRAND_EVENT" \
  --query Result \
  --output text)" = "False" ]
[ "$(aws events test-event-pattern \
  --event-pattern "$EVENT_PATTERN" \
  --event "$FOREIGN_EVENT" \
  --query Result \
  --output text)" = "False" ]
```

Attach both targets with the exact API Destination role, queue ARN, and full
24-hour, 185-attempt envelope. Using JSON files avoids shorthand parsing and
makes a non-zero partial failure count fatal.

```bash
jq -n \
  --arg id "$TARGET_ID" \
  --arg destination "$EVENTBRIDGE_API_DESTINATION_ARN" \
  --arg role "$EVENTBRIDGE_TARGET_ROLE_ARN" \
  --arg dlq "$EVENTBRIDGE_DLQ_ARN" '[{
    Id:$id,
    Arn:$destination,
    RoleArn:$role,
    RetryPolicy:{MaximumEventAgeInSeconds:86400,MaximumRetryAttempts:185},
    DeadLetterConfig:{Arn:$dlq}
  }]' > "${AWS_INPUT_DIRECTORY}/event-target.json"
FAILED_TARGETS="$(aws events put-targets \
  --region "$AWS_REGION" \
  --rule "$EVENT_RULE" \
  --targets "file://${AWS_INPUT_DIRECTORY}/event-target.json" \
  --query FailedEntryCount \
  --output text)"
[ "$FAILED_TARGETS" = "0" ]

jq -n \
  --arg id "$CANARY_TARGET_ID" \
  --arg destination "$EVENTBRIDGE_API_DESTINATION_ARN" \
  --arg role "$EVENTBRIDGE_TARGET_ROLE_ARN" \
  --arg dlq "$EVENTBRIDGE_DLQ_ARN" '[{
    Id:$id,
    Arn:$destination,
    RoleArn:$role,
    Input:({detail:{eventType:"MailPortalCallbackCanary"}}|tojson),
    RetryPolicy:{MaximumEventAgeInSeconds:86400,MaximumRetryAttempts:185},
    DeadLetterConfig:{Arn:$dlq}
  }]' > "${AWS_INPUT_DIRECTORY}/canary-target.json"
FAILED_CANARY_TARGETS="$(aws events put-targets \
  --region "$AWS_REGION" \
  --rule "$CANARY_RULE" \
  --targets "file://${AWS_INPUT_DIRECTORY}/canary-target.json" \
  --query FailedEntryCount \
  --output text)"
[ "$FAILED_CANARY_TARGETS" = "0" ]

aws events list-targets-by-rule \
  --region "$AWS_REGION" \
  --rule "$EVENT_RULE"
aws events list-targets-by-rule \
  --region "$AWS_REGION" \
  --rule "$CANARY_RULE"

cleanup_aws_inputs
trap - EXIT HUP INT TERM
```

The DLQ must be an SQS standard queue in `eu-west-2`, with a resource policy that
permits `events.amazonaws.com` `sqs:SendMessage` only for the exact production
and canary rule ARNs. EventBridge retries are exponential with jitter, defaulting
to up to 24 hours and 185 attempts, and AWS recommends a DLQ to avoid dropping
exhausted events: [retry policy and DLQ](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-retry-policy.html),
[DLQ queue policy](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-dlq.html),
[API Destination role](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-events-iam-roles.html).

### Per-brand synthetic callback canary

The scheduled target above sends one constant unsupported event every five
minutes. The Worker must authenticate it, answer 202 `ignored`, and never touch
D1 recovery correlation tables. Wait for at least one scheduled interval, then
read the exact rule metrics:

```bash
METRIC_START="$(node -p 'new Date(Date.now() - 30 * 60 * 1000).toISOString()')"
METRIC_END="$(node -p 'new Date().toISOString()')"
for METRIC_NAME in InvocationAttempts SuccessfulInvocationAttempts RetryInvocationAttempts FailedInvocations InvocationsSentToDlq InvocationsFailedToBeSentToDlq IngestionToInvocationSuccessLatency; do
  aws cloudwatch get-metric-statistics \
    --region "$AWS_REGION" \
    --namespace AWS/Events \
    --metric-name "$METRIC_NAME" \
    --dimensions "Name=RuleName,Value=${CANARY_RULE}" \
    --start-time "$METRIC_START" \
    --end-time "$METRIC_END" \
    --period 300 \
    --statistics Sum Maximum
done
```

`SuccessfulInvocationAttempts` must be at least one and a matching Worker log
must show authenticated 202 for this brand. A 401 proves a Connection mismatch.
A 404 proves the wrong endpoint. Metrics can lag, so record both timestamps and
repeat the bounded read before declaring failure.

### Disposable API Destination retry and DLQ drill

This proof is mandatory and must not alter the production rules, target, retry
policy, Connection, or callback. Provision an operator-owned disposable HTTPS
responder and a disposable EventBridge graph in the same AWS account and Region.
The responder must expose three otherwise identical URLs:

- `$DRILL_5XX_URL` always returns 503.
- `$DRILL_TIMEOUT_URL` accepts the connection but does not answer within six
  seconds, exceeding EventBridge's five-second timeout.
- `$DRILL_404_URL` always returns 404.

Use a disposable API-key Connection with a random non-production value. Never
send either brand secret to the drill responder. Set and preflight the approved
URLs:

```bash
DRILL_5XX_URL="${DRILL_5XX_URL:?set the approved disposable 503 URL}"
DRILL_TIMEOUT_URL="${DRILL_TIMEOUT_URL:?set the approved disposable timeout URL}"
DRILL_404_URL="${DRILL_404_URL:?set the approved disposable 404 URL}"
DRILL_PREFIX="mail-portal-${BRAND}-delivery-drill"

[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 4 "$DRILL_5XX_URL")" = "503" ]
[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 4 "$DRILL_404_URL")" = "404" ]
if curl -sS -o /dev/null --max-time 6 "$DRILL_TIMEOUT_URL"; then
  echo "Timeout drill endpoint answered unexpectedly" >&2
  exit 1
fi
```

Create three disposable rules and API Destinations with an independent
Connection, target role, and standard SQS DLQ:

```bash
DRILL_CONNECTION_NAME="${DRILL_PREFIX}-connection"
DRILL_ROLE_NAME="${DRILL_PREFIX}-role"
DRILL_POLICY_NAME="InvokeDisposableApiDestinations"
DRILL_DLQ_NAME="${DRILL_PREFIX}-dlq"
DRILL_TOKEN="$(node -p 'require("node:crypto").randomBytes(32).toString("hex")')"
export DRILL_TOKEN
umask 077
DRILL_INPUT_DIRECTORY="$(mktemp -d "/tmp/${DRILL_PREFIX}.XXXXXX")"

node -e '
  const fs = require("node:fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({
    Name: process.argv[2],
    AuthorizationType: "API_KEY",
    AuthParameters: { ApiKeyAuthParameters: {
      ApiKeyName: "X-Mail-Portal-Drill",
      ApiKeyValue: process.env.DRILL_TOKEN
    }}
  }), { mode: 0o600 });
' "${DRILL_INPUT_DIRECTORY}/connection.json" "$DRILL_CONNECTION_NAME"
aws events create-connection \
  --region "$AWS_REGION" \
  --cli-input-json "file://${DRILL_INPUT_DIRECTORY}/connection.json"
DRILL_CONNECTION_ARN="$(aws events describe-connection \
  --region "$AWS_REGION" \
  --name "$DRILL_CONNECTION_NAME" \
  --query ConnectionArn \
  --output text)"
attempt=0
while [ "$(aws events describe-connection \
  --region "$AWS_REGION" \
  --name "$DRILL_CONNECTION_NAME" \
  --query ConnectionState \
  --output text)" != "AUTHORIZED" ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || exit 1
  sleep 2
done

create_drill_destination() {
  aws events create-api-destination \
    --region "$AWS_REGION" \
    --name "${DRILL_PREFIX}-$1" \
    --connection-arn "$DRILL_CONNECTION_ARN" \
    --invocation-endpoint "$2" \
    --http-method POST \
    --invocation-rate-limit-per-second 1
}
create_drill_destination 5xx "$DRILL_5XX_URL"
create_drill_destination timeout "$DRILL_TIMEOUT_URL"
create_drill_destination 404 "$DRILL_404_URL"
DRILL_5XX_ARN="$(aws events describe-api-destination --region "$AWS_REGION" --name "${DRILL_PREFIX}-5xx" --query ApiDestinationArn --output text)"
DRILL_TIMEOUT_ARN="$(aws events describe-api-destination --region "$AWS_REGION" --name "${DRILL_PREFIX}-timeout" --query ApiDestinationArn --output text)"
DRILL_404_ARN="$(aws events describe-api-destination --region "$AWS_REGION" --name "${DRILL_PREFIX}-404" --query ApiDestinationArn --output text)"

DRILL_DLQ_URL="$(aws sqs create-queue \
  --region "$AWS_REGION" \
  --queue-name "$DRILL_DLQ_NAME" \
  --attributes MessageRetentionPeriod=1209600 \
  --query QueueUrl \
  --output text)"
DRILL_DLQ_ARN="$(aws sqs get-queue-attributes \
  --region "$AWS_REGION" \
  --queue-url "$DRILL_DLQ_URL" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn \
  --output text)"

for DRILL_KIND in 5xx timeout 404; do
  aws events put-rule \
    --region "$AWS_REGION" \
    --name "${DRILL_PREFIX}-${DRILL_KIND}" \
    --event-pattern "$(jq -cn --arg kind "$DRILL_KIND" '{
      source:["mail-portal.delivery-drill"],
      "detail-type":[("MailPortal "+$kind+" drill")]
    }')" \
    --state ENABLED
done
DRILL_5XX_RULE_ARN="$(aws events describe-rule --region "$AWS_REGION" --name "${DRILL_PREFIX}-5xx" --query Arn --output text)"
DRILL_TIMEOUT_RULE_ARN="$(aws events describe-rule --region "$AWS_REGION" --name "${DRILL_PREFIX}-timeout" --query Arn --output text)"
DRILL_404_RULE_ARN="$(aws events describe-rule --region "$AWS_REGION" --name "${DRILL_PREFIX}-404" --query Arn --output text)"

DRILL_QUEUE_POLICY="$(jq -cn \
  --arg queue "$DRILL_DLQ_ARN" \
  --arg five "$DRILL_5XX_RULE_ARN" \
  --arg timeout "$DRILL_TIMEOUT_RULE_ARN" \
  --arg four "$DRILL_404_RULE_ARN" '{
    Version:"2012-10-17",
    Statement:[{
      Effect:"Allow",
      Principal:{Service:"events.amazonaws.com"},
      Action:"sqs:SendMessage",
      Resource:$queue,
      Condition:{ArnEquals:{"aws:SourceArn":[$five,$timeout,$four]}}
    }]
  }')"
aws sqs set-queue-attributes \
  --region "$AWS_REGION" \
  --queue-url "$DRILL_DLQ_URL" \
  --attributes "$(jq -cn --arg policy "$DRILL_QUEUE_POLICY" '{Policy:$policy}')"

jq -n '{
  Version:"2012-10-17",
  Statement:[{
    Effect:"Allow",
    Principal:{Service:"events.amazonaws.com"},
    Action:"sts:AssumeRole"
  }]
}' > "${DRILL_INPUT_DIRECTORY}/trust.json"
aws iam create-role \
  --role-name "$DRILL_ROLE_NAME" \
  --assume-role-policy-document "file://${DRILL_INPUT_DIRECTORY}/trust.json"
DRILL_ROLE_ARN="$(aws iam get-role \
  --role-name "$DRILL_ROLE_NAME" \
  --query Role.Arn \
  --output text)"
jq -n \
  --arg five "$DRILL_5XX_ARN" \
  --arg timeout "$DRILL_TIMEOUT_ARN" \
  --arg four "$DRILL_404_ARN" '{
    Version:"2012-10-17",
    Statement:[{
      Effect:"Allow",
      Action:"events:InvokeApiDestination",
      Resource:[$five,$timeout,$four]
    }]
  }' > "${DRILL_INPUT_DIRECTORY}/invoke.json"
aws iam put-role-policy \
  --role-name "$DRILL_ROLE_NAME" \
  --policy-name "$DRILL_POLICY_NAME" \
  --policy-document "file://${DRILL_INPUT_DIRECTORY}/invoke.json"

DRILL_PASS_ROLE_DECISION="$(aws iam simulate-principal-policy \
  --policy-source-arn "$OPERATOR_IAM_PRINCIPAL_ARN" \
  --action-names iam:PassRole \
  --resource-arns "$DRILL_ROLE_ARN" \
  --context-entries ContextKeyName=iam:PassedToService,ContextKeyValues=events.amazonaws.com,ContextKeyType=string \
  --query 'EvaluationResults[0].EvalDecision' \
  --output text)"
[ "$DRILL_PASS_ROLE_DECISION" = "allowed" ]

put_drill_target() {
  jq -n \
    --arg destination "$2" \
    --arg role "$DRILL_ROLE_ARN" \
    --arg dlq "$DRILL_DLQ_ARN" '[{
      Id:"callback",
      Arn:$destination,
      RoleArn:$role,
      RetryPolicy:{MaximumEventAgeInSeconds:60,MaximumRetryAttempts:2},
      DeadLetterConfig:{Arn:$dlq}
    }]' > "${DRILL_INPUT_DIRECTORY}/target.json"
  [ "$(aws events put-targets \
    --region "$AWS_REGION" \
    --rule "${DRILL_PREFIX}-$1" \
    --targets "file://${DRILL_INPUT_DIRECTORY}/target.json" \
    --query FailedEntryCount \
    --output text)" = "0" ]
}
put_drill_target 5xx "$DRILL_5XX_ARN"
put_drill_target timeout "$DRILL_TIMEOUT_ARN"
put_drill_target 404 "$DRILL_404_ARN"

aws events put-events \
  --region "$AWS_REGION" \
  --entries "$(jq -cn '[
    {Source:"mail-portal.delivery-drill",DetailType:"MailPortal 5xx drill",Detail:"{\"case\":\"5xx\"}"},
    {Source:"mail-portal.delivery-drill",DetailType:"MailPortal timeout drill",Detail:"{\"case\":\"timeout\"}"},
    {Source:"mail-portal.delivery-drill",DetailType:"MailPortal 404 drill",Detail:"{\"case\":\"404\"}"}
  ]')"
unset DRILL_TOKEN
```

Wait at least 90 seconds so the 60-second retry envelopes are terminal. Read
every rule independently:

```bash
DRILL_METRIC_START="$(node -p 'new Date(Date.now() - 30 * 60 * 1000).toISOString()')"
DRILL_METRIC_END="$(node -p 'new Date().toISOString()')"
drill_metric_sum() {
  aws cloudwatch get-metric-statistics \
    --region "$AWS_REGION" \
    --namespace AWS/Events \
    --metric-name "$2" \
    --dimensions "Name=RuleName,Value=${DRILL_PREFIX}-$1" \
    --start-time "$DRILL_METRIC_START" \
    --end-time "$DRILL_METRIC_END" \
    --period 60 \
    --statistics Sum \
    --query 'sum(Datapoints[].Sum)' \
    --output text
}
for DRILL_KIND in 5xx timeout; do
  node -e 'if (Number(process.argv[1]) < 1) process.exit(1)' \
    "$(drill_metric_sum "$DRILL_KIND" RetryInvocationAttempts)"
  node -e 'if (Number(process.argv[1]) < 1) process.exit(1)' \
    "$(drill_metric_sum "$DRILL_KIND" FailedInvocations)"
  node -e 'if (Number(process.argv[1]) < 1) process.exit(1)' \
    "$(drill_metric_sum "$DRILL_KIND" InvocationsSentToDlq)"
done
node -e 'if (Number(process.argv[1]) !== 0) process.exit(1)' \
  "$(drill_metric_sum 404 RetryInvocationAttempts)"
node -e 'if (Number(process.argv[1]) < 1) process.exit(1)' \
  "$(drill_metric_sum 404 FailedInvocations)"
node -e 'if (Number(process.argv[1]) < 1) process.exit(1)' \
  "$(drill_metric_sum 404 InvocationsSentToDlq)"
for DRILL_KIND in 5xx timeout 404; do
  node -e 'if (Number(process.argv[1]) !== 0) process.exit(1)' \
    "$(drill_metric_sum "$DRILL_KIND" InvocationsFailedToBeSentToDlq)"
done
aws sqs receive-message \
  --region "$AWS_REGION" \
  --queue-url "$DRILL_DLQ_URL" \
  --max-number-of-messages 10 \
  --visibility-timeout 0 \
  --attribute-names All
```

The disposable queue must contain all three events. Record their SQS message
IDs. AWS documents that API Destinations retry 401, 407, 409, 429, and 5xx plus
timeouts, but do not retry 404: [API Destination response handling](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-api-destinations.html).

Record the three rule ARNs, destination ARNs, metric reads, and DLQ message IDs.
Delete only the disposable graph after the evidence is recorded, in this order:

```bash
for DRILL_KIND in 5xx timeout 404; do
  aws events remove-targets \
    --region "$AWS_REGION" \
    --rule "${DRILL_PREFIX}-${DRILL_KIND}" \
    --ids callback
  aws events delete-rule \
    --region "$AWS_REGION" \
    --name "${DRILL_PREFIX}-${DRILL_KIND}"
  aws events delete-api-destination \
    --region "$AWS_REGION" \
    --name "${DRILL_PREFIX}-${DRILL_KIND}"
done
aws events delete-connection \
  --region "$AWS_REGION" \
  --name "${DRILL_PREFIX}-connection"
aws iam delete-role-policy \
  --role-name "${DRILL_PREFIX}-role" \
  --policy-name InvokeDisposableApiDestinations
aws iam delete-role --role-name "${DRILL_PREFIX}-role"
DRILL_DLQ_URL="$(aws sqs get-queue-url \
  --region "$AWS_REGION" \
  --queue-name "${DRILL_PREFIX}-dlq" \
  --query QueueUrl \
  --output text)"
aws sqs delete-queue \
  --region "$AWS_REGION" \
  --queue-url "$DRILL_DLQ_URL"
rm -f -- "${DRILL_INPUT_DIRECTORY}"/*.json
rmdir -- "$DRILL_INPUT_DIRECTORY"
```

These are cleanup commands, not permission to run them. If the separately
approved disposable graph or its exact evidence is absent, recovery remains
disabled.

### CloudWatch alarms

Provision an independent Amazon SNS action first. The subscription must be
confirmed and a direct test page must arrive before any alarm is accepted:

```bash
ALERT_TOPIC_ARN="$(aws sns create-topic \
  --region "$AWS_REGION" \
  --name "$ALERT_TOPIC_NAME" \
  --query TopicArn \
  --output text)"
aws sns subscribe \
  --region "$AWS_REGION" \
  --topic-arn "$ALERT_TOPIC_ARN" \
  --protocol email \
  --notification-endpoint "$ALERT_EMAIL"
aws sns get-topic-attributes \
  --region "$AWS_REGION" \
  --topic-arn "$ALERT_TOPIC_ARN"
aws sns list-subscriptions-by-topic \
  --region "$AWS_REGION" \
  --topic-arn "$ALERT_TOPIC_ARN"
```

Confirm the AWS email out of band, rerun `list-subscriptions-by-topic`, and
require the exact endpoint's `SubscriptionArn` to be neither
`PendingConfirmation` nor `None`. Then test the independent page:

```bash
TEST_PAGE_MESSAGE_ID="$(aws sns publish \
  --region "$AWS_REGION" \
  --topic-arn "$ALERT_TOPIC_ARN" \
  --subject "[TEST] ${BRAND} mail portal operator page" \
  --message "TEST ONLY: independent mail portal alert channel proof" \
  --query MessageId \
  --output text)"
printf 'Record received test page MessageId: %s\n' "$TEST_PAGE_MESSAGE_ID"
```

Do not continue until the operator records receipt by a path independent of the
Worker, API Destination, EventBridge DLQ, Cloudflare Queues, Cron, and D1.

Create the exact per-rule alarms:

```bash
put_event_alarm() {
  aws cloudwatch put-metric-alarm \
    --region "$AWS_REGION" \
    --alarm-name "${ALARM_PREFIX}-$1-$3" \
    --alarm-description "$4" \
    --namespace AWS/Events \
    --metric-name "$2" \
    --dimensions "Name=RuleName,Value=$1" \
    --statistic "$5" \
    --period "$6" \
    --evaluation-periods "$7" \
    --datapoints-to-alarm "$8" \
    --threshold "$9" \
    --comparison-operator "${10}" \
    --treat-missing-data "${11}" \
    --alarm-actions "$ALERT_TOPIC_ARN"
}

for RULE_NAME in "$EVENT_RULE" "$CANARY_RULE"; do
  put_event_alarm "$RULE_NAME" FailedInvocations failed \
    "Permanent target invocation failure" Sum 60 1 1 0 GreaterThanThreshold notBreaching
  put_event_alarm "$RULE_NAME" InvocationsSentToDlq sent-to-dlq \
    "EventBridge moved an invocation to the DLQ" Sum 60 1 1 0 GreaterThanThreshold notBreaching
  put_event_alarm "$RULE_NAME" InvocationsFailedToBeSentToDlq failed-dlq-write \
    "EventBridge could not write an invocation to the DLQ" Sum 60 1 1 0 GreaterThanThreshold notBreaching
  put_event_alarm "$RULE_NAME" RetryInvocationAttempts retries \
    "Sustained target retries" Sum 300 3 2 0 GreaterThanThreshold notBreaching
  put_event_alarm "$RULE_NAME" IngestionToInvocationSuccessLatency latency \
    "Successful delivery latency exceeded ten seconds" Maximum 300 2 2 10000 GreaterThanThreshold notBreaching
done

aws cloudwatch put-metric-alarm \
  --region "$AWS_REGION" \
  --alarm-name "${ALARM_PREFIX}-${CANARY_RULE}-successful-gap" \
  --alarm-description "No successful callback canary in fifteen minutes" \
  --namespace AWS/Events \
  --metric-name SuccessfulInvocationAttempts \
  --dimensions "Name=RuleName,Value=${CANARY_RULE}" \
  --statistic Sum \
  --period 900 \
  --evaluation-periods 1 \
  --datapoints-to-alarm 1 \
  --threshold 1 \
  --comparison-operator LessThanThreshold \
  --treat-missing-data breaching \
  --alarm-actions "$ALERT_TOPIC_ARN"

umask 077
SUCCESS_RATE_METRICS="$(mktemp "/tmp/${BRAND}-eventbridge-success-rate.XXXXXX.json")"
jq -n --arg rule "$EVENT_RULE" '[
  {
    Id:"attempts",
    MetricStat:{
      Metric:{
        Namespace:"AWS/Events",
        MetricName:"InvocationAttempts",
        Dimensions:[{Name:"RuleName",Value:$rule}]
      },
      Period:300,
      Stat:"Sum"
    },
    ReturnData:false
  },
  {
    Id:"successful",
    MetricStat:{
      Metric:{
        Namespace:"AWS/Events",
        MetricName:"SuccessfulInvocationAttempts",
        Dimensions:[{Name:"RuleName",Value:$rule}]
      },
      Period:300,
      Stat:"Sum"
    },
    ReturnData:false
  },
  {
    Id:"successrate",
    Expression:"successful/attempts",
    Label:"SuccessfulInvocationRate",
    ReturnData:true
  }
]' > "$SUCCESS_RATE_METRICS"
aws cloudwatch put-metric-alarm \
  --region "$AWS_REGION" \
  --alarm-name "${ALARM_PREFIX}-${EVENT_RULE}-success-rate" \
  --alarm-description "Production callback success rate below 99 percent" \
  --metrics "file://${SUCCESS_RATE_METRICS}" \
  --evaluation-periods 3 \
  --datapoints-to-alarm 2 \
  --threshold 0.99 \
  --comparison-operator LessThanThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions "$ALERT_TOPIC_ARN"
rm -- "$SUCCESS_RATE_METRICS"

aws cloudwatch put-metric-alarm \
  --region "$AWS_REGION" \
  --alarm-name "${ALARM_PREFIX}-dlq-depth" \
  --alarm-description "EventBridge callback DLQ contains a message" \
  --namespace AWS/SQS \
  --metric-name ApproximateNumberOfMessagesVisible \
  --dimensions "Name=QueueName,Value=${DLQ_NAME}" \
  --statistic Maximum \
  --period 60 \
  --evaluation-periods 1 \
  --datapoints-to-alarm 1 \
  --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions "$ALERT_TOPIC_ARN"

aws cloudwatch put-metric-alarm \
  --region "$AWS_REGION" \
  --alarm-name "${ALARM_PREFIX}-dlq-oldest-age" \
  --alarm-description "Oldest EventBridge callback DLQ message exceeds five minutes" \
  --namespace AWS/SQS \
  --metric-name ApproximateAgeOfOldestMessage \
  --dimensions "Name=QueueName,Value=${DLQ_NAME}" \
  --statistic Maximum \
  --period 60 \
  --evaluation-periods 1 \
  --datapoints-to-alarm 1 \
  --threshold 300 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions "$ALERT_TOPIC_ARN"

aws cloudwatch describe-alarms \
  --region "$AWS_REGION" \
  --alarm-name-prefix "$ALARM_PREFIX" \
  --query 'MetricAlarms[].{Name:AlarmName,Metric:MetricName,Dimensions:Dimensions,Action:AlarmActions,TreatMissing:TreatMissingData,State:StateValue}'
```

Read-back is not delivery proof. Exercise every exact alarm action with
CloudWatch's temporary test state, which invokes the configured SNS action when
the state changes to `ALARM`. This does not inject production mail, Queue, D1, R2,
SES, or EventBridge traffic.

```bash
umask 077
ALARM_TEST_NAMES="$(mktemp "/tmp/${BRAND}-alarm-test-names.XXXXXX")"
ALARM_TEST_EVIDENCE="$(mktemp "/tmp/${BRAND}-alarm-test-evidence.XXXXXX.tsv")"

for RULE_NAME in "$EVENT_RULE" "$CANARY_RULE"; do
  for SUFFIX in failed sent-to-dlq failed-dlq-write retries latency; do
    printf '%s\n' "${ALARM_PREFIX}-${RULE_NAME}-${SUFFIX}" >> "$ALARM_TEST_NAMES"
  done
done
printf '%s\n' \
  "${ALARM_PREFIX}-${CANARY_RULE}-successful-gap" \
  "${ALARM_PREFIX}-${EVENT_RULE}-success-rate" \
  "${ALARM_PREFIX}-dlq-depth" \
  "${ALARM_PREFIX}-dlq-oldest-age" >> "$ALARM_TEST_NAMES"

ALARM_TEST_COUNT="$(wc -l < "$ALARM_TEST_NAMES" | tr -d ' ')"
ALARM_TEST_UNIQUE_COUNT="$(sort -u "$ALARM_TEST_NAMES" | wc -l | tr -d ' ')"
test "$ALARM_TEST_COUNT" -eq 14
test "$ALARM_TEST_UNIQUE_COUNT" -eq 14

exec 3</dev/tty
while IFS= read -r ALARM_NAME; do
  ALARM_ACTION_CONTRACT="$(aws cloudwatch describe-alarms \
    --region "$AWS_REGION" \
    --alarm-names "$ALARM_NAME" \
    --query 'MetricAlarms[0].{ActionsEnabled:ActionsEnabled,AlarmActions:AlarmActions}' \
    --output json)"
  printf '%s' "$ALARM_ACTION_CONTRACT" | jq -e \
    --arg topic "$ALERT_TOPIC_ARN" \
    '.ActionsEnabled == true and .AlarmActions == [$topic]' >/dev/null

  aws cloudwatch set-alarm-state \
    --region "$AWS_REGION" \
    --alarm-name "$ALARM_NAME" \
    --state-value OK \
    --state-reason "TEST ONLY: establish a safe transition baseline"
  aws cloudwatch set-alarm-state \
    --region "$AWS_REGION" \
    --alarm-name "$ALARM_NAME" \
    --state-value ALARM \
    --state-reason "TEST ONLY: exercise the exact SNS alarm action"

  printf 'Wait for %s, then enter the AlarmName shown in the received page: ' \
    "$ALARM_NAME" >&2
  IFS= read -r RECEIVED_ALARM_NAME <&3
  test "$RECEIVED_ALARM_NAME" = "$ALARM_NAME"
  printf 'Enter the received SNS MessageId for %s: ' "$ALARM_NAME" >&2
  IFS= read -r ALARM_PAGE_MESSAGE_ID <&3
  test -n "$ALARM_PAGE_MESSAGE_ID"
  ALARM_PAGE_RECEIVED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s\t%s\t%s\n' \
    "$ALARM_NAME" "$ALARM_PAGE_MESSAGE_ID" "$ALARM_PAGE_RECEIVED_AT" \
    >> "$ALARM_TEST_EVIDENCE"

  aws cloudwatch describe-alarm-history \
    --region "$AWS_REGION" \
    --alarm-name "$ALARM_NAME" \
    --history-item-type StateUpdate \
    --max-records 5 \
    --query 'AlarmHistoryItems[?contains(HistorySummary, `ALARM`)]|[0]'
  aws cloudwatch set-alarm-state \
    --region "$AWS_REGION" \
    --alarm-name "$ALARM_NAME" \
    --state-value OK \
    --state-reason "TEST ONLY: alarm action exercise complete"
done < "$ALARM_TEST_NAMES"
exec 3<&-

test "$(wc -l < "$ALARM_TEST_EVIDENCE" | tr -d ' ')" -eq 14
rm -- "$ALARM_TEST_NAMES"
printf 'Attach the private 14-row alarm proof, then remove it: %s\n' \
  "$ALARM_TEST_EVIDENCE"
```

For email subscriptions, copy the SNS `MessageId` from the received
notification headers or body. Each row must also have an independently observed
page receipt. A CLI success or alarm-history state update without the received
page is a failure. Attach the private evidence to the approved rollout record,
then delete the exact local file. Recovery remains disabled if any of the 14
alarms lacks an exact action contract, state transition, SNS `MessageId`, or
received page. AWS documents that `set-alarm-state` is specifically for testing
and that a transition to `ALARM` invokes the configured SNS action:
[CloudWatch set-alarm-state](https://docs.aws.amazon.com/cli/latest/reference/cloudwatch/set-alarm-state.html).

The metric-math alarm uses `SuccessfulInvocationRate =
SuccessfulInvocationAttempts / InvocationAttempts` for the production rule,
treats no production traffic as missing rather than failure, and pages when two
of three five-minute periods fall below 99 percent. It does not invent a
denominator with the scheduled canary. AWS recommends combining attempt,
success, retry, permanent failure, DLQ, and latency metrics:
[EventBridge metrics](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-monitoring.html),
[delivery monitoring best practices](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-monitoring-events-best-practices.html).

The named alarms above are an executable minimum. Recovery stays disabled until
all are separately approved, provisioned, read back, and proven by the complete
14-row alarm action exercise.

## Independent Application And Inbound Monitoring Gate

The repository does not provision an independent Cloudflare application monitor.
Therefore `credential_recovery_control.enabled` must remain `0` and mail go-live
is blocked until a separately approved external monitor is created and its proof
is attached. It must not run in this Worker, any of its Queue consumers, its
Cron, its D1, or its R2. It must execute at least once per minute and page through
the independently proven operator channel above.

The external monitor must evaluate and test-page every one of these exact
conditions. “missing or late Cron” means the heartbeat thresholds below, not an
operator checking logs:

- no successful minutely Cron heartbeat for three minutes, no successful
  five-minute reconciliation heartbeat for ten minutes, or no successful hourly
  retention heartbeat for 75 minutes;
- any primary, DLQ, parking, or emergency-forward consumer failure immediately,
  or an oldest ready message in any of those Queues older than ten minutes;
- any `forward_pending` receipt older than ten minutes;
- any raw archive, archive integrity, archive reconciliation, projection
  reconciliation, or recovery-authority failure immediately;
- any parked or expired credential-recovery request or delivery immediately;
- any dispatching credential-recovery lease past its stored `lease_expires_at`;
- independently, any pending or leased credential-recovery request older than
  five minutes and any pending, leased, or dispatching credential-recovery
  delivery older than five minutes;
- any active non-ambiguous request or delivery `last_error_code` present for
  three consecutive one-minute polls. This includes `SES_HTTP_503`,
  `SES_NOT_DISPATCHED`, `PAYLOAD_KEY_UNAVAILABLE`, and
  `RECOVERY_DIRECTORY_INVALID_CONFIG`;
- any active delivery with at least two `http_rejected` attempts;
- any pending credential-recovery request older than 24 hours as a critical
  escalation, or parked ciphertext retained more than seven days;
- accepted credential-recovery delivery without an exact callback after fifteen
  minutes;
- every ambiguous SES attempt that remains `ambiguous` after five minutes, even
  when a different attempt for the same outbox delivery was later accepted;
- a fifteen-minute EventBridge callback canary gap, any target DLQ message, or
  any failed DLQ write immediately.

Cloudflare Worker `send_email` operations can appear as dropped in the Email
Routing summary even when the destination received them. Emergency-forward
canaries and pages must use Email Sending metrics/logs and the returned nonblank
`messageId`, never Email Routing summary status. The fixed verified destination
supports total messages up to 25 MiB; the general Email Service limit is 5 MiB.
Both size classes need separate live proof.

The following queries are diagnostics and monitor inputs only. Running them
manually is not alerting and cannot satisfy this gate. They expose no identity,
destination, token, ciphertext, provider ID, delivery ID, or attempt ID.

Accepted by SES but no exact provider event after a 15-minute SLA:

```bash
npx wrangler d1 execute DB --env "$CF_ENV" --remote --command \
  "SELECT COUNT(*) AS accepted_without_provider_event FROM credential_recovery_delivery_outbox o WHERE o.state = 'accepted' AND o.accepted_at <= (unixepoch('now') - 900) * 1000 AND NOT EXISTS (SELECT 1 FROM credential_recovery_delivery_events e WHERE e.outbox_id = o.id AND e.attempt_id = o.accepted_attempt_id AND e.provider_message_id = o.provider_message_id)"
```

Expired leases, parked/expired work, over-age pending requests, and over-retained
parked ciphertext:

```bash
npx wrangler d1 execute DB --env "$CF_ENV" --remote --command \
  "SELECT (SELECT COUNT(*) FROM credential_recovery_delivery_outbox WHERE state = 'dispatching' AND lease_expires_at <= unixepoch('now') * 1000) AS expired_dispatch_leases, (SELECT COUNT(*) FROM credential_recovery_request_jobs WHERE state IN ('parked', 'expired')) AS parked_or_expired_requests, (SELECT COUNT(*) FROM credential_recovery_delivery_outbox WHERE state IN ('parked', 'expired')) AS parked_or_expired_deliveries, (SELECT COUNT(*) FROM credential_recovery_request_jobs WHERE state IN ('pending', 'leased') AND created_at <= (unixepoch('now') - 86400) * 1000) AS requests_over_24_hours, (SELECT COUNT(*) FROM credential_recovery_request_jobs WHERE state = 'parked' AND payload_ciphertext IS NOT NULL AND completed_at <= (unixepoch('now') - 604800) * 1000) + (SELECT COUNT(*) FROM credential_recovery_delivery_outbox WHERE state = 'parked' AND payload_ciphertext IS NOT NULL AND completed_at <= (unixepoch('now') - 604800) * 1000) AS parked_ciphertexts_over_7_days"
```

Independent five-minute request and delivery age SLAs:

```bash
npx wrangler d1 execute DB --env "$CF_ENV" --remote --command \
  "SELECT (SELECT COUNT(*) FROM credential_recovery_request_jobs WHERE state IN ('pending', 'leased') AND created_at <= (unixepoch('now') - 300) * 1000) AS pending_requests_over_5_minutes, (SELECT COUNT(*) FROM credential_recovery_delivery_outbox WHERE state IN ('pending', 'leased', 'dispatching') AND created_at <= (unixepoch('now') - 300) * 1000) AS pending_deliveries_over_5_minutes"
```

Current non-ambiguous active errors and active deliveries with repeated provider
rejections. Persistence is measured by the independent monitor across polls, so
a retry updating the row cannot reset the alert clock:

```bash
npx wrangler d1 execute DB --env "$CF_ENV" --remote --command \
  "SELECT (SELECT COUNT(*) FROM credential_recovery_request_jobs WHERE state IN ('pending', 'leased') AND last_error_code IS NOT NULL AND last_error_code NOT IN ('SES_TRANSPORT_AMBIGUOUS', 'SES_INVALID_SUCCESS_RESPONSE')) AS active_request_non_ambiguous_errors, (SELECT COUNT(*) FROM credential_recovery_delivery_outbox WHERE state IN ('pending', 'leased', 'dispatching') AND last_error_code IS NOT NULL AND last_error_code NOT IN ('SES_TRANSPORT_AMBIGUOUS', 'SES_INVALID_SUCCESS_RESPONSE')) AS active_delivery_non_ambiguous_errors, (SELECT COUNT(*) FROM (SELECT attempts.outbox_id FROM credential_recovery_delivery_attempts attempts JOIN credential_recovery_delivery_outbox outbox ON outbox.id = attempts.outbox_id WHERE attempts.state = 'http_rejected' AND outbox.state IN ('pending', 'leased', 'dispatching') GROUP BY attempts.outbox_id HAVING COUNT(*) >= 2)) AS active_deliveries_with_repeated_http_rejections"
```

Every ambiguous provider attempt older than the five-minute SLA. This query
deliberately has no outbox-state join or sibling-acceptance exclusion:

```bash
npx wrangler d1 execute DB --env "$CF_ENV" --remote --command \
  "SELECT COUNT(*) AS ambiguous_attempts_over_sla FROM credential_recovery_delivery_attempts WHERE state = 'ambiguous' AND updated_at <= (unixepoch('now') - 300) * 1000"
```

The external monitor must expose a safe test-input path for every rule. Use that
test path to exercise each bullet and each separately named subcondition without
creating production mail or mutating production Queue, D1, R2, SES, EventBridge,
or Cron state. For each exercise, record the monitor rule identifier, injected
test timestamp, threshold, independently received page timestamp, and page
provider message ID. A monitor that cannot safely test one rule does not satisfy
the gate.

The short-SLA monitor rules are separate:
`PENDING_REQUEST_OVER_5_MINUTES`, `PENDING_DELIVERY_OVER_5_MINUTES`,
`ACTIVE_REQUEST_NON_AMBIGUOUS_ERROR`,
`ACTIVE_DELIVERY_NON_AMBIGUOUS_ERROR`, and
`REPEATED_HTTP_REJECTED_DELIVERY`. Page the two age conditions on their first
positive poll, page repeated HTTP rejection on its first positive poll, and page
an active error no later than its third consecutive positive one-minute poll.
This makes persistent request failures visible in at most three minutes, before
the 15-minute request processing window expires. Resolve any of these pages only
after two consecutive zero polls of its own aggregate. Terminal or successful
state must remove the row from the active aggregate. A changed retry timestamp
must not reset the monitor's consecutive-positive count.

The safe test-input path must separately inject and then clear
`SES_HTTP_503`, `SES_NOT_DISPATCHED`, `PAYLOAD_KEY_UNAVAILABLE`, and
`RECOVERY_DIRECTORY_INVALID_CONFIG`, plus the two age conditions and two
`http_rejected` attempts. Each injection must produce a received page within its
threshold. Each clear must produce two zero polls and a recorded resolved
notification. Missing either the page or the recovery clear proof blocks enable.

The proof record must name the independent service and owner, polling identity,
one-minute schedule, read-only Cloudflare control-plane, Queue, D1 aggregate, R2
receipt/authority, Cron-heartbeat, AWS CloudWatch, EventBridge, and SQS sources,
the exact query or rule version for each source, every threshold above, last
successful poll, alarm destination, the direct SNS test `MessageId`, the 14-row
CloudWatch alarm proof, and one received test page per named monitor rule. Until
that proof is separately approved, both recovery and mail go-live remain
blocked.

## First-Deploy Secret File Cleanup

For a first Worker deploy, use the private envelope creator and a real Bash trap.
The creator reads inherited environment values, never secret argv or stdin
redirection, and JSON-encodes every value. This is required for
`ACCOUNT_RECOVERY_DIRECTORY`, whose exact value is itself a JSON object. The exact
key `"*"` supplies the default destination when no portal-address key matches, and
an exact entry overrides it. The object must become an escaped outer JSON string.
The deployment driver accepts only an owned regular
non-symlink single-link file with mode 0600, exact schema version 1, the selected
brand, and exactly the nine declared non-empty string secrets.

```bash
set -euo pipefail
set +x
REQUIRED_SECRET_NAMES=(
ACCOUNT_RECOVERY_DIRECTORY
ADMIN_BOOTSTRAP_EMAIL
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
CREDENTIAL_RECOVERY_PAYLOAD_KEY_V1
JWT_SECRET
SES_EVENT_WEBHOOK_SECRET
VAPID_PRIVATE_KEY
VAPID_PUBLIC_KEY
)
SECRETS_FILE=""
SECRETS_DIRECTORY=""
cleanup_secrets_file() {
  unset SECRET_NAME SECRET_VALUE
  for SECRET_NAME in "${REQUIRED_SECRET_NAMES[@]}"; do
    unset "$SECRET_NAME"
  done
  unset SECRET_NAME
  if [ -n "${SECRETS_FILE:-}" ] &&
    { [ -e "$SECRETS_FILE" ] || [ -L "$SECRETS_FILE" ]; }; then
    rm -- "$SECRETS_FILE"
  fi
  SECRETS_FILE=""
  if [ -n "${SECRETS_DIRECTORY:-}" ] && [ -d "$SECRETS_DIRECTORY" ]; then
    rmdir -- "$SECRETS_DIRECTORY"
  fi
  SECRETS_DIRECTORY=""
}
abort_secret_deploy() {
  SIGNAL_STATUS="$1"
  trap - EXIT HUP INT TERM
  cleanup_secrets_file
  exit "$SIGNAL_STATUS"
}
create_private_secrets_envelope() (
  set -euo pipefail
  set +x
  cleanup_prompt_secrets() {
    unset SECRET_NAME SECRET_VALUE
    for SECRET_NAME in "${REQUIRED_SECRET_NAMES[@]}"; do
      unset "$SECRET_NAME"
    done
    unset SECRET_NAME
  }
  abort_secret_prompt() {
    SIGNAL_STATUS="$1"
    trap - EXIT HUP INT TERM
    cleanup_prompt_secrets
    exit "$SIGNAL_STATUS"
  }
  trap cleanup_prompt_secrets EXIT
  trap 'abort_secret_prompt 129' HUP
  trap 'abort_secret_prompt 130' INT
  trap 'abort_secret_prompt 143' TERM

  for SECRET_NAME in "${REQUIRED_SECRET_NAMES[@]}"; do
    printf 'Enter %s: ' "$SECRET_NAME" >&2
    if ! IFS= read -r -s SECRET_VALUE </dev/tty; then
      printf '\nSecret prompt failed before envelope creation.\n' >&2
      exit 1
    fi
    printf '\n' >&2
    test -n "$SECRET_VALUE"
    export "$SECRET_NAME=$SECRET_VALUE"
    unset SECRET_VALUE
  done

  CREATED_SECRETS_FILE="$(node scripts/create-secrets-envelope.mjs "$BRAND")"
  cleanup_prompt_secrets
  printf '%s\n' "$CREATED_SECRETS_FILE"
)

# The operator shell starts clean. Prompt values and exports exist only in the
# command-substitution process; the parent receives only the created path.
cleanup_secrets_file
trap cleanup_secrets_file EXIT
trap 'abort_secret_deploy 129' HUP
trap 'abort_secret_deploy 130' INT
trap 'abort_secret_deploy 143' TERM
if ! SECRETS_FILE="$(create_private_secrets_envelope)"; then
  printf 'Secret envelope creation failed.\n' >&2
  exit 1
fi
SECRETS_DIRECTORY="$(dirname -- "$SECRETS_FILE")"

npm run "$DEPLOY_SCRIPT" -- --secrets-file "$SECRETS_FILE"
cleanup_secrets_file
SECRETS_FILE=""
SECRETS_DIRECTORY=""
trap - EXIT HUP INT TERM
```

Paste `ACCOUNT_RECOVERY_DIRECTORY` as its exact compact, single-line JSON value.
Do not add outer quotes or manually escape it. The creator owns that encoding and
prints only the unpredictable envelope path. Never log the environment or
envelope contents. The deployment driver validates and snapshots the envelope
before taking the artifact lock, redacts its values from the owned detail log,
gives Wrangler only a derived secret map in a private 0700 temporary directory,
and removes that 0400 derived file on success or failure.
Run the block as a Bash process, never source it into an interactive shell. The
hidden prompt and every secret export live only in an isolated
command-substitution process. Failed input, `HUP`, `INT`, and `TERM` unset all
nine names and exit nonzero. Before path handoff, the creator waits for any
issued file operation to settle, closes the handle, removes the file and
directory, then re-raises the original `HUP`, `INT`, or `TERM`. Once the parent
receives the path, its own signal handlers remove the envelope and directory
before terminating.

## Roll-Forward Rollback

After the legacy scrub, migration 0012 is forward-only. Never restore private
destinations to `users.recovery_email`, never roll back to code that reads that
column, never delete recovery evidence, and never delete or rotate the V1 payload
key while version-1 ciphertext can exist.

At the first anomaly, disable recovery immediately after approval:

```bash
npx wrangler d1 execute DB --env "$CF_ENV" --remote --command \
  "UPDATE credential_recovery_control SET enabled = 0, updated_at = unixepoch('now') * 1000 WHERE control_id = 'global'"
npx wrangler d1 execute DB --env "$CF_ENV" --remote --command \
  "SELECT control_id, enabled FROM credential_recovery_control ORDER BY control_id"
```

Verify the four private no-store 503 responses, preserve every request, outbox,
attempt, event, audit, and encrypted payload row, then roll forward a fix through
the locked build-verifier-deploy chain. Re-enable only after repeating every
disabled-state, callback, alert, and end-to-end proof.

After the observation window, delete the exact private legacy export and verify
the path is gone:

```bash
rm -- "$LEGACY_RECOVERY_EXPORT"
test ! -e "$LEGACY_RECOVERY_EXPORT"
```
