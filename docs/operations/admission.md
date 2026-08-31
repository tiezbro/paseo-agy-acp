# Admission operations

Admission protects one Antigravity account from prompt bursts created by
multi-agent Paseo delegation. It is a durable, account-wide fence around the
official kernel's `session/prompt` write. It does not replace Paseo scheduling
or the official ACP session lifecycle.

## When to enable it

Enable Admission when multiple Paseo agents can use the same Antigravity
account concurrently. A deliberately isolated single-agent connector can run
without it.

All connector processes that share one account must use the same
`AGY_ACP_STATE_DIR`. Different accounts should use different directories.

## Prepare the state directory

```bash
export AGY_ACP_STATE_DIR="$HOME/.local/state/paseo-agy-acp/account-name"
install -d -m 700 "$AGY_ACP_STATE_DIR"
npx -y --package=paseo-agy-acp@2.3.1 \
  agy-acp-prepare-state "$AGY_ACP_STATE_DIR"
export AGY_ACP_ADMISSION_ENABLED=true
```

The preflight requires an absolute path owned by the current user with exact
`0700` permissions. It creates new state files with `0600` permissions. An
existing directory with wider permissions is rejected rather than silently
changed; inspect its owner and contents before running:

```bash
chmod 700 -- "$AGY_ACP_STATE_DIR"
npx -y --package=paseo-agy-acp@2.3.1 \
  agy-acp-prepare-state "$AGY_ACP_STATE_DIR"
```

The official-kernel ledger lives below
`$AGY_ACP_STATE_DIR/official-kernel`. Do not copy a live ledger between
accounts or edit its SQLite files manually.

## Required runtime identity

An enabled connector requires:

- `AGY_ACP_ADMISSION_ENABLED=true` or `1`;
- an absolute, prepared `AGY_ACP_STATE_DIR`;
- a valid `PASEO_AGENT_ID` supplied by Paseo.

Missing or malformed enabled configuration fails closed. Discovery and
`--login` paths without an agent id do not open the Admission ledger.

## Policy defaults

| Behavior | Default | Environment override |
|---|---:|---|
| Shared active turns | `8` | `AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS`, integer >= 1 |
| Concurrent starts | `8` | `AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS`, integer >= 1 |
| Minimum start spacing | `2000 ms` | `AGY_ACP_ADMISSION_MIN_START_INTERVAL_MS`, integer >= 2000 |
| Maximum queue wait | `1800000 ms` | `AGY_ACP_ADMISSION_QUEUE_TIMEOUT_MS`, integer 1-1800000 |
| Provider/model capacity cooldown | `30000 ms` | `AGY_ACP_ADMISSION_CAPACITY_COOLDOWN_MS`, integer >= 30000 |

These values are tested operating defaults, not a declared Google concurrency
limit. Increase them only with account-specific observation and keep the start
spacing floor. Invalid overrides stop the enabled connector before it can run
unfenced.

## Runtime behavior

1. A prompt requests an account seat before any official kernel write.
2. Eligible requests are scheduled oldest-first with agent fairness.
3. The start gate enforces concurrent-start and spacing policy.
4. The connector performs one fenced `session/prompt` write.
5. Completion, failure, or cancellation releases the seat.

Idle sessions do not occupy seats. Closing a session cancels queued work that
has not started. Running work uses the normal connector cancellation path.
Queue timeout removes the queued request and its protected payload in the same
transaction.

Trusted provider-capacity failures pause only the affected provider/model for
the configured cooldown. Authentication, permission, transport, timeout, and
other failures retain distinct classifications.

## Persistence and recovery

Policy, queued ownership, leases, and recovery state are persisted so separate
connector processes share one account pool. Startup recovery verifies process
identity before reclaiming capacity. Ambiguous writes become explicit recovery
states; the adapter does not silently replay a prompt whose delivery cannot be
proven.

Do not delete the state directory while connectors are running. Back up or
inspect it only when every connector using the account is stopped.

## Changing policy

Processes opening the same state directory must agree with the persisted
policy. A conflicting policy fails closed instead of creating a process-local
split.

For an intentional policy change:

1. stop every connector using the account;
2. record the old environment and state path;
3. choose a new owner-only `AGY_ACP_STATE_DIR`;
4. run `agy-acp-prepare-state` for the new directory;
5. start one connector and verify a simple turn;
6. restore normal multi-agent delegation.

Keep the previous directory untouched until the new policy has passed live
verification. Switching the provider environment back to the previous path is
the rollback.

## Troubleshooting

### Connector refuses to start

Check:

```bash
printf '%s\n' "$AGY_ACP_STATE_DIR"
stat -c '%U %a %n' "$AGY_ACP_STATE_DIR"
printf '%s\n' "$PASEO_AGENT_ID"
```

The path must be absolute, owner must match the connector user, permissions
must be `700`, and every numeric policy value must satisfy the table above.

### Policy mismatch

Stop all account connectors and confirm they use identical Admission
environment. Do not overwrite the persisted fingerprint. Use a newly prepared
state directory for the new policy.

### Work remains queued

Check active agents, queue timeout, configured seats, start spacing, and recent
provider-capacity failures. Do not raise limits until authentication, quota,
and kernel health are known.

### Recovery required

Stop additional dispatch for the affected account and preserve the ledger.
Collect the connector error, agent id, state path, and relevant process status
without copying prompt payloads or credentials into an issue.

## Security boundary

Admission state can contain encrypted queued prompt material and process
identity evidence. Keep the directory owner-only, never commit it, and never
place it in the npm package. The repository secret scan and package-content
checks reject database and runtime artifacts from release tarballs.
