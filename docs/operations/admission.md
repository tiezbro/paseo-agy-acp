# Admission retirement and migration

The lightweight adapter removes Admission completely: queues, seats, start spacing,
capacity cooldowns, leases, heartbeats, process recovery and the dedicated SQLite ledger.
`AGY_ACP_ADMISSION_*` and `AGY_ACP_STATE_DIR` are no longer read. Remove these variables
from provider configuration and launch wrappers when deploying this branch.
`agy-acp-prepare-state` is removed. Existing ledger files are left untouched.

The official kernel owns its own conversations and login state. Do not delete those
files. No new adapter scheduling database replaces Admission.

See [the current design and acceptance plan](lightweight-adapter.md). Historical
research and experiment receipts remain under `docs/research/` and `docs/design/`.
